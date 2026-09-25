#!/usr/bin/env node
// rotateLogs.js — rotate the log files now, or see what rotation would do.
//
//   node src/tools/rotateLogs.js              Rotate now
//   node src/tools/rotateLogs.js --dry-run    List what would be archived and removed
//   node src/tools/rotateLogs.js --days N     Override log_retention_days for this run
//
// The same rotation the daily `rotate-logs` maintenance job runs at 23:59
// (src/maintenance/logRotation.js), run directly: it needs no worker, which
// matters when the worker is what you are reading the logs to diagnose. It
// runs even with log_rotation_enabled off, since asking for it is the point.

import * as alogger from '../utils/alogger.js';
import { rotateLogs } from '../maintenance/logRotation.js';

var args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
	console.log('Usage: node src/tools/rotateLogs.js [--dry-run] [--days N]');
	console.log('');
	console.log('  --dry-run   List what would be archived and removed; change nothing');
	console.log('  --days N    Keep N days of archives this run (default: log_retention_days, 0 = keep all)');
	process.exit(0);
}

var dryRun = args.includes('--dry-run');
var days = null;
var i = args.indexOf('--days');
if (i !== -1) {
	days = parseInt(args[i + 1], 10);
	if (!Number.isFinite(days) || days < 0) {
		console.error('--days needs a number of days, 0 or more');
		process.exit(2);
	}
}

async function retentionFromConfig() {
	// The database holds the sysop's setting; without one, say so and use the
	// shipped default rather than refusing to rotate.
	try {
		var appConfig = (await import('../config/appConfig.js')).default;
		await appConfig.load();
		return appConfig.getNumber('log_retention_days', 30);
	} catch (err) {
		console.error('Could not read log_retention_days (' + err.message + '); using 30');
		return 30;
	}
}

async function main() {
	var retentionDays = days !== null ? days : await retentionFromConfig();
	var logDir = alogger.logDirectory();

	var result = await rotateLogs({ logDir: logDir, retentionDays: retentionDays, dryRun: dryRun });

	var verb = dryRun ? 'Would archive' : 'Archived';
	console.log((dryRun ? '[dry run] ' : '') + 'Log directory: ' + logDir);
	if (result.rotated.length === 0) {
		console.log('Nothing to archive.');
	}
	for (var r of result.rotated) {
		console.log('  ' + verb + ' ' + r.file + ' (' + r.bytes + ' bytes, ' + r.method + ')' +
			(r.archived ? ' -> ' + r.archived : ' -> ' + result.archiveDir + '/'));
	}
	for (var d of result.removed) {
		console.log('  ' + (dryRun ? 'Would remove ' : 'Removed ') + d + ' (older than ' + retentionDays + ' days)');
	}
	for (var e of result.errors) {
		console.error('  ERROR ' + e.file + ': ' + e.error);
	}

	if (!dryRun) {
		alogger.writeAlog(2, 'Log rotation (by hand): ' + result.rotated.length + ' file(s) archived to ' +
			result.archiveDir + (result.errors.length ? ', ' + result.errors.length + ' error(s)' : ''), 'cyan');
	}
	return result.errors.length ? 1 : 0;
}

main().then(function (code) {
	// appConfig.load() opens the pg pool and Redis; nothing here needs them to
	// close gracefully.
	process.exit(code);
}).catch(function (err) {
	console.error(err.stack || err.message);
	process.exit(1);
});
