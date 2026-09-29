#!/usr/bin/env node
// publish.mjs -- put what release.mjs cut on the release host, with the
// changelog and release notes the site shows beside it, then read it back.
//
//   node scripts/publish.mjs               publish, then verify over HTTPS
//   node scripts/publish.mjs --dry-run     show what would be sent, change nothing
//   node scripts/publish.mjs --no-verify   publish without the read-back
//
// Three things land, in two places on the host:
//
//   dist/releases/*           -> <root>/releases/           /releases/<file>
//   docs/sysop/CHANGELOG.md   -> <root>/docs/CHANGELOG.md   /docs/changelog
//   docs/releases/v<v>.md     -> <root>/docs/releases/<v>.md
//                                                           /releases/<v>/notes
//
// Release notes are renamed on the way, because the site looks them up by the
// version in the channel index, which carries no leading v. Only versions a
// published index names are sent, so working files beside them such as
// v0.9.6a-changes.md never are.
//
// NOTHING IS EVER DELETED on the host, and no rsync here may carry --delete. A
// development build is a delta against a stable, so a stable that disappears
// takes every build based on it with it; and dist/releases holds only what this
// machine cut, so mirroring it would remove whatever was published from
// anywhere else.
//
// The changelog goes as the tree has it, Pending section included. Running this
// between releases is how the site's copy stays current: re-sending an
// unchanged release costs nothing, since rsync skips files that match.
//
// The host is reached through an ssh alias, with the key and alias described in
// docs/reference/RELEASE_PROCESS.md. Maintainer tooling, not shipped.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { unfilledPlaceholders } from '../src/release/changelog.js';
import { fileURLToPath, pathToFileURL } from 'url';

import { parseIndex } from '../src/release/releaseIndex.js';
import { SUMS_FILENAME } from '../src/release/metadata.js';
import { compareVersions } from '../src/utils/version.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var RELEASES_DIR = path.join(ROOT, 'dist', 'releases');
var CHANGELOG = path.join(ROOT, 'docs', 'sysop', 'CHANGELOG.md');
var NOTES_DIR = path.join(ROOT, 'docs', 'releases');

var HOST = process.env.CANECTIC_PUBLISH_HOST || 'canectic-release';
var REMOTE_ROOT = process.env.CANECTIC_PUBLISH_ROOT || 'tranqsoft-website/canectic';
var SITE = (process.env.CANECTIC_PUBLISH_URL || 'https://canectic.tranqsoft.com').replace(/\/+$/, '');

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Every version any channel index names, oldest first, each once. */
function publishedVersions(indexTexts) {
	var seen = new Set();
	for (var text of indexTexts) {
		// Withdrawn releases stay published, notes and all: a board running
		// one is told why, and the notes are where the why is written down.
		var idx = parseIndex(text);
		for (var r of idx.releases.concat(idx.withdrawn || [])) {
			if (r && r.version) seen.add(r.version);
		}
	}
	return Array.from(seen).sort(compareVersions);
}

/** The notes to send: v<version>.md for each published version that has one,
 *  renamed to the <version>.md the site looks for. */
function notesPlan(versions, notesFiles) {
	var have = new Set(notesFiles);
	return versions
		.filter(function (v) { return have.has('v' + v + '.md'); })
		.map(function (v) { return { version: v, from: 'v' + v + '.md', to: v + '.md' }; });
}

/** Every problem with a publish directory against its own SHA256SUMS, or none.
 *  Unlisted files count, since the list is built by exclusion and so names
 *  everything a cut put there. */
function checkSums(dir) {
	var sumsFile = path.join(dir, SUMS_FILENAME);
	if (!fs.existsSync(sumsFile)) return ['no ' + SUMS_FILENAME + ' in ' + dir];
	var problems = [];
	var listed = new Set();
	for (var line of fs.readFileSync(sumsFile, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		var m = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
		if (!m) {
			problems.push(SUMS_FILENAME + ' has a line it cannot read: ' + line);
			continue;
		}
		listed.add(m[2]);
		var file = path.join(dir, m[2]);
		if (!fs.existsSync(file)) problems.push(m[2] + ' is listed but missing');
		else if (sha256(fs.readFileSync(file)) !== m[1]) problems.push(m[2] + ' does not match its checksum');
	}
	for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!e.isFile() || e.name === SUMS_FILENAME || e.name === SUMS_FILENAME + '.asc') continue;
		if (!listed.has(e.name)) problems.push(e.name + ' is not in ' + SUMS_FILENAME);
	}
	return problems;
}

/** The rsync argument lists, as a value so the no-deletion rule is testable. */
function rsyncCommands(opts) {
	var extra = opts.dryRun ? ['--dry-run'] : [];
	var out = [];
	if (opts.releasesDir) {
		out.push(['-av'].concat(extra, [opts.releasesDir + '/', opts.host + ':' + opts.root + '/releases/']));
	}
	// -rt rather than -a: the staging directory is a mkdtemp at mode 700, and
	// -a would carry that onto the site's docs directory.
	out.push(['-rtv'].concat(extra, [opts.docsStage + '/', opts.host + ':' + opts.root + '/docs/']));
	return out;
}

/** Copy preserving mtime, since the site shows a document's modified date and
 *  rsync -t would otherwise stamp every publish as an edit. */
function copyKeepingTime(from, to) {
	fs.copyFileSync(from, to);
	var st = fs.statSync(from);
	fs.utimesSync(to, st.atime, st.mtime);
}

function signatureProblem(dir) {
	var asc = path.join(dir, SUMS_FILENAME + '.asc');
	if (!fs.existsSync(asc)) return null;
	try {
		execFileSync('gpg', ['--verify', asc, path.join(dir, SUMS_FILENAME)], { stdio: 'pipe' });
		return null;
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		return SUMS_FILENAME + '.asc does not verify: ' + String(e.stderr || e.message).trim();
	}
}

/**
 * An unsigned SHA256SUMS must never go over a signed one (#84). Publishing
 * never deletes, so the host's SHA256SUMS.asc would stay behind, now signing
 * a list it does not match, and bootstrap.sh refuses a signature that fails
 * to verify: every new install would stop until someone removed it by hand.
 *
 * localSigned: dist/releases has SHA256SUMS.asc
 * remote:      the fetchStatus() result for the host's SHA256SUMS.asc
 * returns a reason to refuse, or null
 */
function unsignedOverSigned(localSigned, remote) {
	if (localSigned) return null;
	if (!remote || remote.status === 0) {
		return 'could not tell whether the host has a signed ' + SUMS_FILENAME + ' (' + ((remote && remote.error) || 'no answer') +
			'), and publishing an unsigned one over it would break every new install; sign it (release.mjs --sign) or try again';
	}
	if (remote.status === 200) {
		return 'the host has a signed ' + SUMS_FILENAME + ' and this one is unsigned. The old signature would stay behind ' +
			'and fail against the new list, and bootstrap.sh refuses that, so every new install would stop. Sign it: release.mjs --sign';
	}
	return null;
}

async function fetchStatus(url) {
	try {
		var res = await fetch(url, { redirect: 'follow' });
		return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
	} catch (e) {
		return { status: 0, error: e.message };
	}
}

/** Read everything back the way clients will. A file that arrives intact on the
 *  host can still be served wrong: a 404 page with status 200, a proxy that
 *  re-encodes the zip, a filter that changes line endings in the signature. */
async function verifyServed(releaseFiles, notes) {
	var problems = [];
	for (var name of releaseFiles) {
		var got = await fetchStatus(SITE + '/releases/' + name);
		if (got.status !== 200) problems.push('/releases/' + name + ': HTTP ' + (got.status || got.error));
		else if (sha256(got.body) !== sha256(fs.readFileSync(path.join(RELEASES_DIR, name)))) {
			problems.push('/releases/' + name + ' is not byte-identical as served');
		}
	}
	// The update check reads a 404 as "nothing published on this channel", so a
	// missing file has to be a real one.
	var probe = await fetchStatus(SITE + '/releases/index-publish-check-' + crypto.randomBytes(4).toString('hex') + '.json');
	if (probe.status !== 404) problems.push('a missing file answered HTTP ' + (probe.status || probe.error) + ', not 404');

	var pages = ['/docs/changelog'].concat(notes.map(function (n) { return '/releases/' + n.version + '/notes'; }));
	for (var page of pages) {
		var p = await fetchStatus(SITE + page);
		if (p.status !== 200) problems.push(page + ': HTTP ' + (p.status || p.error));
	}
	return { checked: releaseFiles.length + 1 + pages.length, problems: problems };
}

function fail(message, details) {
	console.error('publish: ' + message);
	for (var d of details || []) console.error('  ' + d);
	process.exit(1);
}

async function main(argv) {
	var known = ['--dry-run', '--no-verify'];
	var unknown = argv.filter(function (a) { return known.indexOf(a) < 0; });
	if (unknown.length) fail('unknown option ' + unknown.join(' '), ['usage: node scripts/publish.mjs [--dry-run] [--no-verify]']);
	var dryRun = argv.indexOf('--dry-run') >= 0;
	var verify = !dryRun && argv.indexOf('--no-verify') < 0;

	var releaseFiles = [];
	var versions = [];
	if (fs.existsSync(RELEASES_DIR)) {
		var problems = checkSums(RELEASES_DIR);
		var sig = signatureProblem(RELEASES_DIR);
		if (sig) problems.push(sig);
		var localSigned = fs.existsSync(path.join(RELEASES_DIR, SUMS_FILENAME + '.asc'));
		if (!localSigned) {
			var overSigned = unsignedOverSigned(false, await fetchStatus(SITE + '/releases/' + SUMS_FILENAME + '.asc'));
			if (overSigned) problems.push(overSigned);
		}
		if (problems.length) fail('refusing to publish ' + RELEASES_DIR, problems);
		releaseFiles = fs.readdirSync(RELEASES_DIR, { withFileTypes: true })
			.filter(function (e) { return e.isFile(); })
			.map(function (e) { return e.name; })
			.sort();
		versions = publishedVersions(releaseFiles
			.filter(function (n) { return /^index-.+\.json$/.test(n); })
			.map(function (n) { return fs.readFileSync(path.join(RELEASES_DIR, n), 'utf8'); }));
		console.log('publish: ' + releaseFiles.length + ' release files verified against ' + SUMS_FILENAME +
			(fs.existsSync(path.join(RELEASES_DIR, SUMS_FILENAME + '.asc')) ? ' and its signature' : ' (unsigned)'));
	} else {
		console.log('publish: no dist/releases here, sending the changelog only');
	}

	var notes = notesPlan(versions, fs.readdirSync(NOTES_DIR));

	// Refuse notes that still carry the fields a human is meant to fill in.
	// The cut generates everything except a one-line summary and the
	// Highlights, and leaves those as placeholders. v0.9.7a went to the
	// website with both of them still there: the release verified perfectly,
	// because every check was about bytes and signatures rather than about
	// what the page said. This is the check that would have caught it.
	var unfilled = [];
	for (var candidate of notes) {
		var text = fs.readFileSync(path.join(NOTES_DIR, candidate.from), 'utf8');
		for (var missing of unfilledPlaceholders(text)) {
			unfilled.push(candidate.from + ' still has ' + missing);
		}
	}
	if (unfilled.length) {
		fail('release notes are not finished', unfilled.concat([
			'Fill them in, or remove the file if the release should have none.'
		]));
	}

	var stage = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-publish-'));
	try {
		copyKeepingTime(CHANGELOG, path.join(stage, 'CHANGELOG.md'));
		if (notes.length) fs.mkdirSync(path.join(stage, 'releases'));
		for (var n of notes) copyKeepingTime(path.join(NOTES_DIR, n.from), path.join(stage, 'releases', n.to));
		console.log('publish: changelog' + (notes.length ? ', notes for ' + notes.map(function (x) { return x.version; }).join(', ') : ', no release notes'));

		var commands = rsyncCommands({
			host: HOST,
			root: REMOTE_ROOT,
			releasesDir: releaseFiles.length ? RELEASES_DIR : null,
			docsStage: stage,
			dryRun: dryRun
		});
		for (var args of commands) {
			console.log('\n$ rsync ' + args.join(' '));
			execFileSync('rsync', args, { stdio: 'inherit' });
		}
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}

	if (!verify) {
		console.log('\npublish: ' + (dryRun ? 'dry run, nothing sent' : 'sent, not verified'));
		return;
	}
	var result = await verifyServed(releaseFiles, notes);
	if (result.problems.length) fail('published, but ' + SITE + ' does not serve it correctly', result.problems);
	console.log('\npublish: ' + result.checked + ' checks against ' + SITE + ' passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch(function (e) {
		console.error('publish: ' + (e.stack || e.message));
		process.exit(1);
	});
}

export { publishedVersions, notesPlan, checkSums, rsyncCommands, unsignedOverSigned };
