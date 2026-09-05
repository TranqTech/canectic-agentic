// tests/helpers/dbAvailable.js — shared PostgreSQL reachability probe for tests.
//
// Most of the suite is pure unit tests, but a handful genuinely need a
// database. Those should skip when one is not reachable rather than fail, so
// `npm test` stays meaningful on a machine without PostgreSQL.
//
// Doing that needs care. The pg pool retries internally, so awaiting a query
// directly turns an unreachable database into a mocha hook timeout, which is
// reported as a failure rather than a skip. The probe below is raced against a
// bound and swallows both the rejection and the hang.
//
// The result is cached, so a run pays for at most one probe no matter how many
// suites ask.
//
// Usage:
//
//   import { dbAvailable } from './helpers/dbAvailable.js';
//
//   describe('something that needs the database', function () {
//     var haveDb = false;
//     before(async function () {
//       this.timeout(12000);
//       haveDb = await dbAvailable();
//     });
//     beforeEach(function () { if (!haveDb) this.skip(); });
//     ...
//   });
//
// beforeEach is deliberate: it skips every test in the suite without each one
// having to check for itself.

var cached = null;

async function dbAvailable(timeoutMs) {
	if (cached !== null) return cached;

	var bound = timeoutMs || 6000;
	try {
		var pg = await import('../../src/middleware/db/postgres.js');
		var probe = pg.queryOne('SELECT 1 AS ok')
			.then(function (row) { return !!row; })
			.catch(function () { return false; });

		cached = await Promise.race([
			probe,
			new Promise(function (resolve) { setTimeout(function () { resolve(false); }, bound); }),
		]);
	} catch (err) {
		cached = false;
	}
	return cached;
}

export { dbAvailable };
