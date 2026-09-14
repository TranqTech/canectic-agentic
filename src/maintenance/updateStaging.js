// updateStaging.js -- get a release onto this machine and prove it is the
// release, without touching the installation.
//
// This is the half that runs from the OLD version, and the design is explicit
// about why the split is here: applying an upgrade is version specific and is
// where the bugs are, so that part runs from the new release's own tree. This
// part is fetch, verify, extract, reconstruct, and it is meant to be small
// enough to get right once and then leave alone.
//
// Nothing here writes outside the staging directory. A staging run that fails
// leaves the installation exactly as it was.
//
// Reconstruction, not patching. A development build ships only what differs
// from its base stable, and the complete tree is rebuilt in staging from the
// base plus the delta and then checked against the manifest. Patching a live
// tree in place would be wrong in a way that is hard to see: a file changed in
// an earlier development build and reverted in a later one appears in neither
// delta at its correct content, so the local copy keeps the earlier change
// while the manifest wants the base version. Rebuilding from the base makes
// reverts, deletions and half-applied states correct by construction.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import * as alogger from '../utils/alogger.js';
import {
	parseManifest, verifyTree, hashFile, manifestIndex, MANIFEST_FILENAME
} from '../release/manifest.js';
import { parseMetadata, artifactName, metadataName } from '../release/metadata.js';
import { parseIndex, findRelease } from '../release/releaseIndex.js';
import { indexName } from '../release/releaseIndex.js';
import { cachedBase, storeBase } from './baseCache.js';

var FETCH_TIMEOUT_MS = 120000;
var MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Sources
//
// A release lives either at a URL or in a directory. The directory form is not
// only for tests: a sysop who fetched an artifact down a file echo, or by hand
// onto a machine with no outbound HTTP, has one on disk and needs the identical
// verify and reconstruct path. The FTN transport in phase 8 is this source with
// a file area lookup in front of it.
// ---------------------------------------------------------------------------

function dirSource(dir) {
	return { kind: 'dir', path: path.resolve(dir) };
}

function httpSource(baseUrl) {
	var b = String(baseUrl || '').trim();
	if (b && b.charAt(b.length - 1) !== '/') b += '/';
	return { kind: 'http', baseUrl: b };
}

/** Copy or download one published file into `dest`. */
async function fetchFile(source, filename, dest) {
	if (source.kind === 'dir') {
		var from = path.join(source.path, filename);
		if (!fs.existsSync(from)) throw new Error('not found in ' + source.path + ': ' + filename);
		fs.copyFileSync(from, dest);
		return dest;
	}

	var url = source.baseUrl + filename;
	var controller = new AbortController();
	var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
	try {
		var res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
		if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + url);
		var buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_ARTIFACT_BYTES) {
			throw new Error(filename + ' is larger than ' + MAX_ARTIFACT_BYTES + ' bytes');
		}
		fs.writeFileSync(dest, buf);
		return dest;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchText(source, filename) {
	var tmp = path.join(os.tmpdir(), 'canectic-fetch-' + process.pid + '-' + Date.now());
	try {
		await fetchFile(source, filename, tmp);
		return fs.readFileSync(tmp, 'utf8');
	} finally {
		try { fs.unlinkSync(tmp); } catch (_) {}
	}
}

/** The release metadata for one version, validated. */
async function fetchMetadata(source, version) {
	return parseMetadata(await fetchText(source, metadataName(version)));
}

/** The newest release on a channel, or a named one. */
async function resolveRelease(source, channel, version) {
	var index = parseIndex(await fetchText(source, indexName(channel)));
	if (version) {
		var found = findRelease(index, version);
		if (!found) throw new Error(version + ' is not published on the ' + channel + ' channel');
		return found;
	}
	var best = null;
	for (var r of index.releases) if (best === null) best = r;
	if (!best) throw new Error('the ' + channel + ' channel has no releases');
	return best;
}

// ---------------------------------------------------------------------------
// Verification and extraction
// ---------------------------------------------------------------------------

/**
 * Nothing is unpacked unverified.
 *
 * Principle 5, and it is not ceremony: the artifact may have arrived over a
 * file echo through systems nobody here controls, and extraction is the point
 * at which a corrupted or substituted archive gets a say in what runs.
 */
function verifyChecksum(file, expected) {
	var actual = hashFile(file);
	if (actual !== expected) {
		throw new Error(path.basename(file) + ' does not match its published checksum ' +
			'(expected ' + expected + ', got ' + actual + '). It was not unpacked.');
	}
	return actual;
}

/**
 * Unpack a release archive, dropping its top-level canectic-<version>/ wrapper.
 *
 * The wrapper has to go because a delta is laid over its base and the two carry
 * different version directories; keeping them would produce two trees side by
 * side rather than one reconstructed one. ZIP has no --strip-components, so
 * this unpacks to a scratch directory and copies the wrapper's contents across.
 *
 * The copy is `force: true` deliberately: laying a delta over a base IS an
 * overwrite, and that is the whole mechanism.
 *
 * Anything at the archive root beside the wrapper is left behind, which is
 * where FILE_ID.DIZ lives. It describes the archive, not the software, and has
 * no business in the installed tree.
 */
function extractInto(archive, dir) {
	fs.mkdirSync(dir, { recursive: true });
	var scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-unzip-'));
	try {
		execFileSync('unzip', ['-q', '-o', archive, '-d', scratch], { maxBuffer: 64 * 1024 * 1024 });

		var tops = fs.readdirSync(scratch, { withFileTypes: true })
			.filter(function (e) { return e.isDirectory(); })
			.map(function (e) { return e.name; });
		if (tops.length !== 1) {
			throw new Error(path.basename(archive) + ' should contain exactly one directory and contains ' +
				(tops.length === 0 ? 'none' : tops.length + ': ' + tops.join(', ')));
		}
		fs.cpSync(path.join(scratch, tops[0]), dir, { recursive: true, force: true });
	} finally {
		try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
	}
}

/**
 * Delete anything in the staged tree the manifest does not list.
 *
 * This is how a deletion travels. A delta carries bodies for what changed and
 * says nothing about what went, so after laying the delta over the base the
 * removed files are still sitting there; the manifest describes the COMPLETE
 * target tree, so absence from it is the instruction.
 *
 * MANIFEST itself is deliberately exempt: it describes the tree, so it cannot
 * be in its own file list, and deleting it would throw away the only record of
 * what the tree is meant to be.
 */
function pruneToManifest(treeRoot, manifest) {
	var keep = manifestIndex(manifest);
	var removed = [];

	function walk(rel) {
		var abs = rel ? path.join(treeRoot, rel) : treeRoot;
		for (var e of fs.readdirSync(abs, { withFileTypes: true })) {
			var childRel = rel ? rel + '/' + e.name : e.name;
			if (e.isDirectory()) { walk(childRel); continue; }
			if (childRel === MANIFEST_FILENAME) continue;
			if (keep.has(childRel)) continue;
			fs.unlinkSync(path.join(treeRoot, childRel));
			removed.push(childRel);
		}
	}

	walk('');
	return removed;
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Put a complete, verified release tree in a staging directory.
 *
 * @param {object} opts
 * @param {object} opts.source     dirSource() or httpSource()
 * @param {string} opts.version    the release to stage
 * @param {string} [opts.stagingDir] where to build it; a temp dir otherwise
 * @param {string} [opts.target]   the installation, so a delta's base can come
 *                                 from and be added to its cache. Omit and
 *                                 every delta re-fetches its base.
 * @param {function} [opts.onPhase] progress callback (name, detail)
 * @returns {{treeRoot, manifest, meta, stagingDir, reconstructed, pruned, verification}}
 */
async function stageRelease(opts) {
	var report = opts.onPhase || function () {};
	var staging = opts.stagingDir
		? path.resolve(opts.stagingDir)
		: fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-update-'));
	fs.mkdirSync(staging, { recursive: true });

	var downloads = path.join(staging, 'download');
	var treeRoot = path.join(staging, 'tree');
	fs.mkdirSync(downloads, { recursive: true });

	report('resolve', 'reading metadata for ' + opts.version);
	var meta = await fetchMetadata(opts.source, opts.version);

	// A delta is nothing without its base, so the base comes first and is
	// verified on its own terms. The base is a full stable artifact and carries
	// its own checksum in its own metadata.
	var reconstructed = false;
	var baseFromCache = false;
	if (meta.delta) {
		// The base is usually already here: a sysop tracking development needs
		// the same stable tarball for every build cut on it. cachedBase
		// re-verifies before answering, so a hit is a hit on something that
		// still checks out rather than on something that is merely present.
		var cached = opts.target ? cachedBase(opts.target, meta.base) : null;
		var baseFile;
		if (cached) {
			report('base', 'using the cached ' + meta.base);
			baseFile = cached.tarball;
			baseFromCache = true;
		} else {
			report('download', 'base ' + meta.base);
			var baseMetaText = await fetchText(opts.source, metadataName(meta.base));
			var baseMeta = parseMetadata(baseMetaText);
			baseFile = path.join(downloads, baseMeta.artifact);
			await fetchFile(opts.source, baseMeta.artifact, baseFile);
			report('verify', baseMeta.artifact);
			verifyChecksum(baseFile, baseMeta.sha256);
			if (opts.target) storeBase(opts.target, meta.base, baseFile, baseMetaText);
		}
		report('extract', 'base ' + meta.base);
		extractInto(baseFile, treeRoot);
		reconstructed = true;
	}

	report('download', meta.artifact);
	var artifactFile = path.join(downloads, meta.artifact);
	await fetchFile(opts.source, meta.artifact, artifactFile);

	report('verify', meta.artifact);
	verifyChecksum(artifactFile, meta.sha256);

	report('extract', meta.artifact);
	extractInto(artifactFile, treeRoot);

	var manifestFile = path.join(treeRoot, MANIFEST_FILENAME);
	if (!fs.existsSync(manifestFile)) {
		throw new Error('the staged tree carries no ' + MANIFEST_FILENAME +
			', so there is no way to tell whether it is complete');
	}
	var manifest = parseManifest(fs.readFileSync(manifestFile, 'utf8'));

	var pruned = reconstructed ? pruneToManifest(treeRoot, manifest) : [];
	if (pruned.length) report('reconstruct', pruned.length + ' file(s) removed since ' + meta.base);

	// The end-state check the full-tarball path never had. After a delta, this
	// is the assertion that base plus delta really did produce the published
	// tree and not something close to it.
	report('verify', 'staged tree against ' + MANIFEST_FILENAME);
	var verification = verifyTree(treeRoot, manifest);
	if (!verification.ok) {
		throw new Error('the staged tree does not match its manifest: ' +
			verification.missing.length + ' missing, ' + verification.mismatched.length + ' altered. ' +
			'Nothing has been applied.');
	}

	alogger.writeAlog(2, '[Update] staged ' + meta.version + ' in ' + staging +
		' (' + verification.checked + ' files verified)', 'green');

	return {
		treeRoot: treeRoot,
		manifest: manifest,
		meta: meta,
		stagingDir: staging,
		reconstructed: reconstructed,
		baseFromCache: baseFromCache,
		pruned: pruned,
		verification: verification
	};
}

/** Throw away a staging directory. Staging is created and deleted per update. */
function discardStaging(stagingDir) {
	if (!stagingDir) return;
	try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
}

export {
	FETCH_TIMEOUT_MS,
	dirSource,
	httpSource,
	fetchFile,
	fetchText,
	fetchMetadata,
	resolveRelease,
	verifyChecksum,
	extractInto,
	pruneToManifest,
	stageRelease,
	discardStaging
};
