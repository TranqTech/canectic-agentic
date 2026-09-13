// tests/applyPlan.test.js: what landing a release on an install will do to it.
//
// This is the module that can destroy somebody's work, so the tests are written
// around the destruction rather than around the happy path. Every one of these
// has a real precedent: setup/install.sh's update mode did a full rm -rf of
// each code directory with public/ still in the list, which deleted every
// sysop-added door icon, every piece of custom branding, and public/css/custom.css,
// the file that exists to hold their own CSS. None of it was recoverable.
//
// The rules are claims about whose file it is. Getting one wrong in the
// permissive direction overwrites or deletes something nobody can get back;
// getting one wrong in the conservative direction leaves a stale file, which is
// visible and fixable. So every ambiguous case has to fall to conservative, and
// these tests assert that it does.
//
// Pure: no filesystem, no network.

import assert from 'assert';
import {
	decideFile, buildApplyPlan, countByAction, pathsFor, filesToWrite, filesToRemove, warningsFor,
	ACTION_CREATE, ACTION_OVERWRITE, ACTION_UNCHANGED, ACTION_KEEP, ACTION_CONFLICT, ACTION_REMOVE
} from '../src/release/applyPlan.js';
import {
	CATEGORY_CODE, CATEGORY_OVERLAY, CATEGORY_OVERLAY_SEED, CATEGORY_DATA, CATEGORY_ART
} from '../src/release/shippedTree.js';

var A = 'a'.repeat(64);   // what the release ships
var B = 'b'.repeat(64);   // what is on disk
var C = 'c'.repeat(64);   // what the previous release shipped

function entry(path, category, sha, size) {
	return { path: path, category: category, sha256: sha || A, size: size || 10, mode: '644' };
}

function manifest(entries, version) {
	return { version: version || '0.9.7a', files: entries };
}

describe('decideFile', function () {

	it('creates a file that is not there', function () {
		assert.strictEqual(decideFile(entry('src/new.js', CATEGORY_CODE), null).action, ACTION_CREATE);
	});

	it('does nothing to a file that is already current', function () {
		var have = { path: 'src/a.js', sha256: A };
		assert.strictEqual(decideFile(entry('src/a.js', CATEGORY_CODE, A), have).action, ACTION_UNCHANGED);
	});

	it('overwrites our own code and overlay files', function () {
		var have = { sha256: B };
		assert.strictEqual(decideFile(entry('src/a.js', CATEGORY_CODE), have).action, ACTION_OVERWRITE);
		assert.strictEqual(decideFile(entry('public/js/a.js', CATEGORY_OVERLAY), have).action, ACTION_OVERWRITE);
	});

	it('never rewrites a seeded file once it exists', function () {
		// public/css/custom.css is sysop-authored by design. Overwriting it
		// every update would wipe the customisation it exists to hold, which is
		// exactly what install.sh did.
		var d = decideFile(entry('public/css/custom.css', CATEGORY_OVERLAY_SEED), { sha256: B });
		assert.strictEqual(d.action, ACTION_KEEP);
	});

	it('seeds a file that is absent, even in the seed category', function () {
		assert.strictEqual(decideFile(entry('public/css/custom.css', CATEGORY_OVERLAY_SEED), null).action, ACTION_CREATE);
	});

	it('never replaces art that is already there', function () {
		// Art is the first thing a sysop replaces, and a release has no way to
		// tell their welcome screen from the shipped one.
		assert.strictEqual(decideFile(entry('txtfiles/ans/welcome/1.ans', CATEGORY_ART), { sha256: B }).action, ACTION_KEEP);
		assert.strictEqual(decideFile(entry('txtfiles/ans/new.ans', CATEGORY_ART), null).action, ACTION_CREATE);
	});

	describe('data files, which is what the manifest exists for', function () {

		it('takes the update when the file is still exactly what shipped', function () {
			// Nobody touched it, so there is nothing to lose. update.sh has to
			// stop and ask here, because an mtime says when a file was written
			// and nothing about whether it differs from what shipped.
			var d = decideFile(entry('config/themes/x.json', CATEGORY_DATA, A), { sha256: C }, { sha256: C });
			assert.strictEqual(d.action, ACTION_OVERWRITE);
		});

		it('keeps the sysop version when they edited it', function () {
			var d = decideFile(entry('config/themes/x.json', CATEGORY_DATA, A), { sha256: B }, { sha256: C });
			assert.strictEqual(d.action, ACTION_CONFLICT);
			assert.ok(/edited/.test(d.reason));
		});

		it('falls to conflict when there is no record of what shipped', function () {
			// Every install predating the release machinery is in this state.
			// Guessing the other way would overwrite edits nobody can recover.
			var d = decideFile(entry('config/themes/x.json', CATEGORY_DATA, A), { sha256: B }, null);
			assert.strictEqual(d.action, ACTION_CONFLICT);
			assert.ok(/no record/.test(d.reason));
		});

		it('still does nothing when the sysop edit happens to match the release', function () {
			var d = decideFile(entry('config/themes/x.json', CATEGORY_DATA, A), { sha256: A }, { sha256: C });
			assert.strictEqual(d.action, ACTION_UNCHANGED);
		});
	});

	it('refuses to write over a category it has no rule for', function () {
		// A release that adds a category this code predates must not have its
		// files written blindly. "I do not know what this is" reads as "leave
		// it alone", not as "overwrite it".
		var d = decideFile(entry('somewhere/x', 'future-category'), { sha256: B });
		assert.strictEqual(d.action, ACTION_CONFLICT);
		assert.ok(/unknown category/.test(d.reason));
	});
});

describe('buildApplyPlan', function () {

	it('covers every file in the release', function () {
		var plan = buildApplyPlan({
			target: manifest([entry('src/a.js', CATEGORY_CODE), entry('src/b.js', CATEGORY_CODE)]),
			local: manifest([])
		});
		assert.deepStrictEqual(pathsFor(plan, ACTION_CREATE), ['src/a.js', 'src/b.js']);
		assert.strictEqual(plan.version, '0.9.7a');
	});

	it('removes a stray left in a code directory', function () {
		// A module the new release does not know about is still importable, and
		// a half-removed subsystem is how a deleted file keeps running.
		var plan = buildApplyPlan({
			target: manifest([entry('src/a.js', CATEGORY_CODE, A)]),
			local: manifest([entry('src/a.js', CATEGORY_CODE, A), entry('src/gone.js', CATEGORY_CODE, B)])
		});
		assert.deepStrictEqual(pathsFor(plan, ACTION_REMOVE), ['src/gone.js']);
	});

	it('never removes a target-only file outside a code directory', function () {
		// The install.sh bug, as an assertion. A door icon, a custom image, a
		// sysop's own art and their edited config are all files we did not ship
		// and do not ship now, and none of them is ours to delete.
		var local = manifest([
			entry('public/images/doors/lord.png', CATEGORY_OVERLAY, B),
			entry('public/css/custom.css', CATEGORY_OVERLAY_SEED, B),
			entry('config/mine.json', CATEGORY_DATA, B),
			entry('txtfiles/ans/mine.ans', CATEGORY_ART, B)
		]);
		var plan = buildApplyPlan({ target: manifest([entry('src/a.js', CATEGORY_CODE)]), local: local });
		assert.deepStrictEqual(pathsFor(plan, ACTION_REMOVE), []);
	});

	it('counts what it is going to do', function () {
		var plan = buildApplyPlan({
			target: manifest([
				entry('src/new.js', CATEGORY_CODE, A),
				entry('src/same.js', CATEGORY_CODE, A),
				entry('src/changed.js', CATEGORY_CODE, A),
				entry('txtfiles/art.ans', CATEGORY_ART, A)
			]),
			local: manifest([
				entry('src/same.js', CATEGORY_CODE, A),
				entry('src/changed.js', CATEGORY_CODE, B),
				entry('txtfiles/art.ans', CATEGORY_ART, B),
				entry('src/stray.js', CATEGORY_CODE, B)
			])
		});
		assert.strictEqual(plan.counts[ACTION_CREATE], 1);
		assert.strictEqual(plan.counts[ACTION_UNCHANGED], 1);
		assert.strictEqual(plan.counts[ACTION_OVERWRITE], 1);
		assert.strictEqual(plan.counts[ACTION_KEEP], 1);
		assert.strictEqual(plan.counts[ACTION_REMOVE], 1);
	});

	it('is a no-op against the tree it describes', function () {
		// Applying the release you are already running must do nothing. A plan
		// that rewrote identical files would make every update look enormous
		// and would touch mtimes across the whole tree for no reason.
		var m = manifest([entry('src/a.js', CATEGORY_CODE, A), entry('config/x.json', CATEGORY_DATA, A)]);
		var plan = buildApplyPlan({ target: m, local: m, installed: m });
		assert.strictEqual(plan.counts[ACTION_UNCHANGED], 2);
		assert.deepStrictEqual(filesToWrite(plan), []);
		assert.deepStrictEqual(filesToRemove(plan), []);
	});

	it('reports only the bytes it will actually write', function () {
		var plan = buildApplyPlan({
			target: manifest([
				entry('src/new.js', CATEGORY_CODE, A, 100),
				entry('src/same.js', CATEGORY_CODE, A, 900)
			]),
			local: manifest([entry('src/same.js', CATEGORY_CODE, A, 900)])
		});
		assert.strictEqual(plan.bytesWritten, 100);
	});

	it('flags conflicts so they can be surfaced rather than logged', function () {
		var plan = buildApplyPlan({
			target: manifest([entry('config/x.json', CATEGORY_DATA, A)]),
			local: manifest([entry('config/x.json', CATEGORY_DATA, B)]),
			installed: manifest([entry('config/x.json', CATEGORY_DATA, C)])
		});
		assert.strictEqual(plan.hasConflicts, true);
		var w = warningsFor(plan);
		assert.strictEqual(w.length, 1);
		assert.strictEqual(w[0].path, 'config/x.json');
		assert.ok(/keeping your/.test(w[0].detail));
	});

	it('has no conflicts and no warnings on a clean upgrade', function () {
		var plan = buildApplyPlan({
			target: manifest([entry('src/a.js', CATEGORY_CODE, A)]),
			local: manifest([entry('src/a.js', CATEGORY_CODE, B)])
		});
		assert.strictEqual(plan.hasConflicts, false);
		assert.deepStrictEqual(warningsFor(plan), []);
	});

	it('handles a first install, where there is nothing to preserve', function () {
		var plan = buildApplyPlan({ target: manifest([entry('src/a.js', CATEGORY_CODE)]), local: null });
		assert.strictEqual(plan.counts[ACTION_CREATE], 1);
		assert.strictEqual(plan.counts[ACTION_REMOVE], 0);
	});

	it('sorts by path, so two runs against one tree read identically', function () {
		var plan = buildApplyPlan({
			target: manifest([entry('src/z.js', CATEGORY_CODE), entry('bin/a.js', CATEGORY_CODE)]),
			local: manifest([])
		});
		assert.deepStrictEqual(plan.files.map(function (f) { return f.path; }), ['bin/a.js', 'src/z.js']);
	});
});

describe('countByAction', function () {

	it('reports every action, including the ones with nothing in them', function () {
		// A missing key would render as undefined in the summary rather than 0.
		var counts = countByAction([]);
		for (var a of [ACTION_CREATE, ACTION_OVERWRITE, ACTION_UNCHANGED, ACTION_KEEP, ACTION_CONFLICT, ACTION_REMOVE]) {
			assert.strictEqual(counts[a], 0, a);
		}
	});
});

describe('filesToWrite and filesToRemove', function () {

	var plan = buildApplyPlan({
		target: manifest([
			entry('src/new.js', CATEGORY_CODE, A),
			entry('src/changed.js', CATEGORY_CODE, A),
			entry('src/same.js', CATEGORY_CODE, A),
			entry('txtfiles/art.ans', CATEGORY_ART, A)
		]),
		local: manifest([
			entry('src/changed.js', CATEGORY_CODE, B),
			entry('src/same.js', CATEGORY_CODE, A),
			entry('txtfiles/art.ans', CATEGORY_ART, B),
			entry('src/stray.js', CATEGORY_CODE, B)
		])
	});

	it('is what a backup has to cover, and nothing else', function () {
		assert.deepStrictEqual(filesToWrite(plan).map(function (f) { return f.path; }),
			['src/changed.js', 'src/new.js']);
		assert.deepStrictEqual(filesToRemove(plan).map(function (f) { return f.path; }),
			['src/stray.js']);
	});

	it('excludes the files being left alone, which must not be touched at all', function () {
		var touched = filesToWrite(plan).concat(filesToRemove(plan)).map(function (f) { return f.path; });
		assert.ok(touched.indexOf('txtfiles/art.ans') === -1);
		assert.ok(touched.indexOf('src/same.js') === -1);
	});
});
