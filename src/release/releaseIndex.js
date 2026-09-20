// releaseIndex.js -- one document per channel listing every release, newest
// first, so a client answers "is there anything newer than what I have" in a
// single fetch.
//
// The index carries each release's migration ids as well as its version. That
// is deliberate: the move rule in section 7 of UPDATE_SYSTEM_DESIGN is a
// question about migrations, not versions, so an index without them would make
// the update check fetch every candidate's metadata before it could say whether
// a move was even allowed.
//
// Entries are summaries. Steps, notices and release notes live in the
// per-release metadata, because they are read once by someone who has decided
// to update and would otherwise grow the document every client fetches daily.

import { compareVersions, parseVersion, channelOf, baseStable, isNewer } from '../utils/version.js';

var INDEX_VERSION = 1;

function indexName(channel) {
	return 'index-' + channel + '.json';
}

function emptyIndex(channel) {
	return {
		index_version: INDEX_VERSION,
		channel: channel,
		updated: null,
		releases: []
	};
}

/** The subset of a release's metadata the index carries. */
function summariseRelease(meta) {
	return {
		version: meta.version,
		released: meta.released,
		codename: meta.codename || null,
		artifact: meta.artifact,
		sha256: meta.sha256,
		delta: meta.delta === true,
		base: meta.base || null,
		base_artifact: meta.base_artifact || null,
		metadata: 'canectic-' + meta.version + '.json',
		node_min: meta.node_min || null,
		min_upgrade_from: meta.min_upgrade_from || null,
		migrations: (meta.migrations || []).slice(),
		bytes: meta.bytes || null,
		// Set when a release is withdrawn after publication. Null on a normal
		// cut; written later by markSuperseded, because the fault that
		// withdraws a release is by definition discovered after it shipped.
		superseded_by: meta.superseded_by || null,
		superseded_reason: meta.superseded_reason || null
	};
}

/**
 * Withdraw a published release, pointing at the one that replaces it.
 *
 * A release can only be found defective after it is published — by then the
 * artifact is signed, indexed, and reachable by every board that checks. There
 * was no way to say so: an index entry carried version, artifact, checksum and
 * migrations, and nothing else. A board on an older version would be offered
 * the broken release, take it, and meet the same fault.
 *
 * Marking it here rather than in the release's own metadata sidecar is
 * deliberate. The sidecar describes the ARCHIVE, is covered by SHA256SUMS, and
 * is what a board verifies; rewriting it would invalidate a signature over a
 * file whose bytes should never change. The index is the mutable, regenerated
 * part, so a withdrawal belongs there.
 *
 * Returns a new index; does not mutate the one given.
 */
function markSuperseded(index, version, supersededBy, reason) {
	var idx = index || emptyIndex(null);
	var found = false;

	var releases = (idx.releases || []).map(function (r) {
		if (r.version !== version) return r;
		found = true;
		return Object.assign({}, r, {
			superseded_by: supersededBy || null,
			superseded_reason: reason || null
		});
	});

	if (!found) {
		throw new Error('no release ' + version + ' in the ' + (idx.channel || 'unknown') + ' index to supersede');
	}

	return Object.assign({}, idx, { releases: releases, updated: new Date().toISOString() });
}

/**
 * Add or replace a release, keeping the list newest first.
 *
 * Replacing rather than appending on a repeat version matters when a release is
 * re-cut after a packaging mistake: two entries for one version would leave
 * every client's answer depending on which one it read first.
 */
function addRelease(index, meta) {
	var idx = index || emptyIndex(channelOf(meta.version));
	var releases = (idx.releases || []).filter(function (r) { return r.version !== meta.version; });
	releases.push(summariseRelease(meta));
	releases.sort(function (a, b) { return compareVersions(b.version, a.version); });
	return {
		index_version: INDEX_VERSION,
		channel: idx.channel || channelOf(meta.version),
		updated: new Date().toISOString(),
		releases: releases
	};
}

function findRelease(index, version) {
	for (var r of ((index && index.releases) || [])) {
		if (compareVersions(r.version, version) === 0) return r;
	}
	return null;
}

/** Newest first is the stored order, so this is the head, but the head of an
 *  index someone hand-edited may not be. Ask the comparator. */
function newestRelease(index) {
	var best = null;
	for (var r of ((index && index.releases) || [])) {
		if (!parseVersion(r.version)) continue;
		if (best === null || compareVersions(r.version, best.version) > 0) best = r;
	}
	return best;
}

/** The newest release strictly newer than `current`, or null when up to date. */
function newestNewerThan(index, current) {
	var best = newestRelease(index);
	if (!best) return null;
	return isNewer(best.version, current) ? best : null;
}

/**
 * Every development build based on a given stable.
 *
 * The base is readable straight out of the version, which is the whole payoff
 * of naming the last stable: the published set of builds carrying a stable's
 * migrations is enumerable without opening a single metadata file.
 */
function releasesBasedOn(index, stableVersion) {
	var out = [];
	for (var r of ((index && index.releases) || [])) {
		var base = r.base || baseStable(r.version);
		if (base && compareVersions(base, stableVersion) === 0) out.push(r);
	}
	out.sort(function (a, b) { return compareVersions(a.version, b.version); });
	return out;
}

function serialiseIndex(index) {
	return JSON.stringify(index, null, 2) + '\n';
}

function parseIndex(text) {
	var parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error('release index is not valid JSON: ' + e.message);
	}
	if (!parsed || !Array.isArray(parsed.releases)) throw new Error('release index has no releases array');
	return parsed;
}

export {
	markSuperseded,
	INDEX_VERSION,
	indexName,
	emptyIndex,
	summariseRelease,
	addRelease,
	findRelease,
	newestRelease,
	newestNewerThan,
	releasesBasedOn,
	serialiseIndex,
	parseIndex
};
