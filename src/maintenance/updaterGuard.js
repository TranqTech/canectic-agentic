// updaterGuard.js -- what the updater does with an error nothing else caught.
//
// The updater is a batch process that, for part of its life, is also a small
// web server (updateStatusServer.js). An error thrown from an event handler,
// or a promise rejection nobody awaited, does not reach runUpdate's try/catch:
// Node prints it and exits. On 2026-09-22 a browser resetting a WebSocket
// upgrade did exactly that to a live board, in the middle of npm install, with
// the BBS stopped. The run file still said "running", so the Update page and
// `update.js --status` both reported an update in progress that had died.
//
// Two rules:
//
//   a client going away   ECONNRESET, EPIPE and the like, raised by a socket
//                         because the far end vanished. Nothing in this process
//                         is inconsistent after one, so it is logged and the
//                         update carries on. Dying here is certain damage;
//                         carrying on is almost certainly fine
//   anything else         a bug. Carrying on after one is not safe, so the run
//                         is marked failed at the phase it was in, with what
//                         happened and where the board was left, and the
//                         process exits. It still dies, but it dies on the
//                         record, and the page says so
//
// NODE BUILTINS ONLY besides the run store and phase helpers, which are
// themselves builtins only: this has to work while node_modules is being
// replaced.

import * as runStore from './updateRunStore.js';
import { failPhase, addWarning } from '../release/updatePhases.js';

// Raised by a socket because the other end went away or stopped answering.
var PEER_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT']);

/** Did a client going away raise this? Pure. */
function isPeerNetworkError(err) {
	return !!err && typeof err.code === 'string' && PEER_CODES.has(err.code);
}

/**
 * Where the board was left, for the record. Pure.
 * @param {object} state  run state
 * @returns {string}
 */
function whereLeft(state) {
	var phases = (state && state.phases) || [];
	var status = {};
	for (var p of phases) status[p.name] = p.status;
	if (status.stop === 'done' && status.start !== 'done') {
		return 'The BBS is stopped and the board is closed for maintenance.';
	}
	return 'Check whether the BBS is running before reopening the board.';
}

/**
 * Record a crash against the run. Returns the saved state, or null when there
 * was no run to record it on.
 */
function recordCrash(target, runId, err) {
	var state = runStore.load(target, runId);
	if (!state) return null;
	var running = (state.phases || []).filter(function (p) { return p.status === 'running'; })[0];
	var message = 'the updater crashed: ' + (err && err.message ? err.message : String(err));
	var next = running ? failPhase(state, running.name, message) : Object.assign({}, state, {
		status: 'failed', error: message, finishedAt: new Date().toISOString()
	});
	next = addWarning(next, message + (running ? ' (during ' + running.name + ')' : '') + '. ' + whereLeft(state));
	runStore.save(target, next);
	return next;
}

/**
 * Install the guard for this process.
 *
 * @param {object} opts
 * @param {string} opts.target
 * @param {string} opts.runId
 * @param {function} [opts.log]
 * @param {function} [opts.exit]   seam for tests; process.exit by default
 * @returns {function} removes the guard
 */
function installUpdaterGuard(opts) {
	var o = opts || {};
	var say = typeof o.log === 'function' ? o.log : function () {};
	var exit = typeof o.exit === 'function' ? o.exit : function (code) { process.exit(code); };
	var dying = false;

	function handle(err, kind) {
		if (isPeerNetworkError(err)) {
			say('ignored a client going away (' + err.code + '), the update carries on');
			return;
		}
		if (dying) return;
		dying = true;
		say('FATAL ' + kind + ': ' + (err && err.stack ? err.stack : err));
		try {
			var saved = recordCrash(o.target, o.runId, err);
			say(saved ? 'recorded the crash against run ' + o.runId : 'no run ' + o.runId + ' to record the crash on');
		} catch (e) {
			say('could not record the crash: ' + e.message);
		}
		exit(1);
	}

	function onException(err) { handle(err, 'uncaught exception'); }
	function onRejection(reason) { handle(reason, 'unhandled rejection'); }

	process.on('uncaughtException', onException);
	process.on('unhandledRejection', onRejection);
	return function remove() {
		process.removeListener('uncaughtException', onException);
		process.removeListener('unhandledRejection', onRejection);
	};
}

export { PEER_CODES, isPeerNetworkError, whereLeft, recordCrash, installUpdaterGuard };
