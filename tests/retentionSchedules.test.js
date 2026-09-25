// tests/retentionSchedules.test.js — a purge switched off stays off.
//
// The daily purges were registered with their retention baked into the
// schedule (`data: { days: 30 }`) and the jobs trusted it. Setting a
// retention to keep-forever skipped registering the schedule but never
// removed the one already there, and fixed schedules are outside what the
// orphan prune may touch, so the old schedule went on purging every night
// with the old days: deleting exactly what the sysop had asked to keep.
//
// Now schedules carry no days, jobs read the setting when they run
// (retention.js), and ensureSchedule removes a schedule that is not wanted.
//
// Run: npx mocha --no-config --exit tests/retentionSchedules.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RETENTION_JOBS, retentionDaysFor, scheduleWanted } from '../src/maintenance/retention.js';
import { MAINTENANCE_JOBS } from '../src/maintenance/maintenanceJobs.js';
import { CONFIG_DEFINITIONS } from '../src/config/configDefaults.js';
import { ensureSchedule } from '../src/queues/schedules.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A getNumber over a plain settings object, falling back to the default.
function settings(values) {
	return function (key, def) {
		return Object.prototype.hasOwnProperty.call(values, key) ? Number(values[key]) : def;
	};
}

describe('retentionDaysFor', function () {

	it('reads the setting when the job runs', function () {
		assert.strictEqual(retentionDaysFor('purge-mailer-sessions', {}, settings({ mailer_session_retention_days: 12 })), 12);
	});

	it('ignores days baked into a schedule by an older release', function () {
		// The whole bug: a leftover schedule carries { days: 30 } while the
		// sysop has since set 0, keep for ever.
		var stale = { days: 30 };
		assert.strictEqual(retentionDaysFor('purge-mailer-sessions', stale, settings({ mailer_session_retention_days: 0 })), null);
		assert.strictEqual(retentionDaysFor('purge-relay-log', stale, settings({ netmail_relay_log_retention_days: 400 })), 400);
	});

	it('honours days a sysop chose for a manual run', function () {
		assert.strictEqual(retentionDaysFor('purge-tossed', { manual: true, days: 3 }, settings({ ftn_keep_tossed_days: 999 })), 3);
	});

	it('purges nothing at 0 for every purge but PM trash', function () {
		for (var name of Object.keys(RETENTION_JOBS)) {
			if (RETENTION_JOBS[name].alwaysOn) continue;
			var s = {};
			s[RETENTION_JOBS[name].key] = 0;
			assert.strictEqual(retentionDaysFor(name, {}, settings(s)), null, name);
		}
	});

	it('treats 999 as keep for ever for tossed packets', function () {
		assert.strictEqual(retentionDaysFor('purge-tossed', {}, settings({ ftn_keep_tossed_days: 999 })), null);
		assert.strictEqual(retentionDaysFor('purge-tossed', {}, settings({ ftn_keep_tossed_days: 7 })), 7);
	});

	it('keeps PM trash purging, with 0 meaning all of it, as before', function () {
		assert.strictEqual(retentionDaysFor('purge-pm-trash', {}, settings({ pm_trash_retention_days: 0 })), 0);
		assert.strictEqual(scheduleWanted('purge-pm-trash', settings({ pm_trash_retention_days: 0 })), true);
	});

	it('uses the default for a setting that is not a number', function () {
		assert.strictEqual(retentionDaysFor('purge-inbound-log', {}, function () { return NaN; }), 90);
	});

	it('refuses a job it has no rule for rather than guessing', function () {
		assert.throws(function () { retentionDaysFor('purge-nothing', {}, settings({})); });
	});
});

describe('retention table', function () {

	it('names settings that exist, with the same defaults', function () {
		for (var name of Object.keys(RETENTION_JOBS)) {
			var spec = RETENTION_JOBS[name];
			var def = CONFIG_DEFINITIONS.find(function (d) { return d.key === spec.key; });
			assert.ok(def, spec.key + ' is not in configDefaults');
			assert.strictEqual(Number(def.defaultValue), spec.defaultDays, spec.key + ' default');
		}
	});

	it('names only jobs the maintenance queue handles', function () {
		for (var name of Object.keys(RETENTION_JOBS)) {
			assert.ok(MAINTENANCE_JOBS.includes(name), name);
		}
	});

	it('is the only place schedules.js registers a retention purge', function () {
		// A second upsert of one of these keys, with days in its data, would
		// bring the bug back for that purge.
		var src = fs.readFileSync(path.join(ROOT, 'src/queues/schedules.js'), 'utf8');
		for (var name of Object.keys(RETENTION_JOBS)) {
			assert.ok(!src.includes("'" + RETENTION_JOBS[name].schedule + "'"), RETENTION_JOBS[name].schedule + ' registered by hand');
		}
		assert.ok(!/data:\s*\{\s*days:/.test(src), 'a schedule still carries days');
	});
});

describe('ensureSchedule', function () {

	function fakeQueue(existing) {
		var q = { upserted: [], removed: [] };
		q.upsertJobScheduler = async function (key, repeat, tmpl) { q.upserted.push({ key: key, repeat: repeat, tmpl: tmpl }); };
		q.removeJobScheduler = async function (key) { q.removed.push(key); return existing; };
		return q;
	}

	it('registers a wanted schedule with no days', async function () {
		var q = fakeQueue(false);
		assert.strictEqual(await ensureSchedule(q, 'purge-tossed-daily', true, '0 2 * * *', 'purge-tossed'), true);
		assert.deepStrictEqual(q.upserted, [{ key: 'purge-tossed-daily', repeat: { pattern: '0 2 * * *' }, tmpl: { name: 'purge-tossed', data: {} } }]);
		assert.deepStrictEqual(q.removed, []);
	});

	it('removes a schedule that is switched off', async function () {
		var q = fakeQueue(true);
		assert.strictEqual(await ensureSchedule(q, 'purge-tossed-daily', false, '0 2 * * *', 'purge-tossed'), false);
		assert.deepStrictEqual(q.removed, ['purge-tossed-daily']);
		assert.deepStrictEqual(q.upserted, []);
	});

	it('does not fail registration when removal throws', async function () {
		var q = fakeQueue(true);
		q.removeJobScheduler = async function () { throw new Error('redis gone'); };
		assert.strictEqual(await ensureSchedule(q, 'x', false, '* * * * *', 'x'), false);
	});
});
