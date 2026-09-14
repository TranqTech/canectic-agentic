// baseCache.js -- keep the stable artifacts that development deltas are
// reconstructed against.
//
// A development build ships only what differs from its base stable, so applying
// one means having that base. A sysop tracking development moves from
// 0.9.6a.20260913 to 0.9.6a.20260920 to 0.9.6a.20260928 and needs the same
// 0.9.6a tarball every time; fetching 7.6 MB again each time is waste over HTTP
// and considerably worse down a file echo, which is often slow and sometimes
// metered.
//
// This is the part of the design that could not live in the staging directory:
// staging is created and deleted per update, and the base has to outlive the
// development builds that reference it.
//
// A CACHED BASE IS STILL VERIFIED ON EVERY USE. Principle 5 says nothing is
// trusted unverified, and a local file is not more trustworthy than a
// downloaded one: it can rot on disk, or be edited, and it is the base that
// everything else is rebuilt from, so a corrupted cache would silently produce
// a tree that passes its own manifest check while not being the release.
//
// The honest limit: storing the metadata alongside the artifact makes this
// trust on first fetch. The checksum is only as good as the fetch that brought
// it in. That is the gap a published signature closes, and why the signature
// hooks exist before the key does.

import * as fs from 'fs';
import * as path from 'path';
import * as alogger from '../utils/alogger.js';
import { hashFile } from '../release/manifest.js';
import { parseMetadata, artifactName, metadataName, manifestName } from '../release/metadata.js';
import { compareVersions, parseVersion } from '../utils/version.js';
import { baseCacheDir, ensure, dirSize } from './updateLayout.js';

var DEFAULT_KEEP = 2;

function artifactPath(target, version) {
	return path.join(baseCacheDir(target), artifactName(version, { delta: false }));
}

function metadataPath(target, version) {
	return path.join(baseCacheDir(target), metadataName(version));
}

function manifestPath(target, version) {
	return path.join(baseCacheDir(target), manifestName(version));
}

/**
 * Is this base cached, and does it still check out?
 *
 * Returns null on anything short of a complete, verified pair. A partial cache
 * entry (an interrupted store, a tarball whose metadata went missing) has to
 * read as a miss rather than as a hit, because the alternative is reconstructing
 * against something nobody can vouch for.
 */
function cachedBase(target, version) {
	var tarball = artifactPath(target, version);
	var meta = metadataPath(target, version);
	if (!fs.existsSync(tarball) || !fs.existsSync(meta)) return null;

	var parsed;
	try {
		parsed = parseMetadata(fs.readFileSync(meta, 'utf8'));
	} catch (e) {
		alogger.writeAlog(3, '[BaseCache] cached metadata for ' + version + ' is unusable: ' + e.message, 'yellowbright');
		return null;
	}

	var actual = hashFile(tarball);
	if (actual !== parsed.sha256) {
		// Not an error to recover from quietly: report it and treat the entry as
		// absent, so the base is fetched again rather than trusted.
		alogger.writeAlog(2, '[BaseCache] cached ' + version + ' does not match its checksum, discarding', 'yellowbright');
		discard(target, version);
		return null;
	}

	return { tarball: tarball, metadata: parsed, metadataFile: meta, verified: actual };
}

/**
 * Put a verified base in the cache.
 *
 * The caller must have verified the artifact already; this stores what it was
 * given and the metadata that vouches for it. Written to a temporary name and
 * renamed, so an interrupted store cannot leave a half-copied tarball that
 * looks like a hit.
 */
function storeBase(target, version, tarballPath, metadataText, manifestText) {
	var dir = ensure(baseCacheDir(target));

	function place(src, dest, text) {
		var tmp = dest + '.tmp';
		if (text !== undefined && text !== null) fs.writeFileSync(tmp, text);
		else fs.copyFileSync(src, tmp);
		fs.renameSync(tmp, dest);
	}

	place(tarballPath, artifactPath(target, version));
	place(null, metadataPath(target, version), metadataText);
	if (manifestText) place(null, manifestPath(target, version), manifestText);

	alogger.writeAlog(3, '[BaseCache] cached ' + version + ' (' +
		Math.round(fs.statSync(artifactPath(target, version)).size / 1024) + ' KB)', 'cyan');
	return { dir: dir, tarball: artifactPath(target, version) };
}

function discard(target, version) {
	for (var f of [artifactPath(target, version), metadataPath(target, version), manifestPath(target, version)]) {
		try { fs.unlinkSync(f); } catch (_) {}
	}
}

/** Versions currently cached, newest first. */
function cachedVersions(target) {
	var out = [];
	var dir = baseCacheDir(target);
	var names;
	try { names = fs.readdirSync(dir); } catch (_) { return []; }
	for (var name of names) {
		var m = /^canectic-(.+)\.tar\.gz$/.exec(name);
		if (!m) continue;
		if (!parseVersion(m[1])) continue;
		out.push(m[1]);
	}
	out.sort(function (a, b) { return compareVersions(b, a); });
	return out;
}

/**
 * Which cached bases to discard.
 *
 * Pure, because this is the rule that can delete something still needed. A
 * delta is always ONE HOP against its own named base, so the only bases that
 * can matter are the one the installed version deltas against and the one the
 * newest release does. `protect` carries those, and nothing in it is ever
 * evicted no matter how many newer entries exist.
 *
 * A count cap rather than a byte cap: nobody is going to tune bytes, and two
 * stable artifacts is about 15 MB.
 *
 * @param {string[]} cached   versions present, any order
 * @param {number} keep       how many to keep, newest first
 * @param {string[]} protect  versions that must survive regardless
 * @returns {string[]} versions to discard, oldest first
 */
function planPrune(cached, keep, protect) {
	var limit = (keep === undefined || keep === null) ? DEFAULT_KEEP : keep;
	var protected_ = new Set();
	for (var p of (protect || [])) {
		if (p && parseVersion(p)) protected_.add(String(p));
	}

	var ordered = (cached || [])
		.filter(function (v) { return parseVersion(v); })
		.slice()
		.sort(function (a, b) { return compareVersions(b, a); });

	var kept = 0;
	var discard_ = [];
	for (var v of ordered) {
		if (protected_.has(v)) continue;          // protected entries do not consume the budget
		if (kept < limit) { kept++; continue; }
		discard_.push(v);
	}
	return discard_.reverse();
}

/** Apply planPrune. Returns the versions discarded. */
function pruneBaseCache(target, keep, protect) {
	var doomed = planPrune(cachedVersions(target), keep, protect);
	for (var v of doomed) {
		discard(target, v);
		alogger.writeAlog(3, '[BaseCache] discarded ' + v, 'cyan');
	}
	return doomed;
}

function cacheSize(target) {
	return dirSize(baseCacheDir(target));
}

export {
	DEFAULT_KEEP,
	artifactPath,
	metadataPath,
	manifestPath,
	cachedBase,
	storeBase,
	discard,
	cachedVersions,
	planPrune,
	pruneBaseCache,
	cacheSize
};
