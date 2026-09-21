// tests/maintenanceFlag.test.js: the maintenance flag file and drain assessment.
//
// The flag is a file because the database may be what is being worked on. So
// the rules that matter are about the file: presence is the flag even when the
// contents cannot be read, re-entering keeps the grace running from the
// original start, and a drain only counts when it was reported for THIS
// closure by a process that is still alive.
//
// Run: npx mocha --no-config --exit tests/maintenanceFlag.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as flags from '../src/maintenance/maintenanceFlag.js';

function tempRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'zz-maint-'));
}

describe('maintenanceFlag', function () {
	var root;
	beforeEach(function () { root = tempRoot(); });
	afterEach(function () { fs.rmSync(root, { recursive: true, force: true }); });

	describe('the flag file', function () {
		it('reads as open when there is no file', function () {
			assert.strictEqual(flags.readFlag(root), null);
			assert.strictEqual(flags.isActive(root), false);
		});

		it('round-trips what was entered', function () {
			flags.enterMaintenance(root, { reason: 'Rebuilding areas', expected_minutes: '30',
				grace_seconds: 120, set_by: 'sysop', source: 'manual' });
			var f = flags.readFlag(root);
			assert.strictEqual(f.reason, 'Rebuilding areas');
			assert.strictEqual(f.expected_minutes, 30);
			assert.strictEqual(f.grace_seconds, 120);
			assert.strictEqual(f.set_by, 'sysop');
			assert.strictEqual(f.source, 'manual');
			assert.strictEqual(f.malformed, false);
			assert.ok(flags.isActive(root));
		});

		it('treats an unreadable file as closed, dated by its mtime', function () {
			fs.writeFileSync(flags.flagPath(root), 'not json {');
			var f = flags.readFlag(root);
			assert.ok(f, 'a torn or hand-written flag must still close the board');
			assert.strictEqual(f.malformed, true);
			assert.ok(!isNaN(new Date(f.since).getTime()));
		});

		it('treats an empty file as closed', function () {
			fs.writeFileSync(flags.flagPath(root), '');
			assert.ok(flags.readFlag(root), 'touch .maintenance is a legitimate way to close the board');
		});

		it('keeps the original start when re-entered, so nobody gets a fresh countdown', function () {
			var first = flags.enterMaintenance(root, { reason: 'one' });
			var second = flags.enterMaintenance(root, { reason: 'two' });
			assert.strictEqual(second.since, first.since);
			assert.strictEqual(flags.readFlag(root).reason, 'two');
		});

		it('leaves no temporary file behind', function () {
			flags.enterMaintenance(root, { reason: 'x' });
			assert.deepStrictEqual(fs.readdirSync(root), ['.maintenance']);
		});

		it('reports whether leaving removed anything', function () {
			assert.strictEqual(flags.leaveMaintenance(root), false);
			flags.enterMaintenance(root, {});
			assert.strictEqual(flags.leaveMaintenance(root), true);
			assert.strictEqual(flags.readFlag(root), null);
		});

		it('coerces an unknown source to manual and junk numbers to null', function () {
			var f = flags.normaliseFlag({ source: 'bogus', expected_minutes: 'soon', grace_seconds: -5 }, null);
			assert.strictEqual(f.source, 'manual');
			assert.strictEqual(f.expected_minutes, null);
			assert.strictEqual(f.grace_seconds, null);
		});
	});

	describe('deadlines', function () {
		var since = '2026-09-21T10:00:00.000Z';

		it('uses the flag grace when it has one', function () {
			var d = flags.deadlineOf({ since: since, grace_seconds: 60 }, 300);
			assert.strictEqual(d.toISOString(), '2026-09-21T10:01:00.000Z');
		});

		it('falls back to the board default, then the built-in one', function () {
			assert.strictEqual(flags.deadlineOf({ since: since, grace_seconds: null }, 120).toISOString(),
				'2026-09-21T10:02:00.000Z');
			assert.strictEqual(flags.deadlineOf({ since: since, grace_seconds: null }, null).toISOString(),
				'2026-09-21T10:05:00.000Z');
		});

		it('allows a grace of zero, which is the emergency case', function () {
			assert.strictEqual(flags.deadlineOf({ since: since, grace_seconds: 0 }, 300).toISOString(), since);
		});

		it('has no expected return unless one was given', function () {
			assert.strictEqual(flags.expectedBackOf({ since: since, expected_minutes: null }), null);
			assert.strictEqual(flags.expectedBackOf({ since: since, expected_minutes: 90 }).toISOString(),
				'2026-09-21T11:30:00.000Z');
		});
	});

	describe('drain assessment', function () {
		var since = '2026-09-21T10:00:00.000Z';
		var now = new Date('2026-09-21T10:05:00.000Z').getTime();
		function status(name, drained, ageMs, pending, forSince) {
			return { process: name, drained: drained, ts: new Date(now - ageMs).toISOString(),
				since: forSince || since, pending: pending || {} };
		}

		it('is drained when every live process says so', function () {
			var a = flags.assessDrain([status('gateway', true, 1000), status('worker', true, 1000)], { since: since, now: now });
			assert.strictEqual(a.drained, true);
			assert.strictEqual(a.reporting, 2);
		});

		it('is not drained while any live process has work in flight', function () {
			var a = flags.assessDrain([status('gateway', true, 1000),
				status('worker', false, 1000, { 'toss jobs': 1 })], { since: since, now: now });
			assert.strictEqual(a.drained, false);
			var w = a.processes.find(function (p) { return p.process === 'worker'; });
			assert.strictEqual(w.state, 'draining');
			assert.deepStrictEqual(w.pending, { 'toss jobs': 1 });
		});

		it('counts a stale status as a stopped process, which has nothing in flight', function () {
			var a = flags.assessDrain([status('gateway', true, 1000),
				status('worker', false, 60000, { 'toss jobs': 1 })], { since: since, now: now });
			assert.strictEqual(a.drained, true);
			assert.strictEqual(a.reporting, 1);
			assert.strictEqual(a.processes.find(function (p) { return p.process === 'worker'; }).state, 'stopped');
		});

		it('ignores a status left over from an earlier closure', function () {
			var a = flags.assessDrain([status('gateway', true, 1000, {}, '2026-09-20T00:00:00.000Z')],
				{ since: since, now: now });
			assert.strictEqual(a.reporting, 0, 'a drained status from last week says nothing about now');
			assert.strictEqual(a.processes[0].state, 'previous');
		});

		it('writes and reads statuses through the directory', function () {
			flags.writeDrainStatus(root, 'gateway', { since: since, drained: false, pending: { 'terminal calls': 2 } });
			flags.writeDrainStatus(root, 'worker', { since: since, drained: true, pending: {} });
			var got = flags.readDrainStatuses(root).map(function (s) { return s.process; }).sort();
			assert.deepStrictEqual(got, ['gateway', 'worker']);
			flags.clearDrainStatus(root, 'gateway');
			assert.deepStrictEqual(flags.readDrainStatuses(root).map(function (s) { return s.process; }), ['worker']);
		});

		it('describes pending work without the zero counts', function () {
			assert.strictEqual(flags.describePending({ 'terminal calls': 2, 'binkp sessions': 0, 'toss jobs': 1 }),
				'2 terminal calls, 1 toss jobs');
		});
	});

	describe('drain verdict', function () {
		var drained   = { drained: true,  reporting: 2 };
		var draining  = { drained: false, reporting: 2 };
		var nobody    = { drained: true,  reporting: 0 };

		it('does not believe drained until every process has had time to report', function () {
			assert.strictEqual(flags.drainVerdict(drained, { sinceFlagMs: 1000, waitedMs: 1000 }), 'waiting');
			assert.strictEqual(flags.drainVerdict(drained, { sinceFlagMs: 10000, waitedMs: 1000 }), 'drained');
		});

		it('says nobody is reporting only after the no-report window', function () {
			assert.strictEqual(flags.drainVerdict(nobody, { sinceFlagMs: 5000, waitedMs: 5000 }), 'waiting');
			assert.strictEqual(flags.drainVerdict(nobody, { sinceFlagMs: 30000, waitedMs: 30000 }), 'nobody');
		});

		it('calls a timeout with nobody reporting "nobody", not work in flight', function () {
			assert.strictEqual(flags.drainVerdict(nobody, { sinceFlagMs: 2000, waitedMs: 2000 }, { timeoutMs: 1000 }), 'nobody');
		});

		it('times out only when a timeout was asked for', function () {
			assert.strictEqual(flags.drainVerdict(draining, { sinceFlagMs: 1e9, waitedMs: 1e9 }), 'waiting');
			assert.strictEqual(flags.drainVerdict(draining, { sinceFlagMs: 1e9, waitedMs: 61000 }, { timeoutMs: 60000 }), 'timeout');
		});
	});

	describe('waitForDrain', function () {
		it('returns open if the flag is cleared', async function () {
			var res = await flags.waitForDrain(root, { intervalMs: 10 });
			assert.strictEqual(res.verdict, 'open');
		});

		it('returns drained once a live process reports nothing in flight', async function () {
			var f = flags.enterMaintenance(root, {});
			// Backdate the flag past the settle window.
			var raw = JSON.parse(fs.readFileSync(flags.flagPath(root), 'utf8'));
			raw.since = new Date(Date.now() - 60000).toISOString();
			fs.writeFileSync(flags.flagPath(root), JSON.stringify(raw));
			flags.writeDrainStatus(root, 'gateway', { since: raw.since, drained: true, pending: {} });
			var res = await flags.waitForDrain(root, { intervalMs: 10 });
			assert.strictEqual(res.verdict, 'drained');
			assert.ok(f);
		});

		it('returns nobody when no process ever reports', async function () {
			flags.enterMaintenance(root, {});
			var res = await flags.waitForDrain(root, { intervalMs: 10, noReportMs: 50 });
			assert.strictEqual(res.verdict, 'nobody');
		});
	});
});
