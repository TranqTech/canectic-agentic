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
import { MANIFEST_FILENAME } from '../release/manifest.js';
import { installedVersion, describeInstall } from '../maintenance/installTarget.js';
import { buildApplyPlan, pathsFor, warningsFor,
	ACTION_CREATE, ACTION_OVERWRITE, ACTION_UNCHANGED, ACTION_KEEP, ACTION_CONFLICT, ACTION_REMOVE
} from '../release/applyPlan.js';
import { blockersFor } from '../release/updateVerdict.js';
import { appliedIds } from '../maintenance/migrationLedger.js';
import {
	dirSource, httpSource, resolveRelease, stageRelease, discardStaging
} from '../maintenance/updateStaging.js';
import { launchUpdater, validateHandoff } from '../maintenance/updateHandoff.js';
import { buildChannelIndex, sourceForRelease, isFtnRelease } from '../maintenance/ftnReleaseSource.js';
import { runUpdate } from '../maintenance/updateRunner.js';
import { stagingDir, reclaimable } from '../maintenance/updateLayout.js';
import { makeRunId, newRun } from '../release/updatePhases.js';
import * as runStore from '../maintenance/updateRunStore.js';
import { summarise } from '../release/updatePhases.js';

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
		'  --staging DIR      where to build the release (default: <target>/.canectic-update)',
		'  --apply            actually write it, in this process. Stop the BBS first',
		'  --handoff          hand off to the NEW release\'s updater, detached,',
		'                     and return. Survives the BBS being stopped',
		'  --status           report the last update run on --target and stop',
		'  --no-dump          do not dump the database before migrating',
		'  --no-deps          do not run npm install',
		'  --no-schema        do not run dbmigrations',
		'  --no-restart       do not stop or start the BBS',
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
		apply: false, handoff: false, keepStaging: false, verbose: false, status: false,
		dump: true, dependencies: true, schema: true, processControl: true
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
		else if (a === '--handoff')      { o.handoff = true; o.apply = true; }
		else if (a === '--status')       o.status = true;
		else if (a === '--no-dump')      o.dump = false;
		else if (a === '--no-deps')      o.dependencies = false;
		else if (a === '--no-schema')    o.schema = false;
		else if (a === '--no-restart')   o.processControl = false;
		else if (a === '--keep-staging') o.keepStaging = true;
		else if (a === '--verbose')      o.verbose = true;
		else if (a === '--plan-only')    o.apply = false;
		else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
		else die('unknown argument: ' + a);
	}
	return o;
}

var LEDGER_TIMEOUT_MS = 10000;

function humanBytes(n) {
	if (!n) return '0 B';
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	return (n / (1024 * 1024)).toFixed(1) + ' MB';
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

/**
 * The applied migration ids, or null when the database will not answer.
 *
 * Bounded, because the pg pool retries internally and an update tool that hangs
 * for ever on a stopped database is worse than one that says so. Null is
 * distinct from an empty list on purpose: empty means a fresh database with
 * nothing applied, null means we do not know, and the caller must not treat the
 * second as the first.
 */
async function readLedger() {
	var timer = null;
	var bound = new Promise(function (resolve) { timer = setTimeout(function () { resolve(null); }, LEDGER_TIMEOUT_MS); });
	try {
		return await Promise.race([appliedIds().catch(function () { return null; }), bound]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * What the last run did, read from the state file rather than from a process.
 *
 * This is the whole reason progress is durable: by the time anybody asks, the
 * thing that launched the updater has usually been replaced by it.
 */
function reportStatus(target) {
	var state = runStore.latest(target);
	if (!state) {
		info('no update has ever run against ' + target);
		return;
	}
	var s = summarise(state);
	console.log('');
	console.log('  run      ' + s.runId + '   ' + s.status.toUpperCase());
	console.log('  moving   ' + (s.from || '?') + ' -> ' + (s.to || '?'));
	console.log('  elapsed  ' + Math.round((s.elapsedMs || 0) / 1000) + 's');
	if (s.current) console.log('  now      ' + s.current);
	if (s.error) console.log('  error    ' + s.error);
	console.log('');
	for (var p of state.phases) {
		var mark = p.status === 'done' ? GREEN + 'done ' + NC
			: p.status === 'failed' ? RED + 'FAIL ' + NC
			: p.status === 'skipped' ? YELLOW + 'skip ' + NC
			: p.status === 'running' ? CYAN + 'now  ' + NC
			: '     ';
		console.log('    ' + mark + ' ' + p.name.padEnd(13) + (p.detail || p.error || ''));
	}
	console.log('');
	for (var w of (state.warnings || [])) warn(w);
	if (state.logFile) console.log('  log      ' + state.logFile);
	console.log('');
}

async function main() {
	var o = parseArgs(process.argv.slice(2));
	await appConfig.load();

	if (o.status) { reportStatus(o.target); return; }

	// An explicit --from-dir or --url overrides the configured transport, since
	// somebody naming a source means it.
	var useFtn = !o.fromDir && !o.url && appConfig.get('update_check_transport', 'http') === 'ftn';

	var source = o.fromDir ? dirSource(o.fromDir)
		: httpSource(o.url || appConfig.get('update_check_url', ''));
	if (!useFtn && source.kind === 'http' && !source.baseUrl) {
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
	//
	// A file echo publishes no index, so one is derived from what the area
	// holds. Everything after this point is identical either way, which is the
	// whole reason the source abstraction takes a directory as well as a URL.
	var entry;
	if (useFtn) {
		var shortcode = appConfig.get(channel === 'development' ? 'update_dev_file_area' : 'update_stable_file_area', '');
		if (!shortcode) die('the FTN transport is selected but no file area is configured for the ' + channel + ' channel');
		var ftnIndex = await buildChannelIndex(shortcode, channel);
		if (!ftnIndex) die('no file area "' + shortcode + '" for the ' + channel + ' channel');
		entry = o.version
			? (ftnIndex.releases.filter(function (r) { return r.version === o.version; })[0] || null)
			: (ftnIndex.releases[0] || null);
		if (!entry) die('the ' + channel + ' file area holds no' + (o.version ? ' ' + o.version : ' release'));
		source = sourceForRelease(entry);
		info('from the ' + shortcode + ' file area: ' + entry.artifact);
	} else {
		entry = await resolveRelease(source, channel, o.version || null);
	}
	var version = entry.version;

	// The move rule, before anything is downloaded. Refusing after a 20 MB
	// fetch would be rude and refusing after extraction would be worse.
	var applied = await readLedger();

	// Only the migration half of the rule needs the ledger. The upgrade floor
	// and the Node requirement are answerable from the release and this machine
	// alone, so a database that will not answer must not take those checks down
	// with it: they are the ones a fresh or misconfigured install is most
	// likely to trip.
	var blockers = blockersFor({
		current: running,
		release: entry,
		appliedMigrations: applied || [],
		nodeVersion: process.versions.node
	});

	if (applied === null) {
		// Fail closed on the half we could not check. An unreadable ledger is
		// not "no migrations applied": treating it as an empty list would clear
		// every migration blocker and wave through exactly the move the rule
		// exists to stop.
		warn('could not read the migration ledger, so whether this move is safe cannot be fully established');
		if (o.apply) die('refusing to apply without it. Bring the database up, or drop --apply to look.');
	}

	if (blockers.length) {
		console.log('');
		for (var b of blockers) warn(b.detail);
		console.log('');
		die('this system cannot move to ' + version + ' yet. Nothing was downloaded.');
	}

	// Staging goes inside the installation by default. node_modules resolves by
	// walking up from a module's own directory and a release ships none, so an
	// updater staged in /tmp cannot import anything with a dependency. Under
	// the install it walks up and finds the install's. The dot directory is not
	// a shipped category, so nothing scans or replaces it.
	var staging = o.staging || stagingDir(o.target, version);

	var staged = null;
	try {
		staged = await stageRelease({
			source: source,
			version: version,
			stagingDir: staging,
			target: o.target,
			allowUnpublishedChecksum: isFtnRelease(entry),
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

		if (o.handoff) {
			// Hand over to the NEW release's updater and stop. From here the
			// state file is the only channel: this process is expected to go
			// away, and on a real update it is the thing being replaced.
			var problems = validateHandoff({ stagedRoot: staged.treeRoot, target: o.target });
			if (problems.length) {
				for (var pr of problems) warn(pr);
				die('cannot hand off to ' + version);
			}

			var handle = launchUpdater({
				stagedRoot: staged.treeRoot, target: o.target,
				from: running, to: version, launchedBy: 'src/tools/update.js --handoff',
				nodeMin: staged.meta.node_min, steps: staged.meta.steps || [],
				base: staged.meta.base || null,
				options: { dump: o.dump, dependencies: o.dependencies, schema: o.schema,
					processControl: o.processControl }
			});
			ok('handed off to ' + version + '\'s own updater, pid ' + handle.pid);
			console.log('');
			console.log('    run      ' + handle.runId);
			console.log('    progress ' + handle.stateFile);
			console.log('    log      ' + handle.logFile);
			console.log('');
			console.log('  It is detached and will outlive this process and the BBS being stopped.');
			console.log('  Watch it with:  node src/tools/update.js --status --target ' + o.target);
			console.log('');
			o.keepStaging = true;
			return;
		}

		// In process, through the same runner the detached updater uses. One
		// implementation of the phases: two programs that both claim to apply
		// an update is how install.sh and update.sh drifted.
		warn('applying to ' + o.target);
		var runId = makeRunId();
		runStore.save(o.target, newRun({
			runId: runId, from: running, to: version, target: o.target,
			stagedRoot: staged.treeRoot, logFile: null
		}));
		var runFile = runStore.writeRunFile(o.target, runId, {
			handoff_version: 1, runId: runId, target: o.target, stagedRoot: staged.treeRoot,
			from: running, to: version, nodeMin: staged.meta.node_min,
			steps: staged.meta.steps || [], base: staged.meta.base || null,
			launchedBy: 'src/tools/update.js --apply', launchedAt: new Date().toISOString(),
			options: { dump: o.dump, dependencies: o.dependencies, schema: o.schema,
				processControl: o.processControl }
		});

		var state = await runUpdate({
			instructions: runStore.readRunFile(runFile),
			log: function (m) { console.log('   ' + m); }
		});

		console.log('');
		reportStatus(o.target);
		if (state.status !== 'complete') die('the update did not finish. Nothing further was attempted.');
		o.keepStaging = true;
	} finally {
		if (staged && !o.keepStaging) discardStaging(staged.stagingDir);
		else if (staged) info('staging kept at ' + staged.stagingDir);
	}
}

main().then(function () { process.exit(0); }, function (e) { die(e.message); });
