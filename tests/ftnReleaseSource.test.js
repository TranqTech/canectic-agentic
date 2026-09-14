// tests/ftnReleaseSource.test.js: releases that arrive down a file echo.
//
// Almost nothing new happens on this path, which is the point: by the time a
// release is interesting the TIC tosser has received it, checked its CRC,
// hashed it and filed it, so detection is a database query and downloading is a
// copy. What IS new is that there is no index document. A file echo carries
// files, so the index is derived from what is present, and these are the rules
// for deriving it.
//
// Two of them are about not overclaiming.
//
//   An archive that cannot identify itself is IGNORED, not offered. Its
//   migration list would be empty, and an empty migration list clears every
//   blocker in the move rule, so a file nobody can identify would be offered as
//   safe to install. That is the worst available answer.
//
//   The sha256 on an entry is null even though the file area has one. The
//   tosser's hash proves the file has not changed since it arrived; it does not
//   prove it is the file the maintainer built, and putting it in the field that
//   means "published checksum" would say it does.
//
// Pure: indexFromEntries takes rows that have already been described.

import assert from 'assert';
import { parseArtifactName, indexFromEntries, ARTIFACT_PATTERN } from '../src/maintenance/ftnReleaseSource.js';

function entry(filename, identity, extra) {
	return Object.assign({
		filename: filename,
		disk_path: '/files/canectic/' + filename,
		sha256: 'f'.repeat(64),
		identity: identity
	}, extra || {});
}

function identity(version, over) {
	return Object.assign({
		software: 'Canectic BBS', version: version, channel: null, codename: 'Handshake',
		released: '2026-09-20', delta: false, base: null,
		node_min: '22.0.0', min_upgrade_from: '0.9.0a',
		migrations: ['0001-menu-layout'], raw: {}
	}, over || {});
}

describe('parseArtifactName', function () {

	it('reads a stable and a delta filename', function () {
		assert.deepStrictEqual(parseArtifactName('canectic-0.9.6a.zip'), { version: '0.9.6a', delta: false });
		assert.deepStrictEqual(parseArtifactName('canectic-0.9.6a.20260913.delta.zip'),
			{ version: '0.9.6a.20260913', delta: true });
	});

	it('ignores everything else in a file area', function () {
		// A file echo carries whatever the sysop and the uplink put in it.
		for (var name of ['README.txt', 'canectic.zip', 'canectic-.zip', 'canectic-banana.zip',
			'somethingelse-0.9.6a.zip', 'canectic-0.9.6a.tar.gz', '']) {
			assert.strictEqual(parseArtifactName(name), null, name);
		}
	});

	it('normalises an uppercased name, which file echoes still produce', function () {
		// A habit inherited from 8.3 DOS and still alive in parts of the network.
		assert.deepStrictEqual(parseArtifactName('CANECTIC-0.9.6A.ZIP'), { version: '0.9.6a', delta: false });
	});
});

describe('indexFromEntries', function () {

	it('produces the shape the update check already understands', function () {
		var idx = indexFromEntries([entry('canectic-0.9.6a.zip', identity('0.9.6a'))], 'stable');
		assert.strictEqual(idx.channel, 'stable');
		assert.strictEqual(idx.releases.length, 1);
		var r = idx.releases[0];
		assert.strictEqual(r.version, '0.9.6a');
		assert.strictEqual(r.artifact, 'canectic-0.9.6a.zip');
		assert.strictEqual(r.node_min, '22.0.0');
		assert.deepStrictEqual(r.migrations, ['0001-menu-layout']);
	});

	it('orders newest first, by version rather than by string', function () {
		var idx = indexFromEntries([
			entry('canectic-0.9.9a.zip', identity('0.9.9a')),
			entry('canectic-0.9.10a.zip', identity('0.9.10a')),
			entry('canectic-0.9.8a.zip', identity('0.9.8a'))
		], 'stable');
		assert.deepStrictEqual(idx.releases.map(function (r) { return r.version; }),
			['0.9.10a', '0.9.9a', '0.9.8a']);
	});

	it('ignores an archive that cannot identify itself, channel filter or not', function () {
		// Asserted with NO channel filter as well, because the filter happens
		// to drop these too and would otherwise be the thing under test. The
		// rule has to stand on its own: an empty migration list clears every
		// blocker in the move rule, so an unidentifiable file offered at all is
		// offered as safe to install.
		var rows = [entry('canectic-0.9.6a.zip', null), entry('canectic-0.9.7a.zip', identity('0.9.7a'))];
		assert.deepStrictEqual(indexFromEntries(rows, null).releases.map(function (r) { return r.version; }),
			['0.9.7a']);
		assert.doesNotThrow(function () { indexFromEntries([entry('anything.zip', null)], null); });
	});

	it('ignores an archive that cannot identify itself', function () {
		// Its migration list would be empty, and an empty list clears every
		// blocker in the move rule, so this would be offered as safe to install
		// on a database it knows nothing about.
		var idx = indexFromEntries([
			entry('canectic-0.9.6a.zip', null),
			entry('canectic-0.9.7a.zip', identity('0.9.7a'))
		], 'stable');
		assert.deepStrictEqual(idx.releases.map(function (r) { return r.version; }), ['0.9.7a']);
	});

	it('trusts the archive over the filename', function () {
		// A filename survives a chain that may rename it, and nothing stops
		// anybody naming a file anything. CANECTIC.ID is inside.
		var idx = indexFromEntries([entry('canectic-9.9.9a.zip', identity('0.9.6a'))], 'stable');
		assert.strictEqual(idx.releases[0].version, '0.9.6a');
		assert.strictEqual(idx.releases[0].artifact, 'canectic-9.9.9a.zip', 'but fetches the file that is there');
	});

	it('drops an artifact from the other channel', function () {
		// A sysop can put anything in a file area, and one that wandered in
		// from the other channel must not be offered as though this area
		// vouched for it.
		var idx = indexFromEntries([
			entry('canectic-0.9.6a.zip', identity('0.9.6a')),
			entry('canectic-0.9.6a.20260913.delta.zip', identity('0.9.6a.20260913', { delta: true, base: '0.9.6a' }))
		], 'stable');
		assert.deepStrictEqual(idx.releases.map(function (r) { return r.version; }), ['0.9.6a']);
	});

	it('keeps a development build on the development channel, with its base', function () {
		var idx = indexFromEntries([
			entry('canectic-0.9.6a.20260913.delta.zip', identity('0.9.6a.20260913', { delta: true, base: '0.9.6a' }))
		], 'development');
		var r = idx.releases[0];
		assert.strictEqual(r.delta, true);
		assert.strictEqual(r.base, '0.9.6a');
		assert.strictEqual(r.base_artifact, 'canectic-0.9.6a.zip');
	});

	it('never presents a locally computed hash as a published checksum', function () {
		// The tosser's hash proves the file has not changed since it arrived.
		// It does not prove it is the file the maintainer built, and the sha256
		// field means the second.
		var idx = indexFromEntries([entry('canectic-0.9.6a.zip', identity('0.9.6a'))], 'stable');
		assert.strictEqual(idx.releases[0].sha256, null);
		assert.strictEqual(idx.releases[0].local_sha256, 'f'.repeat(64));
	});

	it('says where the file is, since it is already on this disk', function () {
		var idx = indexFromEntries([entry('canectic-0.9.6a.zip', identity('0.9.6a'))], 'stable');
		assert.strictEqual(idx.releases[0].local_path, '/files/canectic/canectic-0.9.6a.zip');
		assert.strictEqual(idx.releases[0].transport, 'ftn');
	});

	it('copes with an empty area and with nothing at all', function () {
		assert.deepStrictEqual(indexFromEntries([], 'stable').releases, []);
		assert.deepStrictEqual(indexFromEntries(null, 'stable').releases, []);
	});
});
