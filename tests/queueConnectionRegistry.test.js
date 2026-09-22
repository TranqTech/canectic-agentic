// tests/queueConnectionRegistry.test.js: every queue connection can be closed.
//
// Several models open an event publisher lazily and keep it privately for the
// life of the process, so nothing outside them could close it and the test
// suite could not exit on its own (#46). createQueueConnection() now records
// what it opens and closeAllQueueConnections() closes whatever is left.
//
// Run: npx mocha tests/queueConnectionRegistry.test.js

import assert from 'assert';
import { redisAvailable } from './helpers/redisAvailable.js';
import { createQueueConnection, closeAllQueueConnections } from '../src/queues/connection.js';

function ended(conn) {
	return new Promise(function (resolve) {
		if (conn.status === 'end') return resolve();
		conn.once('end', resolve);
	});
}

describe('closeAllQueueConnections', function () {
	var haveRedis = false;
	before(async function () {
		this.timeout(12000);
		haveRedis = await redisAvailable();
	});
	beforeEach(function () { if (!haveRedis) this.skip(); });

	it('closes connections nobody kept a way to close', async function () {
		// Closes anything an earlier suite left too, so the count is ours.
		closeAllQueueConnections();
		var a = createQueueConnection();
		var b = createQueueConnection();
		await a.ping();
		assert.strictEqual(closeAllQueueConnections(), 2);
		await Promise.all([ended(a), ended(b)]);
		assert.strictEqual(a.status, 'end');
		assert.strictEqual(b.status, 'end');
	});

	it('forgets a connection closed by its owner', async function () {
		closeAllQueueConnections();
		var c = createQueueConnection();
		await c.ping();
		c.disconnect();
		await ended(c);
		assert.strictEqual(closeAllQueueConnections(), 0);
	});
});
