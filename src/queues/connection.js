/**
 * BullMQ connection factory.
 *
 * BullMQ requires ioredis (not the 'redis' npm package used by the rest of the
 * application).  Both clients coexist — this module manages only the ioredis
 * connections used by BullMQ queues and workers.
 *
 * Connection config is derived from the same env vars the application already
 * uses, plus an optional REDIS_BULLMQ_DB to isolate job data from session/cache
 * data on a separate Redis database number.
 */

import IORedis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Parse connection parameters from the existing redis_url env var
// Format: redis://[:password@]host:port[/db]
// ---------------------------------------------------------------------------

function parseRedisConfig() {
	const redisUrl = process.env.redis_url || 'redis://localhost:6379';
	const bullmqDb = parseInt(process.env.REDIS_BULLMQ_DB) || 2;

	try {
		const parsed = new URL(redisUrl);
		return {
			host: parsed.hostname || '127.0.0.1',
			port: parseInt(parsed.port) || 6379,
			password: parsed.password || process.env.REDIS_PASSWORD || undefined,
			db: bullmqDb,
			maxRetriesPerRequest: null,   // required by BullMQ
			// ioredis 6 defaults to RESP3, which changes reply shapes. Pin
			// RESP2 so behaviour matches v5; adopting RESP3 should be its own
			// deliberate change, not a side effect of a version bump.
			protocol: 2,
		};
	} catch (err) {
		// Fallback if URL parsing fails
		return {
			host: '127.0.0.1',
			port: 6379,
			password: process.env.REDIS_PASSWORD || undefined,
			db: bullmqDb,
			maxRetriesPerRequest: null,
			protocol: 2,
		};
	}
}

// Cache the parsed config so every connection uses the same settings
const redisConfig = parseRedisConfig();

/**
 * Create a new ioredis connection for BullMQ.
 *
 * Each BullMQ Queue and Worker needs its own connection instance (ioredis
 * connections are not shared).  Call this once per Queue/Worker and pass
 * the returned instance as the `connection` option.
 */
export function createQueueConnection() {
	var conn = new IORedis(redisConfig);
	_open.add(conn);
	conn.once('end', function () { _open.delete(conn); });
	return conn;
}

// Every connection made above that has not ended yet. Several modules open an
// event publisher lazily and keep it in a private variable for the life of the
// process, which is right for the application and leaves nothing that could
// close it: the test suite, which must exit on its own so that a leaked timer
// or socket fails the run (#46), had no way to let go of them.
var _open = new Set();

/**
 * Disconnect every queue connection still open. For the end of a process that
 * has nothing left to do, such as a test run; a running process shuts its
 * queues and workers down properly first, and this closes whatever is left.
 *
 * @returns {number} how many were closed
 */
export function closeAllQueueConnections() {
	var n = 0;
	for (var conn of Array.from(_open)) {
		try { conn.disconnect(); } catch (_) {}
		_open.delete(conn);
		n++;
	}
	return n;
}

/**
 * Return the parsed config object (for logging / diagnostics).
 */
export function getQueueConfig() {
	return { ...redisConfig, password: redisConfig.password ? '***' : undefined };
}
