// tests/releaseChangelog.test.js: reading and closing the changelog Pending
// section.
//
// v0.9.5a shipped with no release notes at all. They were written
// retrospectively five months later from the changelog, which is the gap the
// release script exists to close: after a cut there is always a file carrying
// the upgrade actions and the change list.
//
// This module deliberately does NOT derive the executable steps from the prose.
// Parsing a changelog to decide what to run on someone's live board works right
// up until a bullet is reworded, and the failure is silent. What it does
// instead is cross check: upgrade notes written for people with nothing
// declared for the updater, or the reverse.
//
// Pure: no database, no services.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
	findPending, countPendingHeadings, pendingIsEmpty, pendingSections, upgradeNotes,
	closePending, crossCheckPending, releaseNoteSkeleton
} from '../src/release/changelog.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var SAMPLE = [
	'# Canectic BBS - Changelog',
	'',
	'## Pending (since v0.9.5a)',
	'',
	'### Upgrade Notes',
	'',
	'- **Run the migrations.** Because the schema moved.',
	'',
	'  ```',
	'  node src/tools/dbmigrations.js',
	'  ```',
	'',
	'- **Second note.** With a nested bullet:',
	'  - not a top level note',
	'',
	'### Features',
	'',
	'- A thing was added.',
	'',
	'## v0.9.5a (2026-04-04)',
	'',
	'### Old Section',
	'',
	'- Old thing.',
	''
].join('\n');

describe('findPending', function () {

	it('locates the block and what it accumulated against', function () {
		var p = findPending(SAMPLE);
		assert.strictEqual(p.since, 'v0.9.5a');
		assert.ok(p.body.indexOf('### Upgrade Notes') !== -1);
	});

	it('stops at the next release heading rather than swallowing history', function () {
		var p = findPending(SAMPLE);
		assert.ok(p.body.indexOf('Old thing') === -1);
		assert.ok(p.body.indexOf('A thing was added') !== -1);
	});

	it('returns null when there is no Pending block', function () {
		assert.strictEqual(findPending('# Changelog\n\n## v1.0.0 (2026-01-01)\n'), null);
	});
});

describe('pendingIsEmpty', function () {

	it('is false when there is content', function () {
		assert.strictEqual(pendingIsEmpty(SAMPLE), false);
	});

	it('is true for a bare heading', function () {
		assert.strictEqual(pendingIsEmpty('## Pending (since v0.9.5a)\n\n## v0.9.5a (2026-04-04)\n'), true);
	});

	it('is true for headings with nothing under them', function () {
		// The shape a maintainer leaves behind when they set up a release and
		// then write none of it. A release with nothing in it is a tag.
		var text = '## Pending (since v0.9.5a)\n\n### Features\n\n### Bugfixes\n\n## v0.9.5a (2026-04-04)\n';
		assert.strictEqual(pendingIsEmpty(text), true);
	});

	it('is true when there is no Pending block at all', function () {
		assert.strictEqual(pendingIsEmpty('# Changelog\n'), true);
	});
});

describe('pendingSections', function () {

	it('lists the section titles in order', function () {
		assert.deepStrictEqual(pendingSections(SAMPLE), ['Upgrade Notes', 'Features']);
	});
});

describe('upgradeNotes', function () {

	it('takes the top level bullets under Upgrade Notes only', function () {
		var notes = upgradeNotes(SAMPLE);
		assert.strictEqual(notes.length, 2);
		assert.ok(notes[0].indexOf('Run the migrations') !== -1);
		assert.ok(notes[1].indexOf('Second note') !== -1);
	});

	it('ignores nested bullets and fenced commands', function () {
		var notes = upgradeNotes(SAMPLE);
		for (var n of notes) {
			assert.ok(n.indexOf('not a top level note') === -1);
			assert.ok(n.indexOf('dbmigrations') === -1);
		}
	});

	it('does not wander into other sections', function () {
		assert.ok(upgradeNotes(SAMPLE).every(function (n) { return n.indexOf('A thing was added') === -1; }));
	});

	it('is empty when there is no such section', function () {
		assert.deepStrictEqual(upgradeNotes('## Pending (since v1)\n\n### Features\n\n- x\n'), []);
	});
});

describe('closePending', function () {

	var closed;
	before(function () { closed = closePending(SAMPLE, { version: '0.9.6a', date: '2026-09-20' }); });

	it('turns the Pending heading into the released version', function () {
		assert.ok(closed.indexOf('## v0.9.6a (2026-09-20)') !== -1);
	});

	it('opens a fresh Pending against the version just cut', function () {
		assert.ok(closed.indexOf('## Pending (since v0.9.6a)') !== -1);
		assert.strictEqual(pendingIsEmpty(closed), true);
	});

	it('keeps the content under the version it belongs to', function () {
		var released = closed.indexOf('## v0.9.6a (2026-09-20)');
		var note = closed.indexOf('Run the migrations');
		var older = closed.indexOf('## v0.9.5a (2026-04-04)');
		assert.ok(released < note && note < older, 'content did not stay with its release');
	});

	it('loses nothing from the older releases', function () {
		assert.ok(closed.indexOf('## v0.9.5a (2026-04-04)') !== -1);
		assert.ok(closed.indexOf('Old thing.') !== -1);
	});

	it('refuses when there is nothing to close', function () {
		assert.throws(function () {
			closePending('# Changelog\n\n## v1.0.0 (2026-01-01)\n', { version: '1.0.1', date: '2026-02-02' });
		}, /no Pending section/);
	});
});

describe('crossCheckPending', function () {

	it('is quiet when both halves are present', function () {
		var pending = { steps: [{ id: 'a' }], notices: [] };
		assert.deepStrictEqual(crossCheckPending(SAMPLE, pending), []);
	});

	it('warns when upgrade notes exist but nothing is declared', function () {
		// The release would apply silently: the sysop reads two actions in the
		// notes and the updater knows about none of them.
		var warnings = crossCheckPending(SAMPLE, { steps: [], notices: [] });
		assert.strictEqual(warnings.length, 1);
		assert.ok(/apply this release silently/.test(warnings[0]));
	});

	it('warns when declarations exist but the notes do not mention them', function () {
		var text = '## Pending (since v1)\n\n### Features\n\n- x\n';
		var warnings = crossCheckPending(text, { steps: [{ id: 'a' }], notices: [{ text: 'b' }] });
		assert.strictEqual(warnings.length, 1);
		assert.ok(/nobody reading the release notes will know/.test(warnings[0]));
	});

	it('is quiet when a release genuinely needs neither', function () {
		var text = '## Pending (since v1)\n\n### Features\n\n- x\n';
		assert.deepStrictEqual(crossCheckPending(text, { steps: [], notices: [] }), []);
	});
});

describe('releaseNoteSkeleton', function () {

	var meta = {
		released: '2026-09-20',
		codename: 'Handshake',
		steps: [
			{ id: 'a', description: 'Run the migrations', automatic: true, command: 'node src/tools/dbmigrations.js' },
			{ id: 'b', description: 'Re-register pm2', automatic: false, command: 'pm2 delete all' }
		],
		notices: [{ level: 'warning', text: 'A setting was deprecated.' }]
	};

	it('names the release and its codename', function () {
		var out = releaseNoteSkeleton({ version: '0.9.6a', meta: meta });
		assert.ok(out.indexOf('# Canectic BBS v0.9.6a') === 0);
		assert.ok(out.indexOf('Handshake') !== -1);
	});

	it('carries every declared step and notice, so none can be forgotten', function () {
		var out = releaseNoteSkeleton({ version: '0.9.6a', meta: meta });
		assert.ok(out.indexOf('A setting was deprecated.') !== -1);
		assert.ok(out.indexOf('Run the migrations') !== -1);
		assert.ok(out.indexOf('node src/tools/dbmigrations.js') !== -1);
		assert.ok(out.indexOf('pm2 delete all') !== -1);
	});

	it('says which steps the sysop has to run themselves', function () {
		var out = releaseNoteSkeleton({ version: '0.9.6a', meta: meta });
		assert.ok(out.indexOf('Applied automatically') !== -1);
		assert.ok(out.indexOf('Run by hand') !== -1);
	});

	it('leaves the prose visibly unwritten rather than pretending', function () {
		var out = releaseNoteSkeleton({ version: '0.9.6a', meta: meta });
		assert.ok(out.indexOf('TODO') !== -1);
	});

	it('folds in the closed changelog body when given one', function () {
		var out = releaseNoteSkeleton({ version: '0.9.6a', meta: meta, body: '### Features\n\n- A thing.' });
		assert.ok(out.indexOf('## Changes') !== -1);
		assert.ok(out.indexOf('- A thing.') !== -1);
	});

	it('omits the upgrade section when a release needs nothing', function () {
		var out = releaseNoteSkeleton({ version: '0.9.6a', meta: { released: '2026-09-20', steps: [], notices: [] } });
		assert.ok(out.indexOf('## Upgrading') === -1);
	});
});

describe('the changelog in this repository', function () {

	var text = null;
	before(function () {
		var file = path.join(ROOT, 'docs', 'sysop', 'CHANGELOG.md');
		if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
	});

	it('has a Pending block the release script can find', function () {
		if (text === null) return this.skip();
		assert.notStrictEqual(findPending(text), null,
			'the release script closes this block by name, so a reformat breaks a cut');
	});

	it('closes and reopens without losing the previous release', function () {
		if (text === null) return this.skip();
		var pending = findPending(text);
		if (!pending) return this.skip();
		var closed = closePending(text, { version: '9.9.9a', date: '2026-01-01' });
		assert.ok(closed.indexOf('## Pending (since v9.9.9a)') !== -1);
		assert.ok(closed.indexOf('## v9.9.9a (2026-01-01)') !== -1);
		assert.ok(closed.indexOf('## v0.9.5a (2026-04-04)') !== -1);
		assert.ok(closed.length > text.length);
	});
});

// A second "## Pending" heading is invisible in a way that costs entries.
// findPending takes the FIRST one and its body stops at the next "## ", so
// everything written under a later heading is silently dropped from the release
// it was written for. It happened here, from an edit that prepended a heading
// rather than inserting under the existing one, and it was found by reading the
// file rather than by anything failing.
describe('how many Pending headings the changelog has', function () {

	it('counts the one a healthy changelog carries', function () {
		assert.strictEqual(countPendingHeadings(SAMPLE), 1);
	});

	// Still exactly one after a cut: closePending closes the old section and
	// opens a fresh empty one for the next cycle, which is why the sibling test
	// above asserts the result is EMPTY rather than absent.
	it('still counts one after a release is closed, not zero', function () {
		var closed = closePending(SAMPLE, '0.9.6a', '2026-09-16');
		assert.strictEqual(countPendingHeadings(closed), 1);
		assert.strictEqual(pendingIsEmpty(closed), true);
	});

	it('counts the duplicate that went unnoticed', function () {
		var text = [
			'# Changelog',
			'',
			'## Pending (since v0.9.6a)',
			'',
			'- something written for the next release',
			'',
			'## Pending (since v0.9.6a)',
			'',
			'## v0.9.6a (2026-09-16)',
			''
		].join('\n');
		assert.strictEqual(countPendingHeadings(text), 2);
	});

	// The consequence, stated as a test so the reason for counting is on record.
	it('shows what the duplicate costs: the second block is not read', function () {
		var text = [
			'# Changelog',
			'',
			'## Pending (since v0.9.6a)',
			'',
			'- read',
			'',
			'## Pending (since v0.9.6a)',
			'',
			'- LOST',
			'',
			'## v0.9.6a (2026-09-16)',
			''
		].join('\n');
		var found = findPending(text);
		assert.match(found.body, /read/);
		assert.ok(found.body.indexOf('LOST') === -1,
			'the second block is read after all, so the refusal would be unnecessary');
	});

	it('is happy with a changelog that has no Pending at all', function () {
		assert.strictEqual(countPendingHeadings('# Changelog\n'), 0);
	});
});
