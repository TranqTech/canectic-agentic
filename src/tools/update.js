#!/usr/bin/env node
// update.js -- stage a release and report or apply what it would do.
//
// A first crack at phase 6 of UPDATE_SYSTEM_DESIGN. What works today:
//
//   resolve   find a release, from a URL or a directory of artifacts
//   stage     download, verify the checksum, extract, reconstruct a delta
//             against its base, and verify the result against the manifest
//   plan      work out exactly what applying it would do to an installation
//   apply     do it, backing up everything displaced first
//
// What does NOT work yet, and is deliberately absent rather than half done:
// the detached handoff that runs the updater from the staged tree, stopping and
// starting the processes, npm install, the schema and migration run, the
// declared upgrade steps, and the durable progress rows the admin page reads.
// Until those exist this is a tool a sysop runs by hand with the BBS stopped,
// and it says so.
//
//   node src/tools/update.js --from-dir dist/releases --target /tmp/test-install
//   node src/tools/update.js --channel stable --version 0.9.7a --plan-only
//   node src/tools/update.js --from-dir dist/releases --target /opt/canectic --apply
//
// --apply is the only thing here that writes to the installation. Everything
// else is read-only and the default is a plan.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import appConfig from '../config/appConfig.js';
import { scanInstalledFiles } from '../release/shippedTree.js';
import { buildManifest, parseManifest, MANIFEST_FILENAME } from '../release/manifest.js';
import { buildApplyPlan, pathsFor, warningsFor,
	ACTION_CREATE, ACTION_OVERWRITE, ACTION_UNCHANGED, ACTION_KEEP, ACTION_CONFLICT, ACTION_REMOVE
} from '../release/applyPlan.js';
import { blockersFor } from '../release/updateVerdict.js';
import { appliedIds } from '../maintenance/migrationLedger.js';
import {
	dirSource, httpSource, resolveRelease, stageRelease, discardStaging
} from '../maintenance/updateStaging.js';
import { applyPlan, verifyApplied } from '../maintenance/updateApply.js';
import { formatVersion as canonicalVersion } from '../utils/version.js';

var RED = '\x1b[0;31m', GREEN = '\x1b[0;32m', YELLOW = '\x1b[1;33m', CYAN = '\x1b[0;36m', BOLD = '\x1b[1m', NC = '\x1b[0m';
function info(m) { console.log(CYAN + '->' + NC + ' ' + m); }
function ok(m)   { console.log(GREEN + '+' + NC + ' ' + m); }
function warn(m) { console.log(YELLOW + '!' + NC + ' ' + m); }
function die(m)  { console.error(RED + 'x' + NC + ' ' + m); process.exit(1); }

function usage() {
	console.log([
		'',
		BOLD + 'Canectic update' + NC,
		'',
		'  node src/tools/update.js [options]',
		'',
		'  --from-dir DIR     take artifacts from a directory instead of over HTTP',
		'  --url BASE         the release host (default: update_check_url)',
		'  --channel NAME     stable or development (default: update_channel)',
		'  --version V        a specific release (default: the newest on the channel)',
		'  --target DIR       the installation to plan against (default: this tree)',
		'  --staging DIR      where to build the release (default: a temp directory)',
		'  --apply            actually write it. Stop the BBS first',
		'  --keep-staging     do not delete the staging directory afterwards',
		'  --verbose          list every file, not just a summary',
		'',
		'  Without --apply this only reports. Nothing is written to the target.',
		''
	].join('\n'));
}

function parseArgs(argv) {
	var o = {
		fromDir: null, url: null, channel: null, version: null,
		target: process.cwd(), staging: null,
		apply: false, keepStaging: false, verbose: false
	};
	for (var i = 0; i < argv.length; i++) {
		var a = argv[i];
		if (a === '--from-dir')          o.fromDir = argv[++i];
		else if (a === '--url')          o.url = argv[++i];
		else if (a === '--channel')      o.channel = argv[++i];
		else if (a === '--version')      o.version = argv[++i];
		else if (a === '--target')       o.target = path.resolve(argv[++i]);
		else if (a === '--staging')      o.staging = argv[++i];
		else if (a === '--apply')        o.apply = true;
		else if (a === '--keep-staging') o.keepStaging = true;
		else if (a === '--verbose')      o.verbose = true;
		else if (a === '--plan-only')    o.apply = false;
		else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
		else die('unknown argument: ' + a);
	}
	return o;
}

function humanBytes(n) {
	if (!n) return '0 B';
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * What the installation looks like now, described the same way an artifact is.
 *
 * Two manifests come out of this. `local` is what is on disk right now.
 * `installed` is the MANIFEST the last release left behind, which answers the
 * only question that matters for a data file: is this still exactly what we
 * shipped, or did the sysop edit it. An install predating the release machinery
 * has no MANIFEST and every differing data file is then treated as theirs.
 */
/** What the installation says it is. Its package.json is the authority, the
 *  same source systeminfo uses for the running process. */
function installedVersion(root) {
	try {
		var pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		return canonicalVersion(pkg.version);
	} catch (_) {
		return null;
	}
}

function describeInstall(root) {
	var files = scanInstalledFiles(root);
	var local = buildManifest({ root: root, files: files, version: null, generated: new Date().toISOString() });

	var installed = null;
	var manifestFile = path.join(root, MANIFEST_FILENAME);
	if (fs.existsSync(manifestFile)) {
		try { installed = parseManifest(fs.readFileSync(manifestFile, 'utf8')); } catch (_) { installed = null; }
	}
	return { local: local, installed: installed, scanned: files.length };
}

function reportPlan(plan, verbose) {
	var c = plan.counts;
	console.log('');
	console.log('  ' + BOLD + 'What applying ' + (plan.version || 'this release') + ' would do' + NC);
	console.log('');
	console.log('    new files        ' + c[ACTION_CREATE]);
	console.log('    replaced         ' + c[ACTION_OVERWRITE]);
	console.log('    already current  ' + c[ACTION_UNCHANGED]);
	console.log('    left alone       ' + c[ACTION_KEEP]);
	console.log('    removed          ' + c[ACTION_REMOVE]);
	console.log('    kept, yours      ' + c[ACTION_CONFLICT]);
	console.log('');
	console.log('    ' + humanBytes(plan.bytesWritten) + ' written');
	console.log('');

	if (verbose) {
		for (var action of [ACTION_CREATE, ACTION_OVERWRITE, ACTION_REMOVE, ACTION_KEEP, ACTION_CONFLICT]) {
			var paths = pathsFor(plan, action);
			if (!paths.length) continue;
			console.log('  ' + action + ':');
			for (var p of paths) console.log('    ' + p);
			console.log('');
		}
	} else {
		var removed = pathsFor(plan, ACTION_REMOVE);
		if (removed.length) {
			console.log('  removed:');
			for (var r of removed.slice(0, 20)) console.log('    ' + r);
			if (removed.length > 20) console.log('    ... and ' + (removed.length - 20) + ' more');
			console.log('');
		}
	}

	var warnings = warningsFor(plan);
	if (warnings.length) {
		warn(warnings.length + ' file(s) you have changed are being kept, and this release\'s versions are not being written:');
		for (var w of warnings) console.log('      ' + w.path + '  (' + w.reason + ')');
		console.log('');
	}
}

async function main() {
	var o = parseArgs(process.argv.slice(2));
	await appConfig.load();

	var source = o.fromDir ? dirSource(o.fromDir)
		: httpSource(o.url || appConfig.get('update_check_url', ''));
	if (source.kind === 'http' && !source.baseUrl) {
		die('no release source. Pass --from-dir, or --url, or set update_check_url.');
	}

	var channel = o.channel || appConfig.get('update_channel', 'stable');

	// The version of the TARGET, not of the tree this process is running from.
	// Those are the same thing for a real update and different whenever
	// --target points elsewhere, and the move rule is a question about the
	// installation being upgraded. Taking the running version would compare the
	// wrong system's migrations and floor.
	var running = installedVersion(o.target);
	if (!running) die('no readable package.json in ' + o.target + ', so there is nothing to upgrade there');

	info('installed at ' + o.target);
	info('installed version ' + running + ', looking at the ' + channel + ' channel');

	// Always through the index, even when a version was named. Taking the
	// caller's word for it would mean naming a version is a way to skip the
	// move rule, and the one time somebody names a version by hand is when they
	// are trying to get past something.
	var entry = await resolveRelease(source, channel, o.version || null);
	var version = entry.version;

	// The move rule, before anything is downloaded. Refusing after a 20 MB
	// fetch would be rude and refusing after extraction would be worse.
	{
		var blockers = blockersFor({
			current: running,
			release: entry,
			appliedMigrations: await appliedIds(),
			nodeVersion: process.versions.node
		});
		if (blockers.length) {
			console.log('');
			for (var b of blockers) warn(b.detail);
			console.log('');
			die('this system cannot move to ' + version + ' yet. Nothing was downloaded.');
		}
	}

	var staged = null;
	try {
		staged = await stageRelease({
			source: source,
			version: version,
			stagingDir: o.staging,
			onPhase: function (phase, detail) { info(phase + ': ' + detail); }
		});
		ok('staged ' + staged.meta.version + ', ' + staged.verification.checked + ' files verified against ' + MANIFEST_FILENAME);
		if (staged.reconstructed) {
			ok('reconstructed from base ' + staged.meta.base +
				(staged.pruned.length ? ', ' + staged.pruned.length + ' file(s) removed since then' : ''));
		}

		var install = describeInstall(o.target);
		info('scanned ' + install.scanned + ' installed files' +
			(install.installed ? ' (install reports ' + install.installed.version + ')'
				: ' (no MANIFEST: every changed data file will be kept as yours)'));

		var plan = buildApplyPlan({
			target: staged.manifest,
			local: install.local,
			installed: install.installed
		});
		reportPlan(plan, o.verbose);

		if (!o.apply) {
			info('report only. Pass --apply to write it.');
			return;
		}

		warn('applying to ' + o.target);
		var backupDir = path.join(staged.stagingDir, 'backup');
		var result = applyPlan({
			plan: plan, stagedRoot: staged.treeRoot, targetRoot: o.target, backupDir: backupDir
		});

		var check = verifyApplied({ plan: plan, targetRoot: o.target });
		if (!check.ok) {
			die('applied, but ' + (check.missing.length + check.mismatched.length) +
				' file(s) do not match the release. The backup is at ' + backupDir);
		}

		ok(result.written.length + ' written, ' + result.removed.length + ' removed, verified');
		ok('displaced files backed up to ' + backupDir);
		console.log('');
		console.log('  Not done by this tool yet, and still needed:');
		console.log('    npm install --omit=dev');
		console.log('    node src/tools/dbmigrations.js');
		console.log('    the upgrade steps in canectic-' + staged.meta.version + '.json');
		console.log('    restart the processes');
		console.log('');
		o.keepStaging = true;  // the backup lives there
	} finally {
		if (staged && !o.keepStaging) discardStaging(staged.stagingDir);
		else if (staged) info('staging kept at ' + staged.stagingDir);
	}
}

main().then(function () { process.exit(0); }, function (e) { die(e.message); });
