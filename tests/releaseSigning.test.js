// tests/releaseSigning.test.js: the release signature and the pinned fingerprint.
//
// What a board pins is the PRIMARY key's fingerprint, never a copy of the
// keyring, and the reason is a result worth recording because it is the
// opposite of what a keyring snapshot suggests. Verified against gpg 2.4 while
// designing this:
//
//   A signature from an EXPIRED signing subkey still verifies against a pinned
//   keyring. Good signature, exit 0. Expiry never retroactively breaks a
//   release anyone already holds.
//
//   A signature from a ROTATED subkey does NOT. "Can't check signature: No
//   public key", exit 2. A pinned keyring is a snapshot, so every routine
//   two-year subkey rotation would strand precisely the boards that cannot
//   make an HTTP call to refresh it.
//
// So the pin is the primary fingerprint, the key material travels inside each
// release, and rotation is a non-event. Refusal is reserved for a primary
// change, which is the case that should be refused.
//
// The assertion that earns its place here is the last one: the key this release
// ships and the fingerprint the documentation tells people to compare against
// are one fact written in four files, and nothing but a test keeps them equal.
//
// Filesystem and gpg. No database, no services, no network.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
	PUBLIC_KEY_FILENAME, signatureName, normaliseFingerprint,
	fingerprintsMatch, formatFingerprint, keyFingerprint
} from '../src/release/signing.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var KEY_FILE = path.join(ROOT, 'setup', PUBLIC_KEY_FILENAME);

function haveGpg() {
	try { execFileSync('gpg', ['--version'], { stdio: 'ignore' }); return true; }
	catch (e) { return false; }
}

describe('fingerprints', function () {

	it('reads the spaced form a person pastes out of gpg', function () {
		assert.strictEqual(
			normaliseFingerprint('F3F1 6D36 59AF 25FB F947  4C6D B5D8 AB14 3016 761F'),
			'F3F16D3659AF25FBF9474C6DB5D8AB143016761F');
	});

	it('reads lower case and an 0x prefix', function () {
		var bare = 'f3f16d3659af25fbf9474c6db5d8ab143016761f';
		assert.strictEqual(normaliseFingerprint(bare), bare.toUpperCase());
		assert.strictEqual(normaliseFingerprint('0x' + bare), bare.toUpperCase());
	});

	// Short key ids are cheap to collide and there are public demonstrations of
	// exactly that, so a 16 hex "fingerprint" is not one and must not compare
	// equal to anything.
	it('refuses a short key id', function () {
		assert.strictEqual(normaliseFingerprint('B5D8AB143016761F'), null);
		assert.strictEqual(normaliseFingerprint('3016761F'), null);
	});

	it('refuses anything that is not 40 hex digits', function () {
		for (var bad of ['', null, undefined, 42, 'not a fingerprint',
			'F3F16D3659AF25FBF9474C6DB5D8AB143016761', 'G3F16D3659AF25FBF9474C6DB5D8AB143016761F']) {
			assert.strictEqual(normaliseFingerprint(bad), null, 'accepted ' + String(bad));
		}
	});

	it('matches the same key however either side was written', function () {
		assert.ok(fingerprintsMatch(
			'F3F1 6D36 59AF 25FB F947  4C6D B5D8 AB14 3016 761F',
			'f3f16d3659af25fbf9474c6db5d8ab143016761f'));
	});

	it('does not match two different keys, or anything unparseable', function () {
		assert.ok(!fingerprintsMatch(
			'F3F16D3659AF25FBF9474C6DB5D8AB143016761F',
			'F3F16D3659AF25FBF9474C6DB5D8AB143016761E'));
		assert.ok(!fingerprintsMatch('B5D8AB143016761F', 'B5D8AB143016761F'), 'two short ids compared equal');
		assert.ok(!fingerprintsMatch(null, null));
	});

	it('prints the form the documentation carries', function () {
		var spaced = formatFingerprint('F3F16D3659AF25FBF9474C6DB5D8AB143016761F');
		assert.strictEqual(spaced, 'F3F1 6D36 59AF 25FB F947  4C6D B5D8 AB14 3016 761F');
		assert.ok(fingerprintsMatch(spaced, 'F3F16D3659AF25FBF9474C6DB5D8AB143016761F'),
			'the printed form does not read back as the same key');
	});
});

describe('signature filenames', function () {

	it('sit beside the file they vouch for', function () {
		assert.strictEqual(signatureName('MANIFEST'), 'MANIFEST.asc');
		assert.strictEqual(signatureName('SHA256SUMS'), 'SHA256SUMS.asc');
	});
});

describe('the key this release ships', function () {

	it('is committed in the tree, so it travels inside every release', function () {
		assert.ok(fs.existsSync(KEY_FILE), KEY_FILE + ' is missing');
		assert.match(fs.readFileSync(KEY_FILE, 'utf8'), /^-----BEGIN PGP PUBLIC KEY BLOCK-----/);
	});

	it('carries no secret key material', function () {
		var text = fs.readFileSync(KEY_FILE, 'utf8');
		assert.ok(text.indexOf('PRIVATE KEY BLOCK') === -1, 'a secret key is committed in the repository');
	});

	// The first fpr record in gpg's colon output is the primary. Subkeys have
	// their own, and taking the last would pin a subkey, which is the one
	// mistake that turns every routine rotation into a stranded board.
	it('reports its primary fingerprint, not a subkey', function () {
		if (!haveGpg()) return this.skip();
		var fpr = keyFingerprint(KEY_FILE);
		assert.ok(fpr, 'no fingerprint could be read');

		var out = execFileSync('gpg', ['--show-keys', '--with-colons', KEY_FILE], { encoding: 'utf8' });
		var records = out.split('\n').filter(function (l) { return /^(pub|sub|fpr):/.test(l); });
		var firstPub = records.findIndex(function (l) { return l.indexOf('pub:') === 0; });
		assert.strictEqual(firstPub, 0, 'the listing does not start with the primary');
		assert.strictEqual(normaliseFingerprint(records[1].split(':')[9]), fpr,
			'the fingerprint read is not the one directly under the primary record');

		var subs = records.filter(function (l) { return l.indexOf('sub:') === 0; });
		assert.ok(subs.length >= 1, 'the key has no signing subkey, so nothing can sign a release');
	});

	// One fact, written in four files. The key is regenerated at most once in
	// the life of the project and the documentation is the only thing a sysop
	// can compare against, so a key swapped without the docs following is
	// exactly the failure this catches.
	it('matches the fingerprint the documentation tells people to compare', function () {
		if (!haveGpg()) return this.skip();
		var fpr = keyFingerprint(KEY_FILE);
		var docs = [
			'README.md',
			path.join('docs', 'sysop', 'INSTALL.md'),
			path.join('docs', 'releases', 'v0.9.6a.md')
		];
		for (var rel of docs) {
			var text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
			var printed = text.match(/[0-9A-F]{4}(?: [0-9A-F]{4}){4} {1,2}(?:[0-9A-F]{4} ){4}[0-9A-F]{4}/);
			assert.ok(printed, rel + ' prints no fingerprint for people to compare against');
			assert.ok(fingerprintsMatch(printed[0], fpr),
				rel + ' prints ' + printed[0] + ', but the shipped key is ' + formatFingerprint(fpr));
		}
	});
});
