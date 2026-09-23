// tests/upgradeNotices.test.js: which upgrade notes a board is shown, and only
// ever verified ones (#55).
//
// Releases declared upgrade notices from 0.9.9a on and nothing on a board read
// them. The rules under test: collect across every release a move skips,
// dedupe carried copies, filter by the running version, order by seriousness,
// bind an acknowledgement to exactly what was shown, and show nothing that
// has not been proven to come from the release key.
//
// The fixture in tests/fixtures/release-notices is the real published 0.9.10a
// SHA256SUMS, its signature, the release key and four real sidecars, so the
// verification path runs gpg against a genuine signature.
//
// Run: npx mocha --no-config --exit tests/upgradeNotices.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
	noticeId, appliesTo, releasesBetween, gatherNotices, applicableNotices,
	needsAcknowledgement, acknowledgementToken, describeCounts
} from '../src/release/upgradeNotices.js';
import { fetchUpgradeNotices, parseSums } from '../src/maintenance/upgradeNoticeFetch.js';
import { dirSource } from '../src/maintenance/updateStaging.js';
import { parseIndex } from '../src/release/releaseIndex.js';
import { validateMetadata } from '../src/release/metadata.js';
import { newRun } from '../src/release/updatePhases.js';
import { progressSnapshot, renderProgressBody } from '../src/maintenance/updateProgress.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var FIX = path.join(ROOT, 'tests', 'fixtures', 'release-notices');
var PIN = path.join(ROOT, 'setup', 'canectic-release.asc');

var W = { level: 'warning', text: 'Clear the gateway log.', from_max: '0.9.7a' };
var I = { level: 'info', text: 'Updates now give notice.', id: 'gives-notice' };
var C = { level: 'critical', text: 'Back up first.' };

describe('upgradeNotices: which notes apply', function () {

	it('derives a stable id from content, and keeps a declared one', function () {
		assert.strictEqual(noticeId(W), noticeId(Object.assign({}, W)));
		assert.notStrictEqual(noticeId(W), noticeId(Object.assign({}, W, { text: 'other' })));
		assert.strictEqual(noticeId(I), 'gives-notice');
	});

	it('matches the running version against an inclusive range, and shows everything when it cannot tell', function () {
		assert.strictEqual(appliesTo(W, '0.9.7a'), true);
		assert.strictEqual(appliesTo(W, '0.9.6a'), true);
		assert.strictEqual(appliesTo(W, '0.9.8a'), false);
		assert.strictEqual(appliesTo({ from_min: '0.9.8a', from_max: '0.9.8a' }, '0.9.8a'), true);
		assert.strictEqual(appliesTo({ from_min: '0.9.8a' }, '0.9.7a'), false);
		assert.strictEqual(appliesTo(I, 'not-a-version'), true);
	});

	it('takes every release between running and target, withdrawn ones included, oldest first', function () {
		var idx = { releases: [{ version: '0.9.10a' }, { version: '0.9.9a' }, { version: '0.9.6a' }],
			withdrawn: [{ version: '0.9.8a' }, { version: '0.9.7a' }] };
		assert.deepStrictEqual(releasesBetween(idx, '0.9.6a', '0.9.10a').map(function (r) { return r.version; }),
			['0.9.7a', '0.9.8a', '0.9.9a', '0.9.10a']);
		assert.deepStrictEqual(releasesBetween(idx, '0.9.9a', '0.9.9a'), [], 'nothing when not moving');
	});

	it('shows a note carried into a later release once, in the later wording', function () {
		var items = gatherNotices([
			{ version: '0.9.10a', notices: [Object.assign({}, I, { text: 'Updates now give notice, reworded.' })] },
			{ version: '0.9.9a', notices: [I, W] }
		]);
		assert.strictEqual(items.length, 2);
		var carried = items.filter(function (n) { return n.id === 'gives-notice'; })[0];
		assert.strictEqual(carried.release, '0.9.10a');
		assert.ok(/reworded/.test(carried.text));
	});

	it('collapses identical copies that carry no id', function () {
		assert.strictEqual(gatherNotices([{ version: '0.9.9a', notices: [W] }, { version: '0.9.10a', notices: [W] }]).length, 1);
	});

	it('filters to the board, drops releases it already runs, and puts the serious ones first', function () {
		var items = gatherNotices([
			{ version: '0.9.9a', notices: [W, I] },
			{ version: '0.9.10a', notices: [C] }
		]);
		assert.deepStrictEqual(applicableNotices(items, '0.9.6a').map(function (n) { return n.level; }),
			['critical', 'warning', 'info']);
		assert.deepStrictEqual(applicableNotices(items, '0.9.8a').map(function (n) { return n.level; }),
			['critical', 'info'], 'the from_max 0.9.7a warning does not concern a board on 0.9.8a');
		assert.deepStrictEqual(applicableNotices(items, '0.9.9a').map(function (n) { return n.level; }),
			['critical'], 'a board already on 0.9.9a has had its notes');
	});

	it('asks for an acknowledgement only when something is more than a note', function () {
		assert.strictEqual(needsAcknowledgement([{ level: 'info' }]), false);
		assert.strictEqual(needsAcknowledgement([{ level: 'info' }, { level: 'warning' }]), true);
		assert.strictEqual(acknowledgementToken([{ id: 'a', level: 'info' }]), '');
	});

	it('binds the acknowledgement to exactly the notes shown', function () {
		var a = [{ id: 'x', level: 'warning' }, { id: 'y', level: 'info' }];
		var b = [{ id: 'y', level: 'info' }, { id: 'x', level: 'warning' }];
		var c = [{ id: 'x', level: 'warning' }, { id: 'z', level: 'info' }];
		assert.strictEqual(acknowledgementToken(a), acknowledgementToken(b), 'order does not matter');
		assert.notStrictEqual(acknowledgementToken(a), acknowledgementToken(c), 'a different set needs a new tick');
	});

	it('counts for a notification', function () {
		assert.strictEqual(describeCounts([]), '');
		assert.ok(/^2 upgrade notes apply to this system, 1 of them needing attention/.test(
			describeCounts([{ level: 'info' }, { level: 'warning' }])));
	});
});

describe('release metadata: notice ids and ranges', function () {
	function meta(notices) {
		return { metadata_version: 1, version: '0.9.11a', channel: 'stable', released: '2026-09-30',
			artifact: 'canectic-0.9.11a.zip', sha256: 'a'.repeat(64), migrations: [], steps: [], notices: notices };
	}
	function problemsFor(notices) { return validateMetadata(meta(notices)).filter(function (p) { return /notice/.test(p); }); }

	it('accepts ids and ranges that make sense', function () {
		assert.deepStrictEqual(problemsFor([{ level: 'warning', text: 't', id: 'clear-log', from_max: '0.9.7a' }]), []);
	});

	it('refuses a bad id, a repeated id, a range that is not a version or runs backwards', function () {
		assert.ok(problemsFor([{ level: 'info', text: 't', id: 'Not A Slug' }]).length);
		assert.ok(problemsFor([{ level: 'info', text: 't', id: 'a' }, { level: 'info', text: 'u', id: 'a' }]).length);
		assert.ok(problemsFor([{ level: 'info', text: 't', from_max: 'soon' }]).length);
		assert.ok(problemsFor([{ level: 'info', text: 't', from_min: '0.9.9a', from_max: '0.9.7a' }]).length);
	});
});

describe('fetching notes, verified against the signed SHA256SUMS', function () {
	var haveGpg = spawnSync('gpg', ['--version'], { stdio: 'ignore' }).status === 0;
	var index;
	before(function () { index = parseIndex(fs.readFileSync(path.join(FIX, 'index-stable.json'), 'utf8')); });

	it('reads SHA256SUMS', function () {
		var sums = parseSums(fs.readFileSync(path.join(FIX, 'SHA256SUMS'), 'utf8'));
		assert.strictEqual(sums.get('canectic-0.9.10a.json').length, 64);
	});

	it('collects the real notes of 0.9.7a to 0.9.10a for a board on 0.9.6a, with a genuine signature', async function () {
		this.timeout(30000);
		if (!haveGpg) this.skip();
		var r = await fetchUpgradeNotices({ source: dirSource(FIX), index: index, running: '0.9.6a', target: '0.9.10a', pinFrom: PIN });
		assert.strictEqual(r.verified, true, r.reason);
		assert.deepStrictEqual(r.releases, ['0.9.7a', '0.9.8a', '0.9.9a', '0.9.10a']);
		var list = applicableNotices(r.items, '0.9.6a');
		assert.ok(list.length >= 9, list.length + ' notes');
		assert.ok(list.some(function (n) { return /gateway-out\.log/.test(n.text); }), 'the gateway log warning');
		assert.ok(needsAcknowledgement(list));
	});

	it('shows nothing when a sidecar has been altered', async function () {
		this.timeout(30000);
		if (!haveGpg) this.skip();
		var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-notices-'));
		try {
			for (var f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
			var p = path.join(dir, 'canectic-0.9.9a.json');
			fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('gateway-out.log', 'something-else.log'));
			var r = await fetchUpgradeNotices({ source: dirSource(dir), index: index, running: '0.9.6a', target: '0.9.10a', pinFrom: PIN });
			assert.strictEqual(r.verified, false);
			assert.ok(/canectic-0\.9\.9a\.json does not match SHA256SUMS/.test(r.reason), r.reason);
			assert.deepStrictEqual(r.items, []);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it('shows nothing when SHA256SUMS is not signed by the release key', async function () {
		var r = await fetchUpgradeNotices({
			source: dirSource(FIX), index: index, running: '0.9.6a', target: '0.9.10a', pinFrom: PIN,
			verify: function () { return { state: 'bad', detail: 'signed by a key that is not the release key' }; }
		});
		assert.strictEqual(r.verified, false);
		assert.ok(/not the release key/.test(r.reason), r.reason);
		assert.deepStrictEqual(r.items, []);
	});

	it('shows nothing when the signature cannot be fetched', async function () {
		var r = await fetchUpgradeNotices({
			source: dirSource(FIX), index: index, running: '0.9.6a', target: '0.9.10a', pinFrom: PIN,
			fetch: async function (src, name) {
				if (/\.asc$/.test(name) && name !== 'canectic-release.asc') throw new Error('404');
				return fs.readFileSync(path.join(FIX, name), 'utf8');
			}
		});
		assert.strictEqual(r.verified, false);
	});

	it('has nothing to fetch for a move with no releases in it', async function () {
		var r = await fetchUpgradeNotices({ source: dirSource(FIX), index: index, running: '0.9.10a', target: '0.9.10a', pinFrom: PIN,
			verify: function () { throw new Error('should not be asked'); } });
		assert.strictEqual(r.verified, true);
		assert.deepStrictEqual(r.items, []);
	});
});

describe('the run keeps the notes for After updating', function () {
	it('starts with the launcher\'s list, or null when it passed none', function () {
		assert.deepStrictEqual(newRun({ runId: 'r', notices: [W] }).notices, [W]);
		assert.strictEqual(newRun({ runId: 'r' }).notices, null);
	});

	it('shows them on the progress page, as After updating once complete', function () {
		var state = newRun({ runId: 'r', from: '0.9.9a', to: '0.9.10a', notices: [{ level: 'warning', text: 'Clear the <gateway> log.' }] });
		state.status = 'complete';
		var html = renderProgressBody(progressSnapshot(state, {}));
		assert.ok(/<h2>After updating<\/h2>/.test(html), html);
		assert.ok(html.includes('Clear the &lt;gateway&gt; log.'), 'escaped');
	});
});

describe('what the sysop sees', function () {
	var pug, verdict;
	before(async function () {
		pug = (await import('pug')).default;
		verdict = await import('../src/release/updateVerdict.js');
	});

	function result(notices) {
		return {
			current: '0.9.6a', channel: 'stable',
			channels: { stable: { channel: 'stable', verdict: 'available', current: '0.9.6a', available: '0.9.10a', blockers: [] } },
			best: { channel: 'stable', verdict: 'available', current: '0.9.6a', available: '0.9.10a', blockers: [] },
			notices: notices
		};
	}

	it('the notification counts the notes that apply', function () {
		var items = gatherNotices([{ version: '0.9.10a', notices: [W, I] }]);
		var n = verdict.notificationFor(result({ target: '0.9.10a', verified: true, items: items }));
		assert.ok(/2 upgrade notes apply to this system, 1 of them needing attention before you update; read them on the Update page/.test(n.body), n.body);
	});

	it('the notification says when they could not be verified', function () {
		var n = verdict.notificationFor(result({ target: '0.9.10a', verified: false, reason: 'x', items: [] }));
		assert.ok(/could not be verified, so read the release notes/.test(n.body), n.body);
	});

	function renderNotes(notices) {
		var views = path.join(ROOT, 'src', 'views');
		return pug.renderFile(path.join(views, 'partials', 'update', 'upgradeNotes.pug'), { basedir: views, notices: notices });
	}

	it('the page lists verified notes, most serious first, naming where a carried one came from', function () {
		var list = applicableNotices(gatherNotices([{ version: '0.9.9a', notices: [W] }, { version: '0.9.10a', notices: [I] }]), '0.9.6a');
		var html = renderNotes({ target: '0.9.10a', verified: true, list: list });
		assert.ok(html.indexOf('Clear the gateway log.') < html.indexOf('Updates now give notice.'), html);
		assert.ok(/\(from 0\.9\.9a\)/.test(html), html);
	});

	it('the page shows no unverified text, only where to read the notes', function () {
		var html = renderNotes({ target: '0.9.10a', verified: false, reason: 'SHA256SUMS is not verified', list: [],
			notesUrl: 'https://example.invalid/releases/0.9.10a/notes' });
		assert.ok(/could not be verified \(SHA256SUMS is not verified\)/.test(html), html);
		assert.ok(html.includes('https://example.invalid/releases/0.9.10a/notes'));
	});

	it('the Update button waits for the tick, which carries the token the apply route checks', function () {
		var page = fs.readFileSync(path.join(ROOT, 'src', 'views', 'admin', 'update', 'index.pug'), 'utf8');
		assert.ok(/input\.form-check-input#ackNotes\(type='checkbox' name='ack' value=notices\.ackToken required/.test(page));
		assert.ok(/button\.btn\.btn-warning\.w-100#updateButton\(type='submit' disabled=!!needAck\)/.test(page));
		var route = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'admin.js'), 'utf8');
		assert.ok(/String\(req\.body\.ack \|\| ''\) !== shown\.ackToken/.test(route), 'the apply route enforces it');
	});
});
