// tests/baseCache.test.js: the cached stable artifacts, and when they go.
//
// A development build ships only what differs from its base stable, so applying
// one means having that base. A sysop tracking development needs the same
// tarball for every build cut on it, and fetching 7.6 MB each time is waste
// over HTTP and considerably worse down a file echo.
//
// Two things are worth asserting and neither is obvious:
//
//   A cached base is verified on every use. A local file is not more
//   trustworthy than a downloaded one: it can rot on disk or be edited, and it
//   is the base everything else is rebuilt from, so a corrupted cache would
//   silently produce a tree that passes its own manifest check while not being
//   the release. A hit has to mean "verified", not "present".
//
//   The prune rule can delete something still needed. A delta is always one hop
//   against its own named base, so the bases that matter are the installed
//   version's and the newest release's, and those must survive any cap.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	planPrune, cachedBase, storeBase, cachedVersions, pruneBaseCache, discard,
	artifactPath, metadataPath, DEFAULT_KEEP
} from '../src/maintenance/baseCache.js';
import { baseCacheDir } from '../src/maintenance/updateLayout.js';
import { buildMetadata, serialiseMetadata } from '../src/release/metadata.js';
import { hashFile } from '../src/release/manifest.js';

var roots = [];
function tmp() {
	var d = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-cache-'));
	roots.push(d);
	return d;
}
after(function () {
	for (var d of roots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

/** Put a real, self-consistent cache entry in place. */
function cache(target, version, body) {
	var src = path.join(tmp(), 'artifact.tar.gz');
	fs.writeFileSync(src, body || ('pretend tarball for ' + version));
	var meta = buildMetadata({
		version: version, released: '2026-09-20', sha256: hashFile(src), node_min: '22.0.0'
	});
	storeBase(target, version, src, serialiseMetadata(meta));
	return meta;
}

describe('planPrune', function () {

	it('keeps the newest and discards the rest, oldest first', function () {
		assert.deepStrictEqual(
			planPrune(['0.9.5a', '0.9.6a', '0.9.7a', '0.9.8a'], 2, []),
			['0.9.5a', '0.9.6a']);
	});

	it('orders by version, not by string', function () {
		// 0.9.10a sorts below 0.9.9a as a string, so a lexical cap would
		// discard the newest entry it has.
		assert.deepStrictEqual(planPrune(['0.9.9a', '0.9.10a', '0.9.8a'], 1, []), ['0.9.8a', '0.9.9a']);
	});

	it('never discards a protected base, however old', function () {
		// The installed version's base. Discarding it means the next
		// development build cannot be rebuilt without fetching it again, which
		// is the entire thing this cache exists to avoid.
		assert.deepStrictEqual(planPrune(['0.9.5a', '0.9.6a', '0.9.7a'], 1, ['0.9.5a']), ['0.9.6a']);
	});

	it('does not let a protected entry eat the budget', function () {
		// Protecting one must not cost a slot, or a sysop who stays on one base
		// for a long time ends up with only that one cached.
		assert.deepStrictEqual(planPrune(['0.9.5a', '0.9.6a', '0.9.7a'], 2, ['0.9.5a']), []);
	});

	it('discards everything unprotected when told to keep none', function () {
		assert.deepStrictEqual(planPrune(['0.9.5a', '0.9.6a'], 0, ['0.9.6a']), ['0.9.5a']);
	});

	it('ignores entries that are not versions rather than sorting them somewhere', function () {
		assert.deepStrictEqual(planPrune(['banana', '0.9.5a', '0.9.6a'], 1, []), ['0.9.5a']);
	});

	it('defaults to keeping two', function () {
		assert.strictEqual(DEFAULT_KEEP, 2);
		assert.deepStrictEqual(planPrune(['0.9.5a', '0.9.6a', '0.9.7a'], undefined, []), ['0.9.5a']);
	});

	it('has nothing to do with an empty cache', function () {
		assert.deepStrictEqual(planPrune([], 2, []), []);
		assert.deepStrictEqual(planPrune(null, 2, null), []);
	});
});

describe('storeBase and cachedBase', function () {

	it('stores an artifact and finds it again', function () {
		var target = tmp();
		var meta = cache(target, '0.9.6a');
		var hit = cachedBase(target, '0.9.6a');
		assert.ok(hit, 'should have been a hit');
		assert.strictEqual(hit.metadata.version, '0.9.6a');
		assert.strictEqual(hit.verified, meta.sha256);
		assert.ok(fs.existsSync(hit.tarball));
	});

	it('is a miss for a base that was never cached', function () {
		assert.strictEqual(cachedBase(tmp(), '0.9.6a'), null);
	});

	it('rejects and discards an artifact that no longer matches its checksum', function () {
		// Rot on disk, or an edit. Trusting it would rebuild a tree that passes
		// its own manifest check while not being the release.
		var target = tmp();
		cache(target, '0.9.6a');
		fs.appendFileSync(artifactPath(target, '0.9.6a'), 'tampered');

		assert.strictEqual(cachedBase(target, '0.9.6a'), null, 'a corrupt entry must read as absent');
		assert.strictEqual(fs.existsSync(artifactPath(target, '0.9.6a')), false,
			'and must be cleared out, so the next fetch replaces it');
	});

	it('is a miss when only half the entry is there', function () {
		// An interrupted store. A tarball with no metadata cannot be verified,
		// and unverifiable is the same as absent.
		var target = tmp();
		cache(target, '0.9.6a');
		fs.unlinkSync(metadataPath(target, '0.9.6a'));
		assert.strictEqual(cachedBase(target, '0.9.6a'), null);
	});

	it('is a miss when the metadata is unreadable', function () {
		var target = tmp();
		cache(target, '0.9.6a');
		fs.writeFileSync(metadataPath(target, '0.9.6a'), 'not json');
		assert.strictEqual(cachedBase(target, '0.9.6a'), null);
	});

	it('leaves nothing half-written if a store is interrupted', function () {
		// Files land under a temporary name and are renamed, so a partial copy
		// can never look like a hit.
		var target = tmp();
		cache(target, '0.9.6a');
		var leftovers = fs.readdirSync(baseCacheDir(target)).filter(function (f) { return /\.tmp$/.test(f); });
		assert.deepStrictEqual(leftovers, []);
	});
});

describe('cachedVersions and pruneBaseCache', function () {

	it('lists what is cached, newest first', function () {
		var target = tmp();
		cache(target, '0.9.5a');
		cache(target, '0.9.7a');
		cache(target, '0.9.6a');
		assert.deepStrictEqual(cachedVersions(target), ['0.9.7a', '0.9.6a', '0.9.5a']);
	});

	it('is empty for an install that has never cached anything', function () {
		assert.deepStrictEqual(cachedVersions(tmp()), []);
	});

	it('removes the artifact and its metadata together', function () {
		var target = tmp();
		cache(target, '0.9.5a');
		cache(target, '0.9.6a');
		cache(target, '0.9.7a');

		// keep=1 plus a protected entry keeps two: protecting the base in use
		// must not cost a slot, or a sysop who sits on one base ends up with
		// only that one cached and every other build re-fetching.
		assert.deepStrictEqual(pruneBaseCache(target, 1, ['0.9.7a']), ['0.9.5a']);
		assert.deepStrictEqual(cachedVersions(target), ['0.9.7a', '0.9.6a']);
		assert.strictEqual(fs.existsSync(metadataPath(target, '0.9.5a')), false,
			'a stray metadata file would make the next store look like a partial entry');
	});

	it('keeps the protected base even when it is the oldest thing there', function () {
		var target = tmp();
		cache(target, '0.9.5a');
		cache(target, '0.9.6a');
		cache(target, '0.9.7a');
		pruneBaseCache(target, 1, ['0.9.5a']);
		assert.ok(cachedVersions(target).indexOf('0.9.5a') !== -1);
	});

	it('survives being asked to prune an empty cache', function () {
		assert.deepStrictEqual(pruneBaseCache(tmp(), 2, []), []);
	});
});

describe('discard', function () {

	it('does not mind a base that is not there', function () {
		assert.doesNotThrow(function () { discard(tmp(), '0.9.6a'); });
	});
});
