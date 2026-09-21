// tests/terminalDrain.test.js: terminal callers while the board closes.
//
// New callers are refused before a node is allocated. Connected callers are
// warned, reminded and then hung up when the grace runs out. The warning is
// drawn on the bottom line with the cursor saved and restored, so it can land
// on top of a door or the editor without leaving the caller's cursor adrift.
//
// Run: npx mocha --no-config --exit tests/terminalDrain.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as flags from '../src/maintenance/maintenanceFlag.js';
import { MaintenanceWatch } from '../src/maintenance/maintenanceWatch.js';
import * as td from '../src/maintenance/terminalDrain.js';

var REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeCall(nodenum, over) {
	var c = Object.assign({ nodenum: nodenum, call_status: 'In Progress', term_height: 25, term_width: 80,
		sent: [], hungUp: false }, over || {});
	c.sendString = function (s) { c.sent.push(s); };
	c.hangUpCall = function () { c.hungUp = true; c.call_status = 'Finished'; };
	return c;
}

function fakeCallManager(calls) {
	return { pools: [{ connectedcalls: calls.slice(0, 1) }, { connectedcalls: calls.slice(1) }] };
}

describe('terminalDrain texts', function () {
	var now = new Date('2026-09-21T10:00:00Z').getTime();

	it('counts down in minutes, then seconds', function () {
		assert.strictEqual(td.countdown(now + 300000, now), 'in 5 minutes');
		assert.strictEqual(td.countdown(now + 30000, now), 'in 30 seconds');
		assert.strictEqual(td.countdown(now + 1000, now), 'in 1 second');
		assert.strictEqual(td.countdown(now - 1000, now), 'now');
	});

	it('tells a refused caller why and when to come back', function () {
		var text = td.refusalText({ active: true, flag: { reason: 'Rebuilding areas' },
			expectedBack: new Date(Date.now() + 1800000) });
		assert.ok(/closed for maintenance/.test(text));
		assert.ok(/Rebuilding areas/.test(text));
		assert.ok(/Expected back around \d\d:\d\d/.test(text), text);
	});

	it('asks a refused caller to call back later when no return time was given', function () {
		assert.ok(/call back later/.test(td.refusalText({ active: true, flag: {}, expectedBack: null })));
	});

	it('refuses nobody while the board is open', function () {
		assert.strictEqual(td.refuseNewCaller({ active: false }), null);
		assert.ok(td.refuseNewCaller({ active: true, flag: {} }));
	});

	it('strips control characters from the reason before it reaches a terminal', function () {
		var text = td.warningText({ flag: { reason: 'bad\x1b[2Jthing\x07' }, deadline: new Date(now + 60000) }, now);
		assert.ok(!/[\x00-\x1f]/.test(text), JSON.stringify(text));
	});

	it('draws on the bottom line and restores the cursor when the size is known', function () {
		var n = td.noticeFor({ term_height: 25, term_width: 80 }, 'hello');
		assert.ok(n.indexOf('\x1b[s') === 0, 'save cursor first');
		assert.ok(n.includes('\x1b[25;1H'), 'bottom line');
		assert.ok(n.endsWith('\x1b[u'), 'restore cursor last');
	});

	it('keeps the notice to one line', function () {
		var n = td.noticeFor({ term_height: 24, term_width: 40 }, 'x'.repeat(200));
		var body = n.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
		assert.ok(body.length <= 39, 'a wrapped line would scroll the screen: ' + body.length);
	});

	it('falls back to plain lines when the size was never negotiated', function () {
		var n = td.noticeFor({ term_height: 0 }, 'hello');
		assert.ok(!n.includes('\x1b'), JSON.stringify(n));
		assert.ok(n.includes('hello'));
	});
});

describe('attachTerminalDrain', function () {
	var root, watch;
	beforeEach(function () {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-tdrain-'));
		watch = new MaintenanceWatch({ process: 'gateway', root: root, intervalMs: 1000000 });
	});
	afterEach(function () {
		watch.stop();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('warns every connected caller when the board starts closing', async function () {
		var calls = [fakeCall(1), fakeCall(2), fakeCall(3, { term_height: 0 })];
		td.attachTerminalDrain(watch, fakeCallManager(calls));
		flags.enterMaintenance(root, { grace_seconds: 600, reason: 'Update' });
		await watch.tick();
		for (var c of calls) {
			assert.strictEqual(c.sent.length, 1, 'node ' + c.nodenum);
			assert.ok(/closes for maintenance in 10 minutes/.test(c.sent[0]), c.sent[0]);
			assert.strictEqual(c.hungUp, false, 'nobody is dropped before the grace runs out');
		}
	});

	it('hangs every caller up when the grace runs out', async function () {
		var calls = [fakeCall(1), fakeCall(2)];
		td.attachTerminalDrain(watch, fakeCallManager(calls));
		flags.enterMaintenance(root, { grace_seconds: 0 });
		await watch.tick();
		for (var c of calls) {
			assert.strictEqual(c.hungUp, true, 'node ' + c.nodenum);
			assert.ok(c.sent.some(function (s) { return /now closed for maintenance/.test(s); }));
		}
	});

	it('reports connected callers as in flight, and not once they are hung up', async function () {
		var calls = [fakeCall(1), fakeCall(2)];
		td.attachTerminalDrain(watch, fakeCallManager(calls));
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();
		assert.deepStrictEqual(flags.readDrainStatuses(root)[0].pending, { 'terminal calls': 2 });
		calls[0].hangUpCall();
		calls[1].hangUpCall();
		await watch.tick();
		assert.strictEqual(flags.readDrainStatuses(root)[0].drained, true);
	});

	it('reminds at one minute and fifteen seconds out, and cancels when the board reopens', async function () {
		var drain = td.attachTerminalDrain(watch, fakeCallManager([fakeCall(1)]));
		flags.enterMaintenance(root, { grace_seconds: 600 });
		await watch.tick();
		assert.strictEqual(drain.pendingReminders(), 2);
		flags.leaveMaintenance(root);
		await watch.tick();
		assert.strictEqual(drain.pendingReminders(), 0, 'a reminder after reopening would tell callers the board is closing');
	});

	it('skips reminders that would already have passed or land on the first warning', async function () {
		var drain = td.attachTerminalDrain(watch, fakeCallManager([fakeCall(1)]));
		flags.enterMaintenance(root, { grace_seconds: 30 });
		await watch.tick();
		assert.strictEqual(drain.pendingReminders(), 1, 'only the fifteen second one is still ahead');
		flags.leaveMaintenance(root);
		await watch.tick();
		flags.enterMaintenance(root, { grace_seconds: 10 });
		await watch.tick();
		assert.strictEqual(drain.pendingReminders(), 0);
	});
});

describe('the connection classes', function () {
	// Refusing has to happen before createCall, which is where a node number
	// is allocated. Checked in the source because constructing a connection
	// needs a live socket and a call pool.
	for (var file of ['src/servers/tcpserver.js', 'src/servers/telnetserver.js', 'src/servers/websockets.js']) {
		(function (f) {
			it(f + ' refuses a caller before allocating a node', function () {
				var src = fs.readFileSync(path.join(REPO, f), 'utf8');
				var body = src.substring(src.indexOf('announceConnection()'));
				var refuse = body.indexOf('refuseNewCaller(currentMaintenance())');
				var create = body.indexOf('createCall(');
				assert.ok(refuse !== -1, 'no maintenance refusal in ' + f);
				assert.ok(refuse < create, 'the refusal must come before createCall in ' + f);
			});
		})(file);
	}
});

describe('MaintenanceWatch before its first check', function () {
	it('answers from the file without firing events', function () {
		var root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-tdrain-'));
		try {
			var watch = new MaintenanceWatch({ process: 'gateway', root: root, intervalMs: 1000000 });
			var entered = 0;
			watch.on('enter', function () { entered++; });
			flags.enterMaintenance(root, { grace_seconds: 600 });
			assert.strictEqual(watch.current().active, true, 'a caller arriving during startup must be refused');
			assert.strictEqual(entered, 0, 'enter waits for start(), so late subscribers still hear it');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
