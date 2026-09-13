// tests/installTarget.test.js: reading the installation a release is about to
// be applied to.
//
// This exists because of a bug the unit tests could not have caught and did
// not: the update tool reported the version of the tree it was RUNNING from
// rather than the tree it was about to modify. Those are the same thing only
// when --target is the current directory, which is exactly the case anybody
// testing by hand would use. It was found by pointing the tool at a scratch
// install and noticing the version line was wrong.
//
// So the version of an installation is now a function with a target argument
// rather than a call to systeminfo, and it is tested here.
//
// The other thing asserted is the two-manifest distinction, which is the whole
// basis of the data-file rule: `local` is what is on disk, `installed` is what
// the last release shipped, and an install with no MANIFEST has to come back
// with `installed` null rather than with something invented.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installedVersion, looksLikeInstall, describeInstall } from '../src/maintenance/installTarget.js';
import { serialiseManifest, buildManifest, MANIFEST_FILENAME } from '../src/release/manifest.js';

var roots = [];
function tmp() {
	var d = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-target-'));
	roots.push(d);
	return d;
}
function write(root, files) {
	for (var p of Object.keys(files)) {
		var abs = path.join(root, p);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, files[p]);
	}
	return root;
}

after(function () {
	for (var d of roots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

describe('installedVersion', function () {

	it('reads the version of the directory it was given', function () {
		var root = write(tmp(), { 'package.json': JSON.stringify({ version: '0.9.6a' }) });
		assert.strictEqual(installedVersion(root), '0.9.6a');
	});

	it('does not report the version of the tree this process is running from', function () {
		// The bug. Two installs at different versions must give different
		// answers, and neither should be whatever this repository says.
		var a = write(tmp(), { 'package.json': JSON.stringify({ version: '0.9.5a' }) });
		var b = write(tmp(), { 'package.json': JSON.stringify({ version: '0.9.8a.20261001' }) });
		assert.strictEqual(installedVersion(a), '0.9.5a');
		assert.strictEqual(installedVersion(b), '0.9.8a.20261001');
	});

	it('normalises the version, so a stray v prefix does not reach a comparison', function () {
		var root = write(tmp(), { 'package.json': JSON.stringify({ version: 'v0.9.6a' }) });
		assert.strictEqual(installedVersion(root), '0.9.6a');
	});

	it('is null where there is no install, which means "not one" rather than "old"', function () {
		assert.strictEqual(installedVersion(tmp()), null);
		assert.strictEqual(installedVersion('/nonexistent/path'), null);
		assert.strictEqual(installedVersion(write(tmp(), { 'package.json': 'not json' })), null);
		assert.strictEqual(installedVersion(write(tmp(), { 'package.json': '{"version":"banana"}' })), null);
	});
});

describe('looksLikeInstall', function () {

	it('wants a package.json and nothing more', function () {
		assert.strictEqual(looksLikeInstall(write(tmp(), { 'package.json': '{}' })), true);
		assert.strictEqual(looksLikeInstall(tmp()), false);
	});
});

describe('describeInstall', function () {

	it('hashes only the shipped categories, not the whole tree', function () {
		// An install also holds the ftn spool, logs, uploaded files and
		// node_modules. Hashing those would be slow and would mean a release
		// had an opinion about files it never shipped.
		var root = write(tmp(), {
			'package.json': JSON.stringify({ version: '0.9.6a' }),
			'src/a.js': 'code',
			'logs/big.log': 'x'.repeat(1000),
			'files/uploads/thing.zip': 'binary'
		});
		var d = describeInstall(root);
		var paths = d.local.files.map(function (f) { return f.path; });
		assert.ok(paths.indexOf('src/a.js') !== -1);
		assert.ok(paths.indexOf('package.json') !== -1);
		assert.ok(paths.indexOf('logs/big.log') === -1);
		assert.ok(paths.indexOf('files/uploads/thing.zip') === -1);
	});

	it('carries the installation\'s own version on the local manifest', function () {
		var root = write(tmp(), { 'package.json': JSON.stringify({ version: '0.9.6a' }), 'src/a.js': 'x' });
		assert.strictEqual(describeInstall(root).version, '0.9.6a');
	});

	it('returns the MANIFEST the last release left, when there is one', function () {
		var root = write(tmp(), { 'package.json': JSON.stringify({ version: '0.9.6a' }), 'config/x.json': '{}' });
		var shipped = buildManifest({ root: root, files: [{ path: 'config/x.json', category: 'data' }], version: '0.9.6a' });
		fs.writeFileSync(path.join(root, MANIFEST_FILENAME), serialiseManifest(shipped));

		var d = describeInstall(root);
		assert.strictEqual(d.installed.version, '0.9.6a');
		assert.strictEqual(d.installed.files[0].path, 'config/x.json');
	});

	it('returns null for installed when there is no MANIFEST', function () {
		// Every install predating the release machinery. The plan reads null as
		// "cannot tell whether the sysop edited this" and keeps their file.
		var root = write(tmp(), { 'package.json': JSON.stringify({ version: '0.9.5a' }), 'config/x.json': '{}' });
		assert.strictEqual(describeInstall(root).installed, null);
	});

	it('treats a corrupt MANIFEST as no MANIFEST rather than throwing', function () {
		// A truncated or hand-edited file must not take the update tool down,
		// and it must not be half-believed either.
		var root = write(tmp(), {
			'package.json': JSON.stringify({ version: '0.9.6a' }),
			'config/x.json': '{}',
			'MANIFEST': '{ this is not json'
		});
		assert.strictEqual(describeInstall(root).installed, null);
	});
});
