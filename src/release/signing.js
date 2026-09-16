// signing.js -- the release signature, and the fingerprint a board pins.
//
// Two layers, with different jobs and different reach.
//
// SHA256SUMS.asc sits at the release root on the host and says the publish
// directory is ours, before anything is unpacked. It covers the artifact, the
// metadata, the manifest and the channel index, so it is what closes the gap
// between "the archive matches the checksum in its metadata" and "that metadata
// is ours". It only exists on the HTTP path.
//
// MANIFEST.asc rides INSIDE the archive and says the tree is ours, after. That
// is the one that reaches a board fed by a file echo, where the only thing that
// arrives is a ZIP: SHA256SUMS never travels down an echo, so a release signed
// only at the host can never be verified by the boards the FTN transport
// exists for. It is also the stronger of the two, because it vouches for the
// content rather than the container and survives a chain renaming, truncating
// or re-archiving the file. MANIFEST already carries a sha256 for every shipped
// file and updateStaging already verifies the tree against it, so signing it
// puts a signature on a step that was already load-bearing.
//
// What a board pins is the PRIMARY key's fingerprint, never a copy of the
// keyring. A pinned keyring is a snapshot: an expired signing subkey still
// verifies against it, but a ROTATED one does not, so every routine subkey
// rotation would strand exactly the boards that cannot make an HTTP call to
// refresh. Pinning the primary and taking the key material out of each release
// makes rotation a non-event and reserves refusal for a primary change, which
// is the case that should be refused.
//
// The pin is the full 40 hex fingerprint and never the 64 bit key id. Short ids
// are cheap to collide and there are public demonstrations of exactly that.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

var SIGNATURE_SUFFIX = '.asc';
var PUBLIC_KEY_FILENAME = 'canectic-release.asc';

/** The detached signature that belongs beside `name`. */
function signatureName(name) {
	return name + SIGNATURE_SUFFIX;
}

/**
 * A fingerprint in the one form everything compares: 40 upper case hex digits,
 * no spaces.
 *
 * gpg prints it in spaced groups, people paste it that way, and the docs print
 * it that way because it is the only form a human can check by eye. Comparing
 * the printed form directly is how a match gets missed over whitespace.
 *
 * @returns {string|null} null when it is not a v4 fingerprint at all
 */
function normaliseFingerprint(text) {
	if (typeof text !== 'string') return null;
	var bare = text.replace(/\s+/g, '').replace(/^0x/i, '').toUpperCase();
	return /^[0-9A-F]{40}$/.test(bare) ? bare : null;
}

/** Do two fingerprints name the same key, however either was written? */
function fingerprintsMatch(a, b) {
	var x = normaliseFingerprint(a);
	var y = normaliseFingerprint(b);
	return x !== null && y !== null && x === y;
}

/** The spaced form, for printing. Five groups of four, two groups of four,
 *  which is what gpg --fingerprint produces and what the docs carry. */
function formatFingerprint(text) {
	var bare = normaliseFingerprint(text);
	if (!bare) return null;
	var groups = bare.match(/.{4}/g);
	return groups.slice(0, 5).join(' ') + '  ' + groups.slice(5).join(' ');
}

/**
 * The primary fingerprint of the key in an armored public key file.
 *
 * The FIRST fpr record is the primary. Subkeys have their own fpr records after
 * their sub record, and taking the last one would pin a subkey, which is the
 * mistake this module exists to avoid.
 */
function keyFingerprint(keyFile) {
	var out = execFileSync('gpg', ['--show-keys', '--with-colons', keyFile], { encoding: 'utf8' });
	for (var line of out.split('\n')) {
		if (line.indexOf('fpr:') === 0) {
			var fpr = normaliseFingerprint(line.split(':')[9] || '');
			if (fpr) return fpr;
		}
	}
	return null;
}

/**
 * Detach-sign `file`, writing `<file>.asc` beside it.
 *
 * Signs with an explicit key rather than gpg's default, because the default is
 * whatever matches the committer's own identity and that is not the release
 * key. A cut that quietly signed with the maintainer's personal key would
 * verify for nobody who pinned the release fingerprint.
 */
function detachSign(file, keyId, opts) {
	var sig = signatureName(file);
	if (fs.existsSync(sig)) fs.unlinkSync(sig);
	var args = ['--detach-sign', '--armor'];
	if (keyId) args = args.concat(['--local-user', keyId]);
	args.push(file);

	// Inherit by default so the passphrase prompt reaches the person running
	// the cut. `capture` is for the probe, which needs gpg's own words in order
	// to say something more useful than "Command failed". pinentry draws on the
	// terminal named by GPG_TTY rather than on this process's stdio, so piping
	// does not stop a prompt appearing on a correctly configured machine.
	try {
		execFileSync('gpg', args, (opts && opts.capture)
			? { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
			: { stdio: 'inherit' });
	} catch (e) {
		var said = String((e && e.stderr) || '').trim();
		throw new Error(said ? said : (e && e.message) || String(e));
	}
	if (!fs.existsSync(sig)) throw new Error('gpg reported success but wrote no signature for ' + file);
	return sig;
}

/**
 * Prove the agent can actually sign, before a cut touches anything.
 *
 * Written after a cut got as far as closing the changelog, clearing the pending
 * declarations, bumping package.json and committing, and THEN failed on `git
 * tag -s` because gpg could not reach a terminal to ask for the passphrase. The
 * repository was left holding a release commit for a release that does not
 * exist, which is a state nothing in the script knows how to be in.
 *
 * Having a key is not the same as being able to use it, and the difference only
 * shows up at the moment of use. So use it, on a throwaway file, first.
 *
 * The usual cause is GPG_TTY being unset: pinentry has no terminal to draw the
 * prompt on and fails with "Inappropriate ioctl for device", which names an
 * ioctl rather than the thing to fix, so the message says the thing to fix.
 */
function assertCanSign(keyId) {
	var probe = path.join(os.tmpdir(), 'canectic-sign-probe-' + process.pid);
	try {
		fs.writeFileSync(probe, 'probe\n');
		detachSign(probe, keyId, { capture: true });
	} catch (e) {
		var hint = /ioctl|pinentry|No such device/i.test(String(e.message || e))
			? '\n  gpg cannot reach a terminal to ask for the passphrase.' +
			  '\n  Set GPG_TTY and try again:  export GPG_TTY=$(tty)' +
			  '\n  If you are running this through something that is not a real terminal, use one.'
			: '';
		throw new Error('gpg cannot sign with ' + keyId + '.' + hint +
			'\n  Nothing has been changed.\n  Original error: ' + (e.message || e));
	} finally {
		for (var f of [probe, signatureName(probe)]) {
			try { fs.unlinkSync(f); } catch (ignore) { /* it may never have been written */ }
		}
	}
	return true;
}

export {
	SIGNATURE_SUFFIX,
	PUBLIC_KEY_FILENAME,
	signatureName,
	normaliseFingerprint,
	fingerprintsMatch,
	formatFingerprint,
	keyFingerprint,
	detachSign,
	assertCanSign
};
