// tests/redisQueue.test.js — Integration tests for the Redis clients and BullMQ.
//
// Unlike the rest of the suite these need a live Redis, so every test skips
// cleanly when one is not reachable. That keeps `npm test` green on a machine
// without Redis while still catching real regressions where one exists.
//
// The main thing being guarded is the wire protocol. node-redis 6 and ioredis 6
// both default to RESP3, which changes the shape of several replies; both are
// pinned to RESP2 (`RESP: 2` in redis.js, `protocol: 2` in connection.js). A
// silent revert to RESP3 would not fail a unit test but would change what the
// session store and cache hand back, so the shape assertions below are
// deliberate rather than incidental.
//
// Everything is namespaced under zz_test_ and removed afterwards so a run
// against a live system cannot disturb it.
// Run: npx mocha tests/redisQueue.test.js

import assert from 'assert';
import { redisAvailable } from './helpers/redisAvailable.js';

var KEY = 'zz_test_redisqueue';
var QUEUE = 'zz_test_redisqueue_q';

// Reachability is decided once, in a single before hook, so the whole file
// skips together rather than each test discovering it independently.
var available = false;
var redisMod = null;
var connMod = null;
var bullmq = null;

describe('Redis and BullMQ integration', function () {
	this.timeout(20000);

	before(async function () {
		this.timeout(12000);
		try {
			redisMod = await import('../src/middleware/db/redis.js');
			connMod  = await import('../src/queues/connection.js');
			bullmq   = await import('bullmq');

			// Shared bounded probe; see tests/helpers/redisAvailable.js for why
			// awaiting getClient() directly would time out the hook instead.
			available = await redisAvailable();
		} catch (err) {
			available = false;
		}
	});

	// ------------------------------------------------------------------
	describe('node-redis client (sessions, cache)', function () {

		it('connects and round-trips a string', async function () {
			if (!available) return this.skip();
			var c = await redisMod.getClient();
			await c.set(KEY, 'hello');
			assert.strictEqual(await c.get(KEY), 'hello');
			await c.del(KEY);
		});

		it('round-trips a hash', async function () {
			if (!available) return this.skip();
			var c = await redisMod.getClient();
			await c.hSet(KEY + ':h', { a: '1', b: 'two' });
			var h = await c.hGetAll(KEY + ':h');
			assert.strictEqual(h.a, '1');
			assert.strictEqual(h.b, 'two');
			await c.del(KEY + ':h');
		});

		it('returns hashes as plain objects, not a RESP3 map', async function () {
			// RESP3 hands hashes back differently. This asserts the RESP2 pin in
			// redis.js is still in place; sessionstore.js relies on this shape.
			if (!available) return this.skip();
			var c = await redisMod.getClient();
			await c.hSet(KEY + ':shape', { k: 'v' });
			var h = await c.hGetAll(KEY + ':shape');
			assert.strictEqual(Object.getPrototypeOf(h), Object.prototype,
				'hash reply should be a plain object; a null-prototype or Map suggests RESP3');
			await c.del(KEY + ':shape');
		});

		it('applies and reports a TTL as a number', async function () {
			if (!available) return this.skip();
			var c = await redisMod.getClient();
			await c.set(KEY + ':ttl', 'x');
			await c.expire(KEY + ':ttl', 60);
			var ttl = await c.ttl(KEY + ':ttl');
			assert.strictEqual(typeof ttl, 'number');
			assert.ok(ttl > 0 && ttl <= 60, 'ttl should be within the window, got ' + ttl);
			await c.del(KEY + ':ttl');
		});
	});

	// ------------------------------------------------------------------
	describe('ioredis connection (BullMQ transport)', function () {

		it('pins RESP2 in the queue connection config', function () {
			if (!available) return this.skip();
			var cfg = connMod.getQueueConfig();
			assert.strictEqual(cfg.protocol, 2,
				'ioredis 6 defaults to RESP3; connection.js should pin protocol 2');
		});

		it('sets maxRetriesPerRequest to null as BullMQ requires', function () {
			if (!available) return this.skip();
			assert.strictEqual(connMod.getQueueConfig().maxRetriesPerRequest, null);
		});

		it('connects and round-trips a string and a hash', async function () {
			if (!available) return this.skip();
			var io = connMod.createQueueConnection();
			try {
				await io.set(KEY + ':io', 'world');
				assert.strictEqual(await io.get(KEY + ':io'), 'world');

				await io.hset(KEY + ':ioh', 'x', '9');
				var h = await io.hgetall(KEY + ':ioh');
				assert.strictEqual(h.x, '9');

				await io.del(KEY + ':io');
				await io.del(KEY + ':ioh');
			} finally {
				await io.quit();
			}
		});
	});

	// ------------------------------------------------------------------
	describe('BullMQ round trip', function () {

		it('enqueues a job, processes it, and returns a result', async function () {
			if (!available) return this.skip();

			var Queue = bullmq.Queue;
			var Worker = bullmq.Worker;

			var queue = new Queue(QUEUE, { connection: connMod.createQueueConnection() });
			var seen = null;

			var worker = new Worker(QUEUE, async function (job) {
				seen = { name: job.name, data: job.data };
				return { echoed: job.data.value };
			}, { connection: connMod.createQueueConnection() });

			try {
				var completed = new Promise(function (resolve) {
					worker.on('completed', function (job, result) { resolve(result); });
					worker.on('failed', function (job, err) { resolve({ error: err && err.message }); });
				});

				await queue.add('probe', { value: 42 });

				var result = await Promise.race([
					completed,
					new Promise(function (r) { setTimeout(function () { r({ error: 'timeout' }); }, 12000); }),
				]);

				assert.ok(seen, 'worker never received the job');
				assert.strictEqual(seen.data.value, 42);
				assert.strictEqual(result.echoed, 42, 'job did not complete cleanly: ' + JSON.stringify(result));
			} finally {
				await worker.close();
				await queue.obliterate({ force: true }).catch(function () {});
				await queue.close();
			}
		});
	});

	// ------------------------------------------------------------------
	after(async function () {
		if (!available) return;
		try {
			var c = await redisMod.getClient();
			for (var k of [KEY, KEY + ':h', KEY + ':shape', KEY + ':ttl', KEY + ':io', KEY + ':ioh']) {
				await c.del(k);
			}
		} catch (err) { /* best effort */ }
	});
});
