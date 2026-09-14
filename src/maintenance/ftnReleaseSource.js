// ftnReleaseSource.js -- releases that arrive down a file echo.
//
// This is how BBS software was distributed for twenty years, it works for a
// system with an FTN link and no outbound HTTP, and it does not depend on a web
// host being reachable. Phase 8 of UPDATE_SYSTEM_DESIGN.
//
// Almost nothing new happens here. By the time a release is interesting, the
// TIC tosser has already received it, checked its CRC against the TIC, hashed
// it, and filed it in a file area. So:
//
//   DETECTION needs no network and no announcement. A new artifact appearing in
//   the configured area IS the signal, and finding it is a query against
//   file_entries.
//
//   DOWNLOADING is a copy. The file is already on this disk, so the existing
//   directory source does the rest, which is why that source was written to
//   take a directory rather than only a URL.
//
// THERE IS NO INDEX DOCUMENT. Over HTTP a channel index is published and
// fetched; a file echo carries files, not indexes, so the index is derived from
// what is present. Each archive carries CANECTIC.ID and its own metadata at the
// root, which is exactly why they are there.
//
// WHAT THIS DOES NOT GIVE YOU, stated plainly because it would be easy to
// assume otherwise: a file echo does not carry the published checksum unless
// the sibling metadata file was TIC'd too. The TIC's own CRC-32 and the SHA-256
// the tosser computed on arrival both prove the file has not changed since it
// got here. Neither proves it is the file the maintainer built. Over FTN the
// trust boundary is the link password and, when a key is published, the
// signature.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as alogger from '../utils/alogger.js';
import * as fileAreas from '../models/fileAreas.js';
import * as fileGroups from '../models/fileGroups.js';
import * as postgres from '../middleware/db/postgres.js';
import { parseVersion, compareVersions, channelOf } from '../utils/version.js';
import { parseIdentity, IDENTITY_FILENAME } from '../release/identity.js';
import { metadataName } from '../release/metadata.js';

// canectic-0.9.6a.zip, canectic-0.9.6a.20260913.delta.zip
var ARTIFACT_PATTERN = /^canectic-(.+?)(\.delta)?\.zip$/i;

/**
 * What a release artifact's filename claims.
 *
 * A claim, not a fact: a filename survives a distribution chain that may rename
 * it, and nothing stops anybody naming a file anything. It is the cheap first
 * pass, and CANECTIC.ID inside the archive is what settles it.
 *
 * @returns {{version:string, delta:boolean}|null}
 */
function parseArtifactName(filename) {
	var m = ARTIFACT_PATTERN.exec(String(filename || ''));
	if (!m) return null;
	// Lowercased because file echoes uppercase names, which is a habit inherited
	// from 8.3 DOS and still alive in parts of the network. Nothing is lost:
	// a version contains digits, dots and a phase letter that is only ever
	// lower case in canonical form, so CANECTIC-0.9.6A.ZIP is unambiguously
	// canectic-0.9.6a.zip.
	var version = m[1].toLowerCase();
	if (!parseVersion(version)) return null;
	return { version: version, delta: !!m[2] };
}

/** Read CANECTIC.ID out of an archive without extracting it. */
function readIdentity(archivePath) {
	try {
		var text = execFileSync('unzip', ['-p', archivePath, IDENTITY_FILENAME],
			{ maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
		return parseIdentity(text);
	} catch (_) {
		return null;
	}
}

/** Read the metadata the archive carries at its root, which has no sha256. */
function readEmbeddedMetadata(archivePath, version) {
	try {
		var text = execFileSync('unzip', ['-p', archivePath, metadataName(version)],
			{ maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
		return JSON.parse(text);
	} catch (_) {
		return null;
	}
}

/**
 * Turn what a file area holds into the index shape the update check already
 * understands.
 *
 * Pure, given rows that have been described already. Keeping it that way is
 * what lets the ordering and the channel filtering be tested without a database
 * or an archive.
 *
 * `identity` on each row is the parsed CANECTIC.ID, or null when it could not
 * be read. A row with no identity falls back to its filename, which is a weaker
 * claim and is treated as one: no migrations means the move rule has nothing to
 * check, so those are dropped rather than offered as safe.
 *
 * @param {Array} described  [{filename, disk_path, sha256, identity}]
 * @param {string} channel   the channel this area carries
 * @returns {object} an index
 */
function indexFromEntries(described, channel) {
	var releases = [];

	for (var row of (described || [])) {
		// Identity first, because everything below depends on it and because
		// this is the rule that matters most. The filename is a hint and
		// nothing more: it survives a distribution chain that may rename,
		// truncate or uppercase it, and nothing stops anybody naming a file
		// anything, so CANECTIC.ID inside settles it.
		//
		// An archive that cannot identify itself is DROPPED, not offered. Its
		// migration list would be empty, and an empty migration list clears
		// every blocker in the move rule, so an unidentifiable file would be
		// presented as safe to install against a database it says nothing
		// about. That is the worst answer available here.
		var id = row.identity;
		if (!id) {
			if (parseArtifactName(row.filename)) {
				alogger.writeAlog(3, '[FTN release] ' + row.filename + ' carries no ' +
					IDENTITY_FILENAME + ' and cannot be identified; ignoring', 'yellowbright');
			}
			continue;
		}

		var version = id.version;
		if (!parseVersion(version)) continue;

		// A channel the area is not carrying. A sysop can put anything in a
		// file area and an artifact that wandered in from the other channel
		// must not be offered as though this area vouched for it.
		if (channel && channelOf(version) !== channel) continue;

		releases.push({
			version: version,
			released: id.released || null,
			codename: id.codename || null,
			artifact: row.filename,
			// The locally computed hash, not the published one. It proves the
			// file has not changed since it arrived here.
			sha256: null,
			local_sha256: row.sha256 || null,
			local_path: row.disk_path || null,
			delta: id.delta,
			base: id.base || null,
			base_artifact: id.base ? 'canectic-' + id.base + '.zip' : null,
			metadata: metadataName(version),
			node_min: id.node_min || null,
			min_upgrade_from: id.min_upgrade_from || null,
			migrations: id.migrations || [],
			transport: 'ftn'
		});
	}

	releases.sort(function (a, b) { return compareVersions(b.version, a.version); });
	return { index_version: 1, channel: channel, updated: new Date().toISOString(), releases: releases };
}

/** The directory a file area's files live in. */
async function areaDirectory(shortcode) {
	var area = await fileAreas.getAreaByShortcode(shortcode);
	if (!area) return null;
	var group = area.group_shortcode ? await fileGroups.getGroupByShortcode(area.group_shortcode) : null;
	return fileAreas.resolveAreaPath(group, area);
}

/** Release artifacts filed in an area, described enough to index. */
async function describeArea(shortcode) {
	var area = await fileAreas.getAreaByShortcode(shortcode);
	if (!area) return { area: null, dir: null, described: [] };

	var dir = await areaDirectory(shortcode);
	var rows = await postgres.query(
		"SELECT filename, disk_path, file_hash_sha256 FROM file_entries " +
		"WHERE area_id = $1 AND active = true AND filename ILIKE 'canectic-%.zip'",
		[area.id]
	) || [];

	var described = [];
	for (var row of rows) {
		var full = row.disk_path || (dir ? path.join(dir, row.filename) : null);
		if (!full || !fs.existsSync(full)) {
			// Filed in the database and gone from the disk. Ignored rather than
			// offered, since staging would fail on it later and more obscurely.
			continue;
		}
		described.push({
			filename: row.filename,
			disk_path: full,
			sha256: row.file_hash_sha256 || null,
			identity: readIdentity(full)
		});
	}
	return { area: area, dir: dir, described: described };
}

/**
 * The channel index this system can derive from a file area.
 *
 * @returns {object|null} an index, or null when no area is configured or it
 *                        does not exist. Null reads as "unknown" rather than
 *                        "nothing available", which is the difference between a
 *                        misconfiguration and an empty channel.
 */
async function buildChannelIndex(shortcode, channel) {
	if (!shortcode) return null;
	var found = await describeArea(shortcode);
	if (!found.area) {
		alogger.writeAlog(2, '[FTN release] no file area "' + shortcode + '" for the ' +
			channel + ' channel', 'yellowbright');
		return null;
	}
	return indexFromEntries(found.described, channel);
}

/**
 * Where to fetch a release that is already on this disk.
 *
 * The artifact is in a file area, so "downloading" is a copy and the existing
 * directory source does the rest. Returning a source rather than a path keeps
 * every caller on one code path regardless of how the release arrived.
 */
function sourceForRelease(entry) {
	if (!entry || !entry.local_path) return null;
	return { kind: 'dir', path: path.dirname(entry.local_path) };
}

/** Did this release come down a file echo? Decides whether the missing
 *  published checksum is expected or is a problem. */
function isFtnRelease(entry) {
	return !!(entry && entry.transport === 'ftn');
}

export {
	ARTIFACT_PATTERN,
	sourceForRelease,
	isFtnRelease,
	parseArtifactName,
	readIdentity,
	readEmbeddedMetadata,
	indexFromEntries,
	areaDirectory,
	describeArea,
	buildChannelIndex
};
