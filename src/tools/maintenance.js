#!/usr/bin/env node

// maintenance.js — CLI runner for message base maintenance tasks.
// Located in src/tools/
//
// Usage:
//   node src/tools/maintenance.js --regen-html                 Regenerate body_html for all areas
//   node src/tools/maintenance.js --regen-html --area GENERAL  Regenerate for a specific area
//   node src/tools/maintenance.js --regen-html --dry-run       Preview without writing
//   node src/tools/maintenance.js --regen-html --width 80      Force a specific column width
//   node src/tools/maintenance.js --regen-pm-html              Regenerate body_html for PM tables
//   node src/tools/maintenance.js --purge-pm-trash             Hard-delete expired PM trash
//   node src/tools/maintenance.js --purge-pm-trash --days 7    Override retention period
//   node src/tools/maintenance.js --help                       Show usage

import * as fs from 'fs';
import { regenerateAllBodyHtml, regeneratePmBodyHtml } from '../maintenance/messageBase.js';
import { purgeDeleted } from '../models/privateMessages.js';

const PID_FILE = '/tmp/can_maint.pid';

function parseArgs() {
	var args = process.argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		console.log('Usage: node maintenance.js [task] [options]');
		console.log('');
		console.log('Tasks:');
		console.log('  --regen-html       Regenerate body_html for message area messages');
		console.log('  --regen-pm-html    Regenerate body_html for private messages (pm_inbox + pm_outbox)');
		console.log('  --purge-pm-trash   Hard-delete PM trash older than retention period');
		console.log('');
		console.log('Options:');
		console.log('  --area SHORTCODE   Limit regen-html to specific area(s) (repeatable)');
		console.log('  --dry-run          Preview without writing changes');
		console.log('  --width N          Force column width for HTML generation');
		console.log('  --batch N          Batch size (default: 100)');
		console.log('  --days N           Trash retention days for purge-pm-trash (default: env pm_trash_retention_days or 30)');
		process.exit(0);
	}

	var areas = [];
	var dryRun = args.includes('--dry-run');
	var regenHtml = args.includes('--regen-html');
	var regenPmHtml = args.includes('--regen-pm-html');
	var purgePmTrash = args.includes('--purge-pm-trash');
	var width = null;
	var batchSize = 100;
	var days = null;

	for (var i = 0; i < args.length; i++) {
		if (args[i] === '--area' && args[i + 1]) {
			areas.push(args[i + 1]);
			i++;
		} else if (args[i] === '--width' && args[i + 1]) {
			width = parseInt(args[i + 1], 10);
			i++;
		} else if (args[i] === '--batch' && args[i + 1]) {
			batchSize = parseInt(args[i + 1], 10);
			i++;
		} else if (args[i] === '--days' && args[i + 1]) {
			days = parseInt(args[i + 1], 10);
			i++;
		}
	}

	return { regenHtml, regenPmHtml, purgePmTrash, areas, dryRun, width, batchSize, days };
}

async function main() {
	var opts = parseArgs();

	if (!opts.regenHtml && !opts.regenPmHtml && !opts.purgePmTrash) {
		console.log('No task specified. Use --help for usage.');
		process.exit(1);
	}

	// PID file to prevent concurrent runs
	try {
		var existingPid = fs.readFileSync(PID_FILE, 'utf8');
		process.kill(parseInt(existingPid), 0);
		console.log('Another maintenance instance (PID ' + existingPid + ') is already running.');
		process.exit(1);
	} catch (err) {
		if (err.code === 'ENOENT' || err.code === 'ESRCH') {
			fs.writeFileSync(PID_FILE, process.pid.toString());
			process.on('exit', function() {
				try { fs.unlinkSync(PID_FILE); } catch (_) {}
			});
		} else {
			console.error('Error checking PID file:', err);
			process.exit(1);
		}
	}

	var startTime = Date.now();

	if (opts.regenHtml) {
		console.log('Starting message area body_html regeneration...');

		var result = await regenerateAllBodyHtml({
			areas:      opts.areas.length > 0 ? opts.areas : undefined,
			dryRun:     opts.dryRun,
			forceWidth: opts.width || undefined,
			batchSize:  opts.batchSize
		});

		var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.log('');
		console.log('Message areas completed in ' + elapsed + 's:');
		console.log('  Processed: ' + result.totalProcessed);
		console.log('  Updated:   ' + result.totalUpdated);
		console.log('  Skipped:   ' + result.totalSkipped);
		console.log('  Errors:    ' + result.totalErrors);
	}

	if (opts.regenPmHtml) {
		var pmStart = Date.now();
		console.log('Starting PM body_html regeneration...');

		var pmResult = await regeneratePmBodyHtml({
			dryRun:     opts.dryRun,
			forceWidth: opts.width || undefined,
			batchSize:  opts.batchSize
		});

		var pmElapsed = ((Date.now() - pmStart) / 1000).toFixed(1);
		console.log('');
		console.log('PM tables completed in ' + pmElapsed + 's:');
		console.log('  Processed: ' + pmResult.totalProcessed);
		console.log('  Updated:   ' + pmResult.totalUpdated);
		console.log('  Skipped:   ' + pmResult.totalSkipped);
		console.log('  Errors:    ' + pmResult.totalErrors);
	}

	if (opts.purgePmTrash) {
		var retentionDays = opts.days || parseInt(process.env.pm_trash_retention_days) || 30;
		console.log('Purging PM trash older than ' + retentionDays + ' days...');
		var purgeResult = await purgeDeleted(retentionDays);
		console.log('PM trash purge complete:');
		console.log('  Inbox purged:  ' + purgeResult.inboxPurged);
		console.log('  Outbox purged: ' + purgeResult.outboxPurged);
	}
}

await main();
process.exit();
