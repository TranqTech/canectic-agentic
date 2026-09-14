// tests/releaseIndex.test.js: the per-channel release index.
//
// One document per channel, newest first, so a client answers "is there
// anything newer than what I have" in a single fetch. Two properties carry the
// weight:
//
//   The order. It comes from compareVersions, where a dated build sorts ABOVE
//   the stable in its name. An index that sorted lexicographically would put
//   0.9.5a above 0.9.5a.20260913 and tell everyone on development they are
//   current for ever.
//
//   The migration ids. The move rule is a question about migrations, not
//   versions, so an index without them would make the update check fetch every
//   candidate's metadata before it could say whether a move was even allowed.
//
// Pure: no database, no services.

import assert from 'assert';
import {
	emptyIndex, addRelease, findRelease, newestRelease, newestNewerThan,
	releasesBasedOn, serialiseIndex, parseIndex, indexName, summariseRelease
} from '../src/release/releaseIndex.js';
import { buildMetadata } from '../src/release/metadata.js';

var SHA = 'b'.repeat(64);

function meta(version, migrations) {
	return buildMetadata({
		version: version,
		released: '2026-09-20',
		sha256: SHA,
		migrations: migrations || [],
		node_min: '22.0.0'
	});
}

function indexOf(versions, channel) {
	var idx = emptyIndex(channel || 'development');
	for (var v of versions) idx = addRelease(idx, meta(v));
	return idx;
}

describe('indexName', function () {
	it('is one document per channel', function () {
		assert.strictEqual(indexName('stable'), 'index-stable.json');
		assert.strictEqual(indexName('development'), 'index-development.json');
	});
});

describe('summariseRelease', function () {

	it('carries the migrations, which is what the move rule needs', function () {
		var s = summariseRelease(meta('0.9.6a', ['0001-menu-layout', '0002-msgid-tuple-split']));
		assert.deepStrictEqual(s.migrations, ['0001-menu-layout', '0002-msgid-tuple-split']);
	});

	it('points at the metadata rather than inlining the steps', function () {
		var s = summariseRelease(meta('0.9.6a'));
		assert.strictEqual(s.metadata, 'canectic-0.9.6a.json');
		assert.strictEqual(s.steps, undefined);
		assert.strictEqual(s.notices, undefined);
	});

	it('names the base artifact a client would have to fetch first', function () {
		var s = summariseRelease(meta('0.9.6a.20260913'));
		assert.strictEqual(s.base, '0.9.6a');
		assert.strictEqual(s.base_artifact, 'canectic-0.9.6a.zip');
		assert.strictEqual(s.delta, true);
	});
});

describe('addRelease', function () {

	it('keeps the list newest first', function () {
		var idx = indexOf(['0.9.5a.20260901', '0.9.5a.20260913', '0.9.5a.20260820']);
		assert.deepStrictEqual(idx.releases.map(function (r) { return r.version; }),
			['0.9.5a.20260913', '0.9.5a.20260901', '0.9.5a.20260820']);
	});

	it('orders a dated build above the stable it names', function () {
		// Lexicographic ordering gets this backwards, and the consequence is
		// that everyone on development is told they are already current.
		var idx = indexOf(['0.9.5a', '0.9.5a.20260913'], 'stable');
		assert.strictEqual(idx.releases[0].version, '0.9.5a.20260913');
	});

	it('replaces rather than appends when a version is cut twice', function () {
		// Two entries for one version would leave every client's answer
		// depending on which one it read first.
		var idx = addRelease(indexOf(['0.9.6a']), Object.assign(meta('0.9.6a'), { sha256: 'c'.repeat(64) }));
		assert.strictEqual(idx.releases.length, 1);
		assert.strictEqual(idx.releases[0].sha256, 'c'.repeat(64));
	});

	it('starts an index from nothing', function () {
		var idx = addRelease(null, meta('0.9.6a'));
		assert.strictEqual(idx.channel, 'stable');
		assert.strictEqual(idx.releases.length, 1);
	});

	it('stamps when it was updated', function () {
		assert.ok(addRelease(null, meta('0.9.6a')).updated);
	});
});

describe('finding a release', function () {

	var idx = indexOf(['0.9.5a.20260901', '0.9.5a.20260913']);

	it('finds by version, tolerating a stray v prefix', function () {
		assert.strictEqual(findRelease(idx, '0.9.5a.20260901').version, '0.9.5a.20260901');
		assert.strictEqual(findRelease(idx, 'v0.9.5a.20260901').version, '0.9.5a.20260901');
		assert.strictEqual(findRelease(idx, '0.9.9a'), null);
	});

	it('asks the comparator for the newest rather than trusting the order', function () {
		var shuffled = { channel: 'development', releases: idx.releases.slice().reverse() };
		assert.strictEqual(newestRelease(shuffled).version, '0.9.5a.20260913');
	});

	it('has no newest when it is empty', function () {
		assert.strictEqual(newestRelease(emptyIndex('stable')), null);
		assert.strictEqual(newestRelease(null), null);
	});
});

describe('newestNewerThan', function () {

	var idx = indexOf(['0.9.5a.20260901', '0.9.5a.20260913']);

	it('offers a build newer than what is running', function () {
		assert.strictEqual(newestNewerThan(idx, '0.9.5a').version, '0.9.5a.20260913');
		assert.strictEqual(newestNewerThan(idx, '0.9.5a.20260901').version, '0.9.5a.20260913');
	});

	it('says nothing when the install is already current', function () {
		assert.strictEqual(newestNewerThan(idx, '0.9.5a.20260913'), null);
	});

	it('never offers a downgrade', function () {
		assert.strictEqual(newestNewerThan(idx, '0.9.6a'), null);
		assert.strictEqual(newestNewerThan(idx, '1.0.0'), null);
	});
});

describe('releasesBasedOn', function () {

	it('enumerates every build on one stable, which is the whole point of naming it', function () {
		var idx = indexOf(['0.9.5a.20260901', '0.9.5a.20260913', '0.9.6a.20261001']);
		var on95 = releasesBasedOn(idx, '0.9.5a').map(function (r) { return r.version; });
		assert.deepStrictEqual(on95, ['0.9.5a.20260901', '0.9.5a.20260913']);
		assert.deepStrictEqual(releasesBasedOn(idx, '0.9.6a').map(function (r) { return r.version; }),
			['0.9.6a.20261001']);
	});

	it('falls back to the version when an entry states no base', function () {
		// The base is derivable from the version, so an index written by
		// something older still answers.
		var idx = { releases: [{ version: '0.9.5a.20260913', migrations: [] }] };
		assert.strictEqual(releasesBasedOn(idx, '0.9.5a').length, 1);
	});

	it('returns nothing for a stable nothing was built on', function () {
		assert.deepStrictEqual(releasesBasedOn(indexOf(['0.9.5a.20260913']), '0.9.9a'), []);
	});
});

describe('serialise and parse', function () {

	it('round trips', function () {
		var idx = indexOf(['0.9.5a.20260913']);
		assert.deepStrictEqual(parseIndex(serialiseIndex(idx)), idx);
	});

	it('refuses something that is not an index', function () {
		assert.throws(function () { parseIndex('{}'); }, /no releases array/);
		assert.throws(function () { parseIndex('nope'); }, /not valid JSON/);
	});
});
