// tests/mailerJobs.test.js: one handler for the mailer queue, used by both consumers.
//
// bin/mailer.js and the embedded consumer in src/queues/embedded.js each had
// their own switch over mailer job names, and the embedded one lacked
// 'bso-scan' and 'nodelist-connect': on a PROCESS_MODE=embedded board the scan
// the tossers ask for after writing outbound packets and the admin's connect to
// a nodelist address were logged as unknown and did nothing.
//
// Pure apart from reading source files.
// Run: npx mocha --no-config --exit tests/mailerJobs.test.js

import assert from 'assert';
import fs from 'fs';
import { MAILER_JOBS, runMailerJob } from '../src/mailer/mailerJobs.js';

function fakeManager() {
	var calls = [];
	var rec = function (name) { return function () { calls.push([name].concat(Array.from(arguments))); return Promise.resolve(); }; };
	return {
		calls: calls,
		signalOutbound: rec('signalOutbound'),
		triggerPoll: rec('triggerPoll'),
		pollConnection: rec('pollConnection'),
		connectToNodelistAddress: rec('connectToNodelistAddress'),
		scanOutboundNow: rec('scanOutboundNow')
	};
}

describe('runMailerJob', function () {
	it('sends each job to the manager method that does it', async function () {
		var m = fakeManager();
		await runMailerJob(m, 'signal-outbound', { connectionUUID: 'c1' });
		await runMailerJob(m, 'trigger-poll', { connectionUUID: 'c2' });
		await runMailerJob(m, 'poll-scheduled', { connectionUUID: 'c3' });
		await runMailerJob(m, 'nodelist-connect', { nodelistData: { a: 1 }, destinationAddress: '1:2/3' });
		await runMailerJob(m, 'bso-scan', {});
		assert.deepStrictEqual(m.calls, [
			['signalOutbound', 'c1'],
			['triggerPoll', 'c2'],
			['pollConnection', 'c3'],
			['connectToNodelistAddress', { a: 1 }, '1:2/3'],
			['scanOutboundNow']
		]);
	});

	it('handles every name it declares, and says so for a name it does not know', async function () {
		for (var name of MAILER_JOBS) {
			assert.strictEqual(await runMailerJob(fakeManager(), name, {}), true, name);
		}
		assert.strictEqual(await runMailerJob(fakeManager(), 'no-such-job', {}), false);
	});
});

describe('the mailer queue producers and consumers', function () {
	it('only puts jobs on the mailer queue that runMailerJob handles', function () {
		var produced = new Set();
		var jobsSrc = fs.readFileSync('src/queues/jobs.js', 'utf8');
		var re = /addDeduped\(\s*mailerQueue\s*,\s*'([^']+)'/g, m;
		while ((m = re.exec(jobsSrc)) !== null) produced.add(m[1]);
		var schedSrc = fs.readFileSync('src/queues/schedules.js', 'utf8');
		var sre = /mailerQueue\.upsertJobScheduler\([\s\S]{0,300}?name:\s*'([^']+)'/g;
		while ((m = sre.exec(schedSrc)) !== null) produced.add(m[1]);
		assert.ok(produced.size >= 4, 'expected to find the producers, found ' + Array.from(produced).join(', '));
		var unhandled = Array.from(produced).filter(function (n) { return MAILER_JOBS.indexOf(n) === -1; });
		assert.deepStrictEqual(unhandled, []);
	});

	for (var rel of ['bin/mailer.js', 'src/queues/embedded.js']) {
		(function (file) {
			it(file + ' delegates to runMailerJob instead of keeping its own switch', function () {
				var src = fs.readFileSync(file, 'utf8');
				assert.ok(/runMailerJob\(/.test(src), file + ' must call runMailerJob');
				assert.ok(!/case\s+'(signal-outbound|trigger-poll|poll-scheduled|bso-scan|nodelist-connect)'/.test(src),
					file + ' still has its own case for a mailer job');
			});
		})(rel);
	}
});
