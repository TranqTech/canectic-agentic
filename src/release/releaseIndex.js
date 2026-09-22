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
		bytes: meta.bytes || null
	};
}

/**
 * Withdrawn releases live in their own list, not flagged inside `releases`.
 *
 * The first withdrawal (0.9.7a) was a mark on its entry in `releases`, and only
 * update checks from 0.9.8a on knew to skip a marked entry. Every board on an
 * older release, and every bootstrap ever published, takes the first entry in
 * `releases` whatever it carries, so a mark could not stop a broken release
 * spreading; 0.9.7a stopped being offered only because 0.9.8a was newer. Taking
 * the entry OUT of `releases` stops it everywhere at once, including on code
 * that has never heard of withdrawal, and it can be done the moment a fault is
 * found, before any replacement exists.
 *
 * An entry in `withdrawn` keeps everything it had in `releases` (its migrations
 * still matter: boards that took it applied them) plus:
 *
 *   withdrawn_at      when
 *   withdrawn_reason  why, which a board running it is told
 *   superseded_by     the release that replaces it, null until there is one
 *
 * The release's own files stay published. The metadata sidecar is covered by
 * SHA256SUMS and describes the archive, so it is never rewritten; the index is
 * the regenerated part.
 */

/**
 * The index in its current shape: a `withdrawn` list always present, and any
 * entry still marked in place (superseded_by set inside `releases`, the first
 * format) moved into it. Returns a new object. Pure.
 */
function normaliseIndex(index) {
	var idx = index || emptyIndex(null);
	var withdrawn = (idx.withdrawn || []).slice();
	var releases = [];
	for (var r of (idx.releases || [])) {
		if (r && r.superseded_by) {
			var legacy = Object.assign({}, r);
			var reason = legacy.superseded_reason || null;
			delete legacy.superseded_reason;
			if (!withdrawn.some(function (w) { return w.version === legacy.version; })) {
				withdrawn.push(Object.assign(legacy, {
					withdrawn_at: idx.updated || null,
					withdrawn_reason: reason
				}));
			}
			continue;
		}
		releases.push(r);
	}
	withdrawn.sort(function (a, b) { return compareVersions(b.version, a.version); });
	return Object.assign({}, idx, { releases: releases, withdrawn: withdrawn });
}

/**
 * Withdraw a release, with or without a replacement yet. Withdrawing one that
 * is already withdrawn updates it: that is how the replacement is named once
 * it exists, and how a reason is corrected.
 *
 * @param {object} index
 * @param {string} version
 * @param {object} opts   { reason, by, at }
 * @returns {object} a new index
 */
function withdrawRelease(index, version, opts) {
	var o = opts || {};
	var idx = normaliseIndex(index);
	var same = function (r) { return r && compareVersions(r.version, version) === 0; };
	var listed = idx.releases.filter(same)[0] || null;
	var earlier = idx.withdrawn.filter(same)[0] || null;
	if (!listed && !earlier) {
		throw new Error('no release ' + version + ' in the ' + (idx.channel || 'unknown') + ' index to withdraw');
	}
	if (o.by && compareVersions(o.by, version) === 0) throw new Error('a release cannot supersede itself');

	var entry = Object.assign({}, earlier || {}, listed || {}, {
		withdrawn_at: (earlier && earlier.withdrawn_at) || (o.at || new Date()).toISOString(),
		withdrawn_reason: o.reason || (earlier && earlier.withdrawn_reason) || null,
		superseded_by: o.by || (earlier && earlier.superseded_by) || null
	});
	delete entry.superseded_reason;

	var withdrawn = idx.withdrawn.filter(function (w) { return !same(w); }).concat([entry]);
	withdrawn.sort(function (a, b) { return compareVersions(b.version, a.version); });
	return Object.assign({}, idx, {
		releases: idx.releases.filter(function (r) { return !same(r); }),
		withdrawn: withdrawn,
		updated: new Date().toISOString()
	});
}

/** The withdrawn entry for a version, or null. */
function findWithdrawn(index, version) {
	for (var w of (normaliseIndex(index).withdrawn || [])) {
		if (compareVersions(w.version, version) === 0) return w;
	}
	return null;
}

/**
 * Add or replace a release, keeping the list newest first.
 *
 * Replacing rather than appending on a repeat version matters when a release is
 * re-cut after a packaging mistake: two entries for one version would leave
 * every client's answer depending on which one it read first.
 */
function addRelease(index, meta) {
	var idx = normaliseIndex(index || emptyIndex(channelOf(meta.version)));
	if (idx.withdrawn.some(function (w) { return compareVersions(w.version, meta.version) === 0; })) {
		// A version names one set of bytes for ever. Re-using a withdrawn one
		// would mean two different releases answering to the same name.
		throw new Error(meta.version + ' has been withdrawn; a replacement needs a new version');
	}
	var releases = idx.releases.filter(function (r) { return r.version !== meta.version; });
	releases.push(summariseRelease(meta));
	releases.sort(function (a, b) { return compareVersions(b.version, a.version); });
	return {
		index_version: INDEX_VERSION,
		channel: idx.channel || channelOf(meta.version),
		updated: new Date().toISOString(),
		releases: releases,
		withdrawn: idx.withdrawn
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
	// Withdrawn builds count: a board that took one applied its migrations,
	// and withdrawing it did not undo them.
	var idx = normaliseIndex(index);
	for (var r of idx.releases.concat(idx.withdrawn)) {
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
	return normaliseIndex(parsed);
}

export {
	normaliseIndex,
	withdrawRelease,
	findWithdrawn,
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
