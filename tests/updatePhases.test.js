// tests/updatePhases.test.js: the state of an update run.
//
// An update replaces the code of the process that started it, so whatever was
// watching is gone by the time anybody asks what happened. The state file is
// the only answer, and these are the rules that keep it honest.
//
// The one that matters most is that completeRun REFUSES over a failed or still
// running phase. A run reporting success across a failed phase tells a sysop
// their board is updated when it is half replaced, and nothing else in the
// system contradicts it: the files are on disk, the processes are down, and the
// only record says it went fine.
//
// The other is that "never reached" and "deliberately not done" are different
// facts. Conflating them makes a partial updater either look permanently stuck
// or look finished when it is not, and this updater deliberately performs four
// of the ten phases.
//
// Pure: no filesystem, no processes.

import assert from 'assert';
import {
	PHASES, makeRunId, newRun, beginPhase, finishPhase, skipPhase, failPhase,
	addWarning, completeRun, failRun, isTerminal, summarise,
	STATUS_PENDING, STATUS_RUNNING, STATUS_DONE, STATUS_SKIPPED, STATUS_FAILED,
	RUN_RUNNING, RUN_COMPLETE, RUN_FAILED
} from '../src/release/updatePhases.js';

function run(phases) {
	return newRun({
		runId: 'test-run', from: '0.9.6a', to: '0.9.7a', target: '/opt/canectic',
		phases: phases || ['preflight', 'files', 'verify'],
		startedAt: new Date('2026-09-13T10:00:00Z')
	});
}

function phase(state, name) {
	return state.phases.filter(function (p) { return p.name === name; })[0];
}

describe('makeRunId', function () {

	it('sorts chronologically, so a directory listing is in order', function () {
		var a = makeRunId(new Date(2026, 8, 13, 10, 0, 0), 'aaaa');
		var b = makeRunId(new Date(2026, 8, 13, 10, 0, 1), 'bbbb');
		assert.ok(a < b, a + ' should sort before ' + b);
	});

	it('reads as a local timestamp, which is when the sysop pressed the button', function () {
		assert.strictEqual(makeRunId(new Date(2026, 8, 13, 16, 27, 39), 'p29p'), '20260913-162739-p29p');
	});
});

describe('newRun', function () {

	it('lists every phase, not only the ones it intends to do', function () {
		var s = run();
		assert.deepStrictEqual(s.phases.map(function (p) { return p.name; }), PHASES);
		assert.strictEqual(s.status, RUN_RUNNING);
	});

	it('records which phases it means to perform', function () {
		var s = run(['preflight', 'files']);
		assert.strictEqual(phase(s, 'preflight').intended, true);
		assert.strictEqual(phase(s, 'dependencies').intended, false);
	});

	it('refuses a phase name that does not exist', function () {
		// A typo would otherwise create a run whose intended list names nothing
		// real, and every check against it would quietly pass.
		assert.throws(function () { newRun({ runId: 'x', phases: ['filez'] }); }, /no such update phase/);
	});
});

describe('phase transitions', function () {

	it('runs a phase from pending to done', function () {
		var s = finishPhase(beginPhase(run(), 'files'), 'files', '12 written');
		assert.strictEqual(phase(s, 'files').status, STATUS_DONE);
		assert.strictEqual(phase(s, 'files').detail, '12 written');
		assert.ok(phase(s, 'files').startedAt);
		assert.ok(phase(s, 'files').finishedAt);
	});

	it('does not mutate the state it was given', function () {
		// The caller persists each state in turn, so a mutation would rewrite
		// history rather than adding to it.
		var before = run();
		beginPhase(before, 'files');
		assert.strictEqual(phase(before, 'files').status, STATUS_PENDING);
	});

	it('refuses to start a phase that already finished', function () {
		// Running a phase twice is a bug in the caller, and the second run
		// would overwrite the record of the first.
		var s = finishPhase(beginPhase(run(), 'files'), 'files', 'done');
		assert.throws(function () { beginPhase(s, 'files'); }, /already done/);
	});

	it('refuses to skip without a reason', function () {
		// "Skipped" with no explanation reads exactly like "pending" to anybody
		// looking at the page: they cannot tell whether something went wrong.
		assert.throws(function () { skipPhase(run(), 'stop'); }, /needs a reason/);
	});

	it('records a skip as a distinct outcome from never having run', function () {
		var s = skipPhase(run(), 'stop', 'this updater does not stop the BBS');
		assert.strictEqual(phase(s, 'stop').status, STATUS_SKIPPED);
		assert.strictEqual(phase(s, 'dependencies').status, STATUS_PENDING);
		assert.ok(phase(s, 'stop').detail);
	});

	it('throws on a phase nobody has heard of', function () {
		assert.throws(function () { beginPhase(run(), 'nonsense'); }, /no such update phase/);
	});
});

describe('failure', function () {

	it('fails the run along with the phase', function () {
		var s = failPhase(beginPhase(run(), 'files'), 'files', new Error('disk full'));
		assert.strictEqual(phase(s, 'files').status, STATUS_FAILED);
		assert.strictEqual(s.status, RUN_FAILED);
		assert.strictEqual(s.error, 'disk full');
		assert.ok(s.finishedAt);
	});

	it('accepts a plain string as well as an Error', function () {
		assert.strictEqual(failPhase(run(), 'files', 'went wrong').error, 'went wrong');
	});

	it('can fail a run outside any phase', function () {
		var s = failRun(run(), new Error('handoff never started'));
		assert.strictEqual(s.status, RUN_FAILED);
		assert.strictEqual(isTerminal(s), true);
	});
});

describe('completeRun', function () {

	it('completes a run whose phases all settled', function () {
		var s = run(['preflight']);
		s = finishPhase(beginPhase(s, 'preflight'), 'preflight', 'ok');
		for (var name of PHASES) {
			if (name !== 'preflight') s = skipPhase(s, name, 'not part of this run');
		}
		s = completeRun(s);
		assert.strictEqual(s.status, RUN_COMPLETE);
		assert.ok(s.finishedAt);
	});

	it('refuses over a failed phase', function () {
		// The worst outcome available here: a half-applied tree reported as a
		// successful update, with nothing else marking it as broken.
		var s = failPhase(beginPhase(run(), 'files'), 'files', new Error('boom'));
		assert.throws(function () { completeRun(s); }, /failed phase: files/);
	});

	it('refuses while a phase is still running', function () {
		var s = beginPhase(run(), 'files');
		assert.throws(function () { completeRun(s); }, /still running: files/);
	});

	it('warns about an intended phase nobody ran', function () {
		// Not a failure, because the files did land, but it means the caller
		// skipped a step it said it would do and somebody should know.
		var s = run(['preflight', 'files']);
		s = finishPhase(beginPhase(s, 'preflight'), 'preflight', 'ok');
		s = completeRun(s);
		assert.ok(s.warnings.some(function (w) { return /files was intended but never ran/.test(w); }),
			JSON.stringify(s.warnings));
	});
});

describe('summarise', function () {

	it('counts what happened and what is happening', function () {
		var s = run(['preflight', 'files', 'verify']);
		s = finishPhase(beginPhase(s, 'preflight'), 'preflight', 'ok');
		s = skipPhase(s, 'stop', 'not implemented');
		s = beginPhase(s, 'files');

		var out = summarise(s);
		assert.strictEqual(out.done, 1);
		assert.strictEqual(out.skipped, 1);
		assert.strictEqual(out.current, 'files');
		assert.strictEqual(out.total, 3, 'total counts intended phases, not all ten');
		assert.strictEqual(out.status, RUN_RUNNING);
	});

	it('measures against now while a run is live, and against the end once it is not', function () {
		var s = run();
		assert.ok(summarise(s).elapsedMs >= 0);
		var done = failRun(s, 'stopped', new Date('2026-09-13T10:00:05Z'));
		assert.strictEqual(summarise(done).elapsedMs, 5000);
	});

	it('carries the error and the warnings, which are what a person reads first', function () {
		var s = addWarning(failPhase(run(), 'files', 'boom'), 'kept your config/theme.json');
		var out = summarise(s);
		assert.strictEqual(out.error, 'boom');
		assert.deepStrictEqual(out.warnings, ['kept your config/theme.json']);
	});

	it('has nothing to say about nothing', function () {
		assert.strictEqual(summarise(null), null);
	});
});
