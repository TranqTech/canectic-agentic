// tests/releasePipeline.test.js: the migration coverage rule.
//
// A move is safe when every migration already applied to this database also
// exists in the target release. Channel is not the test and neither is version,
// quite: someone on a development build from 1 September moving to a stable
// released on the 10th is moving forward and should be allowed. What constrains
// them is whether the target understands the state their database is in.
//
// The case version comparison misses is work that went out on development and
// then got deferred out of the stable cut. Version-wise the move is forward. In
// practice the database carries a migration the target does not ship.
//
// The same rule is asked in two places: at update time against a sysop's
// ledger, and at release time against every development build already
// published. The second is a warning on the maintainer's machine instead of a
// bug report from somebody who cannot move off development.
//
// Pure: no database, no services.

import assert from 'assert';
import { migrationsFrom, checkMoveSafety, checkStableCoverage, deltaShare } from '../src/release/pipelineCheck.js';

function build(version, migrations, base) {
	return { version: version, base: base === undefined ? '0.9.5a' : base, migrations: migrations };
}

describe('migrationsFrom', function () {

	it('is the union across releases, deduped and ordered', function () {
		assert.deepStrictEqual(migrationsFrom([
			build('0.9.5a.20260901', ['0001-a', '0002-b']),
			build('0.9.5a.20260913', ['0002-b', '0003-c'])
		]), ['0001-a', '0002-b', '0003-c']);
	});

	it('is empty for nothing', function () {
		assert.deepStrictEqual(migrationsFrom([]), []);
		assert.deepStrictEqual(migrationsFrom(null), []);
	});
});

describe('checkMoveSafety', function () {

	it('allows a move whose target ships everything the database has', function () {
		var r = checkMoveSafety({ applied: ['0001-a', '0002-b'], target: ['0001-a', '0002-b', '0003-c'] });
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(r.blocking, []);
	});

	it('allows a move to a target that ships exactly what has been applied', function () {
		assert.strictEqual(checkMoveSafety({ applied: ['0001-a'], target: ['0001-a'] }).ok, true);
	});

	it('refuses when the database carries a migration the target does not ship', function () {
		// The deferred-migration case. Forward by version, impossible in
		// practice.
		var r = checkMoveSafety({ applied: ['0001-a', '0007-fileecho-hashes'], target: ['0001-a', '0002-b'] });
		assert.strictEqual(r.ok, false);
		assert.deepStrictEqual(r.blocking, ['0007-fileecho-hashes']);
	});

	it('names every blocking migration, since the caller has to print them', function () {
		// "You cannot move to stable" is not actionable. "Your database has
		// applied 0007-fileecho-hashes, which stable 0.9.6a does not ship" is.
		var r = checkMoveSafety({ applied: ['0006-x', '0007-y'], target: [] });
		assert.deepStrictEqual(r.blocking, ['0006-x', '0007-y']);
	});

	it('allows a fresh database to move anywhere', function () {
		assert.strictEqual(checkMoveSafety({ applied: [], target: ['0001-a'] }).ok, true);
		assert.strictEqual(checkMoveSafety({}).ok, true);
	});

	it('is one directional: the target may ship more than has been applied', function () {
		// Reversing the comparison would refuse every ordinary upgrade, since
		// every release ships migrations the database has not run yet.
		assert.strictEqual(checkMoveSafety({ applied: [], target: ['0001-a', '0002-b'] }).ok, true);
	});

	it('ignores duplicates in either list', function () {
		var r = checkMoveSafety({ applied: ['0001-a', '0001-a'], target: ['0001-a'] });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.applied, 1);
	});
});

describe('checkStableCoverage', function () {

	it('passes on normal convergence, where stable contains its own builds', function () {
		var r = checkStableCoverage({
			version: '0.9.6a',
			migrations: ['0001-a', '0002-b', '0003-c'],
			developmentReleases: [
				build('0.9.5a.20260901', ['0001-a', '0002-b']),
				build('0.9.5a.20260913', ['0003-c'])
			],
			previousStable: '0.9.5a'
		});
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.checked, 2);
	});

	it('catches a migration that shipped on development and was deferred out', function () {
		var r = checkStableCoverage({
			version: '0.9.6a',
			migrations: ['0001-a'],
			developmentReleases: [build('0.9.5a.20260913', ['0001-a', '0002-deferred'])],
			previousStable: '0.9.5a'
		});
		assert.strictEqual(r.ok, false);
		assert.deepStrictEqual(r.missing, ['0002-deferred']);
	});

	it('names which builds are affected, so the maintainer knows who is stuck', function () {
		var r = checkStableCoverage({
			version: '0.9.6a',
			migrations: [],
			developmentReleases: [
				build('0.9.5a.20260901', ['0001-a']),
				build('0.9.5a.20260913', ['0001-a', '0002-b'])
			],
			previousStable: '0.9.5a'
		});
		assert.deepStrictEqual(r.builds, [
			{ version: '0.9.5a.20260901', migrations: ['0001-a'] },
			{ version: '0.9.5a.20260913', migrations: ['0001-a', '0002-b'] }
		]);
	});

	it('only considers builds on the stable being superseded', function () {
		// Builds on an older base were already checked when their own stable
		// was cut. Carrying every build ever published forward would mean a
		// migration could never be retired.
		var r = checkStableCoverage({
			version: '0.9.7a',
			migrations: ['0003-c'],
			developmentReleases: [
				build('0.9.5a.20260913', ['0001-old'], '0.9.5a'),
				build('0.9.6a.20261001', ['0003-c'], '0.9.6a')
			],
			previousStable: '0.9.6a'
		});
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.checked, 1);
	});

	it('reports nothing checked when no development build was published', function () {
		var r = checkStableCoverage({ version: '0.9.6a', migrations: ['0001-a'], developmentReleases: [] });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.checked, 0);
		assert.deepStrictEqual(r.builds, []);
	});

	it('considers everything when no previous stable is named', function () {
		var r = checkStableCoverage({
			version: '0.9.6a',
			migrations: [],
			developmentReleases: [build('0.9.5a.20260913', ['0001-a'])]
		});
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.checked, 1);
	});
});

describe('deltaShare', function () {

	it('is the delta as a fraction of the full tree', function () {
		assert.strictEqual(deltaShare(50, 200), 0.25);
	});

	it('has no answer without a full tree size', function () {
		assert.strictEqual(deltaShare(50, 0), null);
		assert.strictEqual(deltaShare(50, null), null);
	});
});
