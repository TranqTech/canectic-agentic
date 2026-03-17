#!/usr/bin/env node

// maintenance.js — CLI runner for message base maintenance tasks.
// Located in src/tools/
//
// Usage:
//   node src/tools/maintenance.js --regen-html                 Regenerate body_html for all areas
//   node src/tools/maintenance.js --regen-html --area GENERAL  Regenerate for a specific area
//   node src/tools/maintenance.js --regen-html --area GENERAL --area ALTBBSADS  Multiple areas
//   node src/tools/maintenance.js --regen-html --dry-run       Preview without writing
//   node src/tools/maintenance.js --regen-html --width 80      Force a specific column width
//   node src/tools/maintenance.js --help                       Show usage

import * as fs from 'fs';
import { regenerateAllBodyHtml } from '../maintenance/messageBase.js';

const PID_FILE = '/tmp/can_maint.pid';

function parseArgs() {
	var args = process.argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		console.log('Usage: node maintenance.js [task] [options]');
		console.log('');
		console.log('Tasks:');
		console.log('  --regen-html    Regenerate body_html for messages');
		console.log('');
		console.log('Options:');
		console.log('  --area SHORTCODE  Limit to specific area(s) (repeatable)');
		console.log('  --dry-run         Preview without writing changes');
		console.log('  --width N         Force column width for HTML generation');
		console.log('  --batch N         Batch size (default: 100)');
		process.exit(0);
	}

	var areas = [];
	var dryRun = args.includes('--dry-run');
	var regenHtml = args.includes('--regen-html');
	var width = null;
	var batchSize = 100;

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
		}
	}

	return { regenHtml, areas, dryRun, width, batchSize };
}

async function main() {
	var opts = parseArgs();

	if (!opts.regenHtml) {
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

	if (opts.regenHtml) {
		var startTime = Date.now();
		console.log('Starting body_html regeneration...');

		var result = await regenerateAllBodyHtml({
			areas:      opts.areas.length > 0 ? opts.areas : undefined,
			dryRun:     opts.dryRun,
			forceWidth: opts.width || undefined,
			batchSize:  opts.batchSize
		});

		var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		console.log('');
		console.log('Completed in ' + elapsed + 's:');
		console.log('  Processed: ' + result.totalProcessed);
		console.log('  Updated:   ' + result.totalUpdated);
		console.log('  Skipped:   ' + result.totalSkipped);
		console.log('  Errors:    ' + result.totalErrors);
	}
}

await main();
process.exit();
