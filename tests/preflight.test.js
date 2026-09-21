// tests/preflight.test.js: what is checked before an update is offered.
//
// The timing is the point. Several of these are only answerable while the BBS
// is running, and once the updater has stopped the processes, "how many callers
// are online" is zero and "is a job in flight" is no. Asking then is asking a
// question the asking has already changed the answer to.
//
// Two rules carry the weight. Blocking is reserved for things that make the
// update fail; everything else warns, because a preflight that refused on
// judgement calls would be one a sysop learns to bypass. And unknown is never
// treated as bad: a free-space figure that cannot be read must not refuse the
// update, or every filesystem without statfs becomes un-updatable.
//
// Pure: every probe is passed in.

import assert from 'assert';
import { preflight, LEVEL_BLOCK, LEVEL_WARN, LEVEL_OK, STAGING_HEADROOM } from '../src/release/preflight.js';

function ids(list) { return list.map(function (c) { return c.id; }); }
function find(r, id) { return r.checks.filter(function (c) { return c.id === id; })[0]; }

describe('preflight', function () {

	it('passes a system with nothing wrong', function () {
		var r = preflight({
			nodeVersion: '26.8.1', nodeMin: '22.0.0',
			freeBytes: 10 * 1024 * 1024 * 1024, artifactBytes: 8 * 1024 * 1024,
			databaseReachable: true, callersOnline: 0
		});
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(r.blocking, []);
		assert.deepStrictEqual(r.warnings, []);
	});

	it('reports everything at once rather than stopping at the first problem', function () {
		// A maintenance window is the worst place to fix one thing, run it
		// again, and find the next.
		var r = preflight({
			nodeVersion: '20.0.0', nodeMin: '22.0.0',
			freeBytes: 1024, artifactBytes: 8 * 1024 * 1024,
			databaseReachable: false, callersOnline: 3
		});
		assert.strictEqual(r.ok, false);
		assert.ok(r.blocking.length >= 3, ids(r.blocking).join(','));
		assert.ok(ids(r.blocking).indexOf('node') !== -1);
		assert.ok(ids(r.blocking).indexOf('disk') !== -1);
		assert.ok(ids(r.blocking).indexOf('database') !== -1);
	});
});

describe('what blocks', function () {

	it('blocks on Node older than the release needs', function () {
		var r = preflight({ nodeVersion: '20.0.0', nodeMin: '22.0.0' });
		assert.strictEqual(find(r, 'node').level, LEVEL_BLOCK);
		assert.strictEqual(preflight({ nodeVersion: '22.0.0', nodeMin: '22.0.0' }).ok, true,
			'exactly the minimum is fine');
	});

	it('blocks on not enough disk for staging, the backup and the dump', function () {
		var artifact = 8 * 1024 * 1024;
		var db = 700 * 1024 * 1024;
		var enough = artifact * STAGING_HEADROOM + db;
		assert.strictEqual(preflight({ freeBytes: enough, artifactBytes: artifact, databaseBytes: db }).ok, true);
		assert.strictEqual(preflight({ freeBytes: enough - 1, artifactBytes: artifact, databaseBytes: db }).ok, false);
	});

	it('blocks on an unreachable database, since the schema pass cannot run', function () {
		assert.strictEqual(preflight({ databaseReachable: false }).ok, false);
	});

	it('blocks on a target it cannot write to', function () {
		assert.strictEqual(preflight({ targetWritable: false }).ok, false);
	});

	it('blocks when a release rebuilds a native module and there is no compiler', function () {
		// The OS upgrade that silently removed build-essential is why this is
		// here: it only surfaced on the next clean npm install.
		assert.strictEqual(preflight({ nativeModules: true, buildToolchain: false }).ok, false);
		assert.strictEqual(preflight({ nativeModules: true, buildToolchain: true }).ok, true);
		assert.strictEqual(preflight({ nativeModules: false, buildToolchain: false }).ok, true,
			'a release that rebuilds nothing does not need a compiler');
	});
});

describe('what only warns', function () {

	it('warns about connected callers and does not block', function () {
		// The single most useful thing the page can say, and the sysop's call
		// whether three people mid-door is a reason to wait.
		var r = preflight({ callersOnline: 3 });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(find(r, 'callers').level, LEVEL_WARN);
		assert.ok(/warn 3 connected users, then disconnect them/.test(find(r, 'callers').summary));
	});

	it('gets the singular right, because this line is read by a person', function () {
		assert.ok(/1 connected user\b/.test(find(preflight({ callersOnline: 1 }), 'callers').summary));
	});

	it('says so plainly when nobody is on', function () {
		assert.strictEqual(find(preflight({ callersOnline: 0 }), 'callers').level, LEVEL_OK);
	});

	it('warns about jobs in flight', function () {
		var r = preflight({ jobsInFlight: 2 });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(find(r, 'jobs').level, LEVEL_WARN);
	});
});

describe('unknown is not bad', function () {

	it('warns rather than blocking when free space cannot be measured', function () {
		// Treating an unreadable figure as no free space would refuse every
		// update on a filesystem whose statfs is unsupported.
		var r = preflight({ freeBytes: null, artifactBytes: 8 * 1024 * 1024 });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(find(r, 'disk').level, LEVEL_WARN);
	});

	it('says nothing about probes that were not run', function () {
		// The updater's own re-check cannot see callers or jobs, and inventing
		// an answer would be worse than omitting the line.
		var r = preflight({ nodeVersion: '26.8.1' });
		assert.strictEqual(find(r, 'callers'), undefined);
		assert.strictEqual(find(r, 'jobs'), undefined);
		assert.strictEqual(find(r, 'database'), undefined);
		assert.strictEqual(r.ok, true);
	});

	it('has an opinion about nothing at all', function () {
		var r = preflight({});
		assert.strictEqual(r.ok, true);
	});
});

// Added after noticing that socat, which the recommended DOS door launch type
// needs, appeared in no install instruction anywhere. The general problem is
// that none of Canectic's external programs are needed to BOOT a board, so each
// is discovered missing at the moment a caller first uses the feature it
// belongs to.
//
// Update time is a second place worth saying it, not a duplicate of install
// time: an OS release upgrade disables third-party repositories, which is where
// dosemu2 comes from, and has been observed removing build-essential outright.
// A board can therefore arrive at an update having quietly lost a tool it had
// when it was installed.
describe('external programs the board needs but does not need to boot', function () {

	it('warns about a missing pg_dump, and says what is lost', function () {
		var r = preflight({ dumpTool: false });
		var c = find(r, 'dump');
		assert.ok(c, 'nothing was said about pg_dump');
		assert.strictEqual(c.level, LEVEL_WARN);
		assert.match(c.summary + ' ' + (c.detail || ''), /postgresql-client|backed up/);
	});

	// Not blocking: --no-dump is a supported way to run an update, and refusing
	// the update outright would strand a board with a remote database and no
	// local client.
	it('does not block an update over pg_dump', function () {
		assert.strictEqual(preflight({ dumpTool: false }).ok, true);
	});

	it('says nothing when pg_dump is there', function () {
		assert.strictEqual(find(preflight({ dumpTool: true }), 'dump'), undefined);
	});

	it('names the other missing programs in one line', function () {
		var r = preflight({ missingTools: ['dosemu', 'socat'] });
		var c = find(r, 'tools');
		assert.ok(c, 'nothing was said about the missing tools');
		assert.strictEqual(c.level, LEVEL_WARN);
		assert.match(c.summary, /dosemu/);
		assert.match(c.summary, /socat/);
	});

	it('says nothing when none are missing', function () {
		assert.strictEqual(find(preflight({ missingTools: [] }), 'tools'), undefined);
		assert.strictEqual(find(preflight({}), 'tools'), undefined);
	});

	// Same rule the disk check follows: a probe that could not run must not
	// invent a warning, because a preflight nobody trusts is a preflight
	// everybody clicks past.
	it('says nothing when the probe did not run', function () {
		var r = preflight({ nodeVersion: '26.8.1' });
		assert.strictEqual(find(r, 'dump'), undefined);
		assert.strictEqual(find(r, 'tools'), undefined);
	});
});
