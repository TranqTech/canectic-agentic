// tests/releaseManifest.test.js: content hashes for a release, and the diff
// between two of them.
//
// Three things rest on the manifest, and each has a specific way of going
// wrong quietly:
//
//   Deletions. A delta expressed only as changed files cannot say "this file is
//   gone", which is why update.sh reaches for rm -rf on code directories today.
//   The manifest describes the COMPLETE target tree, so a deletion is "present
//   locally, absent from the manifest". Getting the argument order of
//   diffManifests backwards turns a deletion into an addition whose body no
//   delta carries, and the updater then leaves a stale file in place for ever.
//
//   Sysop edits. update.sh compares mtimes, which says when a file was written
//   and nothing about whether its contents differ from what shipped.
//
//   The end state. After reconstructing base plus delta the manifest says
//   whether the result is the tree that was published.
//
// Pure apart from a temp directory: no database, no services.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	hashBuffer, hashFile, buildManifest, serialiseManifest, parseManifest,
	manifestIndex, diffManifests, deltaFiles, verifyTree, pathsToRemove, manifestIsFor, totalBytes
} from '../src/release/manifest.js';

function tmpTree(files) {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-manifest-test-'));
	for (var p of Object.keys(files)) {
		var abs = path.join(dir, p);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, files[p]);
	}
	return dir;
}

function manifestOf(tree, spec, version) {
	return buildManifest({
		root: tree,
		files: Object.keys(spec).sort().map(function (p) { return { path: p, category: 'code' }; }),
		version: version || '0.9.6a',
		generated: '2026-09-20T00:00:00.000Z'
	});
}

describe('hashing', function () {

	it('hashes a buffer as sha256 hex', function () {
		assert.strictEqual(
			hashBuffer(Buffer.from('canectic')),
			hashBuffer(Buffer.from('canectic'))
		);
		assert.ok(/^[0-9a-f]{64}$/.test(hashBuffer(Buffer.from(''))));
		assert.notStrictEqual(hashBuffer(Buffer.from('a')), hashBuffer(Buffer.from('b')));
	});

	it('hashes a file the same as its bytes', function () {
		var dir = tmpTree({ 'a.txt': 'hello' });
		assert.strictEqual(hashFile(path.join(dir, 'a.txt')), hashBuffer(Buffer.from('hello')));
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe('buildManifest', function () {

	var spec = { 'src/a.js': 'alpha', 'src/b.js': 'beta', 'bin/run.sh': '#!/bin/sh\n' };
	var tree, manifest;

	before(function () {
		tree = tmpTree(spec);
		fs.chmodSync(path.join(tree, 'bin/run.sh'), 0o755);
		manifest = manifestOf(tree, spec);
	});

	after(function () { fs.rmSync(tree, { recursive: true, force: true }); });

	it('records a hash, a size and a category per file', function () {
		var idx = manifestIndex(manifest);
		assert.strictEqual(idx.get('src/a.js').sha256, hashBuffer(Buffer.from('alpha')));
		assert.strictEqual(idx.get('src/a.js').size, 5);
		assert.strictEqual(idx.get('src/a.js').category, 'code');
	});

	it('records the executable bit, which a script needs to still be one', function () {
		var idx = manifestIndex(manifest);
		assert.strictEqual(idx.get('bin/run.sh').mode, '755');
		assert.strictEqual(idx.get('src/a.js').mode, '644');
	});

	it('sorts by path, so the same tree serialises identically twice', function () {
		var again = manifestOf(tree, spec);
		assert.strictEqual(serialiseManifest(manifest), serialiseManifest(again));
		assert.deepStrictEqual(manifest.files.map(function (f) { return f.path; }),
			['bin/run.sh', 'src/a.js', 'src/b.js']);
	});

	it('totals the bytes it describes', function () {
		assert.strictEqual(totalBytes(manifest), 5 + 4 + '#!/bin/sh\n'.length);
		assert.strictEqual(totalBytes(null), 0);
	});
});

describe('parseManifest', function () {

	it('round trips', function () {
		var dir = tmpTree({ 'a.js': 'x' });
		var m = manifestOf(dir, { 'a.js': 'x' });
		assert.deepStrictEqual(parseManifest(serialiseManifest(m)), m);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('refuses a manifest with no files, which would read as "delete everything"', function () {
		// The updater removes what is present locally and absent from the
		// manifest. An empty file list is therefore an instruction to delete the
		// install, so it must not parse.
		assert.throws(function () { parseManifest('{"files":[]}'); }, /lists no files/);
		assert.throws(function () { parseManifest('{}'); }, /no files array/);
	});

	it('refuses entries with no usable hash', function () {
		assert.throws(function () {
			parseManifest('{"files":[{"path":"a.js"}]}');
		}, /no sha256/);
		assert.throws(function () {
			parseManifest('{"files":[{"path":"a.js","sha256":"nope"}]}');
		}, /no sha256/);
		assert.throws(function () {
			parseManifest('{"files":[{"sha256":"' + 'a'.repeat(64) + '"}]}');
		}, /no path/);
	});

	it('refuses text that is not JSON', function () {
		assert.throws(function () { parseManifest('not json'); }, /not valid JSON/);
	});
});

describe('diffManifests', function () {

	var base, target;

	before(function () {
		var baseTree = tmpTree({ 'keep.js': 'same', 'edit.js': 'before', 'gone.js': 'bye' });
		var targetTree = tmpTree({ 'keep.js': 'same', 'edit.js': 'after', 'new.js': 'hi' });
		base = manifestOf(baseTree, { 'keep.js': 1, 'edit.js': 1, 'gone.js': 1 }, '0.9.5a');
		target = manifestOf(targetTree, { 'keep.js': 1, 'edit.js': 1, 'new.js': 1 }, '0.9.5a.20260913');
		fs.rmSync(baseTree, { recursive: true, force: true });
		fs.rmSync(targetTree, { recursive: true, force: true });
	});

	it('names what the updater must add, rewrite and delete', function () {
		var d = diffManifests(base, target);
		assert.deepStrictEqual(d.added, ['new.js']);
		assert.deepStrictEqual(d.changed, ['edit.js']);
		assert.deepStrictEqual(d.removed, ['gone.js']);
		assert.deepStrictEqual(d.unchanged, ['keep.js']);
	});

	it('is directional, because reversing it turns a deletion into a phantom add', function () {
		// The failure this guards: with the arguments the wrong way round the
		// updater would be told to create gone.js, whose body no delta carries,
		// and to delete new.js, which the release ships.
		var reversed = diffManifests(target, base);
		assert.deepStrictEqual(reversed.added, ['gone.js']);
		assert.deepStrictEqual(reversed.removed, ['new.js']);
	});

	it('treats a mode change as a change even when the bytes match', function () {
		var m1 = JSON.parse(JSON.stringify(base));
		var m2 = JSON.parse(JSON.stringify(base));
		m2.files.find(function (f) { return f.path === 'keep.js'; }).mode = '755';
		assert.deepStrictEqual(diffManifests(m1, m2).changed, ['keep.js']);
	});

	it('reports everything as added against nothing', function () {
		var d = diffManifests({ files: [] }, target);
		assert.deepStrictEqual(d.added, ['edit.js', 'keep.js', 'new.js']);
		assert.deepStrictEqual(d.removed, []);
	});
});

describe('deltaFiles', function () {

	it('carries added and changed bodies, and no deletions', function () {
		var baseTree = tmpTree({ 'keep.js': 'same', 'edit.js': 'before', 'gone.js': 'bye' });
		var targetTree = tmpTree({ 'keep.js': 'same', 'edit.js': 'after', 'new.js': 'hi' });
		var base = manifestOf(baseTree, { 'keep.js': 1, 'edit.js': 1, 'gone.js': 1 });
		var target = manifestOf(targetTree, { 'keep.js': 1, 'edit.js': 1, 'new.js': 1 });

		// gone.js is deliberately absent: a delta that also listed deletions
		// would state the same fact the manifest already states, and the two
		// would eventually disagree.
		assert.deepStrictEqual(deltaFiles(base, target), ['edit.js', 'new.js']);
		assert.deepStrictEqual(pathsToRemove(base, target), ['gone.js']);

		fs.rmSync(baseTree, { recursive: true, force: true });
		fs.rmSync(targetTree, { recursive: true, force: true });
	});

	it('is empty when nothing differs, which means there is no build to cut', function () {
		var tree = tmpTree({ 'a.js': 'x' });
		var m = manifestOf(tree, { 'a.js': 1 });
		assert.deepStrictEqual(deltaFiles(m, m), []);
		fs.rmSync(tree, { recursive: true, force: true });
	});
});

describe('manifestIsFor', function () {

	it('accepts the manifest of the version it names', function () {
		assert.strictEqual(manifestIsFor({ version: '0.9.6a' }, '0.9.6a'), true);
		assert.strictEqual(manifestIsFor({ version: 'v0.9.6a' }, '0.9.6a'), true);
	});

	it('rejects the manifest of a different tree', function () {
		// The only check that can catch --base-manifest aimed at the wrong
		// place. The version and the metadata `base` field are both derived
		// from the version string, so they agree with each other whichever
		// manifest was loaded, and the result is a published delta that
		// reconstructs into a tree no release corresponds to.
		assert.strictEqual(manifestIsFor({ version: '0.9.5a' }, '0.9.6a'), false);
		assert.strictEqual(manifestIsFor({ version: '0.9.6a.20260913' }, '0.9.6a'), false);
	});

	it('fails closed on a manifest that names no tree', function () {
		assert.strictEqual(manifestIsFor({}, '0.9.6a'), false);
		assert.strictEqual(manifestIsFor({ version: null }, '0.9.6a'), false);
		assert.strictEqual(manifestIsFor(null, '0.9.6a'), false);
		assert.strictEqual(manifestIsFor({ version: '0.9.6a' }, null), false);
	});
});

describe('verifyTree', function () {

	it('passes on the tree it was built from', function () {
		var tree = tmpTree({ 'a.js': 'x', 'b/c.js': 'y' });
		var m = manifestOf(tree, { 'a.js': 1, 'b/c.js': 1 });
		var r = verifyTree(tree, m);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.checked, 2);
		fs.rmSync(tree, { recursive: true, force: true });
	});

	it('names a file whose contents drifted', function () {
		var tree = tmpTree({ 'a.js': 'x' });
		var m = manifestOf(tree, { 'a.js': 1 });
		fs.writeFileSync(path.join(tree, 'a.js'), 'tampered');
		var r = verifyTree(tree, m);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.mismatched.length, 1);
		assert.strictEqual(r.mismatched[0].path, 'a.js');
		fs.rmSync(tree, { recursive: true, force: true });
	});

	it('names a file the reconstruction failed to produce', function () {
		var tree = tmpTree({ 'a.js': 'x', 'b.js': 'y' });
		var m = manifestOf(tree, { 'a.js': 1, 'b.js': 1 });
		fs.unlinkSync(path.join(tree, 'b.js'));
		var r = verifyTree(tree, m);
		assert.strictEqual(r.ok, false);
		assert.deepStrictEqual(r.missing, ['b.js']);
		fs.rmSync(tree, { recursive: true, force: true });
	});

	it('ignores files the manifest does not mention', function () {
		// An install holds plenty a release manifest never names: logs, the ftn
		// spool, sysop art. Calling those a verification failure would fail
		// every real system.
		var tree = tmpTree({ 'a.js': 'x' });
		var m = manifestOf(tree, { 'a.js': 1 });
		fs.writeFileSync(path.join(tree, 'sysop-notes.txt'), 'mine');
		assert.strictEqual(verifyTree(tree, m).ok, true);
		fs.rmSync(tree, { recursive: true, force: true });
	});
});
