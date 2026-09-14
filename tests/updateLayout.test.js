// tests/updateLayout.test.js: where the updater keeps its things.
//
// One definition, because the last time a directory layout was written down in
// two places the two drifted and an update deleted every sysop-added asset
// under public/.
//
// The property worth asserting is that the whole directory is INERT to the
// update machinery: never scanned as part of the installation, never removed by
// an apply plan, and untouched by setup/update.sh, which only handles
// directories it names. If any of that stopped being true, an update would
// delete its own staging tree, its own base cache, or the backup it would need
// to undo itself, and it would do so partway through.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	UPDATE_DIRNAME, updateRoot, stagingDir, stagingRoot, baseCacheDir, backupDir,
	dirSize, reclaimable, freeBytes
} from '../src/maintenance/updateLayout.js';
import { categoryForPath, scanInstalledFiles } from '../src/release/shippedTree.js';
import { buildApplyPlan, ACTION_REMOVE } from '../src/release/applyPlan.js';
import { buildManifest } from '../src/release/manifest.js';

var roots = [];
function tmp() {
	var d = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-layout-'));
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

describe('the layout', function () {

	it('keeps three lifetimes apart under one directory', function () {
		// staging goes per update, base survives updates, backup lasts until
		// reclaimed. Collapsing any two of those into one directory means
		// deleting one deletes another.
		var t = '/opt/canectic';
		assert.strictEqual(stagingDir(t, '0.9.8a'), t + '/' + UPDATE_DIRNAME + '/staging/0.9.8a');
		assert.strictEqual(baseCacheDir(t), t + '/' + UPDATE_DIRNAME + '/base');
		assert.strictEqual(backupDir(t, 'run-1'), t + '/' + UPDATE_DIRNAME + '/backup/run-1');
		assert.ok(stagingRoot(t) !== baseCacheDir(t));
	});

	it('lives inside the installation, which is what makes node_modules resolve', function () {
		// An updater staged outside the install cannot import anything with a
		// dependency, because node_modules resolves by walking up and a release
		// artifact ships none.
		assert.ok(updateRoot('/opt/canectic').indexOf('/opt/canectic/') === 0);
	});
});

describe('inertness to the update machinery', function () {

	it('is not a shipped category, so nothing in it is ever shipped or removed', function () {
		for (var p of [
			UPDATE_DIRNAME + '/staging/0.9.8a/tree/src/a.js',
			UPDATE_DIRNAME + '/base/canectic-0.9.6a.tar.gz',
			UPDATE_DIRNAME + '/backup/run-1/src/a.js'
		]) {
			assert.strictEqual(categoryForPath(p), null, p);
		}
	});

	it('is never walked when an installation is scanned', function () {
		// Scanning it would be slow, and would put a cached 7.6 MB tarball into
		// the manifest of the install.
		var root = write(tmp(), {
			'src/a.js': 'code',
			[UPDATE_DIRNAME + '/base/canectic-0.9.6a.tar.gz']: 'tarball',
			[UPDATE_DIRNAME + '/staging/0.9.8a/tree/src/a.js']: 'staged'
		});
		var paths = scanInstalledFiles(root).map(function (f) { return f.path; });
		assert.deepStrictEqual(paths, ['src/a.js']);
	});

	it('is never proposed for removal by an apply plan', function () {
		// The plan removes strays from code directories. If the update
		// directory read as one, an update would delete the staging tree it is
		// running from and the backup it would need to undo itself.
		var root = write(tmp(), {
			'src/a.js': 'code',
			[UPDATE_DIRNAME + '/backup/run-1/src/a.js']: 'backed up'
		});
		var local = buildManifest({ root: root, files: scanInstalledFiles(root), version: '0.9.6a' });
		var plan = buildApplyPlan({ target: { version: '0.9.8a', files: [] }, local: local });
		for (var f of plan.files) {
			assert.ok(f.path.indexOf(UPDATE_DIRNAME) === -1, 'plan touches ' + f.path + ' as ' + f.action);
		}
		assert.deepStrictEqual(plan.files.filter(function (f) { return f.action === ACTION_REMOVE; })
			.map(function (f) { return f.path; }), ['src/a.js']);
	});
});

describe('reclaimable', function () {

	it('says what can go and what it costs', function () {
		// "I need that disk back" should have an answer that is not guesswork.
		var root = tmp();
		write(root, {
			[UPDATE_DIRNAME + '/base/canectic-0.9.6a.tar.gz']: 'x'.repeat(500),
			[UPDATE_DIRNAME + '/staging/0.9.8a/tree/a.js']: 'y'.repeat(100),
			[UPDATE_DIRNAME + '/backup/run-1/a.js']: 'z'.repeat(50)
		});
		var r = reclaimable(root);
		assert.strictEqual(r.base.bytes, 500);
		assert.strictEqual(r.staging.bytes, 100);
		assert.strictEqual(r.backup.bytes, 50);
		assert.strictEqual(r.total, 650);
		for (var part of ['base', 'staging', 'backup']) {
			assert.ok(r[part].cost, part + ' must say what deleting it costs');
		}
	});

	it('reports nothing rather than throwing when there is no update directory', function () {
		var r = reclaimable(tmp());
		assert.strictEqual(r.total, 0);
		assert.strictEqual(r.base.bytes, 0);
	});
});

describe('dirSize and freeBytes', function () {

	it('adds up a tree', function () {
		var root = write(tmp(), { 'a': 'xx', 'b/c': 'yyy' });
		assert.strictEqual(dirSize(root), 5);
	});

	it('treats a missing directory as empty rather than throwing', function () {
		assert.strictEqual(dirSize('/nonexistent/path'), 0);
	});

	it('answers null rather than zero when free space cannot be read', function () {
		// A preflight treating an unreadable figure as no free space would
		// refuse every update on a filesystem whose statfs is unsupported,
		// which is the wrong way to fail an advisory check.
		assert.strictEqual(freeBytes('/nonexistent/path'), null);
		assert.ok(freeBytes(os.tmpdir()) > 0);
	});
});
