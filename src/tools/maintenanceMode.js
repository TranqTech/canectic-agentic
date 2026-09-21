// maintenanceMode.js -- close the board, open it, and see whether it has drained.
//
// Maintenance mode is for any operation that needs the board to itself: an
// update, a message base import, area surgery, manual database work. Closing
// it refuses new callers, new mail client logins and new binkp sessions,
// pauses the worker's queues, and gives connected callers the grace period
// before they are disconnected. Opening it undoes all of that.
//
// Usage:
//   node src/tools/maintenanceMode.js --status
//   node src/tools/maintenanceMode.js --on --reason "Rebuilding areas" [--minutes 30] [--grace 300] [--by NAME] [--wait]
//   node src/tools/maintenanceMode.js --off
//   node src/tools/maintenanceMode.js --wait [--timeout SECONDS]
//
// --wait blocks until every running process reports nothing in flight, so a
// script can do the work only once the board is quiet:
//
//   node src/tools/maintenanceMode.js --on --reason "DB work" --wait && pg_dump ...
//
// Exit codes for --wait: 0 drained, 2 timed out, 3 nothing is reporting (so
// nothing can be confirmed), 4 the board was reopened while waiting.
//
// Run from the install root, like every tool here. Deliberately NODE BUILTINS
// ONLY: this is the tool you reach for when the gateway will not start or the
// database is the thing being repaired, so it cannot need either. Without
// --grace, the board's own maintenance_grace_seconds applies, read by each
// process from its config.

import * as os from 'os';
import * as flags from '../maintenance/maintenanceFlag.js';

var argv = process.argv.slice(2);
var root = process.cwd();

function has(name) { return argv.includes(name); }
function value(name, fallback) {
	var i = argv.indexOf(name);
	if (i === -1 || i === argv.length - 1) return fallback;
	var v = argv[i + 1];
	return v.startsWith('--') ? fallback : v;
}

function when(date) {
	if (!date) return '-';
	var d = new Date(date);
	var mins = Math.round((d.getTime() - Date.now()) / 60000);
	var rel = mins === 0 ? 'now' : (mins > 0 ? 'in ' + mins + ' min' : Math.abs(mins) + ' min ago');
	return d.toLocaleString() + ' (' + rel + ')';
}

function printStatus() {
	var flag = flags.readFlag(root);
	if (!flag) {
		console.log('The board is OPEN.');
		return;
	}
	console.log('The board is CLOSED for maintenance.');
	console.log('  reason:        ' + (flag.reason || '(none given)'));
	console.log('  since:         ' + when(flag.since));
	console.log('  expected back: ' + (flag.expected_minutes !== null ? when(flags.expectedBackOf(flag)) : '(not given)'));
	console.log('  grace:         ' + (flag.grace_seconds !== null ? flag.grace_seconds + 's' : 'board default (maintenance_grace_seconds)'));
	console.log('  set by:        ' + (flag.set_by || '?') + ' (' + flag.source + (flag.run_id ? ', run ' + flag.run_id : '') + ')');
	if (flag.malformed) console.log('  note:          the flag file could not be read; it still closes the board');

	var a = flags.assessDrain(flags.readDrainStatuses(root), { since: flag.since });
	console.log('');
	if (a.processes.length === 0) {
		console.log('  No process has reported. Either nothing is running, or what is running');
		console.log('  predates maintenance mode and will not drain.');
		return;
	}
	for (var p of a.processes) {
		var line = '  ' + (p.process + '          ').substring(0, 10) + p.state;
		if (p.state === 'draining') line += ': ' + flags.describePending(p.pending);
		if (p.state === 'draining' && p.deadline) line += ' (grace ends ' + when(p.deadline) + ')';
		console.log(line);
	}
	console.log('');
	console.log(a.drained && a.reporting > 0 ? '  Drained: nothing in flight.' : (a.reporting > 0 ? '  Still draining.' : '  Nothing is reporting.'));
}

async function waitDrain() {
	var timeoutS = parseInt(value('--timeout', '0'), 10) || 0;
	var last = '';
	var res = await flags.waitForDrain(root, {
		timeoutMs: timeoutS * 1000,
		onProgress: function (a) {
			var line = a.processes
				.filter(function (p) { return p.state === 'draining'; })
				.map(function (p) { return p.process + ': ' + flags.describePending(p.pending); })
				.join('; ');
			if (line && line !== last) console.log('  waiting on ' + line);
			last = line;
		}
	});
	switch (res.verdict) {
		case 'drained':
			console.log('Drained: nothing in flight.');
			return 0;
		case 'timeout':
			console.log('Timed out after ' + timeoutS + 's with work still in flight.');
			return 2;
		case 'nobody':
			console.log('No process is reporting. Either nothing is running, or what is running');
			console.log('predates maintenance mode. Nothing can be confirmed as drained.');
			return 3;
		case 'open':
			console.log('The board was reopened while waiting.');
			return 4;
	}
	return 1;
}

function usage() {
	console.log('Usage:');
	console.log('  node src/tools/maintenanceMode.js --status');
	console.log('  node src/tools/maintenanceMode.js --on --reason "..." [--minutes N] [--grace SECONDS] [--by NAME] [--wait]');
	console.log('  node src/tools/maintenanceMode.js --off');
	console.log('  node src/tools/maintenanceMode.js --wait [--timeout SECONDS]');
}

async function main() {
	if (has('--on')) {
		var existing = flags.readFlag(root);
		var flag = flags.enterMaintenance(root, {
			reason:           value('--reason', null),
			expected_minutes: value('--minutes', null),
			grace_seconds:    value('--grace', null),
			set_by:           value('--by', null) || (function () { try { return os.userInfo().username; } catch (_) { return null; } })(),
			source:           'manual'
		});
		console.log(existing ? 'Maintenance details updated; the grace still runs from ' + when(flag.since) + '.'
			: 'The board is now CLOSED for maintenance.');
		if (has('--wait')) return await waitDrain();
		return 0;
	}
	if (has('--off')) {
		var was = flags.readFlag(root);
		flags.leaveMaintenance(root);
		console.log(was ? 'The board is now OPEN.' : 'The board was already open.');
		if (was && was.source === 'update') {
			console.log('Note: this closure was set by an update' + (was.run_id ? ' (run ' + was.run_id + ')' : '') +
				'. If that update failed, check the Update page before letting callers back in.');
		}
		return 0;
	}
	if (has('--wait')) return await waitDrain();
	if (has('--status') || argv.length === 0) {
		printStatus();
		return 0;
	}
	usage();
	return 1;
}

main().then(function (code) { process.exit(code); }).catch(function (err) {
	console.error('maintenanceMode: ' + (err && err.message || err));
	process.exit(1);
});
