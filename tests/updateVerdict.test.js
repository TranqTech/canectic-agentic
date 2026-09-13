// tests/updateVerdict.test.js: is there an update, and may this system take it?
//
// Three directional rules decide it, and each one, reversed, produces a
// specific and quiet failure. The tests are written around those reversals,
// because every one of them still returns a plausible looking answer:
//
//   NEWER, reversed: everyone on development is told they are behind by builds
//   they are ahead of, and the check offers downgrades while calling them
//   upgrades.
//
//   MIGRATIONS, reversed: every ordinary upgrade is refused, because every
//   release ships migrations the database has not run yet.
//
//   MIN UPGRADE FROM, reversed: the only systems allowed to upgrade are the
//   ones too old to do it safely.
//
// The other thing worth asserting is the dedupe. A daily job that says the same
// thing every morning is a job a sysop turns off, and then they hear about
// nothing at all.
//
// Pure: no database, no network.

import assert from 'assert';
import {
	compareDotted, blockersFor, evaluateChannel, channelsToCheck, evaluate,
	shouldNotify, notificationFor,
	VERDICT_CURRENT, VERDICT_AVAILABLE, VERDICT_BLOCKED, VERDICT_UNKNOWN,
	BLOCKER_MIGRATION, BLOCKER_TOO_OLD, BLOCKER_NODE
} from '../src/release/updateVerdict.js';

function release(version, extra) {
	return Object.assign({
		version: version,
		released: '2026-09-20',
		migrations: [],
		node_min: null,
		min_upgrade_from: null
	}, extra || {});
}

function index(channel, releases) {
	return { channel: channel, releases: releases };
}

describe('compareDotted', function () {

	it('orders Node versions numerically, not lexically', function () {
		assert.strictEqual(compareDotted('9.0.0', '10.0.0'), -1);
		assert.strictEqual(compareDotted('26.8.1', '22.0.0'), 1);
		assert.strictEqual(compareDotted('22.0.0', '22.0.0'), 0);
	});

	it('tolerates a v prefix and a short version', function () {
		assert.strictEqual(compareDotted('v22.1.0', '22.1'), 0);
		assert.strictEqual(compareDotted('22', '22.0.1'), -1);
	});

	it('ignores prerelease and build metadata rather than refusing a release candidate', function () {
		assert.strictEqual(compareDotted('27.0.0-rc.1', '27.0.0'), 0);
	});

	it('gives up rather than guessing on nonsense', function () {
		assert.strictEqual(compareDotted('banana', '22.0.0'), 0);
	});
});

describe('blockersFor', function () {

	it('finds nothing wrong with an ordinary upgrade', function () {
		var b = blockersFor({
			current: '0.9.6a',
			release: release('0.9.7a', { migrations: ['0001-a', '0002-b'], node_min: '22.0.0', min_upgrade_from: '0.9.0a' }),
			appliedMigrations: ['0001-a'],
			nodeVersion: '26.8.1'
		});
		assert.deepStrictEqual(b, []);
	});

	it('does not refuse a target that ships migrations this database has not run', function () {
		// The reversal that would refuse every upgrade there is.
		var b = blockersFor({
			current: '0.9.6a',
			release: release('0.9.7a', { migrations: ['0001-a', '0002-b', '0003-c'] }),
			appliedMigrations: []
		});
		assert.deepStrictEqual(b, []);
	});

	it('refuses a target that does not ship a migration this database applied', function () {
		var b = blockersFor({
			current: '0.9.6a',
			release: release('0.9.7a', { migrations: ['0001-a'] }),
			appliedMigrations: ['0001-a', '0007-fileecho-hashes']
		});
		assert.strictEqual(b.length, 1);
		assert.strictEqual(b[0].kind, BLOCKER_MIGRATION);
		assert.deepStrictEqual(b[0].ids, ['0007-fileecho-hashes']);
		assert.ok(/0007-fileecho-hashes/.test(b[0].detail), 'the reason must name the migration');
	});

	it('refuses a system below the target floor, and only below it', function () {
		var target = release('0.9.7a', { min_upgrade_from: '0.9.5a' });
		assert.strictEqual(blockersFor({ current: '0.9.1a', release: target }).length, 1);
		assert.strictEqual(blockersFor({ current: '0.9.1a', release: target })[0].kind, BLOCKER_TOO_OLD);
		// At the floor and above it are both fine. Reversing the comparison
		// would let exactly these two through and refuse everyone else.
		assert.deepStrictEqual(blockersFor({ current: '0.9.5a', release: target }), []);
		assert.deepStrictEqual(blockersFor({ current: '0.9.6a', release: target }), []);
	});

	it('ignores a floor that is not a version rather than refusing everything', function () {
		assert.deepStrictEqual(blockersFor({ current: '0.9.6a', release: release('0.9.7a', { min_upgrade_from: 'soon' }) }), []);
	});

	it('refuses when Node is older than the release needs', function () {
		var target = release('0.9.7a', { node_min: '26.0.0' });
		var b = blockersFor({ current: '0.9.6a', release: target, nodeVersion: '22.11.0' });
		assert.strictEqual(b.length, 1);
		assert.strictEqual(b[0].kind, BLOCKER_NODE);
		assert.deepStrictEqual(blockersFor({ current: '0.9.6a', release: target, nodeVersion: '26.8.1' }), []);
	});

	it('reports every blocker at once, since a sysop fixes them together', function () {
		var b = blockersFor({
			current: '0.9.1a',
			release: release('0.9.7a', { migrations: [], node_min: '26.0.0', min_upgrade_from: '0.9.5a' }),
			appliedMigrations: ['0001-a'],
			nodeVersion: '22.0.0'
		});
		assert.strictEqual(b.length, 3);
		assert.deepStrictEqual(b.map(function (x) { return x.kind; }).sort(),
			[BLOCKER_MIGRATION, BLOCKER_TOO_OLD, BLOCKER_NODE].sort());
	});
});

describe('evaluateChannel', function () {

	it('says current when nothing is newer', function () {
		var r = evaluateChannel({ index: index('stable', [release('0.9.6a')]), current: '0.9.6a' });
		assert.strictEqual(r.verdict, VERDICT_CURRENT);
		assert.strictEqual(r.available, null);
	});

	it('never offers a downgrade', function () {
		var r = evaluateChannel({ index: index('stable', [release('0.9.5a')]), current: '0.9.6a' });
		assert.strictEqual(r.verdict, VERDICT_CURRENT);
	});

	it('offers the newest release, not the first listed', function () {
		var r = evaluateChannel({
			index: index('stable', [release('0.9.6a'), release('0.9.8a'), release('0.9.7a')]),
			current: '0.9.5a'
		});
		assert.strictEqual(r.available, '0.9.8a');
	});

	it('orders versions numerically, where string order disagrees', function () {
		// 0.9.10a sorts BELOW 0.9.9a as a string, because "1" is less than "9",
		// and the same trap catches 0.10.0a against 0.9.0a. A check comparing
		// version strings looks right for the whole of a single digit series
		// and then silently stops offering upgrades at the tenth release.
		var r = evaluateChannel({
			index: index('stable', [release('0.9.9a'), release('0.9.10a')]),
			current: '0.9.8a'
		});
		assert.strictEqual(r.available, '0.9.10a');

		var major = evaluateChannel({
			index: index('stable', [release('0.9.0a'), release('0.10.0a')]),
			current: '0.8.0a'
		});
		assert.strictEqual(major.available, '0.10.0a');
	});

	it('orders a dated build above the stable it names', function () {
		// Lexically 0.9.6a sorts above 0.9.6a.20260913, and a check that got
		// this backwards would tell every development install it is current.
		var r = evaluateChannel({
			index: index('development', [release('0.9.6a.20260913'), release('0.9.6a.20260901')]),
			current: '0.9.6a'
		});
		assert.strictEqual(r.verdict, VERDICT_AVAILABLE);
		assert.strictEqual(r.available, '0.9.6a.20260913');
	});

	it('reports the newest release as blocked rather than falling back to an older one', function () {
		// Offering something older would hide the problem behind a smaller
		// number, and the sysop would never learn why they are stuck.
		var r = evaluateChannel({
			index: index('stable', [release('0.9.7a'), release('0.9.8a', { node_min: '99.0.0' })]),
			current: '0.9.6a',
			nodeVersion: '26.8.1'
		});
		assert.strictEqual(r.verdict, VERDICT_BLOCKED);
		assert.strictEqual(r.available, '0.9.8a');
		assert.strictEqual(r.blockers.length, 1);
	});

	it('skips entries whose version cannot be read', function () {
		var r = evaluateChannel({
			index: index('stable', [{ version: 'banana' }, release('0.9.7a')]),
			current: '0.9.6a'
		});
		assert.strictEqual(r.available, '0.9.7a');
	});

	it('says current for an empty channel', function () {
		assert.strictEqual(evaluateChannel({ index: index('stable', []), current: '0.9.6a' }).verdict, VERDICT_CURRENT);
	});
});

describe('channelsToCheck', function () {

	it('tells a development system about stable as well', function () {
		// Convergence onto stable is a move it should be offered and would
		// otherwise never see.
		assert.deepStrictEqual(channelsToCheck('development'), ['development', 'stable']);
	});

	it('does not tell a stable system about development', function () {
		// That is a channel they did not opt into. Offering it would be the
		// software talking somebody into running prerelease code.
		assert.deepStrictEqual(channelsToCheck('stable'), ['stable']);
	});

	it('treats an unrecognised channel as stable, which is the safe direction', function () {
		assert.deepStrictEqual(channelsToCheck('nonsense'), ['stable']);
		assert.deepStrictEqual(channelsToCheck(undefined), ['stable']);
	});
});

describe('evaluate', function () {

	var stable = index('stable', [release('0.9.7a')]);
	var dev = index('development', [release('0.9.7a.20261001')]);

	it('prefers the configured channel when it has something', function () {
		var r = evaluate({
			current: '0.9.7a', channel: 'development',
			indexes: { stable: stable, development: dev }
		});
		assert.strictEqual(r.best.channel, 'development');
		assert.strictEqual(r.best.available, '0.9.7a.20261001');
	});

	it('falls back to stable for a development system whose own channel is quiet', function () {
		var r = evaluate({
			current: '0.9.6a', channel: 'development',
			indexes: { stable: stable, development: index('development', []) }
		});
		assert.strictEqual(r.best.channel, 'stable');
		assert.strictEqual(r.best.available, '0.9.7a');
	});

	it('has no best when everything is current', function () {
		var r = evaluate({ current: '0.9.7a', channel: 'stable', indexes: { stable: stable } });
		assert.strictEqual(r.best, null);
		assert.strictEqual(r.channels.stable.verdict, VERDICT_CURRENT);
	});

	it('marks a channel unknown when its index did not resolve', function () {
		// A channel with nothing published has no index, and treating that as
		// an error would make a stable-only project look broken.
		var r = evaluate({ current: '0.9.6a', channel: 'development', indexes: { stable: stable } });
		assert.strictEqual(r.channels.development.verdict, VERDICT_UNKNOWN);
		assert.strictEqual(r.best.channel, 'stable');
	});

	it('does not evaluate a channel the system did not ask for', function () {
		var r = evaluate({ current: '0.9.6a', channel: 'stable', indexes: { stable: stable, development: dev } });
		assert.strictEqual(r.channels.development, undefined);
	});

	it('reports a blocked best rather than skipping to a channel with none', function () {
		var blockedDev = index('development', [release('0.9.7a.20261001', { node_min: '99.0.0' })]);
		var r = evaluate({
			current: '0.9.6a', channel: 'development', nodeVersion: '26.8.1',
			indexes: { stable: stable, development: blockedDev }
		});
		assert.strictEqual(r.best.channel, 'development');
		assert.strictEqual(r.best.verdict, VERDICT_BLOCKED);
	});
});

describe('shouldNotify', function () {

	var available = evaluate({ current: '0.9.6a', channel: 'stable', indexes: { stable: index('stable', [release('0.9.7a')]) } });

	it('notifies the first time', function () {
		assert.strictEqual(shouldNotify(available, null), true);
	});

	it('does not repeat itself every morning', function () {
		// The whole reason the dedupe exists: a job that says the same thing
		// daily is a job a sysop turns off, and then they hear about nothing.
		assert.strictEqual(shouldNotify(available, { version: '0.9.7a', verdict: VERDICT_AVAILABLE }), false);
	});

	it('notifies again when a newer release appears', function () {
		assert.strictEqual(shouldNotify(available, { version: '0.9.6a.20260913', verdict: VERDICT_AVAILABLE }), true);
	});

	it('notifies when a blocked release becomes reachable', function () {
		// Same version, different verdict: they ran the migration or upgraded
		// Node, and that is news even though the number has not moved.
		assert.strictEqual(shouldNotify(available, { version: '0.9.7a', verdict: VERDICT_BLOCKED }), true);
	});

	it('says nothing when there is nothing to say', function () {
		var current = evaluate({ current: '0.9.7a', channel: 'stable', indexes: { stable: index('stable', [release('0.9.7a')]) } });
		assert.strictEqual(shouldNotify(current, null), false);
		assert.strictEqual(shouldNotify(null, null), false);
	});
});

describe('notificationFor', function () {

	it('names the version and says the system can take it', function () {
		var r = evaluate({ current: '0.9.6a', channel: 'stable', indexes: { stable: index('stable', [release('0.9.7a')]) } });
		var n = notificationFor(r);
		assert.strictEqual(n.severity, 'info');
		assert.ok(n.title.indexOf('0.9.7a') !== -1);
		assert.ok(n.body.indexOf('0.9.6a') !== -1);
	});

	it('says why a blocked release is blocked, in the notification itself', function () {
		var r = evaluate({
			current: '0.9.6a', channel: 'stable', nodeVersion: '22.0.0',
			indexes: { stable: index('stable', [release('0.9.7a', { node_min: '26.0.0' })]) }
		});
		var n = notificationFor(r);
		assert.strictEqual(n.severity, 'warning');
		assert.ok(/blocked/.test(n.title));
		assert.ok(/Node 26\.0\.0/.test(n.body), 'the notification must carry the reason: ' + n.body);
	});

	it('has nothing to say when the system is current', function () {
		var r = evaluate({ current: '0.9.7a', channel: 'stable', indexes: { stable: index('stable', [release('0.9.7a')]) } });
		assert.strictEqual(notificationFor(r), null);
	});
});
