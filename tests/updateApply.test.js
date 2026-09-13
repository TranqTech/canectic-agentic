// tests/updateApply.test.js: staging a release and landing it on a tree, on
// real files.
//
// applyPlan.test.js asserts the decisions. This asserts that carrying them out
// does what the decisions said, which is a different question: a correct plan
// executed by a loop that copies in the wrong order, loses an executable bit,
// or forgets the backup is still an install somebody has to restore by hand.
//
// The three things worth proving here cannot be proved without a filesystem:
//
//   Reconstruction. A delta plus its base has to produce the published tree
//   exactly, deletions included, verified against the manifest.
//   Rollback. Everything displaced comes back, everything created goes away,
//   and the install ends up claiming the version it started at.
//   Refusal. A corrupted artifact is never unpacked.
//
// Builds its own tiny releases with tar rather than using a real artifact, so
// the test is self-contained and fast.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildManifest, parseManifest, serialiseManifest, hashFile, MANIFEST_FILENAME } from '../src/release/manifest.js';
import { buildApplyPlan } from '../src/release/applyPlan.js';
import { stageRelease, dirSource, verifyChecksum, pruneToManifest } from '../src/maintenance/updateStaging.js';
import { applyPlan, rollback, verifyApplied, pruneEmptyDirs } from '../src/maintenance/updateApply.js';
import { buildMetadata, serialiseMetadata, artifactName, metadataName } from '../src/release/metadata.js';

var tmpRoots = [];

function tmpDir(tag) {
	var d = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-apply-' + tag + '-'));
	tmpRoots.push(d);
	return d;
}

function writeTree(root, files) {
	for (var p of Object.keys(files)) {
		var abs = path.join(root, p);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, files[p]);
	}
}

// Build a release artifact from a file map, the same shape scripts/release.mjs
// produces: a canectic-<version>/ wrapper with a MANIFEST at its root.
function buildRelease(publishDir, version, files, opts) {
	var o = opts || {};
	var staging = tmpDir('build');
	var treeName = 'canectic-' + version;
	var treeRoot = path.join(staging, treeName);
	writeTree(treeRoot, files);

	var entries = Object.keys(files).sort().map(function (p) {
		return { path: p, category: o.categories && o.categories[p] ? o.categories[p] : 'code' };
	});
	var manifest = buildManifest({ root: treeRoot, files: entries, version: version, generated: '2026-09-20T00:00:00.000Z' });

	// A delta ships only the named members; the manifest still describes the
	// whole tree, which is what makes deletions expressible.
	if (o.deltaMembers) {
		for (var p2 of Object.keys(files)) {
			if (o.deltaMembers.indexOf(p2) === -1) fs.unlinkSync(path.join(treeRoot, p2));
		}
	}
	fs.writeFileSync(path.join(treeRoot, MANIFEST_FILENAME), serialiseManifest(manifest));

	fs.mkdirSync(publishDir, { recursive: true });
	var artifact = path.join(publishDir, artifactName(version, { delta: !!o.deltaMembers }));
	execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner',
		'-czf', artifact, '-C', staging, treeName]);

	var meta = buildMetadata({
		version: version, released: '2026-09-20', sha256: hashFile(artifact),
		migrations: [], node_min: '22.0.0'
	});
	fs.writeFileSync(path.join(publishDir, metadataName(version)), serialiseMetadata(meta));
	return { manifest: manifest, artifact: artifact, meta: meta };
}

after(function () {
	for (var d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

describe('stageRelease', function () {

	it('stages a full release and verifies it against its manifest', async function () {
		var pub = tmpDir('pub');
		buildRelease(pub, '0.9.7a', { 'src/a.js': 'alpha', 'bin/run.js': 'run' });

		var staged = await stageRelease({ source: dirSource(pub), version: '0.9.7a', stagingDir: tmpDir('stage') });
		assert.strictEqual(staged.verification.ok, true);
		assert.strictEqual(staged.verification.checked, 2);
		assert.strictEqual(fs.readFileSync(path.join(staged.treeRoot, 'src/a.js'), 'utf8'), 'alpha');
		assert.strictEqual(staged.reconstructed, false);
	});

	it('reconstructs a delta against its base, deletions included', async function () {
		var pub = tmpDir('pub');
		buildRelease(pub, '0.9.7a', { 'src/a.js': 'alpha', 'src/gone.js': 'doomed', 'src/same.js': 'steady' });
		// The delta carries only what differs; gone.js is absent from the new
		// manifest, which is the only statement that it was deleted.
		buildRelease(pub, '0.9.7a.20260913', { 'src/a.js': 'ALPHA2', 'src/same.js': 'steady', 'src/new.js': 'fresh' },
			{ deltaMembers: ['src/a.js', 'src/new.js'] });

		var staged = await stageRelease({ source: dirSource(pub), version: '0.9.7a.20260913', stagingDir: tmpDir('stage') });
		assert.strictEqual(staged.reconstructed, true);
		assert.strictEqual(staged.verification.ok, true);
		assert.strictEqual(fs.readFileSync(path.join(staged.treeRoot, 'src/a.js'), 'utf8'), 'ALPHA2');
		assert.strictEqual(fs.readFileSync(path.join(staged.treeRoot, 'src/new.js'), 'utf8'), 'fresh');
		// Came from the base, carried by no delta.
		assert.strictEqual(fs.readFileSync(path.join(staged.treeRoot, 'src/same.js'), 'utf8'), 'steady');
		assert.strictEqual(fs.existsSync(path.join(staged.treeRoot, 'src/gone.js')), false);
		assert.deepStrictEqual(staged.pruned, ['src/gone.js']);
	});

	it('restores a file a later build reverted, which patching in place cannot', async function () {
		// The case the design calls out: changed in an earlier development
		// build and put back in a later one. The local copy holds the earlier
		// change, the target manifest wants the base content, and the delta
		// carries no body for it because it does not differ from the base.
		// Reconstructing from the base gets it right by construction.
		var pub = tmpDir('pub');
		buildRelease(pub, '0.9.7a', { 'src/a.js': 'original' });
		buildRelease(pub, '0.9.7a.20260920', { 'src/a.js': 'original' }, { deltaMembers: [] });

		var staged = await stageRelease({ source: dirSource(pub), version: '0.9.7a.20260920', stagingDir: tmpDir('stage') });
		assert.strictEqual(fs.readFileSync(path.join(staged.treeRoot, 'src/a.js'), 'utf8'), 'original');
		assert.strictEqual(staged.verification.ok, true);
	});

	it('refuses a corrupted artifact and unpacks nothing', async function () {
		var pub = tmpDir('pub');
		var built = buildRelease(pub, '0.9.7a', { 'src/a.js': 'alpha' });
		fs.appendFileSync(built.artifact, Buffer.from([0x00, 0x01]));

		var stagingDir = tmpDir('stage');
		await stageRelease({ source: dirSource(pub), version: '0.9.7a', stagingDir: stagingDir }).then(function () {
			assert.fail('should have refused');
		}, function (e) {
			assert.ok(/does not match its published checksum/.test(e.message), e.message);
			assert.ok(/not unpacked/.test(e.message));
		});
		assert.strictEqual(fs.existsSync(path.join(stagingDir, 'tree')), false);
	});

	it('refuses a release whose metadata names a version it is not', async function () {
		var pub = tmpDir('pub');
		buildRelease(pub, '0.9.7a', { 'src/a.js': 'alpha' });
		var metaFile = path.join(pub, metadataName('0.9.7a'));
		var meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
		meta.channel = 'development';
		fs.writeFileSync(metaFile, JSON.stringify(meta));

		await stageRelease({ source: dirSource(pub), version: '0.9.7a', stagingDir: tmpDir('stage') }).then(function () {
			assert.fail('should have refused');
		}, function (e) {
			assert.ok(/invalid/.test(e.message), e.message);
		});
	});
});

describe('verifyChecksum', function () {

	it('names both hashes, so a mismatch can be chased', function () {
		var dir = tmpDir('sum');
		var f = path.join(dir, 'x');
		fs.writeFileSync(f, 'content');
		assert.strictEqual(verifyChecksum(f, hashFile(f)), hashFile(f));
		assert.throws(function () { verifyChecksum(f, 'f'.repeat(64)); }, /expected f{64}, got/);
	});
});

describe('pruneToManifest', function () {

	it('leaves MANIFEST alone, since it cannot be in its own file list', function () {
		var dir = tmpDir('prune');
		writeTree(dir, { 'a.js': 'a', 'stray.js': 's' });
		var m = buildManifest({ root: dir, files: [{ path: 'a.js', category: 'code' }], version: '1.0.0' });
		fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), serialiseManifest(m));

		var removed = pruneToManifest(dir, m);
		assert.deepStrictEqual(removed, ['stray.js']);
		assert.strictEqual(fs.existsSync(path.join(dir, MANIFEST_FILENAME)), true);
	});
});

describe('applyPlan', function () {

	function scenario() {
		var pub = tmpDir('pub');
		var categories = {
			'src/a.js': 'code',
			'src/new.js': 'code',
			'public/css/custom.css': 'overlay-seed',
			'config/theme.json': 'data',
			'txtfiles/art.ans': 'art'
		};
		var built = buildRelease(pub, '0.9.7a', {
			'src/a.js': 'NEW CODE',
			'src/new.js': 'brand new',
			'public/css/custom.css': '/* shipped default */',
			'config/theme.json': '{"shipped":2}',
			'txtfiles/art.ans': 'shipped art'
		}, { categories: categories });

		var install = tmpDir('install');
		writeTree(install, {
			'src/a.js': 'OLD CODE',
			'src/stray.js': 'left behind',
			'public/css/custom.css': '/* MY CSS */',
			'public/images/mine.png': 'MY IMAGE',
			'config/theme.json': '{"shipped":1}',
			'txtfiles/art.ans': 'MY ART'
		});

		// What the previous release shipped: theme.json untouched by the sysop.
		var installed = buildManifest({
			root: install,
			files: [{ path: 'config/theme.json', category: 'data' }],
			version: '0.9.6a'
		});

		var local = buildManifest({
			root: install,
			files: Object.keys({
				'src/a.js': 1, 'src/stray.js': 1, 'public/css/custom.css': 1,
				'public/images/mine.png': 1, 'config/theme.json': 1, 'txtfiles/art.ans': 1
			}).sort().map(function (p) {
				return { path: p, category: p === 'src/a.js' || p === 'src/stray.js' ? 'code'
					: p === 'public/css/custom.css' ? 'overlay-seed'
					: p.indexOf('public/') === 0 ? 'overlay'
					: p.indexOf('config/') === 0 ? 'data' : 'art' };
			}),
			version: '0.9.6a'
		});

		return { pub: pub, install: install, built: built, local: local, installed: installed };
	}

	it('writes, removes, and leaves the sysop\'s files exactly as they were', async function () {
		var s = scenario();
		var staged = await stageRelease({ source: dirSource(s.pub), version: '0.9.7a', stagingDir: tmpDir('stage') });
		var plan = buildApplyPlan({ target: staged.manifest, local: s.local, installed: s.installed });

		var result = applyPlan({
			plan: plan, stagedRoot: staged.treeRoot, targetRoot: s.install, backupDir: tmpDir('backup')
		});

		var read = function (p) { return fs.readFileSync(path.join(s.install, p), 'utf8'); };
		assert.strictEqual(read('src/a.js'), 'NEW CODE', 'code is ours to replace');
		assert.strictEqual(read('src/new.js'), 'brand new', 'a new module lands');
		assert.strictEqual(fs.existsSync(path.join(s.install, 'src/stray.js')), false, 'a stray in src/ goes');
		assert.strictEqual(read('public/css/custom.css'), '/* MY CSS */', 'a seeded file is never rewritten');
		assert.strictEqual(read('public/images/mine.png'), 'MY IMAGE', 'a target-only overlay file survives');
		assert.strictEqual(read('txtfiles/art.ans'), 'MY ART', 'art is never replaced');
		assert.strictEqual(read('config/theme.json'), '{"shipped":2}', 'an untouched data file takes the update');
		assert.strictEqual(result.manifestWritten, true);
	});

	it('leaves the install claiming the version it now is', async function () {
		// Without this the next update compares data files against the wrong
		// release's hashes and invents conflicts for ever after.
		var s = scenario();
		var staged = await stageRelease({ source: dirSource(s.pub), version: '0.9.7a', stagingDir: tmpDir('stage') });
		var plan = buildApplyPlan({ target: staged.manifest, local: s.local, installed: s.installed });
		applyPlan({ plan: plan, stagedRoot: staged.treeRoot, targetRoot: s.install, backupDir: tmpDir('backup') });

		var written = parseManifest(fs.readFileSync(path.join(s.install, MANIFEST_FILENAME), 'utf8'));
		assert.strictEqual(written.version, '0.9.7a');
	});

	it('verifies what it wrote, and only what it wrote', async function () {
		// A conflict was kept on purpose, so a whole-tree verify would report
		// the intended outcome as a failure.
		var s = scenario();
		var staged = await stageRelease({ source: dirSource(s.pub), version: '0.9.7a', stagingDir: tmpDir('stage') });
		var plan = buildApplyPlan({ target: staged.manifest, local: s.local, installed: s.installed });
		applyPlan({ plan: plan, stagedRoot: staged.treeRoot, targetRoot: s.install, backupDir: tmpDir('backup') });
		assert.strictEqual(verifyApplied({ plan: plan, targetRoot: s.install }).ok, true);
	});

	it('writes nothing in a dry run', async function () {
		var s = scenario();
		var staged = await stageRelease({ source: dirSource(s.pub), version: '0.9.7a', stagingDir: tmpDir('stage') });
		var plan = buildApplyPlan({ target: staged.manifest, local: s.local, installed: s.installed });

		var result = applyPlan({ plan: plan, stagedRoot: staged.treeRoot, targetRoot: s.install, dryRun: true });
		assert.strictEqual(result.applied, false);
		assert.ok(result.written.length > 0, 'it still reports what it would do');
		assert.strictEqual(fs.readFileSync(path.join(s.install, 'src/a.js'), 'utf8'), 'OLD CODE');
		assert.strictEqual(fs.existsSync(path.join(s.install, 'src/stray.js')), true);
	});

	it('refuses to write without somewhere to put the displaced files', function () {
		assert.throws(function () {
			applyPlan({ plan: { files: [] }, stagedRoot: '/tmp', targetRoot: '/tmp' });
		}, /without a backup directory/);
	});

	it('preserves the executable bit on a script', async function () {
		var pub = tmpDir('pub');
		var staging = tmpDir('build2');
		var treeRoot = path.join(staging, 'canectic-0.9.7a');
		writeTree(treeRoot, { 'setup/run.sh': '#!/bin/sh\n' });
		fs.chmodSync(path.join(treeRoot, 'setup/run.sh'), 0o755);
		var manifest = buildManifest({ root: treeRoot, files: [{ path: 'setup/run.sh', category: 'code' }], version: '0.9.7a' });
		fs.writeFileSync(path.join(treeRoot, MANIFEST_FILENAME), serialiseManifest(manifest));
		var artifact = path.join(pub, artifactName('0.9.7a'));
		fs.mkdirSync(pub, { recursive: true });
		execFileSync('tar', ['-czf', artifact, '-C', staging, 'canectic-0.9.7a']);
		fs.writeFileSync(path.join(pub, metadataName('0.9.7a')), serialiseMetadata(buildMetadata({
			version: '0.9.7a', released: '2026-09-20', sha256: hashFile(artifact), node_min: '22.0.0'
		})));

		var install = tmpDir('install2');
		var staged = await stageRelease({ source: dirSource(pub), version: '0.9.7a', stagingDir: tmpDir('stage2') });
		var plan = buildApplyPlan({ target: staged.manifest, local: null });
		applyPlan({ plan: plan, stagedRoot: staged.treeRoot, targetRoot: install, backupDir: tmpDir('backup2') });

		var mode = fs.statSync(path.join(install, 'setup/run.sh')).mode & 0o111;
		assert.notStrictEqual(mode, 0, 'a shipped script that is not executable will not run');
	});
});

describe('rollback', function () {

	it('puts the installation back exactly as it was', async function () {
		var pub = tmpDir('pub');
		buildRelease(pub, '0.9.7a', { 'src/a.js': 'NEW', 'src/new.js': 'added' });

		var install = tmpDir('install');
		writeTree(install, { 'src/a.js': 'OLD', 'src/stray.js': 'doomed' });
		var local = buildManifest({
			root: install,
			files: [{ path: 'src/a.js', category: 'code' }, { path: 'src/stray.js', category: 'code' }],
			version: '0.9.6a'
		});

		var staged = await stageRelease({ source: dirSource(pub), version: '0.9.7a', stagingDir: tmpDir('stage') });
		var plan = buildApplyPlan({ target: staged.manifest, local: local });
		var backupDir = tmpDir('backup');
		var result = applyPlan({ plan: plan, stagedRoot: staged.treeRoot, targetRoot: install, backupDir: backupDir });

		assert.strictEqual(fs.readFileSync(path.join(install, 'src/a.js'), 'utf8'), 'NEW');
		assert.strictEqual(fs.existsSync(path.join(install, 'src/stray.js')), false);

		rollback({ backupDir: backupDir, targetRoot: install, result: result });

		assert.strictEqual(fs.readFileSync(path.join(install, 'src/a.js'), 'utf8'), 'OLD', 'an overwritten file comes back');
		assert.strictEqual(fs.readFileSync(path.join(install, 'src/stray.js'), 'utf8'), 'doomed', 'a removed file comes back');
		assert.strictEqual(fs.existsSync(path.join(install, 'src/new.js')), false, 'a created file goes away');
	});

	it('restores the MANIFEST, so a rolled back install does not claim the release it backed out of', async function () {
		var pub = tmpDir('pub');
		buildRelease(pub, '0.9.7a', { 'src/a.js': 'NEW' });

		var install = tmpDir('install');
		writeTree(install, { 'src/a.js': 'OLD' });
		var old = buildManifest({ root: install, files: [{ path: 'src/a.js', category: 'code' }], version: '0.9.6a' });
		fs.writeFileSync(path.join(install, MANIFEST_FILENAME), serialiseManifest(old));

		var staged = await stageRelease({ source: dirSource(pub), version: '0.9.7a', stagingDir: tmpDir('stage') });
		var plan = buildApplyPlan({ target: staged.manifest, local: old, installed: old });
		var backupDir = tmpDir('backup');
		var result = applyPlan({ plan: plan, stagedRoot: staged.treeRoot, targetRoot: install, backupDir: backupDir });
		assert.strictEqual(parseManifest(fs.readFileSync(path.join(install, MANIFEST_FILENAME), 'utf8')).version, '0.9.7a');

		rollback({ backupDir: backupDir, targetRoot: install, result: result });
		assert.strictEqual(parseManifest(fs.readFileSync(path.join(install, MANIFEST_FILENAME), 'utf8')).version, '0.9.6a');
	});
});

describe('pruneEmptyDirs', function () {

	it('clears the shell of a directory a release dropped', function () {
		var root = tmpDir('dirs');
		writeTree(root, { 'src/gone/a.js': 'x', 'src/kept/b.js': 'y' });
		fs.unlinkSync(path.join(root, 'src/gone/a.js'));

		var removed = pruneEmptyDirs(root, ['src/gone/a.js']);
		assert.ok(removed.indexOf('src/gone') !== -1);
		assert.strictEqual(fs.existsSync(path.join(root, 'src/kept')), true);
		assert.strictEqual(fs.existsSync(path.join(root, 'src')), true);
	});
});
