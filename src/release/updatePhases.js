// updatePhases.js -- the state of an update run, as a value.
//
// An update replaces the code of the process that started it, so the thing
// watching it is going to go away. Progress therefore cannot live in memory or
// in a websocket: each step has to leave a durable record, and when the browser
// or the sysop comes back they read what happened rather than being shown a
// lost connection.
//
// This module is the shape of that record and the legal moves over it. It is
// pure, so the awkward cases are testable without spawning anything:
//
//   A phase that was never reached is `pending`, and one deliberately not
//   performed is `skipped` with a reason. Those are different facts and a run
//   that conflates them either looks stuck for ever or looks finished when it
//   is not.
//
//   completeRun REFUSES when a phase failed or is still running. Reporting a
//   half-applied tree as a successful update is the worst outcome available
//   here, because nothing else marks it as broken.
//
//   An unknown phase name throws rather than being ignored. A typo that
//   silently did nothing would leave a phase pending for ever while the run
//   carried on around it.

// The full sequence, in order, and it is ONE sequence for both installing and
// updating. Principle 1 of the design: install is update from nothing. An
// install skips `backup` because there is nothing to preserve and `stop`
// because nothing is running; an update skips `env` because the .env is the
// sysop's. Expressing both as the same list with different skips is what stops
// a second copier growing beside the first, which is how install.sh came to
// delete every sysop-added asset under public/.
//
// A run states which of these it intends to perform; the rest are skipped with
// a reason, so a tool that only does some of them is honest about it rather
// than appearing to hang.
var PHASES = [
	'preflight',
	'backup',
	'stop',
	'files',
	'directories',
	'env',
	'dependencies',
	'schema',
	'migrations',
	'steps',
	'start',
	'verify'
];

var STATUS_PENDING = 'pending';
var STATUS_RUNNING = 'running';
var STATUS_DONE    = 'done';
var STATUS_SKIPPED = 'skipped';
var STATUS_FAILED  = 'failed';

var RUN_RUNNING  = 'running';
var RUN_COMPLETE = 'complete';
var RUN_FAILED   = 'failed';

var RUN_VERSION = 1;

var TERMINAL_PHASE = [STATUS_DONE, STATUS_SKIPPED, STATUS_FAILED];

function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

/**
 * A run id that sorts chronologically and is readable in a directory listing.
 *
 * Local time, not UTC, because a sysop reading the filename is matching it
 * against when they pressed the button.
 */
function makeRunId(date, suffix) {
	var d = date || new Date();
	return String(d.getFullYear()) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + '-' +
		pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2) +
		'-' + (suffix || Math.random().toString(36).substring(2, 6));
}

function clone(state) {
	return JSON.parse(JSON.stringify(state));
}

function findPhase(state, name) {
	for (var p of state.phases) if (p.name === name) return p;
	throw new Error('no such update phase: ' + name);
}

/**
 * A fresh run.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.from    the version installed now
 * @param {string} opts.to      the version being applied
 * @param {string} opts.target  the installation
 * @param {string[]} [opts.phases] the phases this run intends to perform
 */
function newRun(opts) {
	var intended = opts.phases || PHASES;
	for (var name of intended) {
		if (PHASES.indexOf(name) === -1) throw new Error('no such update phase: ' + name);
	}

	return {
		run_version: RUN_VERSION,
		runId: opts.runId,
		status: RUN_RUNNING,
		from: opts.from || null,
		to: opts.to || null,
		target: opts.target || null,
		stagedRoot: opts.stagedRoot || null,
		logFile: opts.logFile || null,
		pid: opts.pid || null,
		startedAt: (opts.startedAt || new Date()).toISOString(),
		finishedAt: null,
		error: null,
		warnings: [],
		phases: PHASES.map(function (name) {
			return {
				name: name,
				status: STATUS_PENDING,
				intended: intended.indexOf(name) !== -1,
				startedAt: null,
				finishedAt: null,
				detail: null,
				error: null
			};
		})
	};
}

function beginPhase(state, name, at) {
	var next = clone(state);
	var phase = findPhase(next, name);
	if (TERMINAL_PHASE.indexOf(phase.status) !== -1) {
		throw new Error('phase ' + name + ' has already ' + phase.status + ' and cannot be started again');
	}
	phase.status = STATUS_RUNNING;
	phase.startedAt = (at || new Date()).toISOString();
	return next;
}

function finishPhase(state, name, detail, at) {
	var next = clone(state);
	var phase = findPhase(next, name);
	phase.status = STATUS_DONE;
	phase.detail = detail || null;
	phase.finishedAt = (at || new Date()).toISOString();
	return next;
}

/**
 * A phase this run is deliberately not performing.
 *
 * The reason is required. "skipped" with no explanation is the same problem as
 * "pending" from the reader's point of view: they cannot tell whether something
 * went wrong.
 */
function skipPhase(state, name, reason, at) {
	if (!reason) throw new Error('skipping ' + name + ' needs a reason');
	var next = clone(state);
	var phase = findPhase(next, name);
	phase.status = STATUS_SKIPPED;
	phase.detail = reason;
	phase.finishedAt = (at || new Date()).toISOString();
	return next;
}

/** A phase that threw. The run fails with it; there is no carrying on. */
function failPhase(state, name, error, at) {
	var next = clone(state);
	var phase = findPhase(next, name);
	var when = (at || new Date()).toISOString();
	phase.status = STATUS_FAILED;
	phase.error = error ? String(error.message || error) : 'failed';
	phase.finishedAt = when;
	next.status = RUN_FAILED;
	next.error = phase.error;
	next.finishedAt = when;
	return next;
}

function addWarning(state, text) {
	var next = clone(state);
	next.warnings.push(text);
	return next;
}

/**
 * Mark the run finished.
 *
 * Refuses when anything failed or is still running. A run that reported success
 * over a failed phase would tell a sysop their board is updated when it is
 * half replaced, and nothing else in the system would contradict it.
 */
function completeRun(state, at) {
	var failed = state.phases.filter(function (p) { return p.status === STATUS_FAILED; });
	if (failed.length) {
		throw new Error('cannot complete a run with a failed phase: ' +
			failed.map(function (p) { return p.name; }).join(', '));
	}
	var running = state.phases.filter(function (p) { return p.status === STATUS_RUNNING; });
	if (running.length) {
		throw new Error('cannot complete a run with a phase still running: ' +
			running.map(function (p) { return p.name; }).join(', '));
	}

	var next = clone(state);
	next.status = RUN_COMPLETE;
	next.finishedAt = (at || new Date()).toISOString();
	// An intended phase nobody touched is a bug in the caller, not a success.
	for (var p of next.phases) {
		if (p.intended && p.status === STATUS_PENDING) {
			next.warnings.push('phase ' + p.name + ' was intended but never ran');
		}
	}
	return next;
}

function failRun(state, error, at) {
	var next = clone(state);
	next.status = RUN_FAILED;
	next.error = error ? String(error.message || error) : 'failed';
	next.finishedAt = (at || new Date()).toISOString();
	return next;
}

function isTerminal(state) {
	return !!state && (state.status === RUN_COMPLETE || state.status === RUN_FAILED);
}

/** What to put in front of a person. */
function summarise(state) {
	if (!state) return null;
	var done = 0, skipped = 0, failed = 0, current = null;
	for (var p of state.phases) {
		if (p.status === STATUS_DONE) done++;
		else if (p.status === STATUS_SKIPPED) skipped++;
		else if (p.status === STATUS_FAILED) failed++;
		else if (p.status === STATUS_RUNNING) current = p.name;
	}
	var started = state.startedAt ? Date.parse(state.startedAt) : null;
	var ended = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();

	return {
		runId: state.runId,
		status: state.status,
		from: state.from,
		to: state.to,
		current: current,
		done: done,
		skipped: skipped,
		failed: failed,
		total: state.phases.filter(function (p) { return p.intended; }).length,
		elapsedMs: (started !== null) ? (ended - started) : null,
		error: state.error,
		warnings: state.warnings || []
	};
}

export {
	PHASES,
	RUN_VERSION,
	STATUS_PENDING, STATUS_RUNNING, STATUS_DONE, STATUS_SKIPPED, STATUS_FAILED,
	RUN_RUNNING, RUN_COMPLETE, RUN_FAILED,
	makeRunId,
	newRun,
	beginPhase,
	finishPhase,
	skipPhase,
	failPhase,
	addWarning,
	completeRun,
	failRun,
	isTerminal,
	summarise
};
