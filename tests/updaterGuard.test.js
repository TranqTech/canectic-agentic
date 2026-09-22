// tests/updaterGuard.test.js: an error nothing caught, inside the updater.
//
// On 2026-09-22 a browser resetting a WebSocket upgrade threw an unhandled
// ECONNRESET in the updater on a live board. It died in the middle of npm
// install with the BBS stopped, and its run file still said "running", so the
// Update page reported an update in progress that had been dead for minutes.
// Now a client going away is ignored, and anything else is recorded against the
// run before the process exits.
//
// Run: npx mocha --no-config --exit tests/updaterGuard.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as runStore from '../src/maintenance/updateRunStore.js';
import { newRun, beginPhase, finishPhase } from '../src/release/updatePhases.js';
import { isPeerNetworkError, whereLeft } from '../src/maintenance/updaterGuard.js';

var PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'guardProbe.mjs');

describe('the updater guard', function () {
	this.timeout(20000);
	var target, runId;

	beforeEach(function () {
		target = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-guard-'));
		runId = '20260922-000000-test';
		var s = newRun({ runId: runId, from: '0.9.7a', to: '0.9.8a', target: target });
		for (var name of ['preflight', 'backup', 'stop', 'files']) {
			s = finishPhase(beginPhase(s, name), name, 'done');
		}
		s = beginPhase(s, 'dependencies');
		runStore.save(target, s);
	});
	afterEach(function () { fs.rmSync(target, { recursive: true, force: true }); });

	function probe(mode) {
		return spawnSync(process.execPath, [PROBE, target, runId, mode], { encoding: 'utf8', timeout: 10000 });
	}

	it('carries on when a client goes away', function () {
		var r = probe('peer');
		assert.strictEqual(r.status, 0, r.stdout + r.stderr);
		assert.ok(/survived/.test(r.stdout), r.stdout);
		assert.ok(/ignored a client going away \(ECONNRESET\)/.test(r.stdout), r.stdout);
		assert.strictEqual(runStore.load(target, runId).status, 'running', 'the run is untouched');
	});

	it('records a bug against the run, at the phase it was in, before dying', function () {
		var r = probe('bug');
		assert.strictEqual(r.status, 1, r.stdout + r.stderr);
		assert.ok(!/still alive/.test(r.stdout), 'it must not carry on after a bug');
		var s = runStore.load(target, runId);
		assert.strictEqual(s.status, 'failed');
		var deps = s.phases.filter(function (p) { return p.name === 'dependencies'; })[0];
		assert.strictEqual(deps.status, 'failed');
		assert.ok(/the updater crashed/.test(deps.error), deps.error);
		assert.ok(s.warnings.some(function (w) { return /BBS is stopped/.test(w); }), s.warnings.join('\n'));
		assert.strictEqual(runStore.latest(target).status, 'failed', 'latest.json, which the page reads, agrees');
	});

	it('treats a rejection nobody awaited the same way', function () {
		var r = probe('rejection');
		assert.strictEqual(r.status, 1, r.stdout + r.stderr);
		assert.strictEqual(runStore.load(target, runId).status, 'failed');
		assert.ok(/nobody awaited this/.test(runStore.load(target, runId).error));
	});

	it('knows a client going away from a bug', function () {
		for (var code of ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT']) {
			var e = new Error(code); e.code = code;
			assert.ok(isPeerNetworkError(e), code);
		}
		assert.ok(!isPeerNetworkError(new TypeError('x is null')));
		var enoent = new Error('gone'); enoent.code = 'ENOENT';
		assert.ok(!isPeerNetworkError(enoent), 'a missing file is not a client going away');
		assert.ok(!isPeerNetworkError(null));
	});

	it('says where the board was left', function () {
		var s = runStore.load(target, runId);
		assert.ok(/BBS is stopped/.test(whereLeft(s)));
		assert.ok(/Check whether the BBS is running/.test(whereLeft(newRun({ runId: 'x' }))));
	});
});

// Twice this codebase has had a test prove a helper that the running code
// never called. Both ways of applying an update must install the guard.
describe('who installs the updater guard', function () {
	var root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

	it('the detached updater, before it runs the phases', function () {
		var text = fs.readFileSync(path.join(root, 'src', 'tools', 'applyUpdate.js'), 'utf8');
		var guard = text.indexOf('installUpdaterGuard({');
		assert.ok(guard !== -1, 'applyUpdate.js does not install the guard');
		assert.ok(guard < text.indexOf('await runUpdate('), 'the guard must be in place before the phases run');
	});

	it('update.js --apply, around its in-process run', function () {
		var text = fs.readFileSync(path.join(root, 'src', 'tools', 'update.js'), 'utf8');
		var guard = text.indexOf('installUpdaterGuard({');
		assert.ok(guard !== -1, 'update.js does not install the guard');
		assert.ok(guard < text.indexOf('await runUpdate('), 'the guard must be in place before the phases run');
	});
});
