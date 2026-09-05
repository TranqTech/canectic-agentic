// tests/helpers/redisAvailable.js — shared Redis reachability probe for tests.
//
// Companion to dbAvailable.js, and for the same reason: the node-redis client
// retries internally, so awaiting a connection in a mocha hook turns an
// unreachable Redis into a hook timeout reported as a failure rather than a
// skip. The probe is raced against a bound and swallows both the rejection and
// the hang.
//
// Cached, so a run pays for at most one probe.
//
// Usage:
//
//   import { redisAvailable } from './helpers/redisAvailable.js';
//
//   describe('something that needs redis', function () {
//     var haveRedis = false;
//     before(async function () {
//       this.timeout(12000);
//       haveRedis = await redisAvailable();
//     });
//     beforeEach(function () { if (!haveRedis) this.skip(); });
//     ...
//   });

var cached = null;

async function redisAvailable(timeoutMs) {
	if (cached !== null) return cached;

	var bound = timeoutMs || 6000;
	try {
		var redisMod = await import('../../src/middleware/db/redis.js');
		var probe = (async function () {
			var client = await redisMod.getClient();
			await client.ping();
			return true;
		})().catch(function () { return false; });

		cached = await Promise.race([
			probe,
			new Promise(function (resolve) { setTimeout(function () { resolve(false); }, bound); }),
		]);
	} catch (err) {
		cached = false;
	}
	return cached;
}

export { redisAvailable };
