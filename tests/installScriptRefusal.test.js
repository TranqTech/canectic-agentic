// tests/installScriptRefusal.test.js: install.sh must not update.
//
// It used to detect an existing installation and offer to update it, and its
// update path did a full rm -rf replace of every CODE_DIRS entry, with `public`
// still in that list. update.sh had moved public into an overlay in April so
// sysop-added door icons, collection images and branding survive, and added a
// skiplist so public/css/custom.css is never overwritten once it exists.
// install.sh never received either change.
//
// So a sysop who ran install.sh against a live board lost all of it, and the
// script invited them to: it detected the mode itself and offered. Issue #44.
//
// The cause was two programs claiming to update with duplicated directory
// categorisation. The fix is that only one of them updates.
//
// This runs the real script rather than reading it. A grep would pin where the
// refusal lives rather than that it happens, which is the mistake
// msgidSplitMarker.test.js had to be rewritten to stop making. The refusal is
// reached before anything is copied, so running it is cheap and touches nothing.
//
// Run: npx mocha

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

function hasBash() {
	try {
		execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' });
		return true;
	} catch (_) { return false; }
}

// Run install.sh against a directory, answering nothing. Returns
// { code, output }.
function runInstall(target) {
	try {
		var out = execFileSync('bash', ['setup/install.sh', target], {
			input: '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000
		});
		return { code: 0, output: out };
	} catch (err) {
		return {
			code: err.status === undefined ? -1 : err.status,
			output: String(err.stdout || '') + String(err.stderr || '')
		};
	}
}

describe('install.sh refuses to update', function () {
	this.timeout(40000);

	var available = false;
	var tmp = null;

	before(function () {
		available = hasBash() && fs.existsSync('setup/install.sh');
		if (!available) return;
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-install-test-'));
	});

	after(function () {
		if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
	});

	beforeEach(function () { if (!available) this.skip(); });

	function existingInstall() {
		var dir = fs.mkdtempSync(path.join(tmp, 'existing-'));
		fs.mkdirSync(path.join(dir, 'src'));
		fs.mkdirSync(path.join(dir, 'bin'));
		fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"canectic"}');
		return dir;
	}

	it('exits non-zero when the target is already an installation', function () {
		var result = runInstall(existingInstall());
		assert.strictEqual(result.code, 1,
			'it must refuse rather than offer, since accepting deletes public/');
	});

	it('names update.sh so the sysop knows what to run instead', function () {
		var result = runInstall(existingInstall());
		assert.ok(/update\.sh/.test(result.output),
			'refusing without saying what to do instead just moves the problem');
	});

	it('says what update.sh preserves, rather than only that it differs', function () {
		// "Use the other script" invites someone to conclude they are aliases
		// and run this one anyway. The reason is the part that stops them.
		var result = runInstall(existingInstall());
		assert.ok(/custom\.css/.test(result.output));
	});

	it('leaves the target untouched when it refuses', function () {
		var dir = existingInstall();
		fs.mkdirSync(path.join(dir, 'public'));
		fs.writeFileSync(path.join(dir, 'public', 'sysop-asset.png'), 'not really a png');

		runInstall(dir);

		assert.ok(fs.existsSync(path.join(dir, 'public', 'sysop-asset.png')),
			'the refusal path must not copy or delete anything');
	});

	it('still recognises a directory that is not an installation', function () {
		// The refusal must not be so broad that a fresh install cannot happen.
		// Answering the prompt with nothing leaves it at the default, so this
		// only checks how far it gets, not that it completes.
		var dir = fs.mkdtempSync(path.join(tmp, 'fresh-'));
		var result = runInstall(dir);
		assert.ok(!/existing Canectic installation/.test(result.output),
			'an empty directory is a fresh install, not an update');
	});
});

describe('only one script updates', function () {

	var install = null;

	before(function () {
		try { install = fs.readFileSync('setup/install.sh', 'utf8'); }
		catch (_) { this.skip(); }
	});

	it('install.sh carries no update implementation to drift', function () {
		// The bug was not the rm -rf itself, it was a second copy of the
		// directory categorisation that nobody updated when the first changed.
		// Deleting it is what stops that happening again.
		assert.ok(!/^do_update\(\)/m.test(install),
			'a second update implementation is how this drifted in the first place');
		assert.ok(!/^merge_data_dir\(\)/m.test(install));
	});
});
