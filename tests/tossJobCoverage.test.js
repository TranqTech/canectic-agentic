// tests/tossJobCoverage.test.js — every job that can be put on the `toss`
// queue must be handled by both consumers of that queue.
//
// There are two: the standalone worker (bin/worker.js) and the embedded worker
// the gateway starts under PROCESS_MODE=embedded (src/queues/embedded.js).
// They are separate switch statements over the same job names, and nothing has
// ever held them together.
//
// An unhandled name does not throw. BullMQ hands the job to the consumer, the
// switch falls through to `default`, one line is logged at level 3, and the job
// is marked COMPLETE. The queue drains, the dashboard is clean, and the work
// never happened. That is how `tic:inbound` and `tic:outbound` went missing
// from embedded mode: file echoes did not work in either direction, in silence.
//
// The producers are the source of truth here rather than a hand-written list,
// so adding a queue name without teaching both consumers about it fails.
//
// Pure: reads source text, imports nothing, touches no Redis or PostgreSQL.
// Run: npx mocha --no-config --no-package tests/tossJobCoverage.test.js

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

// ---------------------------------------------------------------------------
// Producers: what can land on the toss queue
// ---------------------------------------------------------------------------

// Enqueued on demand by jobs.js helpers.
var ON_DEMAND = extract(read('src/queues/jobs.js'), /tossQueue\.add\('([a-z0-9:-]+)'/g);

// Registered as repeatable schedulers against the same queue.
var SCHEDULED = extract(read('src/queues/schedules.js'), /tossQueue\.upsertJobScheduler\('([a-z0-9:-]+)'/g);

var PRODUCED = new Set([...ON_DEMAND, ...SCHEDULED]);

// ---------------------------------------------------------------------------
// Consumers: what each switch actually handles
// ---------------------------------------------------------------------------

var CASE_LABEL = /case '([a-z0-9:-]+)'/g;

var HANDLED = {
	'bin/worker.js':        extract(read('bin/worker.js'), CASE_LABEL),
	'src/queues/embedded.js': extract(read('src/queues/embedded.js'), CASE_LABEL),
};

// ---------------------------------------------------------------------------

describe('toss queue job coverage', function () {

	it('finds the producers, so a broken regex cannot pass this file vacuously', function () {
		assert.ok(ON_DEMAND.size >= 10,
			'expected jobs.js to enqueue many toss jobs, found ' + ON_DEMAND.size);
		assert.ok(SCHEDULED.has('outbound-sweep'),
			'expected the periodic outbound sweep to be registered on the toss queue');
		// Named explicitly: these are the ones whose absence is silent.
		assert.ok(ON_DEMAND.has('tic:inbound'));
		assert.ok(ON_DEMAND.has('tic:outbound'));
	});

	Object.keys(HANDLED).forEach(function (consumer) {
		it(consumer + ' handles every job the toss queue can carry', function () {
			var handled = HANDLED[consumer];
			var missing = [...PRODUCED].filter(function (name) { return !handled.has(name); }).sort();

			assert.deepStrictEqual(missing, [],
				consumer + ' silently completes these toss jobs without doing the work: ' +
				missing.join(', '));
		});
	});

	it('both consumers agree on the toss job names', function () {
		// Not the same as the check above: this catches a name one consumer
		// grew and the other did not, before a producer for it even exists.
		var worker = HANDLED['bin/worker.js'];
		var embedded = HANDLED['src/queues/embedded.js'];

		var tossNames = [...PRODUCED].sort();
		for (var name of tossNames) {
			assert.strictEqual(worker.has(name), embedded.has(name),
				'toss job "' + name + '" is handled by one consumer but not the other');
		}
	});
});
