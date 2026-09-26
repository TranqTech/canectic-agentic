// tests/queueJobCoverage.test.js — every job that can be put on a queue is
// handled by everything that consumes that queue.
//
// Two processes consume these queues: the standalone worker (bin/worker.js)
// and the embedded worker the gateway starts under PROCESS_MODE=embedded
// (src/queues/embedded.js).
//
// An unhandled name does not throw. BullMQ hands the job over, the switch
// falls through to `default`, one line is logged at level 3 — verbose, so
// nothing at a normal log level — and the job is marked COMPLETE. The queue
// drains, the schedule diagnostics report every scheduler healthy, and the
// work never happened.
//
// It has happened twice. `tic:inbound` and `tic:outbound` were missing from
// the embedded toss switch, so file echoes did not work in either direction.
// The embedded maintenance switch handled 7 of 33 names, so an embedded board
// never purged a log, never enforced retention, and never ran a timed event,
// while `registerSchedules()` cheerfully fired all of them.
//
// The producers are the source of truth rather than a hand-written list, so
// adding a queue name without teaching the consumers about it fails here.
//
// Pure: reads source text, opens no Redis or PostgreSQL.
// Run: npx mocha --no-config --no-package tests/queueJobCoverage.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Every distinct match of `re` group 1, as a Set.
function extract(source, re) {
	var found = new Set();
	var m;
	while ((m = re.exec(source)) !== null) found.add(m[1]);
	return found;
}

// A repeatable scheduler is registered under a key that may be per-connection
// or per-entity (`generate-stub:17`, `poll:<uuid>`) while the job NAME it
// produces is in the options object that follows. Take the name, since that is
// what the consumer switches on.
function extractSchedulerNames(source, queueVar) {
	var found = new Set();
	var re = new RegExp(queueVar + '\\.upsertJobScheduler\\(', 'g');
	var m;
	while ((m = re.exec(source)) !== null) {
		var window = source.slice(m.index, m.index + 600);
		var nameMatch = window.match(/name:\s*'([a-z0-9:-]+)'/);
		if (nameMatch) found.add(nameMatch[1]);
	}
	return found;
}

// Files that enqueue work. Routes enqueue admin-triggered jobs directly.
var PRODUCER_FILES = ['src/queues/jobs.js', 'src/queues/schedules.js', 'src/routes/admin.js'];

function producedFor(queueVar) {
	var names = new Set();
	for (var rel of PRODUCER_FILES) {
		var src = read(rel);
		for (var n of extract(src, new RegExp(queueVar + "\\.add\\('([a-z0-9:-]+)'", 'g'))) names.add(n);
		// jobs.js goes through addDeduped(queue, 'name', ...) since the
		// completed-job dedupe fix; same producer, different spelling.
		for (var d of extract(src, new RegExp("addDeduped\\(" + queueVar + ", '([a-z0-9:-]+)'", 'g'))) names.add(d);
		for (var s of extractSchedulerNames(src, queueVar)) names.add(s);
	}
	return names;
}

var CASE_LABEL = /case '([a-z0-9:-]+)'/g;

// ---------------------------------------------------------------------------
// Toss queue — still a switch in each consumer
// ---------------------------------------------------------------------------

describe('toss queue job coverage', function () {

	var PRODUCED = producedFor('tossQueue');
	var HANDLED = {
		'bin/worker.js': extract(read('bin/worker.js'), CASE_LABEL),
		'src/queues/embedded.js': extract(read('src/queues/embedded.js'), CASE_LABEL),
	};

	it('finds the producers, so a broken regex cannot pass this file vacuously', function () {
		assert.ok(PRODUCED.size >= 10,
			'expected many toss jobs, found ' + PRODUCED.size);
		assert.ok(PRODUCED.has('outbound-sweep'),
			'expected the periodic outbound sweep to be registered on the toss queue');
		// Named explicitly: these are the ones whose absence was silent.
		assert.ok(PRODUCED.has('tic:inbound'));
		assert.ok(PRODUCED.has('tic:outbound'));
	});

	Object.keys(HANDLED).forEach(function (consumer) {
		it(consumer + ' handles every job the toss queue can carry', function () {
			var handled = HANDLED[consumer];
			var missing = [...PRODUCED].filter(function (n) { return !handled.has(n); }).sort();

			assert.deepStrictEqual(missing, [],
				consumer + ' silently completes these toss jobs without doing the work: ' +
				missing.join(', '));
		});
	});

	it('both consumers agree on the toss job names', function () {
		var worker = HANDLED['bin/worker.js'];
		var embedded = HANDLED['src/queues/embedded.js'];
		for (var name of [...PRODUCED].sort()) {
			assert.strictEqual(worker.has(name), embedded.has(name),
				'toss job "' + name + '" is handled by one consumer but not the other');
		}
	});
});

// ---------------------------------------------------------------------------
// The CLI tosser is a producer too, and was missing half of FTN
// ---------------------------------------------------------------------------

describe('src/tools/tosser.js', function () {

	var source = read('src/tools/tosser.js');

	it('tosses file echoes whenever it tosses FTN', function () {
		// --ftn covers echomail, netmail AND file echoes: they share the
		// inbound directory, the outbound directory and the mailer. The tool
		// enqueued only the message half, while CLAUDE.md and
		// FILES_ARCHITECTURE.md both listed it as a trigger for the TIC jobs,
		// so a sysop tossing by hand moved mail, moved no files, and was told
		// nothing had gone wrong.
		var pairs = [
			['enqueueFtnInbound', 'enqueueTicInbound'],
			['enqueueFtnOutbound', 'enqueueTicOutbound'],
		];
		for (var pair of pairs) {
			if (!source.includes(pair[0])) continue;
			assert.ok(source.includes(pair[1]),
				'the CLI tosser calls ' + pair[0] + ' but not ' + pair[1] +
				', so --ftn would move messages and silently skip file echoes');
		}
	});
});

// ---------------------------------------------------------------------------
// Maintenance queue — one shared switch, so the question is different
// ---------------------------------------------------------------------------

describe('maintenance queue job coverage', function () {

	var PRODUCED = producedFor('maintenanceQueue');
	var MAINTENANCE_JOBS = null;

	before(async function () {
		MAINTENANCE_JOBS = (await import('../src/maintenance/maintenanceJobs.js')).MAINTENANCE_JOBS;
	});

	it('finds the producers, so a broken regex cannot pass this file vacuously', function () {
		assert.ok(PRODUCED.size >= 20,
			'expected many maintenance jobs, found ' + PRODUCED.size);
		// One of each producer shape: a plain add, a plain scheduler, and a
		// scheduler whose key is per-entity while its name is not.
		assert.ok(PRODUCED.has('scan-inbound'), 'scheduler-produced name');
		assert.ok(PRODUCED.has('message-maintenance'), 'daily scheduler name');
		assert.ok(PRODUCED.has('generate-stub'), 'per-entity scheduler key, plain name');
	});

	it('handles every job the maintenance queue can carry', function () {
		var handled = new Set(MAINTENANCE_JOBS);
		var missing = [...PRODUCED].filter(function (n) { return !handled.has(n); }).sort();

		assert.deepStrictEqual(missing, [],
			'these maintenance jobs are enqueued and silently marked complete: ' + missing.join(', '));
	});

	it('declares the job list it actually implements', function () {
		// MAINTENANCE_JOBS is what the coverage check above is measured
		// against, so it has to describe the switch rather than sit beside it.
		var source = read('src/maintenance/maintenanceJobs.js');
		var implemented = extract(source, CASE_LABEL);

		var declaredNotImplemented = MAINTENANCE_JOBS.filter(function (n) { return !implemented.has(n); }).sort();
		assert.deepStrictEqual(declaredNotImplemented, [],
			'MAINTENANCE_JOBS names jobs with no case: ' + declaredNotImplemented.join(', '));

		var implementedNotDeclared = [...implemented].filter(function (n) {
			return MAINTENANCE_JOBS.indexOf(n) === -1;
		}).sort();
		assert.deepStrictEqual(implementedNotDeclared, [],
			'these cases exist but are not in MAINTENANCE_JOBS: ' + implementedNotDeclared.join(', '));
	});

	it('can resolve every module its cases load', function () {
		// Each case imports what it needs on demand, so a wrong relative path
		// throws only when that one job first runs — which for a daily purge
		// means the failure surfaces a day later on somebody else's board.
		// The paths moved wholesale when this switch came out of bin/worker.js
		// (`../src/maintenance/x.js` became `./x.js`), which is exactly the
		// edit that gets one of twenty-seven wrong.
		var source = read('src/maintenance/maintenanceJobs.js');
		var specs = [...source.matchAll(/await import\("([^"]+)"\)/g)].map(function (m) { return m[1]; });
		var relative = [...new Set(specs)].filter(function (s) { return s.startsWith('.'); });

		assert.ok(relative.length >= 20, 'expected many dynamic imports, found ' + relative.length);

		var missing = relative.filter(function (spec) {
			return !fs.existsSync(path.resolve(ROOT, 'src/maintenance', spec));
		}).sort();

		assert.deepStrictEqual(missing, [],
			'maintenanceJobs.js imports modules that do not exist: ' + missing.join(', '));
	});

	it('is reached from both consumers rather than copied into either', function () {
		// The drift this file exists to prevent came from two switches over
		// one queue. Neither consumer should grow its own again.
		for (var rel of ['bin/worker.js', 'src/queues/embedded.js']) {
			var src = read(rel);
			assert.ok(/runMaintenanceJob\(/.test(src),
				rel + ' must delegate to maintenanceJobs.runMaintenanceJob()');
		}
	});
});
