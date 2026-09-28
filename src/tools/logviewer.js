#!/usr/bin/env node

// src/tools/logviewer.js — Terminal log viewer
//
// Subscribes to the alog:stream Redis pub/sub channel and renders entries
// with chalk colors, just like the processes themselves see them.
// Works from any machine with Redis access — perfect for Termux, SSH, etc.
//
// Usage:
//   node src/tools/logviewer.js                        # all processes, all levels
//   node src/tools/logviewer.js --process gateway      # gateway only
//   node src/tools/logviewer.js --process worker mailer # worker + mailer
//   node src/tools/logviewer.js --level 2              # level 2 and below (more important)
//   node src/tools/logviewer.js --level 5              # level 5 and below (verbose)
//   node src/tools/logviewer.js --history              # load history before streaming
//   node src/tools/logviewer.js --history --last 2h    # history from last 2 hours
//   node src/tools/logviewer.js --help

import { createClient } from 'redis';
import chalk from 'chalk';
import * as dotenv from 'dotenv';

dotenv.config();

const LOG_CHANNEL = 'alog:stream';
const HISTORY_PREFIX = 'alog:history:';
const ALL_PROCESSES = ['gateway', 'worker', 'mailer', 'mail'];

// -----------------------------------------------------------------------
// Argument parsing
// -----------------------------------------------------------------------

function parseArgs() {
	var args = process.argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		console.log('Usage: node src/tools/logviewer.js [options]');
		console.log('');
		console.log('Options:');
		console.log('  --process NAME     Filter by process (repeatable: --process gateway --process worker)');
		console.log('  --level N          Show entries at level N and below (default: all)');
		console.log('  --history          Load recent history before streaming');
		console.log('  --last DURATION    History window (e.g. 1h, 30m, 2h). Default: 1h');
		console.log('  --no-color         Disable chalk colors');
		console.log('  --compact          Single-line format (no newlines between entries)');
		console.log('');
		console.log('Connects to Redis at redis_url env var (default: redis://localhost:6379)');
		process.exit(0);
	}

	var processes = [];
	var maxLevel = null;
	var showHistory = args.includes('--history');
	var compact = args.includes('--compact');
	var lastDuration = '1h';

	for (var i = 0; i < args.length; i++) {
		if (args[i] === '--process' && args[i + 1]) {
			processes.push(args[i + 1].toLowerCase());
			i++;
		} else if (args[i] === '--level' && args[i + 1]) {
			maxLevel = parseInt(args[i + 1]);
			i++;
		} else if (args[i] === '--last' && args[i + 1]) {
			lastDuration = args[i + 1];
			i++;
		}
	}

	if (args.includes('--no-color')) {
		chalk.level = 0;
	}

	return {
		processes: processes.length > 0 ? processes : null,
		maxLevel,
		showHistory,
		lastDuration,
		compact
	};
}

// -----------------------------------------------------------------------
// Duration parsing (1h, 30m, 2h, etc.)
// -----------------------------------------------------------------------

function parseDuration(str) {
	var match = str.match(/^(\d+)(h|m|s)$/i);
	if (!match) return 3600000; // default 1h
	var val = parseInt(match[1]);
	switch (match[2].toLowerCase()) {
		case 'h': return val * 60 * 60 * 1000;
		case 'm': return val * 60 * 1000;
		case 's': return val * 1000;
		default: return 3600000;
	}
}

// -----------------------------------------------------------------------
// Chalk color rendering
// -----------------------------------------------------------------------

var chalkMap = {
	black: chalk.black, red: chalk.red, green: chalk.green,
	yellow: chalk.yellow, blue: chalk.blue, magenta: chalk.magenta,
	cyan: chalk.cyan, white: chalk.white, gray: chalk.gray,
	redbright: chalk.redBright, greenbright: chalk.greenBright,
	yellowbright: chalk.yellowBright, bluebright: chalk.blueBright,
	magentabright: chalk.magentaBright, cyanbright: chalk.cyanBright,
	whitebright: chalk.whiteBright
};

var chalkBoldMap = {
	black: chalk.black.bold, red: chalk.red.bold, green: chalk.green.bold,
	yellow: chalk.yellow.bold, blue: chalk.blue.bold, magenta: chalk.magenta.bold,
	cyan: chalk.cyan.bold, white: chalk.white.bold, gray: chalk.gray.bold,
	redbright: chalk.redBright.bold, greenbright: chalk.greenBright.bold,
	yellowbright: chalk.yellowBright.bold, bluebright: chalk.blueBright.bold,
	magentabright: chalk.magentaBright.bold, cyanbright: chalk.cyanBright.bold,
	whitebright: chalk.whiteBright.bold
};

// Process label colors
var processColors = {
	gateway: chalk.blueBright,
	worker:  chalk.cyan,
	mailer:  chalk.magenta
};

function renderEntry(entry, compact) {
	var ts = new Date(entry.ts).toLocaleTimeString();
	var procColor = processColors[entry.process] || chalk.white;
	var label = procColor('[' + entry.process.padEnd(7) + ']');
	var levelStr = chalk.gray('L' + entry.level);

	var colorFn = null;
	if (entry.color) {
		var key = entry.color.toLowerCase();
		colorFn = entry.bold ? chalkBoldMap[key] : chalkMap[key];
	}

	var msg = entry.message;
	if (colorFn) {
		msg = colorFn(msg);
	}

	if (compact) {
		console.log(chalk.gray(ts) + ' ' + label + ' ' + levelStr + ' ' + msg);
	} else {
		console.log('');
		console.log(chalk.gray(ts) + ' ' + label + ' ' + levelStr);
		console.log('  ' + msg);
	}
}

// -----------------------------------------------------------------------
// Filter check
// -----------------------------------------------------------------------

function shouldShow(entry, opts) {
	if (opts.processes && !opts.processes.includes(entry.process)) return false;
	if (opts.maxLevel !== null && entry.level > opts.maxLevel) return false;
	return true;
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
	var opts = parseArgs();
	var redisUrl = process.env.redis_url || 'redis://localhost:6379';

	console.log(chalk.bold('\n=== Canectic Log Viewer ===\n'));
	console.log('  Redis:     ' + redisUrl);
	console.log('  Processes: ' + (opts.processes ? opts.processes.join(', ') : 'all'));
	console.log('  Level:     ' + (opts.maxLevel !== null ? '<= ' + opts.maxLevel : 'all'));
	console.log('  History:   ' + (opts.showHistory ? opts.lastDuration : 'off'));
	console.log('');
	console.log(chalk.gray('  Press Ctrl+C to exit'));
	console.log('');

	// --- Load history if requested ---
	if (opts.showHistory) {
		try {
			var histClient = createClient({ url: redisUrl });
			await histClient.connect();

			var sinceMs = Date.now() - parseDuration(opts.lastDuration);
			var targetProcesses = opts.processes || ALL_PROCESSES;
			var allEntries = [];

			for (var proc of targetProcesses) {
				var key = HISTORY_PREFIX + proc;
				var entries = await histClient.zRangeByScore(key, sinceMs, '+inf');
				for (var raw of entries) {
					try {
						allEntries.push(JSON.parse(raw));
					} catch (_) {}
				}
			}

			await histClient.disconnect();

			// Sort by timestamp, then sequence
			allEntries.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

			console.log(chalk.gray('--- History (' + allEntries.length + ' entries) ---'));
			for (var entry of allEntries) {
				if (shouldShow(entry, opts)) {
					renderEntry(entry, opts.compact);
				}
			}
			console.log(chalk.gray('--- Live ---'));
			console.log('');

		} catch (err) {
			console.log(chalk.red('Failed to load history: ' + err.message));
		}
	}

	// --- Subscribe to real-time stream ---
	var subClient = createClient({ url: redisUrl });
	await subClient.connect();

	await subClient.subscribe(LOG_CHANNEL, (payload) => {
		try {
			var entry = JSON.parse(payload);
			if (shouldShow(entry, opts)) {
				renderEntry(entry, opts.compact);
			}
		} catch (_) {}
	});

	// Keep alive until Ctrl+C
	process.on('SIGINT', async () => {
		console.log(chalk.gray('\n\nDisconnecting...'));
		await subClient.unsubscribe(LOG_CHANNEL);
		await subClient.disconnect();
		process.exit(0);
	});
}

main().catch(err => {
	console.error(chalk.red('Error: ' + err.message));
	process.exit(1);
});
