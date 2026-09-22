// tests/processEscape.test.js: the updater leaves the process tree that
// launched it.
//
// Launched from the Admin UI, the updater is a descendant of the gateway, and
// pm2's treekill kills every descendant when it stops the gateway, which is
// the first thing the update does. `detached: true` does not help: the parent
// pid is still the gateway. The updater relaunches itself so that its parent
// has gone, and nobody's treekill reaches it. Proved against pm2 by hand on
// 2026-09-21 (the directly launched updater died at `pm2 stop all`, the
// escaped one survived); pm2 itself is not run here.
//
// Run: npx mocha --no-config --exit tests/processEscape.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { hasEscaped, escapeProcessTree, MARK } from '../src/maintenance/processEscape.js';

var FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'escapeProbe.mjs');

function waitFor(file, ms) {
	var until = Date.now() + ms;
	return new Promise(function (resolve, reject) {
		(function check() {
			if (fs.existsSync(file)) return resolve(fs.readFileSync(file, 'utf8'));
			if (Date.now() > until) return reject(new Error('timed out waiting for ' + file));
			setTimeout(check, 50);
		})();
	});
}

describe('escaping the launcher\'s process tree', function () {
	this.timeout(10000);
	var dir;
	beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-escape-')); });
	afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

	it('ends up with a parent that is neither the launcher nor the first process', async function () {
		var out = path.join(dir, 'probe');
		var log = fs.openSync(path.join(dir, 'update.log'), 'a');
		// Launched the way the gateway launches the updater.
		var first = spawn(process.execPath, [FIXTURE, out], { detached: true, stdio: ['ignore', log, log] });
		first.unref();
		fs.closeSync(log);

		var firstPid = parseInt(await waitFor(out + '.first', 5000), 10);
		var copy = JSON.parse(await waitFor(out + '.copy', 5000));
		assert.notStrictEqual(copy.pid, firstPid, 'the update carries on in a new process');
		assert.notStrictEqual(copy.ppid, firstPid, 'whose parent is not the process that was launched');
		assert.notStrictEqual(copy.ppid, process.pid,
			'and not the launcher: a descendant of the gateway is what pm2 treekill kills');
		var logged = fs.readFileSync(path.join(dir, 'update.log'), 'utf8');
		assert.ok(/copy writing to the inherited stdout/.test(logged),
			'the copy must keep writing to the log the launcher opened: ' + JSON.stringify(logged));
	});

	// A failed spawn reports itself as an 'error' event after the call returns.
	// Unheard, Node throws it; and the caller, told a pid, exited with no copy
	// running, so the update vanished. Mocha fails this on the uncaught error.
	it('returns null, and throws nothing, when the copy cannot be started', function (done) {
		var pid = escapeProcessTree({
			argv: ['node', '/x/applyUpdate.js', '--run', '/x/run.json'], execArgv: [],
			execPath: '/nonexistent/canectic-node', cwd: os.tmpdir()
		});
		assert.strictEqual(pid, null, 'the caller must not be told a copy is running');
		setTimeout(done, 300);
	});

	it('marks the copy so it does not escape again', function () {
		var calls = [];
		var pid = escapeProcessTree({
			argv: ['node', '/x/applyUpdate.js', '--run', '/x/run.json'], execArgv: ['--no-warnings'],
			execPath: '/usr/bin/node', env: { A: '1' }, cwd: '/x',
			spawnFn: function (file, args, opts) { calls.push({ file: file, args: args, opts: opts }); return { pid: 42, unref: function () {} }; }
		});
		assert.strictEqual(pid, 42);
		assert.strictEqual(calls[0].file, '/usr/bin/node');
		assert.deepStrictEqual(calls[0].args, ['--no-warnings', '/x/applyUpdate.js', '--run', '/x/run.json']);
		assert.strictEqual(calls[0].opts.detached, true);
		assert.strictEqual(calls[0].opts.env[MARK], '1');
		assert.strictEqual(calls[0].opts.env.A, '1');
		assert.strictEqual(hasEscaped(calls[0].opts.env), true);
		assert.strictEqual(hasEscaped({}), false);
	});
});
