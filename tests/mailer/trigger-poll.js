#!/usr/bin/env node
// tests/mailer/trigger-poll.js
//
// Manually trigger an outbound mailer poll for a specific peer connection.
//
// Default mode: enqueues a trigger-poll job on the mailer queue.  The mailer
// process (bin/mailer.js or embedded) picks it up and runs the session.
// Session details appear in the mailer's logs.
//
// Direct mode (--direct): starts a local MailerManager, polls the connection,
// and prints session events inline.  Useful for debugging binkp sessions
// without the queue layer.  Does not require the mailer process to be running.
//
// Requires the full project environment (database, Redis, .env).
//
// Usage:
//   node tests/mailer/trigger-poll.js <connection-uuid or ftn-address>
//   node tests/mailer/trigger-poll.js --direct <connection-uuid or ftn-address>
//
// Examples:
//   node tests/mailer/trigger-poll.js 9f894ef9-5333-42c2-826b-caaf84cb457e
//   node tests/mailer/trigger-poll.js 1:123/456
//   node tests/mailer/trigger-poll.js --direct 1:123/456

import * as dotenv from 'dotenv';
dotenv.config();

import * as peerConnections from '../../src/models/peerConnections.js';
import * as alogger from '../../src/utils/alogger.js';

// Parse args — extract --direct flag and the target
var args = process.argv.slice(2);
var directMode = args.includes('--direct');
var target = args.filter(a => a !== '--direct')[0];

if (!target) {
	console.log('Usage: node tests/mailer/trigger-poll.js [--direct] <connection-uuid or ftn-address>');
	console.log('');
	console.log('  Accepts either a connection UUID or an FTN address (e.g. 1:123/456).');
	console.log('  Triggers an outbound binkp call to the matching peer connection.');
	console.log('');
	console.log('Options:');
	console.log('  --direct   Start a local MailerManager and run the session in this process.');
	console.log('             Shows session events inline. Does not require mailer process.');
	console.log('');
	console.log('  (default)  Enqueue a trigger-poll job on the mailer queue.');
	console.log('             Requires the mailer process (bin/mailer.js) to be running.');
	process.exit(1);
}

// Detect whether the argument is an FTN address (contains a colon and slash)
function isFtnAddress(str) {
	return /^\d+:\d+\/\d+/.test(str);
}

async function resolveConnection(target) {
	if (isFtnAddress(target)) {
		// Search active FTN connections for a matching address
		var connections = await peerConnections.getActiveConnectionsByNetworkType('FTN');
		if (!connections || connections.length === 0) {
			console.log('\x1b[31mNo active FTN connections found.\x1b[0m');
			process.exit(1);
		}

		// Normalize — strip point if .0, lowercase
		var normalized = target.toLowerCase().replace(/\.0$/, '');

		for (var conn of connections) {
			var cd = conn.connection_data || {};
			var connAddr = (cd.address || '').toLowerCase().replace(/\.0$/, '');
			if (connAddr === normalized) {
				return conn;
			}
		}

		console.log('\x1b[31mNo active FTN connection found for address: ' + target + '\x1b[0m');
		console.log('');
		console.log('Active FTN connections:');
		for (var c of connections) {
			var ccd = c.connection_data || {};
			console.log('  ' + (ccd.address || '—').padEnd(16) + ' ' + (c.peer_name || '').padEnd(20) + ' ' + c.uuid);
		}
		process.exit(1);
	} else {
		// Treat as UUID
		var conn = await peerConnections.getConnectionByUUIDWithNetwork(target);
		if (!conn) {
			console.log('\x1b[31mConnection not found: ' + target + '\x1b[0m');
			process.exit(1);
		}
		return conn;
	}
}

function printConnectionInfo(conn) {
	var cd = conn.connection_data || {};
	console.log('\x1b[1m\x1b[36m=== Mailer Poll Trigger ===\x1b[0m\n');
	console.log('  Connection: ' + conn.uuid);
	console.log('  Peer:       ' + (conn.peer_name || 'unknown'));
	console.log('  Network:    ' + (conn.network_name || conn.network_id));
	console.log('  Address:    ' + (cd.address || '—'));
	console.log('  Host:       ' + (cd.remote_host || cd.mailer_host || '—'));
	console.log('  Port:       ' + (cd.remote_port || cd.mailer_port || 24554));
	console.log('  Status:     ' + (cd.status || 'NORMAL'));
	console.log('  Active:     ' + (conn.active ? 'yes' : 'no'));
	console.log('  Mode:       ' + (directMode ? 'DIRECT (local MailerManager)' : 'QUEUE (mailer process)'));
	console.log('');
}

// ---------------------------------------------------------------------------
// Queue mode — enqueue a job and wait for the result
// ---------------------------------------------------------------------------

async function runQueueMode(connectionUUID) {
	var { enqueueMailerTriggerPoll } = await import('../../src/queues/jobs.js');
	var { closeQueues } = await import('../../src/queues/queues.js');
	var { QueueEvents } = await import('bullmq');
	var { createQueueConnection } = await import('../../src/queues/connection.js');

	console.log('Enqueueing trigger-poll job...\n');

	var job = await enqueueMailerTriggerPoll(connectionUUID);

	if (!job || !job.id) {
		console.log('\x1b[31mFailed to enqueue job. Is Redis running?\x1b[0m');
		await closeQueues();
		process.exit(1);
	}

	console.log('  Job ID:  ' + job.id);
	console.log('  Queue:   mailer');
	console.log('');
	console.log('Waiting for mailer process to pick up the job...');

	// Watch for completion/failure
	var connection = createQueueConnection();
	var queueEvents = new QueueEvents('mailer', { connection });

	var timeout = setTimeout(() => {
		console.log('\n\x1b[31mTimeout — job not completed within 60 seconds.\x1b[0m');
		console.log('Is the mailer process running?  (node bin/mailer.js)');
		cleanup();
		process.exit(1);
	}, 60000);

	function cleanup() {
		clearTimeout(timeout);
		queueEvents.close();
		connection.disconnect();
		closeQueues();
	}

	queueEvents.on('completed', ({ jobId }) => {
		if (jobId === job.id) {
			console.log('\n\x1b[32m✓ Poll completed.\x1b[0m');
			console.log('  Check mailer logs for session details.');
			cleanup();
			setTimeout(() => process.exit(0), 200);
		}
	});

	queueEvents.on('failed', ({ jobId, failedReason }) => {
		if (jobId === job.id) {
			console.log('\n\x1b[31m✗ Poll failed: ' + failedReason + '\x1b[0m');
			cleanup();
			setTimeout(() => process.exit(1), 200);
		}
	});
}

// ---------------------------------------------------------------------------
// Direct mode — instantiate MailerManager locally (original behavior)
// ---------------------------------------------------------------------------

async function runDirectMode(connectionUUID, conn) {
	var cd = conn.connection_data || {};

	if (!cd.remote_host && !cd.mailer_host) {
		console.log('\x1b[31mNo mailer host configured for this connection.\x1b[0m');
		console.log('Set remote_host in connection_data via the admin peer editor.');
		process.exit(1);
	}

	if (!conn.active) {
		console.log('\x1b[33mWarning: connection is inactive. Polling anyway.\x1b[0m\n');
	}

	var { MailerManager } = await import('../../src/mailer/manager.js');

	// Create a mailer manager but don't start the full listener/poll system
	var manager = new MailerManager();

	// Listen for session events
	manager.on('sessionStart', (status) => {
		console.log('\x1b[32mSession started:\x1b[0m ' + status.uuid + ' → ' + status.remoteAddress);
	});

	manager.on('sessionEnd', (info) => {
		console.log('');
		console.log('\x1b[1mSession complete:\x1b[0m');
		console.log('  Reason:   ' + info.reason);
		console.log('  Sent:     ' + info.filesSent + ' files');
		console.log('  Received: ' + info.filesReceived + ' files');
		console.log('  Duration: ' + info.duration + 's');

		// Give a moment for logs to flush, then exit
		setTimeout(() => process.exit(0), 500);
	});

	manager.on('pollFailed', (info) => {
		console.log('\x1b[31mPoll failed: ' + info.error + '\x1b[0m');
		setTimeout(() => process.exit(1), 500);
	});

	console.log('Initiating outbound call (direct mode)...\n');
	await manager.triggerPoll(connectionUUID);

	// Timeout safety — if nothing happens within 60s, bail
	setTimeout(() => {
		console.log('\n\x1b[31mTimeout — no session completed within 60 seconds.\x1b[0m');
		process.exit(1);
	}, 60000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	var conn = await resolveConnection(target);
	printConnectionInfo(conn);

	if (directMode) {
		await runDirectMode(conn.uuid, conn);
	} else {
		await runQueueMode(conn.uuid);
	}
}

main().catch(err => {
	console.error('\x1b[31mError:\x1b[0m', err.message);
	process.exit(1);
});
