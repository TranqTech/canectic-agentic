// manifest.js -- the content hash of every file in a release, and the diff
// between two of them.
//
// The manifest is what makes a release describable rather than merely
// downloadable. Three things depend on it:
//
//   1. Telling a file the sysop edited from one they never touched. update.sh
//      compares mtimes today, which says when a file was written and nothing
//      about whether its contents differ from what shipped.
//   2. Deletions. A delta expressed only as changed files cannot say "this file
//      is gone", which is exactly why update.sh reaches for rm -rf on code
//      directories. A manifest of the COMPLETE target tree makes a deletion
//      fall out for free: present locally, absent from the manifest, therefore
//      removed.
//   3. An end-state check. After reconstructing a tree from a base plus a
//      delta, the manifest says whether the result is the tree that was
//      published, which the full-tarball path never had.
//
// The file list is sorted and the serialisation is stable, so building the same
// tree twice produces byte-identical output. Without that a manifest cannot be
// compared or usefully checksummed.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { compareVersions } from '../utils/version.js';

var MANIFEST_VERSION = 1;
var MANIFEST_FILENAME = 'MANIFEST';

function hashBuffer(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashFile(absPath) {
	return hashBuffer(fs.readFileSync(absPath));
}

// git records one permission bit and so do we. Anything finer would be a
// promise the source of truth cannot keep.
function modeFor(stat) {
	return (stat.mode & 0o111) ? '755' : '644';
}

/**
 * Hash every shipped file under `root`.
 *
 * @param {object} opts
 * @param {string} opts.root    absolute path to the tree
 * @param {Array}  opts.files   [{path, category}] from selectShippedFiles
 * @param {string} opts.version the version this tree claims to be
 * @param {string} [opts.generated] ISO timestamp, for reproducible builds
 * @returns {object} manifest
 */
function buildManifest(opts) {
	var root = opts.root;
	var entries = [];

	for (var f of (opts.files || [])) {
		var abs = path.join(root, f.path);
		var stat = fs.statSync(abs);
		entries.push({
			path: f.path,
			category: f.category,
			size: stat.size,
			mode: modeFor(stat),
			sha256: hashFile(abs)
		});
	}

	entries.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });

	return {
		manifest_version: MANIFEST_VERSION,
		version: opts.version || null,
		generated: opts.generated || new Date().toISOString(),
		files: entries
	};
}

function serialiseManifest(manifest) {
	return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Read a manifest back, refusing anything that is not one.
 *
 * A manifest that parses as JSON but carries no file list would silently mean
 * "the target tree is empty", which the updater would honour by deleting the
 * install. It throws instead.
 */
function parseManifest(text) {
	var parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error('manifest is not valid JSON: ' + e.message);
	}
	if (!parsed || typeof parsed !== 'object') throw new Error('manifest is not an object');
	if (!Array.isArray(parsed.files)) throw new Error('manifest has no files array');
	if (parsed.files.length === 0) throw new Error('manifest lists no files');
	for (var f of parsed.files) {
		if (!f || typeof f.path !== 'string' || !f.path) throw new Error('manifest entry has no path');
		if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) {
			throw new Error('manifest entry ' + f.path + ' has no sha256');
		}
	}
	return parsed;
}

/** path -> entry, for lookups. */
function manifestIndex(manifest) {
	var map = new Map();
	for (var f of ((manifest && manifest.files) || [])) map.set(f.path, f);
	return map;
}

/**
 * What changed between two manifests.
 *
 * Direction matters and is easy to get backwards: `removed` means present in
 * the base and absent from the target, so the updater deletes it. Reversing the
 * arguments turns a deletion into an addition of a file whose body no delta
 * carries.
 *
 * @returns {{added:string[], changed:string[], removed:string[], unchanged:string[]}}
 */
function diffManifests(base, target) {
	var baseIdx = manifestIndex(base);
	var targetIdx = manifestIndex(target);

	var added = [];
	var changed = [];
	var unchanged = [];
	var removed = [];

	for (var [p, entry] of targetIdx) {
		var before = baseIdx.get(p);
		if (!before) added.push(p);
		else if (before.sha256 !== entry.sha256 || before.mode !== entry.mode) changed.push(p);
		else unchanged.push(p);
	}

	for (var [bp] of baseIdx) {
		if (!targetIdx.has(bp)) removed.push(bp);
	}

	added.sort();
	changed.sort();
	unchanged.sort();
	removed.sort();

	return { added: added, changed: changed, removed: removed, unchanged: unchanged };
}

/**
 * The file bodies a delta artifact has to carry: everything added or changed.
 *
 * Deletions are not in here on purpose. They are derivable from the manifest,
 * and a delta that also listed them would be stating the same fact twice, with
 * the usual consequence when the two disagree.
 */
function deltaFiles(base, target) {
	var d = diffManifests(base, target);
	return d.added.concat(d.changed).sort();
}

/**
 * Compare a tree on disk against a manifest.
 *
 * `extra` is only meaningful for a tree the updater built itself, so it is
 * reported separately from a mismatch rather than folded in: an install has
 * plenty of files a release manifest never mentions, and calling those a
 * verification failure would fail every real system.
 *
 * @returns {{ok:boolean, missing:string[], mismatched:Array, checked:number}}
 */
function verifyTree(root, manifest) {
	var missing = [];
	var mismatched = [];
	var checked = 0;

	for (var f of ((manifest && manifest.files) || [])) {
		var abs = path.join(root, f.path);
		if (!fs.existsSync(abs)) { missing.push(f.path); continue; }
		checked++;
		var actual = hashFile(abs);
		if (actual !== f.sha256) mismatched.push({ path: f.path, expected: f.sha256, actual: actual });
	}

	return {
		ok: missing.length === 0 && mismatched.length === 0,
		missing: missing,
		mismatched: mismatched,
		checked: checked
	};
}

/** Paths present locally but absent from the target manifest, so due for removal. */
function pathsToRemove(localManifest, targetManifest) {
	return diffManifests(localManifest, targetManifest).removed;
}

/**
 * Is this the manifest of the version it is claimed to be?
 *
 * A delta is only reconstructable if it was computed against the tree the
 * metadata names. Nothing else catches a mismatch: the version and the `base`
 * field agree with each other because both are derived from the version string,
 * so a manifest loaded from the wrong place slips straight past validation and
 * produces an artifact nobody can rebuild. The manifest states which tree it
 * describes, so the check costs one comparison.
 *
 * Fails closed on a manifest that names no version. Refusing to build against
 * an unidentified tree is the whole point.
 */
function manifestIsFor(manifest, version) {
	if (!manifest || !manifest.version || !version) return false;
	return compareVersions(manifest.version, version) === 0;
}

/** Total bytes a manifest describes, used to size a delta against a full tree. */
function totalBytes(manifest) {
	var sum = 0;
	for (var f of ((manifest && manifest.files) || [])) sum += (f.size || 0);
	return sum;
}

export {
	MANIFEST_VERSION,
	MANIFEST_FILENAME,
	hashBuffer,
	hashFile,
	buildManifest,
	serialiseManifest,
	parseManifest,
	manifestIndex,
	diffManifests,
	deltaFiles,
	verifyTree,
	pathsToRemove,
	manifestIsFor,
	totalBytes
};
