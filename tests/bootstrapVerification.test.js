// tests/bootstrapVerification.test.js: what the bootstrap will refuse to unpack.
//
// The bootstrap is the one piece of Canectic that runs before Canectic exists,
// on a machine with nothing on it, and the thing it does at the end is execute
// code it just downloaded. Its verification is therefore not a nicety.
//
// It used to check the archive against the sha256 inside the archive's OWN
// metadata JSON, then separately verify the signature over SHA256SUMS and never
// open the file. So the document that the archive was actually trusted against
// was vouched for by nothing, while the sysop was told "signature verified".
// Anyone able to write to the release host swapped the archive and its metadata
// together, left the genuine signed checksum list alone, and both checks
// passed. That is case 3 below, and the old code unpacked it.
//
// The chain now runs signature -> SHA256SUMS -> metadata -> artifact. Every
// link is checked and the weakest one is no longer load-bearing on its own.
//
// These run the real script rather than reading it, for the reason
// installScriptRefusal.test.js gives: a grep pins where a refusal is written
// rather than that it happens. --download-only stops immediately after
// verification, so nothing is ever unpacked and nothing is installed.
//
// No signature is made here. Signing needs the release key's passphrase, which
// is not on any build machine and must not be. What is asserted is the part
// that decides whether bytes are trusted; the signature is what decides whether
// SHA256SUMS itself is trusted, and gpg's own verification is not this
// project's to test.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var BOOTSTRAP = path.join(ROOT, 'setup', 'bootstrap.sh');
var VERSION = '9.9.9a';
var ARTIFACT = 'canectic-' + VERSION + '.zip';
var META = 'canectic-' + VERSION + '.json';

function sha256(file) {
	return execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0];
}

/**
 * A publish directory shaped like a real one. The archive is not a real release
 * because --download-only never unpacks it: what is under test is which bytes
 * the script agrees to hand onward.
 */
function publish(dir) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ARTIFACT), 'pretend this is a release\n');
	fs.writeFileSync(path.join(dir, META), JSON.stringify({
		version: VERSION, artifact: ARTIFACT, channel: 'stable',
		sha256: sha256(path.join(dir, ARTIFACT)), delta: false
	}, null, 2) + '\n');
	writeSums(dir);
	return dir;
}

function writeSums(dir) {
	var lines = [META, ARTIFACT].sort().map(function (n) {
		return sha256(path.join(dir, n)) + '  ' + n;
	});
	fs.writeFileSync(path.join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
}

/** Rewrite the archive AND restate its hash in the metadata, which is what an
 *  attacker who can write to the host does. Deliberately leaves SHA256SUMS as
 *  published, because they cannot re-sign it. */
function swapArtifactAndMetadata(dir) {
	var file = path.join(dir, ARTIFACT);
	fs.writeFileSync(file, 'this is not the release you asked for\n');
	var meta = JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
	meta.sha256 = sha256(file);
	fs.writeFileSync(path.join(dir, META), JSON.stringify(meta, null, 2) + '\n');
}

function run(from, out) {
	fs.mkdirSync(out, { recursive: true });
	try {
		var stdout = execFileSync('bash', [BOOTSTRAP, '--from', from, '--version', VERSION,
			'--download-only', '--target', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		return { ok: true, output: stdout };
	} catch (e) {
		return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') };
	}
}

describe('what the bootstrap will hand onward', function () {
	this.timeout(30000);

	var work;

	beforeEach(function () { work = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-bootstrap-')); });
	afterEach(function () { fs.rmSync(work, { recursive: true, force: true }); });

	it('accepts a publish whose every file agrees', function () {
		var r = run(publish(path.join(work, 'pub')), path.join(work, 'out'));
		assert.ok(r.ok, 'refused a good publish:\n' + r.output);
		assert.match(r.output, /checksum verified/);
		assert.ok(fs.existsSync(path.join(work, 'out', ARTIFACT)), 'nothing was handed onward');
	});

	it('refuses an archive that does not match the checksum list', function () {
		var dir = publish(path.join(work, 'pub'));
		fs.appendFileSync(path.join(dir, ARTIFACT), 'tampered\n');   // sums not restated
		var r = run(dir, path.join(work, 'out'));
		assert.ok(!r.ok, 'accepted a tampered archive');
		assert.match(r.output, /does not match the published checksum list/);
		assert.ok(!fs.existsSync(path.join(work, 'out', ARTIFACT)), 'it was handed onward anyway');
	});

	// The one the old code passed. Both halves are restated consistently, so
	// every check that reads only the metadata agrees; only the signed list
	// disagrees, and only because it is the one document the attacker cannot
	// rewrite.
	it('refuses an archive swapped together with its own metadata', function () {
		var dir = publish(path.join(work, 'pub'));
		swapArtifactAndMetadata(dir);
		var r = run(dir, path.join(work, 'out'));
		assert.ok(!r.ok, 'accepted an archive whose metadata was rewritten to match it');
		assert.match(r.output, /does not match the published checksum list/);
		assert.ok(!fs.existsSync(path.join(work, 'out', ARTIFACT)), 'it was handed onward anyway');
	});

	it('refuses a file the checksum list does not mention at all', function () {
		var dir = publish(path.join(work, 'pub'));
		var sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8')
			.split('\n').filter(function (l) { return l.indexOf(ARTIFACT) === -1; });
		fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.join('\n'));
		var r = run(dir, path.join(work, 'out'));
		assert.ok(!r.ok, 'accepted a file the list says nothing about');
		assert.match(r.output, /SHA256SUMS does not mention/);
	});

	// A file echo delivers an archive and nothing else. That is the normal shape
	// there rather than a fault, so it proceeds on the metadata checksum alone
	// and says so. The archive carries a signed MANIFEST inside it, which is
	// what verifies a release that arrived this way.
	it('proceeds without a checksum list, and says that is what it did', function () {
		var dir = publish(path.join(work, 'pub'));
		fs.unlinkSync(path.join(dir, 'SHA256SUMS'));
		var r = run(dir, path.join(work, 'out'));
		assert.ok(r.ok, 'refused a release delivered the way a file echo delivers one:\n' + r.output);
		assert.match(r.output, /no SHA256SUMS alongside the release/);
		assert.match(r.output, /not signature checked/);
	});

	it('still refuses a bad archive when there is no checksum list to fall back on', function () {
		var dir = publish(path.join(work, 'pub'));
		fs.unlinkSync(path.join(dir, 'SHA256SUMS'));
		fs.appendFileSync(path.join(dir, ARTIFACT), 'tampered\n');
		var r = run(dir, path.join(work, 'out'));
		assert.ok(!r.ok, 'accepted a tampered archive with no list present');
		assert.match(r.output, /does not match its published checksum/);
	});
});
