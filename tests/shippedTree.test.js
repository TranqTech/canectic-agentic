// tests/shippedTree.test.js: what ships in a release artifact, and how each
// file is allowed to be treated when it lands.
//
// The failure this guards against is not theoretical. The same categorisation
// was written twice, in setup/install.sh and setup/update.sh, and the two
// drifted: install.sh never received the overlay work, so its update mode
// deleted public/ including every sysop-added asset and public/css/custom.css.
// A sysop's custom CSS is not recoverable from a backup they did not take.
//
// So the assertions worth having are the ones about destructive categories.
// Calling a data directory "code" deletes a sysop's content; calling
// public/css/custom.css "overlay" instead of "overlay-seed" overwrites it every
// update. Both are silent.
//
// Pure: no database, no services.

import assert from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
	categoryForPath, isShipped, selectShippedFiles, listTrackedFiles,
	CATEGORY_CODE, CATEGORY_OVERLAY, CATEGORY_OVERLAY_SEED, CATEGORY_DATA, CATEGORY_ART,
	CATEGORIES
} from '../src/release/shippedTree.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('categoryForPath', function () {

	it('puts the code directories in the destructive category', function () {
		for (var p of ['bin/gateway.js', 'src/models/messages.js', 'db/schema/users.conf',
			'docs/reference/PROCESS_ARCHITECTURE.md', 'tests/version.test.js',
			'setup/update.sh', 'examples/env.example']) {
			assert.strictEqual(categoryForPath(p), CATEGORY_CODE, p);
		}
	});

	it('treats the root code files as code', function () {
		assert.strictEqual(categoryForPath('package.json'), CATEGORY_CODE);
		assert.strictEqual(categoryForPath('package-lock.json'), CATEGORY_CODE);
		assert.strictEqual(categoryForPath('ecosystem.config.cjs'), CATEGORY_CODE);
		assert.strictEqual(categoryForPath('.mocharc.yml'), CATEGORY_CODE);
		assert.strictEqual(categoryForPath('README.md'), CATEGORY_CODE);
		assert.strictEqual(categoryForPath('LICENSE'), CATEGORY_CODE);
	});

	it('overlays public/ so sysop-added assets survive', function () {
		assert.strictEqual(categoryForPath('public/js/messageAreas.js'), CATEGORY_OVERLAY);
		assert.strictEqual(categoryForPath('public/css/styles.css'), CATEGORY_OVERLAY);
		assert.notStrictEqual(categoryForPath('public/js/messageAreas.js'), CATEGORY_CODE);
	});

	it('seeds public/css/custom.css once and never overwrites it', function () {
		// The nested rule has to beat the directory rule, or every update wipes
		// the file that exists to hold the sysop's own CSS.
		assert.strictEqual(categoryForPath('public/css/custom.css'), CATEGORY_OVERLAY_SEED);
	});

	it('merges the data directories rather than overwriting them', function () {
		assert.strictEqual(categoryForPath('config/themes/canectic.json'), CATEGORY_DATA);
		assert.strictEqual(categoryForPath('xtrn/protocols/sexyz'), CATEGORY_DATA);
	});

	it('treats art as art, since it is the first thing a sysop replaces', function () {
		assert.strictEqual(categoryForPath('txtfiles/ans/welcome/1.ans'), CATEGORY_ART);
	});

	it('excludes maintainer tooling and research notes', function () {
		assert.strictEqual(categoryForPath('scripts/release.mjs'), null);
		assert.strictEqual(categoryForPath('scripts/syncMcpDocs.mjs'), null);
		assert.strictEqual(categoryForPath('reference/SYNCTERM_TELNET_ZMODEM.md'), null);
		assert.strictEqual(categoryForPath('.gitignore'), null);
	});

	it('excludes anything it has no rule for, rather than guessing', function () {
		// A new top level directory must be classified deliberately. Defaulting
		// it to code would mean the first release after someone adds one
		// deletes whatever a sysop keeps there.
		assert.strictEqual(categoryForPath('somewhere-new/thing.txt'), null);
		assert.strictEqual(categoryForPath('stray.txt'), null);
	});

	it('handles empty and malformed input without throwing', function () {
		assert.strictEqual(categoryForPath(''), null);
		assert.strictEqual(categoryForPath(null), null);
		assert.strictEqual(categoryForPath(undefined), null);
		assert.strictEqual(categoryForPath('./src/a.js'), CATEGORY_CODE);
	});

	it('only ever returns a known category', function () {
		for (var p of ['src/a.js', 'public/a.css', 'public/css/custom.css', 'config/a.json', 'txtfiles/a.ans']) {
			assert.ok(CATEGORIES.indexOf(categoryForPath(p)) !== -1, p);
		}
	});
});

describe('selectShippedFiles', function () {

	it('drops what is not shipped and keeps the category with the path', function () {
		var out = selectShippedFiles(['src/b.js', 'scripts/x.mjs', 'public/css/custom.css', '.gitignore']);
		assert.deepStrictEqual(out, [
			{ path: 'public/css/custom.css', category: CATEGORY_OVERLAY_SEED },
			{ path: 'src/b.js', category: CATEGORY_CODE }
		]);
	});

	it('sorts, so a manifest built twice from one tree is byte identical', function () {
		var a = selectShippedFiles(['src/z.js', 'src/a.js', 'bin/m.js']);
		var b = selectShippedFiles(['bin/m.js', 'src/z.js', 'src/a.js']);
		assert.deepStrictEqual(a, b);
		assert.deepStrictEqual(a.map(function (f) { return f.path; }), ['bin/m.js', 'src/a.js', 'src/z.js']);
	});

	it('tolerates an empty list', function () {
		assert.deepStrictEqual(selectShippedFiles([]), []);
		assert.deepStrictEqual(selectShippedFiles(null), []);
	});
});

describe('the real repository', function () {

	var tracked = null;
	before(function () {
		try { tracked = listTrackedFiles(ROOT); } catch (e) { tracked = null; }
	});

	it('classifies every tracked file, or excludes it on purpose', function () {
		if (!tracked) return this.skip();
		var unclassified = tracked.filter(function (p) { return !isShipped(p); });
		// Everything unshipped must be one of the known exclusions. A new file
		// landing here means somebody added a directory nobody decided about.
		for (var p of unclassified) {
			assert.ok(
				p.indexOf('scripts/') === 0 || p.indexOf('reference/') === 0 || p === '.gitignore',
				'tracked but unclassified, so it would silently not ship: ' + p
			);
		}
	});

	it('ships the things an install cannot run without', function () {
		if (!tracked) return this.skip();
		var shipped = new Set(selectShippedFiles(tracked).map(function (f) { return f.path; }));
		for (var required of ['package.json', 'package-lock.json', 'ecosystem.config.cjs',
			'bin/gateway.js', 'bin/worker.js', 'src/config/configDefaults.js',
			'config/themes/canectic.json']) {
			assert.ok(shipped.has(required), 'not in the artifact: ' + required);
		}
	});

	it('does not ship the release script inside its own artifact', function () {
		if (!tracked) return this.skip();
		var shipped = new Set(selectShippedFiles(tracked).map(function (f) { return f.path; }));
		assert.ok(!shipped.has('scripts/release.mjs'));
	});
});
