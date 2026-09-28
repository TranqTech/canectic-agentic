// tests/maintenanceJobIds.test.js -- job ids for maintenance jobs that carry
// options (#79).
//
// regen-html used the fixed id `regen-html`, so a second request while one
// was waiting or running was handed the first job and its --area, --width and
// --batch were dropped, while the CLI announced them as queued. Ids are now
// derived from the options, and a regen is one job per area so a whole board
// cannot overrun maintenance_job_timeout as a single job.
//
// Pure: no queue is touched, so the dev worker is never handed a test job.

import assert from 'assert';
import { optionJobId, regenHtmlRequests } from '../src/queues/jobs.js';

describe('maintenance job ids (#79)', function () {

	describe('optionJobId', function () {
		it('is the bare base when there are no options', function () {
			assert.strictEqual(optionJobId('purge-tossed-manual', {}), 'purge-tossed-manual');
			assert.strictEqual(optionJobId('rethread', { areas: null, dryRun: false }), 'rethread');
		});

		it('differs when the options differ', function () {
			var a = optionJobId('regen-html', { areas: ['GENERAL'], batchSize: 100 });
			var b = optionJobId('regen-html', { areas: ['OTHERNETS'], batchSize: 100 });
			var c = optionJobId('regen-html', { areas: ['GENERAL'], batchSize: 100, forceWidth: 80 });
			assert.notStrictEqual(a, b);
			assert.notStrictEqual(a, c);
		});

		it('is the same for the same request whatever the order', function () {
			assert.strictEqual(
				optionJobId('fix-msgids', { areas: ['B', 'A'], batchSize: 500 }),
				optionJobId('fix-msgids', { batchSize: 500, areas: ['A', 'B'] }));
		});

		it('tells a dry run from a real run of the same areas', function () {
			assert.notStrictEqual(
				optionJobId('rethread', { areas: ['A'], dryRun: true }),
				optionJobId('rethread', { areas: ['A'], dryRun: false }));
		});

		it('holds no colon, which BullMQ refuses in an id', function () {
			assert.doesNotMatch(optionJobId('regen-html', { areas: ['A:B'] }), /:/);
		});
	});

	describe('regenHtmlRequests', function () {
		it('is one job per area', function () {
			var reqs = regenHtmlRequests(['A', 'B', 'C'], { batchSize: 50 });
			assert.deepStrictEqual(reqs.map(function (r) { return r.data.areas; }), [['A'], ['B'], ['C']]);
			assert.strictEqual(new Set(reqs.map(function (r) { return r.jobId; })).size, 3);
			assert.ok(reqs.every(function (r) { return r.data.batchSize === 50; }));
		});

		it('gives an area the same id in two requests with the same options, so it merges', function () {
			var first = regenHtmlRequests(['A', 'B']);
			var second = regenHtmlRequests(['B', 'C']);
			assert.strictEqual(first[1].jobId, second[0].jobId);
		});

		it('gives an area a different id when the width differs, so it queues', function () {
			var plain = regenHtmlRequests(['A'])[0].jobId;
			var wide = regenHtmlRequests(['A'], { forceWidth: 80 })[0].jobId;
			assert.notStrictEqual(plain, wide);
		});

		it('lists a repeated area once', function () {
			assert.strictEqual(regenHtmlRequests(['A', 'A']).length, 1);
		});
	});
});
