// tests/updateHousekeeping.test.js — which update backups and staging go (#62).
//
// Every update kept its backup, a full database dump included, for ever, and
// the handoff path kept its staging for ever too. The hub reached 933 MB of
// backups and 179 MB of staging after five updates. These are the rules that
// decide what an update may now delete, and a backup is the only way to undo
// a migration, so most of the cases are about what must be KEPT.
//
// Run: npx mocha --no-config --exit tests/updateHousekeeping.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
	planBackupPrune, planStagingPrune, stagingEntryFor, pruneUpdateLeftovers, DEFAULT_BACKUP_KEEP
} from '../src/maintenance/updateHousekeeping.js';
import * as runStore from '../src/maintenance/updateRunStore.js';
import { CONFIG_DEFINITIONS } from '../src/config/configDefaults.js';

function b(runId, status) { return { runId: runId, status: status }; }

describe('planBackupPrune', function () {
	var A = '20260920-040034-aaaa', B = '20260922-043013-bbbb', C = '20260922-181318-cccc', D = '20260925-050758-dddd';

	it('keeps only the current run by default', function () {
		var r = planBackupPrune({ backups: [b(A, 'complete'), b(B, 'complete'), b(C, 'complete'), b(D, 'complete')], currentRunId: D, keep: 1 });
		assert.deepStrictEqual(r, [A, B, C]);
	});

	it('keeps the last N completed runs, the current one counting', function () {
		var r = planBackupPrune({ backups: [b(A, 'complete'), b(B, 'complete'), b(C, 'complete'), b(D, 'complete')], currentRunId: D, keep: 2 });
		assert.deepStrictEqual(r, [A, B]);
	});

	it('never deletes the current run, whatever keep says', function () {
		assert.ok(!planBackupPrune({ backups: [b(D, 'running')], currentRunId: D, keep: 1 }).includes(D));
	});

	it('keeps everything at 0', function () {
		assert.deepStrictEqual(planBackupPrune({ backups: [b(A, 'complete'), b(D, 'complete')], currentRunId: D, keep: 0 }), []);
	});

	it('removes a failed run once a later update has completed', function () {
		// The board has moved past it; its backup can no longer be restored.
		assert.deepStrictEqual(planBackupPrune({ backups: [b(A, 'failed'), b(D, 'complete')], currentRunId: D, keep: 1 }), [A]);
	});

	it('keeps a failed run newer than the last completed one', function () {
		// By hand after a failed update: that backup may be what the sysop is
		// recovering with.
		var r = planBackupPrune({ backups: [b(A, 'complete'), b(B, 'complete'), b(C, 'failed')], currentRunId: B, keep: 1 });
		assert.deepStrictEqual(r, [A]);
	});

	it('never touches a directory not named like a run', function () {
		var r = planBackupPrune({ backups: [b('my-copy', null), b(A, 'complete'), b(D, 'complete')], currentRunId: D, keep: 1 });
		assert.deepStrictEqual(r, [A]);
	});

	it('treats nonsense keep as the default', function () {
		var r = planBackupPrune({ backups: [b(A, 'complete'), b(D, 'complete')], currentRunId: D, keep: 'lots' });
		assert.deepStrictEqual(r, [A]);
		assert.strictEqual(DEFAULT_BACKUP_KEEP, 1);
	});

	it('matches the shipped default of update_backup_keep', function () {
		var def = CONFIG_DEFINITIONS.find(function (d) { return d.key === 'update_backup_keep'; });
		assert.ok(def);
		assert.strictEqual(Number(def.defaultValue), DEFAULT_BACKUP_KEEP);
	});
});

describe('planStagingPrune / stagingEntryFor', function () {
	it('removes every staged release but the one in use', function () {
		assert.deepStrictEqual(planStagingPrune(['0.9.7a', '0.9.11a', '0.9.10a'], '0.9.11a'), ['0.9.10a', '0.9.7a']);
	});

	it('finds the staging entry an updater runs from', function () {
		var t = '/opt/canectic';
		assert.strictEqual(stagingEntryFor(t, '/opt/canectic/.canectic-update/staging/0.9.11a/tree'), '0.9.11a');
		assert.strictEqual(stagingEntryFor(t, '/tmp/tmp.x/canectic-0.9.10a'), null, 'an install stages elsewhere');
		assert.strictEqual(stagingEntryFor(t, null), null);
	});
});

describe('pruneUpdateLeftovers', function () {
	var target;

	function makeRun(runId, status, bytes) {
		var dir = path.join(target, '.canectic-update', 'backup', runId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'database.dump'), Buffer.alloc(bytes || 10));
		runStore.save(target, { runId: runId, status: status, phases: [] });
	}
	function stage(name) {
		fs.mkdirSync(path.join(target, '.canectic-update', 'staging', name, 'tree'), { recursive: true });
		fs.writeFileSync(path.join(target, '.canectic-update', 'staging', name, 'tree', 'x'), 'x');
	}
	function exists(rel) { return fs.existsSync(path.join(target, '.canectic-update', rel)); }

	beforeEach(function () {
		target = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-updhk-'));
	});
	afterEach(function () {
		fs.rmSync(target, { recursive: true, force: true });
	});

	it('removes old backups and staging at the end of an update', function () {
		makeRun('20260920-040034-aaaa', 'complete', 100);
		makeRun('20260922-043013-bbbb', 'failed', 100);
		makeRun('20260925-050758-dddd', 'complete', 100);
		stage('0.9.10a'); stage('0.9.11a');
		var r = pruneUpdateLeftovers({
			target: target, currentRunId: '20260925-050758-dddd', keep: 1,
			stagedRoot: path.join(target, '.canectic-update', 'staging', '0.9.11a', 'tree')
		});
		assert.deepStrictEqual(r.errors, []);
		assert.deepStrictEqual(r.backups.map(function (x) { return x.runId; }), ['20260920-040034-aaaa', '20260922-043013-bbbb']);
		assert.ok(exists('backup/20260925-050758-dddd'), 'the current backup stays');
		assert.ok(!exists('backup/20260920-040034-aaaa'));
		assert.ok(exists('staging/0.9.11a'), 'the staging the updater runs from stays');
		assert.ok(!exists('staging/0.9.10a'));
		assert.ok(r.freed >= 200);
	});

	it('marks a run whose backup it removed, without moving latest.json', function () {
		makeRun('20260920-040034-aaaa', 'complete');
		makeRun('20260925-050758-dddd', 'complete');   // saved last, so it is latest
		pruneUpdateLeftovers({ target: target, currentRunId: '20260925-050758-dddd', keep: 1, stagedRoot: null });
		assert.ok(runStore.load(target, '20260920-040034-aaaa').backupRemovedAt);
		assert.strictEqual(runStore.latest(target).runId, '20260925-050758-dddd');
	});

	it('by hand, keeps the newest completed run and changes nothing on a dry run', function () {
		makeRun('20260920-040034-aaaa', 'complete');
		makeRun('20260925-050758-dddd', 'complete');
		stage('0.9.11a');
		var dry = pruneUpdateLeftovers({ target: target, currentRunId: null, keep: 1, stagedRoot: null, dryRun: true });
		assert.deepStrictEqual(dry.backups.map(function (x) { return x.runId; }), ['20260920-040034-aaaa']);
		assert.deepStrictEqual(dry.staging.map(function (x) { return x.name; }), ['0.9.11a']);
		assert.ok(exists('backup/20260920-040034-aaaa') && exists('staging/0.9.11a'), 'dry run removes nothing');

		pruneUpdateLeftovers({ target: target, currentRunId: null, keep: 1, stagedRoot: null });
		assert.ok(!exists('backup/20260920-040034-aaaa'));
		assert.ok(exists('backup/20260925-050758-dddd'));
	});

	it('by hand, refuses while an update is running', function () {
		makeRun('20260920-040034-aaaa', 'complete');
		makeRun('20260925-050758-dddd', 'running');
		stage('0.9.11a');
		var r = pruneUpdateLeftovers({ target: target, currentRunId: null, keep: 1, stagedRoot: null });
		assert.strictEqual(r.errors.length, 1);
		assert.ok(exists('staging/0.9.11a') && exists('backup/20260920-040034-aaaa'));
	});

	it('by hand, is not blocked by a run that died saying "running" before a later update', function () {
		// The hub: the 0.9.7a updater crashed before the updater guard existed,
		// and its run says "running" for ever. Three updates have completed since.
		makeRun('20260920-040034-aaaa', 'running');
		makeRun('20260922-043013-bbbb', 'complete');
		makeRun('20260925-050758-dddd', 'complete');
		var r = pruneUpdateLeftovers({ target: target, currentRunId: null, keep: 1, stagedRoot: null });
		assert.deepStrictEqual(r.errors, []);
		assert.deepStrictEqual(r.backups.map(function (x) { return x.runId; }), ['20260920-040034-aaaa', '20260922-043013-bbbb']);
	});

	it('by hand, refuses when the running update has no backup yet', function () {
		// A run starts before its backup directory exists.
		makeRun('20260920-040034-aaaa', 'complete');
		runStore.save(target, { runId: '20260925-050758-dddd', status: 'running', phases: [] });
		stage('0.9.11a');
		var r = pruneUpdateLeftovers({ target: target, currentRunId: null, keep: 1, stagedRoot: null });
		assert.strictEqual(r.errors.length, 1);
		assert.ok(exists('staging/0.9.11a'));
	});

	it('does nothing on an install that has never updated', function () {
		var r = pruneUpdateLeftovers({ target: target, currentRunId: null, keep: 1, stagedRoot: null });
		assert.deepStrictEqual(r, { backups: [], staging: [], freed: 0, errors: [] });
	});
});
