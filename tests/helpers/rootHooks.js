// tests/helpers/rootHooks.js -- let the suite exit on its own, and fail it
// when something will not let it.
//
// Loaded by .mocharc.yml with `require`. The suite used to run with
// `exit: true`, which kills the process the moment the tests report and so
// hides every handle a test leaves open: #45 was a leaked timer that crashed
// the process after 3,831 tests had passed, and nothing showed it. It needed
// `exit: true` because the suites touching PostgreSQL and Redis go through
// module-level singletons (the pg pool, the shared Redis client, the ioredis
// connections behind queues and event publishers) held for the life of the
// process, which is right for the application and left a test run hanging.
//
// So this closes those after the last test, and then, if the process is still
// alive a few seconds later, names whatever is holding it open and exits 1.
// A leak fails the run with a list of suspects instead of hanging it, or
// being killed without a word as before (#46).
//
// A run with --no-config does not load this, and runs without `exit` too:
// fine for a single file that touches neither database, and a file that does
// will hang there, which is the prompt to run it through the config.

import { promisify } from 'util';

var GRACE_MS = 5000;

// Node stopped listing timers among the active handles, so all a leaked timer
// reports by itself is the word "Timeout". Every timer made through the
// globals is recorded with where it was made, and forgotten when cleared or
// when a one-shot fires, so the report can name the line that armed it.
// Timers imported from node:timers bypass this and fall back to the word.
var liveTimers = new Map();
var real = {
	setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval,
	clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval
};

function whereFrom() {
	var lines = (new Error().stack || '').split('\n').slice(3);
	var own = lines.filter(function (l) { return !/node_modules|node:internal|rootHooks\.js/.test(l); });
	return ((own[0] || lines[0] || '').trim()).replace(/^at /, '');
}

function track(kind) {
	var wrapped = function (fn) {
		var args = Array.prototype.slice.call(arguments);
		var t;
		if (kind === 'setTimeout' && typeof fn === 'function') {
			args[0] = function () { liveTimers.delete(t); return fn.apply(this, arguments); };
		}
		t = real[kind].apply(globalThis, args);
		if (t && typeof t === 'object') liveTimers.set(t, { kind: kind, fn: fn, where: whereFrom() });
		return t;
	};
	// util.promisify(setTimeout) and friends look for this on the function.
	if (real[kind][promisify.custom]) wrapped[promisify.custom] = real[kind][promisify.custom];
	return wrapped;
}

function untrack(kind) {
	return function (t) { liveTimers.delete(t); return real[kind].apply(globalThis, arguments); };
}

globalThis.setTimeout = track('setTimeout');
globalThis.setInterval = track('setInterval');
globalThis.clearTimeout = untrack('clearTimeout');
globalThis.clearInterval = untrack('clearInterval');

function describeTimers() {
	var out = [];
	for (var [t, info] of liveTimers) {
		if (typeof t.hasRef === 'function' && !t.hasRef()) continue;
		out.push(info.kind + ' ' + ((info.fn && info.fn.name) || '(anonymous)') + ', armed at ' + info.where);
	}
	return out;
}

function describeHandle(h) {
	var name = (h && h.constructor && h.constructor.name) || typeof h;
	if (h === process.stdin || h === process.stdout || h === process.stderr) return null;
	if (name === 'Socket' || name === 'TLSSocket') {
		if (!h.remoteAddress && !h.localPort) return null;   // a pipe: stdio or the npx parent
		return name + ' to ' + h.remoteAddress + ':' + h.remotePort + ' from port ' + h.localPort;
	}
	if (name === 'Server') {
		var a = h.address && h.address();
		return 'Server listening on ' + (a && typeof a === 'object' ? a.address + ':' + a.port : String(a));
	}
	return name;
}

async function closeSingletons() {
	// Importing these opens nothing, so a run that never touched a database
	// loses nothing by it: the pg pool connects on its first query, the Redis
	// client on the first getClient(), and a queue connection only when made.
	var pg = await import('../../src/middleware/db/postgres.js');
	var redis = await import('../../src/middleware/db/redis.js');
	var queues = await import('../../src/queues/connection.js');
	try { await pg.pgpool.end(); } catch (_) {}
	try { await redis.shutdown(); } catch (_) {}
	queues.closeAllQueueConnections();
}

export var mochaHooks = {
	async afterAll() {
		await closeSingletons();

		// unref'd, so it never keeps the process alive itself: it fires only
		// when something else does.
		real.setTimeout(function () {
			var held = process._getActiveHandles().map(describeHandle).filter(Boolean).concat(describeTimers());
			console.error('\nThe test run finished but the process is still held open by:');
			for (var d of held.length ? held : ['(nothing identifiable: ' + process.getActiveResourcesInfo().join(', ') + ')']) {
				console.error('  ' + d);
			}
			console.error('A test left this open. Close it in that test\'s after hook.');
			// Mocha sets the exit code to its failure count from an 'exit'
			// listener, which would turn this back into 0. Listeners run in
			// the order they were added, and this one is added after mocha's.
			process.on('exit', function () { process.exitCode = 1; });
			process.exit(1);
		}, GRACE_MS).unref();
	}
};
