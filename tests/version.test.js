// tests/version.test.js: parsing and ordering Canectic versions.
//
// Everything in the update system rests on this. Whether an update exists,
// which release a development build deltas against, whether a move between
// channels is forward, and what the release script publishes all reduce to
// comparing two of these strings.
//
// The half that matters most is which side of its base a dated build sorts on.
// A development build carries the last stable released plus its build date, so
// it sorts ABOVE the version in its name. Reversing that inverts every
// comparison in the system: everyone on development would be told they are
// behind by builds they are ahead of, and the update check would offer
// downgrades while calling them upgrades. Nothing else about the scheme can go
// wrong that quietly.
//
// So the ordering is asserted as a whole chain rather than as pairs. A pairwise
// test can pass while the overall order is incoherent.
//
// Pure: no database, no services.
// Run: npx mocha

import assert from 'assert';
import {
	parseVersion, compareVersions, isNewer, isDevelopment, isStable,
	channelOf, baseStable, formatVersion, sortVersions, newest
} from '../src/utils/version.js';

// The canonical chain from UPDATE_SYSTEM_DESIGN, in order.
var CHAIN = [
	'0.9.5a',
	'0.9.5a.20260901',
	'0.9.5a.20260913',
	'0.9.5b',
	'0.9.5b.20261005',
	'0.9.5',
	'0.9.6a'
];

describe('parseVersion', function () {

	it('parses a stable release', function () {
		var p = parseVersion('0.9.5a');
		assert.strictEqual(p.major, 0);
		assert.strictEqual(p.minor, 9);
		assert.strictEqual(p.patch, 5);
		assert.strictEqual(p.phase, 'a');
		assert.strictEqual(p.date, null);
		assert.strictEqual(p.build, 0);
	});

	it('parses a final release with no phase letter', function () {
		var p = parseVersion('1.0.0');
		assert.strictEqual(p.phase, null);
		assert.strictEqual(p.date, null);
	});

	it('parses a development build', function () {
		var p = parseVersion('0.9.5a.20260913');
		assert.strictEqual(p.phase, 'a');
		assert.strictEqual(p.date, 20260913);
		assert.strictEqual(p.build, 0);
	});

	it('parses a same-day counter', function () {
		var p = parseVersion('0.9.6a.20260913.2');
		assert.strictEqual(p.date, 20260913);
		assert.strictEqual(p.build, 2);
	});

	it('accepts a leading v, since that is how tags are written', function () {
		assert.deepStrictEqual(parseVersion('v0.9.5a').patch, 5);
		assert.strictEqual(compareVersions('v0.9.5a', '0.9.5a'), 0);
	});

	it('keeps the raw string it was given', function () {
		assert.strictEqual(parseVersion('v0.9.5a').raw, 'v0.9.5a');
	});

	it('returns null rather than throwing on anything else', function () {
		var bad = ['', '   ', 'banana', '0.9', '0.9.5c', '0.9.5a.2026', '0.9.5a.202609131',
			'0.9.5.a', 'v', '0.9.5a-', null, undefined, {}, 1];
		for (var b of bad) {
			assert.strictEqual(parseVersion(b), null, JSON.stringify(b) + ' should not parse');
		}
	});

	it('rejects a build date that cannot be a date', function () {
		// A stamp claiming month 13 means the build that produced it is wrong.
		// Returning null makes that visible rather than ordering it plausibly.
		assert.strictEqual(parseVersion('0.9.5a.20261301'), null);
		assert.strictEqual(parseVersion('0.9.5a.20260900'), null);
		assert.strictEqual(parseVersion('0.9.5a.20260932'), null);
	});

	it('accepts the ends of the calendar', function () {
		assert.ok(parseVersion('0.9.5a.20260101'));
		assert.ok(parseVersion('0.9.5a.20261231'));
	});
});

describe('parseVersion, the retired form', function () {

	it('still parses v0.9.1-alpha.1, because two tags use it', function () {
		// Retired, never emitted, but an install running one has to be able to
		// be told something newer exists.
		var p = parseVersion('v0.9.1-alpha.1');
		assert.strictEqual(p.major, 0);
		assert.strictEqual(p.minor, 9);
		assert.strictEqual(p.patch, 1);
		assert.strictEqual(p.phase, 'a');
		assert.strictEqual(p.legacy, true);
	});

	it('treats -beta as the b phase', function () {
		assert.strictEqual(parseVersion('0.9.1-beta.2').phase, 'b');
	});

	it('places a legacy version below the current releases', function () {
		assert.ok(isNewer('0.9.5a', 'v0.9.1-alpha.1'));
		assert.ok(isNewer('v0.9.1-alpha.1', 'v0.9.0-alpha.1'));
	});

	it('never emits the retired form back out', function () {
		assert.strictEqual(formatVersion(parseVersion('v0.9.1-alpha.1')), '0.9.1a');
	});
});

describe('compareVersions, the canonical chain', function () {

	it('orders the whole chain as the design states it', function () {
		// The assertion that matters. Pairwise checks can all pass while the
		// overall order is incoherent, so this sorts a shuffled copy and
		// compares against the chain.
		var shuffled = CHAIN.slice().reverse();
		assert.deepStrictEqual(sortVersions(shuffled), CHAIN);
	});

	it('holds for every adjacent pair', function () {
		for (var i = 0; i < CHAIN.length - 1; i++) {
			assert.strictEqual(compareVersions(CHAIN[i], CHAIN[i + 1]), -1,
				CHAIN[i] + ' should be below ' + CHAIN[i + 1]);
		}
	});

	it('holds transitively across the chain', function () {
		for (var i = 0; i < CHAIN.length; i++) {
			for (var j = i + 1; j < CHAIN.length; j++) {
				assert.strictEqual(compareVersions(CHAIN[i], CHAIN[j]), -1,
					CHAIN[i] + ' should be below ' + CHAIN[j]);
				assert.strictEqual(compareVersions(CHAIN[j], CHAIN[i]), 1);
			}
		}
	});
});

describe('compareVersions, the rule that inverts everything', function () {

	it('sorts a dated build ABOVE the version it names', function () {
		// A development build carries the LAST stable released, so it was built
		// after that release and comes after it. Reverse this one line and every
		// comparison in the system flips.
		assert.ok(isNewer('0.9.5a.20260901', '0.9.5a'),
			'a build made after 0.9.5a must be newer than 0.9.5a');
	});

	it('sorts a later build date above an earlier one', function () {
		assert.ok(isNewer('0.9.5a.20260913', '0.9.5a.20260901'));
	});

	it('sorts the next stable above every development build before it', function () {
		// The convergence property: whoever is on development lands cleanly on
		// the next stable the day it ships.
		assert.ok(isNewer('0.9.6a', '0.9.5a.20260913'));
		assert.ok(isNewer('0.9.6a', '0.9.5a.29991231'));
	});

	it('sorts a same-day counter above the bare date', function () {
		assert.ok(isNewer('0.9.6a.20260913.2', '0.9.6a.20260913'));
		assert.ok(isNewer('0.9.6a.20260913.10', '0.9.6a.20260913.2'));
	});
});

describe('compareVersions, phases', function () {

	it('orders alpha below beta below final', function () {
		assert.ok(isNewer('0.9.5b', '0.9.5a'));
		assert.ok(isNewer('0.9.5', '0.9.5b'));
		assert.ok(isNewer('0.9.5', '0.9.5a'));
	});

	it('puts a beta above every alpha development build of the same version', function () {
		assert.ok(isNewer('0.9.5b', '0.9.5a.29991231'));
	});

	it('compares the numbers before the phase', function () {
		// 0.9.6a is newer than 0.9.5 even though alpha is below final, because
		// the version number moved.
		assert.ok(isNewer('0.9.6a', '0.9.5'));
	});
});

describe('compareVersions, numbers', function () {

	it('compares numerically rather than lexically', function () {
		assert.ok(isNewer('0.10.0a', '0.9.0a'), '10 must be above 9');
		assert.ok(isNewer('0.9.10a', '0.9.9a'));
		assert.ok(isNewer('1.0.0', '0.99.99'));
	});

	it('reports equality for the same version', function () {
		assert.strictEqual(compareVersions('0.9.5a', '0.9.5a'), 0);
		assert.strictEqual(compareVersions('0.9.5a.20260913', '0.9.5a.20260913'), 0);
	});
});

describe('compareVersions, unparseable input', function () {

	it('sorts an unreadable version below anything readable', function () {
		// The safe direction for "is there something newer": a system whose
		// version cannot be read is told an update exists rather than being
		// quietly told it is current.
		assert.strictEqual(compareVersions('banana', '0.9.5a'), -1);
		assert.strictEqual(compareVersions('0.9.5a', 'banana'), 1);
	});

	it('treats two unreadable versions as equal rather than throwing', function () {
		assert.strictEqual(compareVersions('banana', 'orange'), 0);
		assert.strictEqual(compareVersions(null, undefined), 0);
	});
});

describe('channel and shape', function () {

	it('calls a dated build development and an undated one stable', function () {
		assert.strictEqual(channelOf('0.9.5a'), 'stable');
		assert.strictEqual(channelOf('0.9.5a.20260913'), 'development');
		assert.strictEqual(isDevelopment('0.9.5a.20260913'), true);
		assert.strictEqual(isStable('0.9.5a'), true);
		assert.strictEqual(isDevelopment('0.9.5a'), false);
		assert.strictEqual(isStable('0.9.5a.20260913'), false);
	});

	it('has no channel for something that is not a version', function () {
		assert.strictEqual(channelOf('banana'), null);
		assert.strictEqual(isDevelopment('banana'), false);
		assert.strictEqual(isStable('banana'), false);
	});
});

describe('baseStable', function () {

	it('gives the stable a development build deltas against', function () {
		// The payoff of naming the last stable: the delta base is in the
		// version, so it cannot disagree with the metadata field stating it.
		assert.strictEqual(baseStable('0.9.5a.20260913'), '0.9.5a');
		assert.strictEqual(baseStable('0.9.6a.20260913.2'), '0.9.6a');
		assert.strictEqual(baseStable('1.0.0.20270101'), '1.0.0');
	});

	it('is null for a stable release, which is a base rather than having one', function () {
		assert.strictEqual(baseStable('0.9.5a'), null);
		assert.strictEqual(baseStable('1.0.0'), null);
	});

	it('is null for something that is not a version', function () {
		assert.strictEqual(baseStable('banana'), null);
	});

	it('always names a version that sorts below the build', function () {
		for (var v of ['0.9.5a.20260901', '0.9.6a.20260913.2', '1.0.0.20270101']) {
			assert.ok(isNewer(v, baseStable(v)), v + ' should be above its own base');
		}
	});
});

describe('formatVersion', function () {

	it('round trips every form in the chain', function () {
		for (var v of CHAIN) {
			assert.strictEqual(formatVersion(parseVersion(v)), v);
		}
	});

	it('round trips a same-day counter', function () {
		assert.strictEqual(formatVersion(parseVersion('0.9.6a.20260913.2')), '0.9.6a.20260913.2');
	});

	it('drops a zero counter rather than writing it', function () {
		assert.strictEqual(formatVersion(parseVersion('0.9.6a.20260913')), '0.9.6a.20260913');
	});

	it('strips a leading v', function () {
		assert.strictEqual(formatVersion(parseVersion('v0.9.5a')), '0.9.5a');
	});

	it('is null for something that is not a version', function () {
		assert.strictEqual(formatVersion('banana'), null);
	});
});

describe('newest', function () {

	it('picks the newest of a list', function () {
		assert.strictEqual(newest(CHAIN), '0.9.6a');
	});

	it('restricts to a channel when asked', function () {
		// What the update check does for someone on stable: development builds
		// exist and are newer, and must not be offered.
		assert.strictEqual(newest(CHAIN, 'stable'), '0.9.6a');
		assert.strictEqual(newest(['0.9.5a', '0.9.5a.20260913'], 'stable'), '0.9.5a');
		assert.strictEqual(newest(['0.9.5a', '0.9.5a.20260913'], 'development'), '0.9.5a.20260913');
	});

	it('ignores entries it cannot read rather than failing the whole list', function () {
		// One malformed entry in a release index must not stop a sysop being
		// told about the rest.
		assert.strictEqual(newest(['banana', '0.9.5a', '', null, '0.9.6a']), '0.9.6a');
	});

	it('is null for an empty or entirely unreadable list', function () {
		assert.strictEqual(newest([]), null);
		assert.strictEqual(newest(null), null);
		assert.strictEqual(newest(['banana', 'orange']), null);
		assert.strictEqual(newest(['0.9.5a'], 'development'), null);
	});
});

describe('the update question', function () {

	it('says an upgrade exists when the channel has moved on', function () {
		assert.ok(isNewer(newest(CHAIN, 'stable'), '0.9.5a'));
	});

	it('says nothing is newer when already on the newest', function () {
		assert.strictEqual(isNewer('0.9.6a', '0.9.6a'), false);
	});

	it('lets an old development build move to a newer stable', function () {
		// The case that made me sharpen the rule: channel is not the test.
		// Someone on a development build from 1 September can move to a stable
		// released on the 10th, because it is genuinely forward.
		assert.ok(isNewer('0.9.6a', '0.9.5a.20260901'));
	});

	it('refuses a newer development build moving back to the older stable', function () {
		// The same comparison in the other direction, which is a downgrade and
		// has to read as one.
		assert.strictEqual(isNewer('0.9.5a', '0.9.5a.20260913'), false);
	});
});
