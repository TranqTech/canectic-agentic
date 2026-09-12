// relayLog.js -- what this system did with netmail addressed to somebody else.
//
// Relay used to leave its traces in four places, none of them together: an
// alog line for a success, a different one for a refusal, an undeliverable row
// for a loop, and a text dump in ftn/bad for an unroutable address. So the
// question a sysop actually has, "did we relay what we should have, and did it
// leave", took four searches and two of the four sources roll over.
//
// This reads the one table that now records every decision.
//
// Usage:
//   node src/tools/relayLog.js                    summary plus anything stuck
//   node src/tools/relayLog.js --list [N]         the last N decisions
//   node src/tools/relayLog.js --decision refused only that kind
//   node src/tools/relayLog.js --stuck [hours]    relayed but never sent
//   node src/tools/relayLog.js --sources          who is sending us transit mail
//   node src/tools/relayLog.js --msgid <id>       everything about one message
//   node src/tools/relayLog.js --days N           window for the summaries (default 7)
//
// Read-only.

import * as dotenv from 'dotenv';
import appConfig from '../config/appConfig.js';
import * as relayLog from '../models/netmailRelayLog.js';
import { formatDuration } from '../utils/scheduleFormat.js';

dotenv.config();

var argv = process.argv.slice(2);

function flag(name) { return argv.includes(name); }
function value(name, fallback) {
	var i = argv.indexOf(name);
	if (i === -1 || i === argv.length - 1) return fallback;
	var v = argv[i + 1];
	return v.startsWith('--') ? fallback : v;
}

function pad(str, len) {
	var s = String(str === null || str === undefined ? '' : str);
	if (s.length > len) return s.substring(0, len - 1) + '…';
	return s + ' '.repeat(len - s.length);
}

function ago(ts) {
	if (!ts) return '-';
	return formatDuration(Date.now() - new Date(ts).getTime()) + ' ago';
}

function printRows(rows) {
	if (!rows || rows.length === 0) { console.log('  (none)'); return; }
	console.log('  ' + pad('when', 14) + pad('decision', 10) + pad('from', 20) +
		pad('to', 20) + pad('next hop', 16) + 'subject');
	for (var r of rows) {
		console.log('  ' + pad(ago(r.received_at), 14) + pad(r.decision, 10) +
			pad((r.from_user || '?') + ' @ ' + (r.from_address || '?'), 20) +
			pad((r.to_user || '?') + ' @ ' + (r.to_address || '?'), 20) +
			pad(r.next_hop || '-', 16) + (r.subject || ''));
	}
}

async function main() {
	await appConfig.load();
	var days = parseInt(value('--days', '7')) || 7;

	if (flag('--msgid')) {
		var id = value('--msgid', '');
		console.log('\n=== ' + id + ' ===');
		var rows = await relayLog.getByMsgId(id);
		if (!rows.length) { console.log('  no relay decision recorded for that MSGID'); return; }
		for (var r of rows) {
			console.log('  ' + new Date(r.received_at).toISOString());
			console.log('    decision      ' + r.decision + (r.reason ? ' (' + r.reason + ')' : ''));
			console.log('    from          ' + (r.from_user || '?') + ' @ ' + (r.from_address || '?'));
			console.log('    to            ' + (r.to_user || '?') + ' @ ' + (r.to_address || '?'));
			console.log('    packet from   ' + (r.packet_source || 'unknown'));
			console.log('    relay mode    ' + (r.relay_mode || '-'));
			if (r.next_hop) console.log('    next hop      ' + r.next_hop + ' (' + (r.route_method || 'route') + ')');
			if (r.via_stamped) console.log('    stamped as    ' + r.via_stamped);
			if (r.outbound_uuid) console.log('    outbound row  ' + r.outbound_uuid);
			if (r.via_in) console.log('    via in        ' + r.via_in.split('\n').join('\n                  '));
		}
		return;
	}

	if (flag('--list') || flag('--decision')) {
		var limit = parseInt(value('--list', '50')) || 50;
		var decision = value('--decision', null);
		console.log('\n=== last ' + limit + (decision ? ' ' + decision : '') + ' decision(s) ===');
		printRows(await relayLog.getRecent(limit, decision));
		return;
	}

	if (flag('--sources')) {
		console.log('\n=== transit mail by sender, last ' + days + ' day(s) ===');
		var src = await relayLog.byPacketSource(days);
		if (!src.length) console.log('  (none)');
		for (var s of src) {
			console.log('  ' + pad(s.packet_source || '(unknown)', 24) + pad(s.decision, 12) + s.count);
		}
		return;
	}

	if (flag('--stuck')) {
		var hours = parseInt(value('--stuck', '6')) || 6;
		console.log('\n=== relayed but not sent, older than ' + hours + 'h ===');
		printRows(await relayLog.pendingDelivery(hours));
		return;
	}

	// Default: the two things worth knowing without being asked.
	console.log('\n=== relay decisions, last ' + days + ' day(s) ===');
	var summary = await relayLog.summarise(days);
	if (!summary.length) {
		console.log('  no netmail addressed elsewhere has reached this system');
	} else {
		for (var row of summary) {
			console.log('  ' + pad(row.decision, 12) + pad(row.count, 8) + 'last ' + ago(row.last_seen));
		}
	}

	// Accepted for relay and never actually sent. This is the failure the old
	// logging could not show at all: queueing looked like success, and a
	// message sitting unsent produced no further event.
	var stuck = await relayLog.pendingDelivery(6);
	console.log('\n=== relayed but not sent, older than 6h ===');
	printRows(stuck);
	if (stuck.length > 0) {
		console.log('\n  These were accepted and queued but the outbound row has not gone.');
		console.log('  Check the peer is polling: node src/tools/schedules.js');
	}
}

main().then(function () { process.exit(0); }).catch(function (err) {
	console.error('relayLog: ' + (err && err.stack ? err.stack : err));
	process.exit(1);
});
