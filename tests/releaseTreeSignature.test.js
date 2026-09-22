// tests/releaseTreeSignature.test.js: checking a release's signature on a board.
//
// update_require_signature was read by nothing: a sysop who turned it on got
// no checking at all. The updater now checks the release tree's MANIFEST.asc
// against the key the INSTALLED board trusts, before applying anything.
//
// Uses throwaway keys in a temporary gpg home and stops gpg's daemons for it
// afterwards: a stray daemon on a small box is not harmless. Skips without gpg.
//
// Run: npx mocha --no-config --exit tests/releaseTreeSignature.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { verifyTreeSignature, gpgAvailable } from '../src/release/signing.js';

describe('verifying a release tree signature', function () {
	this.timeout(60000);
	var work, home, keyA, keyB, fprA, fprB;

	function gpg(args, opts) {
		var r = spawnSync('gpg', ['--homedir', home, '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--passphrase', '']
			.concat(args), Object.assign({ encoding: 'utf8', timeout: 30000 }, opts || {}));
		if (r.status !== 0) throw new Error('gpg ' + args.join(' ') + ': ' + r.stderr);
		return r.stdout;
	}

	function newKey(name) {
		gpg(['--quick-gen-key', name + ' <' + name.toLowerCase() + '@example.invalid>', 'ed25519', 'sign', 'never']);
		var out = gpg(['--with-colons', '--list-keys', name]);
		var fpr = out.split('\n').filter(function (l) { return l.indexOf('fpr:') === 0; })[0].split(':')[9];
		var file = path.join(work, name + '.asc');
		fs.writeFileSync(file, gpg(['--armor', '--export', fpr]));
		return { fpr: fpr, file: file };
	}

	function tree(name, signer) {
		var root = path.join(work, name);
		fs.mkdirSync(path.join(root, 'setup'), { recursive: true });
		fs.writeFileSync(path.join(root, 'MANIFEST'), '{"files":[{"path":"src/a.js","sha256":"abc"}]}\n');
		if (signer) gpg(['--local-user', signer, '--armor', '--detach-sign', '--output', path.join(root, 'MANIFEST.asc'),
			path.join(root, 'MANIFEST')]);
		return root;
	}

	before(function () {
		if (!gpgAvailable()) return this.skip();
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-treesig-'));
		home = path.join(work, 'gnupg');
		fs.mkdirSync(home, { mode: 0o700 });
		var a = newKey('ReleaseKey'); keyA = a.file; fprA = a.fpr;
		var b = newKey('OtherKey'); keyB = b.file; fprB = b.fpr;
	});
	after(function () {
		if (!work) return;
		spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore' });
		fs.rmSync(work, { recursive: true, force: true });
	});

	it('verifies a tree signed by the key the board trusts', function () {
		var r = verifyTreeSignature({ treeRoot: tree('good', fprA), keyMaterial: keyA, pinFrom: keyA });
		assert.strictEqual(r.state, 'verified', r.detail);
	});

	it('calls a tree without MANIFEST.asc unsigned', function () {
		var r = verifyTreeSignature({ treeRoot: tree('unsigned', null), keyMaterial: keyA, pinFrom: keyA });
		assert.strictEqual(r.state, 'unsigned');
	});

	it('calls a MANIFEST changed after signing bad', function () {
		var root = tree('tampered', fprA);
		fs.appendFileSync(path.join(root, 'MANIFEST'), '{"path":"evil.js"}\n');
		var r = verifyTreeSignature({ treeRoot: root, keyMaterial: keyA, pinFrom: keyA });
		assert.strictEqual(r.state, 'bad');
		assert.ok(/does not match/.test(r.detail), r.detail);
	});

	it('refuses a release carrying its own key in place of the trusted one', function () {
		// The attack a pin exists for: replace the release and the key with it.
		var r = verifyTreeSignature({ treeRoot: tree('wrongkey', fprB), keyMaterial: keyB, pinFrom: keyA });
		assert.strictEqual(r.state, 'bad');
		assert.ok(/not the release key this board trusts/.test(r.detail), r.detail);
	});

	it('refuses a signature by a key other than the trusted one', function () {
		var r = verifyTreeSignature({ treeRoot: tree('othersigner', fprB), keyMaterial: keyA, pinFrom: keyA });
		assert.strictEqual(r.state, 'bad', r.detail);
	});

	it('cannot verify without the installed board saying which key to trust', function () {
		var r = verifyTreeSignature({ treeRoot: tree('nopin', fprA), keyMaterial: keyA,
			pinFrom: path.join(work, 'missing.asc') });
		assert.strictEqual(r.state, 'unverifiable');
	});

	it('cannot verify when the release ships no key', function () {
		var r = verifyTreeSignature({ treeRoot: tree('nokey', fprA), keyMaterial: path.join(work, 'missing.asc'),
			pinFrom: keyA });
		assert.strictEqual(r.state, 'unverifiable');
	});

	it('leaves no gpg daemon behind for its temporary home', function () {
		verifyTreeSignature({ treeRoot: tree('daemons', fprA), keyMaterial: keyA, pinFrom: keyA });
		var left = spawnSync('pgrep', ['-af', 'canectic-gpg-'], { encoding: 'utf8' }).stdout
			.split('\n').filter(function (l) { return l && !/pgrep/.test(l); });
		assert.deepStrictEqual(left, [], 'stray daemons: ' + left.join(' | '));
		assert.ok(fprB);
	});
});
