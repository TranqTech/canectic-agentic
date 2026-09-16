#!/usr/bin/env node
// release.mjs -- cut a Canectic release.
//
// A script, because there is no CI and the manual process already let v0.9.5a
// ship with no release notes at all: they were written retrospectively five
// months later from the changelog. Everything here is a step that was
// previously somebody remembering.
//
//   node scripts/release.mjs --stable 0.9.6a
//   node scripts/release.mjs --dev
//   node scripts/release.mjs --stable 0.9.6a --dry-run
//
// Stable builds a full tarball and mutates the repository: package.json is
// bumped, the changelog Pending section is closed into the version, a release
// note skeleton is written, pending.json is reset, and the result is committed
// and tagged. Development builds a delta against the most recent stable and
// touches nothing in the repository at all.
//
// The bookkeeping happens BEFORE the artifact is staged, so a release tarball
// contains its own release notes and its own changelog entry. Building first
// would ship a tarball whose changelog says the release is still pending.
//
// Nothing here talks to a database or a running BBS. The pure parts live in
// src/release/ and are unit tested.
//
// This file used to say the orchestration was the part a test cannot usefully
// assert. Two bugs in one evening said otherwise, both of them in the handful
// of lines between "the suite passed" and "the artifact exists", which is the
// worst place in the program to be wrong because the repository has already
// been written to by then. So main() runs only when this file is the program,
// and the helpers below are importable and tested.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

import { parseVersion, formatVersion, compareVersions, isNewer, baseStable, channelOf } from '../src/utils/version.js';
import { listTrackedFiles, selectShippedFiles } from '../src/release/shippedTree.js';
import {
	buildManifest, serialiseManifest, parseManifest, deltaFiles, diffManifests,
	hashFile, hashBuffer, totalBytes, manifestIsFor, MANIFEST_FILENAME
} from '../src/release/manifest.js';
import {
	buildMetadata, validateMetadata, serialiseMetadata, artifactName, metadataName,
	manifestName, developmentVersionFor, normalisePending, emptyPending, codenameFor,
	checksummedNames, releaseDate
} from '../src/release/metadata.js';
import {
	IDENTITY_FILENAME, DIZ_FILENAME, serialiseIdentity, buildFileIdDiz, withoutSelfChecksum
} from '../src/release/identity.js';
import { publishEntryPoint } from '../src/release/entryPoint.js';
import { gitlabAvailable, publishToGitLab, releaseTitle } from '../src/release/gitlabRelease.js';
import {
	PUBLIC_KEY_FILENAME, signatureName, detachSign, keyFingerprint, formatFingerprint,
	assertCanSign
} from '../src/release/signing.js';
import {
	emptyIndex, addRelease, findRelease, newestRelease, releasesBasedOn,
	serialiseIndex, parseIndex, indexName
} from '../src/release/releaseIndex.js';
import { checkStableCoverage, deltaShare } from '../src/release/pipelineCheck.js';
import {
	pendingIsEmpty, findPending, closePending, crossCheckPending, releaseNoteSkeleton
} from '../src/release/changelog.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var CHANGELOG = path.join(ROOT, 'docs', 'sysop', 'CHANGELOG.md');
var PENDING = path.join(ROOT, 'docs', 'releases', 'pending.json');
var MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');
var DEFAULT_OUTPUT = path.join(ROOT, 'dist', 'releases');

var RED = '\x1b[0;31m', GREEN = '\x1b[0;32m', YELLOW = '\x1b[1;33m', CYAN = '\x1b[0;36m', BOLD = '\x1b[1m', NC = '\x1b[0m';
function info(m)  { console.log(CYAN + '->' + NC + ' ' + m); }
function ok(m)    { console.log(GREEN + '+' + NC + ' ' + m); }
function warn(m)  { console.log(YELLOW + '!' + NC + ' ' + m); }
function die(m)   { console.error(RED + 'x' + NC + ' ' + m); process.exit(1); }

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	var opts = {
		mode: null, version: null, output: DEFAULT_OUTPUT, dryRun: false,
		skipTests: false, allowDirty: false, tag: true, sign: false,
		baseManifest: null, date: null, counter: null, allowMigrationGap: false
	};

	for (var i = 0; i < argv.length; i++) {
		var a = argv[i];
		if (a === '--stable')                   { opts.mode = 'stable'; opts.version = argv[++i]; }
		else if (a === '--dev')                 { opts.mode = 'development'; }
		else if (a === '--output')              { opts.output = path.resolve(argv[++i]); }
		else if (a === '--base-manifest')       { opts.baseManifest = path.resolve(argv[++i]); }
		else if (a === '--date')                { opts.date = argv[++i]; }
		else if (a === '--counter')             { opts.counter = parseInt(argv[++i], 10); }
		else if (a === '--dry-run')             { opts.dryRun = true; }
		else if (a === '--skip-tests')          { opts.skipTests = true; }
		else if (a === '--allow-dirty')         { opts.allowDirty = true; }
		else if (a === '--allow-migration-gap') { opts.allowMigrationGap = true; }
		else if (a === '--no-tag')              { opts.tag = false; }
		else if (a === '--no-gitlab')           { opts.gitlab = false; }
		else if (a === '--publish')             { opts.mode = 'publish'; opts.version = argv[++i]; }
		else if (a === '--sign')                { opts.sign = true; }
		else if (a === '--help' || a === '-h')  { usage(); process.exit(0); }
		else die('unknown argument: ' + a);
	}
	return opts;
}

function usage() {
	console.log([
		'',
		BOLD + 'Canectic release' + NC,
		'',
		'  node scripts/release.mjs --stable <version>   cut a stable release',
		'  node scripts/release.mjs --dev                cut a development build',
		'',
		'  --output DIR             where artifacts land (default dist/releases)',
		'  --dry-run                report what would happen, write nothing',
		'  --skip-tests             do not run the suite (for a re-cut after a failure)',
		'  --allow-dirty            build from a dirty tree (never for a real release)',
		'  --allow-migration-gap    publish a stable that drops a development migration',
		'  --no-tag                 skip the release commit and tag (stable only)',
		'  --no-gitlab              do not mirror the release onto the GitLab releases page',
		'  --publish <version>      only mirror an already cut release onto GitLab',
		'  --sign                   gpg sign SHA256SUMS',
		'  --base-manifest PATH     the stable manifest a development delta is against',
		'  --date YYYY-MM-DD        override the release date',
		'  --counter N              same-day development build counter',
		''
	].join('\n'));
}

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

function git(args, opts) {
	// execFileSync returns null for stdout when stdio is inherited rather than
	// captured, so trimming the result unconditionally turns a command that
	// SUCCEEDED into a TypeError. That is how a signed tag got created and the
	// cut then died on the line after it, with the artifact never built and the
	// repository holding a release commit.
	var out = execFileSync('git', ['-C', ROOT].concat(args), Object.assign({ encoding: 'utf8' }, opts || {}));
	return out == null ? '' : String(out).trim();
}

function treeIsClean() {
	return git(['status', '--porcelain']) === '';
}

function readJSON(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function packageVersion() {
	return readJSON(path.join(ROOT, 'package.json')).version;
}

function nodeMinFromEngines() {
	var engines = readJSON(path.join(ROOT, 'package.json')).engines || {};
	var m = /(\d+\.\d+\.\d+)/.exec(String(engines.node || ''));
	return m ? m[1] : null;
}

// Every migration id this tree ships. The ledger orders by the numeric prefix
// and refuses a malformed name, so the same rule applies here rather than a
// looser one: a file the ledger would refuse must not be published as shipped.
function shippedMigrations() {
	if (!fs.existsSync(MIGRATIONS_DIR)) return [];
	return fs.readdirSync(MIGRATIONS_DIR)
		.filter(function (f) { return /^\d{4}-[a-z0-9][a-z0-9-]*\.js$/.test(f); })
		.map(function (f) { return f.replace(/\.js$/, ''); })
		.sort();
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function runTests() {
	info('running the test suite');
	try {
		execFileSync('npx', ['mocha'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e) {
		var out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
		console.log(out.split('\n').slice(-40).join('\n'));
		die('the test suite failed, so there is nothing to release');
	}
	ok('tests pass');
}

// ---------------------------------------------------------------------------
// Output directory state
// ---------------------------------------------------------------------------

function loadIndex(outputDir, channel) {
	var file = path.join(outputDir, indexName(channel));
	if (!fs.existsSync(file)) return emptyIndex(channel);
	return parseIndex(fs.readFileSync(file, 'utf8'));
}

// A manifest is only usable as a base if it describes the tree the metadata
// names. The version and the `base` field are both derived from the version
// string, so they agree with each other no matter which manifest was loaded;
// this is the only check that can catch --base-manifest aimed at the wrong
// tree, and the failure it prevents is a published delta nobody can rebuild.
function verifiedBase(text, base, source) {
	var manifest = parseManifest(text);
	if (!manifestIsFor(manifest, base)) {
		die(source + ' describes ' + (manifest.version || 'an unnamed tree') + ', not ' + base + '. ' +
			'A delta built against it would reconstruct into a tree no release corresponds to.');
	}
	return manifest;
}

function loadBaseManifest(outputDir, base, override) {
	if (override) {
		if (!fs.existsSync(override)) die('base manifest not found: ' + override);
		return verifiedBase(fs.readFileSync(override, 'utf8'), base, override);
	}

	var standalone = path.join(outputDir, manifestName(base));
	if (fs.existsSync(standalone)) {
		return verifiedBase(fs.readFileSync(standalone, 'utf8'), base, manifestName(base));
	}

	// Fall back to the copy inside the stable archive, which is the authority
	// and is what a maintainer who only kept the published files will have.
	var tarball = path.join(outputDir, artifactName(base, { delta: false }));
	if (fs.existsSync(tarball)) {
		var text = execFileSync('unzip', ['-p', tarball, 'canectic-' + base + '/' + MANIFEST_FILENAME],
			{ maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
		return verifiedBase(text, base, artifactName(base, { delta: false }));
	}

	die('no manifest for base ' + base + ' in ' + outputDir + '. A development build is a delta ' +
		'against its base stable, so that release must be published before anything can be built on it. ' +
		'Pass --base-manifest to point at it elsewhere.');
}

// ---------------------------------------------------------------------------
// Staging and packing
// ---------------------------------------------------------------------------

// Did package.json change for a reason other than the version stamp?
//
// Every development build rewrites the version in the staged package.json, so
// that one file always differs from the base and "nothing has changed since the
// last build" would never be true. Re-hashing the staged file with the base's
// version put back answers the question exactly, because the base's own hash
// was computed over a file written by this same serialisation.
function packageJsonIsVersionStampOnly(treeRoot, baseVersion, baseManifest) {
	var entry = (baseManifest.files || []).find(function (f) { return f.path === 'package.json'; });
	if (!entry) return false;
	var pkg = readJSON(path.join(treeRoot, 'package.json'));
	pkg.version = baseVersion;
	return hashBuffer(Buffer.from(JSON.stringify(pkg, null, 2) + '\n')) === entry.sha256;
}

function stageTree(version, files) {
	var staging = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-release-'));
	var treeName = 'canectic-' + version;
	var treeRoot = path.join(staging, treeName);

	for (var f of files) {
		var src = path.join(ROOT, f.path);
		var dst = path.join(treeRoot, f.path);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
		fs.chmodSync(dst, (fs.statSync(src).mode & 0o111) ? 0o755 : 0o644);
	}

	// The version the artifact reports itself as. Without this a development
	// build installs claiming to be the stable it was based on, is told by the
	// update check that it is current, and never sees a newer development build
	// at all.
	var pkgFile = path.join(treeRoot, 'package.json');
	var pkg = readJSON(pkgFile);
	pkg.version = version;
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

	return { staging: staging, treeRoot: treeRoot, treeName: treeName };
}

/**
 * Give every staged file the same timestamp.
 *
 * ZIP stores a DOS timestamp per member and has no equivalent of tar's
 * --mtime, so without this two builds of one commit differ in bytes purely
 * because the files were checked out at different times.
 */
function normaliseTimes(root, when) {
	var stamp = new Date(when);
	(function walk(dir) {
		for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
			var p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) fs.utimesSync(p, stamp, stamp);
		}
	})(root);
}

/**
 * Build the release archive.
 *
 * Names are fed on stdin, sorted, so the archive's member order is the same on
 * every build of the same tree. `-X` drops the extra fields (uid, gid, extended
 * timestamps) that would otherwise vary between machines. Combined with the
 * mtime normalisation in stageTree, two builds of one commit produce the same
 * bytes, which is a property worth having even though the published sha256 is
 * the authority regardless.
 *
 * FILE_ID.DIZ goes in at the archive ROOT, outside the version wrapper. Our own
 * extractor finds it anywhere, but plenty of other BBS software only looks at
 * the top, and the whole reason this is a ZIP is so other software can read it.
 */
function pack(opts) {
	var names = [];
	if (opts.members) {
		for (var m of opts.members) names.push(path.join(opts.treeName, m));
	} else {
		names = walkRelative(path.join(opts.staging, opts.treeName), opts.treeName);
	}
	names.sort();
	if (opts.rootFiles) names = names.concat(opts.rootFiles);

	execFileSync('zip', ['-X', '-q', '-@', opts.out], {
		cwd: opts.staging,
		input: names.join('\n') + '\n',
		maxBuffer: 16 * 1024 * 1024
	});
}

/** Every file under `dir`, as paths prefixed with `prefix`, for zip's -@. */
function walkRelative(dir, prefix) {
	var out = [];
	for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
		var rel = prefix + '/' + e.name;
		if (e.isDirectory()) out = out.concat(walkRelative(path.join(dir, e.name), rel));
		else if (e.isFile()) out.push(rel);
	}
	return out;
}

/**
 * The fingerprint of the key this release ships, which is the key it must be
 * signed with. Read out of the published key rather than configured, so the two
 * cannot disagree: a cut signed with some other key on the box would verify for
 * nobody who pinned the fingerprint in the docs.
 */
function releaseKeyFingerprint() {
	var keyFile = path.join(ROOT, 'setup', PUBLIC_KEY_FILENAME);
	if (!fs.existsSync(keyFile)) die('--sign needs setup/' + PUBLIC_KEY_FILENAME + ', and it is not in the tree');
	var fpr = keyFingerprint(keyFile);
	if (!fpr) die('could not read a fingerprint out of setup/' + PUBLIC_KEY_FILENAME);
	return fpr;
}

function writeSums(outputDir, sign) {
	var names = checksummedNames(fs.readdirSync(outputDir, { withFileTypes: true })
		.filter(function (e) { return e.isFile(); })
		.map(function (e) { return e.name; }));
	var lines = names.map(function (n) { return hashFile(path.join(outputDir, n)) + '  ' + n; });
	var sums = path.join(outputDir, 'SHA256SUMS');
	fs.writeFileSync(sums, lines.join('\n') + '\n');

	if (sign) {
		try {
			if (fs.existsSync(sums + '.asc')) fs.unlinkSync(sums + '.asc');
			execFileSync('gpg', ['--detach-sign', '--armor', sums], { stdio: 'inherit' });
			ok('signed SHA256SUMS');
		} catch (e) {
			warn('could not sign SHA256SUMS: ' + e.message);
		}
	}
	return sums;
}

function humanBytes(n) {
	if (n === null || n === undefined) return '?';
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// The two cuts
// ---------------------------------------------------------------------------

function cutStable(opts) {
	var version = formatVersion(opts.version);
	var parsed = parseVersion(version);
	if (!parsed) die('"' + opts.version + '" is not a Canectic version');
	if (parsed.date !== null) die(version + ' carries a build date, so it is a development build, not a stable release');
	if (parsed.legacy) die(version + ' uses the retired version form');

	var current = packageVersion();
	if (!isNewer(version, current)) {
		die(version + ' is not newer than ' + current + ', which is what this tree already claims to be');
	}

	if (pendingIsEmpty(fs.readFileSync(CHANGELOG, 'utf8'))) {
		die('the changelog Pending section is empty. A release with nothing in it is a tag, not a release.');
	}

	var pending = normalisePending(fs.existsSync(PENDING) ? readJSON(PENDING) : {});
	for (var w of crossCheckPending(fs.readFileSync(CHANGELOG, 'utf8'), pending)) warn(w);

	var migrations = shippedMigrations();
	var devIndex = loadIndex(opts.output, 'development');
	var stableIndex = loadIndex(opts.output, 'stable');

	// The pipeline check. Enumerable because a development build names its base
	// in its own version, so every build that put migrations into a database on
	// this cycle is readable straight out of the index.
	var previousStable = newestRelease(stableIndex);
	var coverage = checkStableCoverage({
		version: version,
		migrations: migrations,
		developmentReleases: releasesBasedOn(devIndex, previousStable ? previousStable.version : current),
		previousStable: previousStable ? previousStable.version : current
	});

	if (!coverage.ok) {
		console.log('');
		warn('this stable does not ship every migration its development builds already applied:');
		for (var b of coverage.builds) {
			console.log('    ' + b.version + ': ' + b.migrations.join(', '));
		}
		console.log('');
		console.log('  Everyone running one of those builds will be refused this upgrade, because');
		console.log('  their database carries a migration ' + version + ' does not ship and cannot');
		console.log('  reason about. Either ship the migration or accept that they stay put.');
		console.log('');
		if (!opts.allowMigrationGap) die('refusing to cut. Pass --allow-migration-gap if this is deliberate.');
		warn('continuing anyway (--allow-migration-gap)');
	} else if (coverage.checked) {
		ok('ships every migration from ' + coverage.checked + ' development build(s) on this base');
	}

	var released = opts.date || releaseDate();

	// Bookkeeping first, so the artifact carries its own release notes.
	var changelogText = fs.readFileSync(CHANGELOG, 'utf8');
	var pendingBlock = findPending(changelogText);
	var closed = closePending(changelogText, { version: version, date: released });
	var notesFile = path.join(ROOT, 'docs', 'releases', 'v' + version + '.md');

	var meta = buildMetadata({
		version: version,
		released: released,
		migrations: migrations,
		steps: pending.steps,
		notices: pending.notices,
		min_upgrade_from: pending.min_upgrade_from,
		node_min: pending.node_min || nodeMinFromEngines()
	});

	var skeleton = releaseNoteSkeleton({ version: version, meta: meta, body: pendingBlock.body });

	if (opts.dryRun) {
		info('dry run, nothing written');
		reportPlan(meta, migrations, pending);
		console.log('  changelog:     Pending closed into "## v' + version + ' (' + released + ')"');
		console.log('  release notes: ' + path.relative(ROOT, notesFile) + (fs.existsSync(notesFile) ? ' (EXISTS, would not overwrite)' : ''));
		return;
	}

	fs.writeFileSync(CHANGELOG, closed);
	ok('changelog Pending closed into v' + version);

	if (fs.existsSync(notesFile)) {
		warn('release notes already exist, leaving them alone: ' + path.relative(ROOT, notesFile));
	} else {
		fs.writeFileSync(notesFile, skeleton);
		ok('release note skeleton at ' + path.relative(ROOT, notesFile));
	}

	fs.writeFileSync(PENDING, JSON.stringify(emptyPending(pending), null, 2) + '\n');
	var pkgFile = path.join(ROOT, 'package.json');
	var pkg = readJSON(pkgFile);
	pkg.version = version;
	fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
	ok('package.json bumped to ' + version);

	if (opts.tag) {
		git(['add', 'package.json', 'docs/sysop/CHANGELOG.md', 'docs/releases']);
		git(['commit', '-m', 'Release: v' + version]);
		if (opts.sign) {
			git(['tag', '-s', '-u', opts.signKey, 'v' + version, '-m', 'Canectic BBS v' + version]);
			ok('committed and signed tag v' + version);
		} else {
			git(['tag', '-a', 'v' + version, '-m', 'Canectic BBS v' + version]);
			ok('committed and tagged v' + version);
		}
	} else {
		warn('--no-tag: the bump, changelog and notes are uncommitted');
	}

	buildArtifact({ version: version, meta: meta, output: opts.output, index: stableIndex, sign: opts.sign, signKey: opts.signKey, released: released });

	// The releases page is where a person looks, and it has carried an entry for
	// every tag since v0.9.0-alpha.1. Left to itself GitLab shows "Source code
	// (zip)" for a tag, which looks like a download and is a git tree: no
	// MANIFEST, no CANECTIC.ID, and installing it takes the from-source path.
	//
	// Last, and never fatal. The artifact exists and is verified by this point,
	// the commit and the tag are made, and nothing here can undo any of that.
	if (opts.gitlab !== false && opts.tag) mirrorToGitLab(version, opts);
}

/**
 * Put the cut release on the GitLab releases page.
 *
 * Never fatal. By the time this runs the archive is built and verified, the
 * commit is made and the tag is signed, so nothing here can undo any of it, and
 * the step can be repeated on its own with --publish.
 *
 * It will refuse while the tag is not on the remote, which is the normal state
 * at the end of a cut, because a cut deliberately does not push. That refusal
 * is the point: glab creates a tag it does not find, unsigned, at the remote's
 * current head, and the first signed release went out with exactly that.
 */
function mirrorToGitLab(version, opts) {
	var notesFile = path.join(ROOT, 'docs', 'releases', 'v' + version + '.md');
	if (!gitlabAvailable()) {
		warn('glab is not available or not authenticated, so the GitLab release was not created');
		warn('after pushing, run: node scripts/release.mjs --publish ' + version);
		return;
	}
	try {
		var mirrored = publishToGitLab({
			version: version, output: opts.output, cwd: ROOT,
			notes: fs.readFileSync(notesFile, 'utf8')
		});
		ok('GitLab release ' + releaseTitle(version) + ' with ' + mirrored.present.length + ' assets');
		if (mirrored.absent.length) warn('not attached (absent): ' + mirrored.absent.join(', '));
	} catch (e) {
		warn('the GitLab release was not created:');
		for (var line of String(e.message || e).split('\n')) warn('  ' + line);
		warn('the cut itself is complete; this is the releases page only');
	}
}

function cutDevelopment(opts) {
	var base = packageVersion();
	var parsedBase = parseVersion(base);
	if (!parsedBase) die('package.json version "' + base + '" is not a Canectic version');
	if (parsedBase.date !== null) {
		die('package.json says ' + base + ', which is itself a development build. It must carry the last ' +
			'stable released, since that is what every development build deltas against.');
	}

	var index = loadIndex(opts.output, 'development');
	var when = opts.date ? new Date(opts.date + 'T12:00:00') : new Date();
	var counter = opts.counter || 1;
	var version = developmentVersionFor(base, when, counter);

	// A second build on one day gets a counter rather than overwriting the
	// first, which somebody may already be running.
	while (!opts.counter && findRelease(index, version)) {
		counter++;
		version = developmentVersionFor(base, when, counter);
	}
	if (findRelease(index, version)) {
		die(version + ' is already published. Bump --counter or wait for tomorrow.');
	}

	var newest = newestRelease(index);
	if (newest && !isNewer(version, newest.version)) {
		die(version + ' is not newer than the published ' + newest.version);
	}

	var pending = normalisePending(fs.existsSync(PENDING) ? readJSON(PENDING) : {});
	var baseManifest = loadBaseManifest(opts.output, base, opts.baseManifest);

	var meta = buildMetadata({
		version: version,
		released: opts.date || releaseDate(),
		migrations: shippedMigrations(),
		steps: pending.steps,
		notices: pending.notices,
		min_upgrade_from: pending.min_upgrade_from,
		node_min: pending.node_min || nodeMinFromEngines()
	});

	if (opts.dryRun) {
		info('dry run, nothing written');
		reportPlan(meta, meta.migrations, pending);
		return;
	}

	buildArtifact({
		version: version, meta: meta, output: opts.output, index: index,
		baseManifest: baseManifest, sign: opts.sign, signKey: opts.signKey, released: meta.released
	});
}

function reportPlan(meta, migrations, pending) {
	console.log('');
	console.log('  version:       ' + meta.version + ' (' + meta.channel + ', ' + meta.codename + ')');
	if (meta.base) console.log('  base:          ' + meta.base);
	console.log('  node_min:      ' + meta.node_min);
	console.log('  migrations:    ' + (migrations.length ? migrations.join(', ') : 'none'));
	console.log('  steps:         ' + pending.steps.length + ' (' +
		pending.steps.filter(function (s) { return s.automatic; }).length + ' automatic)');
	console.log('  notices:       ' + pending.notices.length);
	console.log('');
}

function buildArtifact(opts) {
	var version = opts.version;
	var meta = opts.meta;
	fs.mkdirSync(opts.output, { recursive: true });

	var files = selectShippedFiles(listTrackedFiles(ROOT));
	info(files.length + ' shipped files');

	var staged = stageTree(version, files);
	var manifest = buildManifest({ root: staged.treeRoot, files: files, version: version, generated: new Date().toISOString() });
	fs.writeFileSync(path.join(staged.treeRoot, MANIFEST_FILENAME), serialiseManifest(manifest));

	// Signed INSIDE the archive, because this is the only signature that reaches
	// a board fed by a file echo: SHA256SUMS lives at the release root on the
	// host and never travels down an echo. Before normaliseTimes so the
	// signature is stamped like everything else, and before pack so it is in
	// the archive at all.
	if (opts.sign) {
		detachSign(path.join(staged.treeRoot, MANIFEST_FILENAME), opts.signKey);
		ok(MANIFEST_FILENAME + ' signed with ' + opts.signKey);
	}

	// All three sidecars go at the archive ROOT, outside the version wrapper,
	// because they describe the ARCHIVE rather than the software. Inside the
	// wrapper they would be extracted into the installed tree, where they are
	// two more files to keep in step with what the install actually is, and a
	// delta would then prune them on every update because no manifest lists
	// them. At the root they are read with a fixed path that carries no version
	// in it, which is what the FTN transport wants.
	//
	// Over HTTP a sibling metadata file is better, since 3 KB decides whether
	// you want 8 MB. Over a file echo the archive is already on disk and a
	// sibling becomes a liability: two TIC'd files arrive independently,
	// possibly out of order, possibly one lost, leaving an artifact whose
	// metadata never comes. So it travels both ways, generated once from one
	// source so the two cannot disagree.
	fs.writeFileSync(path.join(staged.staging, IDENTITY_FILENAME), serialiseIdentity(meta));
	fs.writeFileSync(path.join(staged.staging, metadataName(version)), serialiseMetadata(withoutSelfChecksum(meta)));
	fs.writeFileSync(path.join(staged.staging, DIZ_FILENAME), buildFileIdDiz(meta));

	normaliseTimes(staged.staging, opts.released + 'T00:00:00Z');

	var members = null;
	var fullBytes = totalBytes(manifest);
	var payloadBytes = fullBytes;

	if (opts.baseManifest) {
		var changed = deltaFiles(opts.baseManifest, manifest);
		var diff = diffManifests(opts.baseManifest, manifest);
		members = changed.concat(opts.sign
			? [MANIFEST_FILENAME, signatureName(MANIFEST_FILENAME)]
			: [MANIFEST_FILENAME]);
		payloadBytes = changed.reduce(function (sum, p) {
			var e = manifest.files.find(function (f) { return f.path === p; });
			return sum + (e ? e.size : 0);
		}, 0);
		info('delta against ' + meta.base + ': ' + diff.added.length + ' added, ' +
			diff.changed.length + ' changed, ' + diff.removed.length + ' removed');
		var share = deltaShare(payloadBytes, fullBytes);
		if (share !== null && share > 0.5) {
			warn('this delta is ' + Math.round(share * 100) + '% of the full tree, which says a stable release is overdue');
		}
		var stampOnly = packageJsonIsVersionStampOnly(staged.treeRoot, meta.base, opts.baseManifest);
		var substantive = diff.added.length + diff.removed.length + diff.changed.filter(function (p) {
			return !(p === 'package.json' && stampOnly);
		}).length;
		if (!substantive) {
			fs.rmSync(staged.staging, { recursive: true, force: true });
			die('nothing differs from ' + meta.base + ' but the version stamp, so there is no build to cut');
		}
	}

	var artifact = path.join(opts.output, meta.artifact);
	pack({
		out: artifact, staging: staged.staging, treeName: staged.treeName,
		members: members, rootFiles: [DIZ_FILENAME, IDENTITY_FILENAME, metadataName(version)]
	});
	fs.rmSync(staged.staging, { recursive: true, force: true });

	meta.sha256 = hashFile(artifact);
	meta.files = members ? (members.length - 1) : manifest.files.length;
	meta.bytes = payloadBytes;
	meta.full_files = manifest.files.length;
	meta.full_bytes = fullBytes;

	var problems = validateMetadata(meta);
	if (problems.length) {
		for (var p of problems) console.error('    ' + p);
		die('the metadata this build produced is invalid, which is a packaging bug');
	}

	fs.writeFileSync(path.join(opts.output, metadataName(version)), serialiseMetadata(meta));
	fs.writeFileSync(path.join(opts.output, manifestName(version)), serialiseManifest(manifest));
	fs.writeFileSync(path.join(opts.output, indexName(meta.channel)), serialiseIndex(addRelease(opts.index, meta)));
	var entryPoint = publishEntryPoint({ root: ROOT, output: opts.output });
	writeSums(opts.output, opts.sign);

	console.log('');
	ok(meta.artifact + '  ' + humanBytes(fs.statSync(artifact).size));
	ok(metadataName(version));
	ok(manifestName(version));
	ok(indexName(meta.channel));
	ok(entryPoint.join(', '));
	ok('SHA256SUMS');
	console.log('');
	console.log('  sha256 ' + meta.sha256);
	console.log('  in     ' + opts.output);
	console.log('');
}

// ---------------------------------------------------------------------------

function main() {
	var opts = parseArgs(process.argv.slice(2));
	if (!opts.mode) { usage(); die('choose --stable <version> or --dev'); }

	if (opts.mode === 'publish') {
		if (!opts.version) die('--publish needs a version');
		mirrorToGitLab(opts.version, opts);
		return;
	}

	if (!treeIsClean()) {
		if (!opts.allowDirty) {
			die('the working tree is dirty. A release must be reproducible from a commit, ' +
				'and an artifact built from uncommitted work is not. Pass --allow-dirty to override.');
		}
		warn('building from a dirty tree (--allow-dirty)');
	}

	if (opts.sign) {
		opts.signKey = releaseKeyFingerprint();
		// Before the suite, before the bookkeeping, before the commit. Having a
		// key is not the same as being able to use it.
		try {
			assertCanSign(opts.signKey);
		} catch (e) {
			die(e.message);
		}
		ok('signing with ' + formatFingerprint(opts.signKey));
	}

	if (!opts.skipTests) runTests();
	else warn('skipping the test suite (--skip-tests)');

	if (opts.mode === 'publish') mirrorToGitLab(opts.version, opts);
	else if (opts.mode === 'stable') cutStable(opts);
	else cutDevelopment(opts);
}

// Only when this file IS the program. Imported, it is a library of helpers,
// which is what lets the orchestration be tested at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { git, writeSums, releaseKeyFingerprint, publishEntryPoint };
