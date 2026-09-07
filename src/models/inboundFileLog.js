// inboundFileLog.js — Tracks files received from peers via mailer sessions.
//
// Every file received through binkp or EMSI/Wazoo is logged with the
// peer connection info. Used by the tosser to look up who sent a file,
// and by the admin for debugging delivery issues.

import * as postgres from '../middleware/db/postgres.js';

/**
 * Log a received file.
 */
async function logFile(filename, filepath, fileSize, peerInfo) {
	var info = peerInfo || {};
	await postgres.insertObject({
		filename:           filename,
		filepath:           filepath || null,
		file_size:          fileSize || 0,
		peer_address:       info.address || null,
		peer_connection_id: info.connectionId || null,
		peer_name:          info.peerName || null,
		session_uuid:       info.sessionUuid || null,
		received_at:        new Date()
	}, 'inbound_file_log');
}

/**
 * Look up who sent a file by filename (most recent match).
 */
async function lookupSender(filename) {
	return await postgres.queryOne(
		'SELECT * FROM inbound_file_log WHERE filename = $1 ORDER BY received_at DESC LIMIT 1',
		[filename]
	);
}

/**
 * Look up who sent a file by filepath.
 */
async function lookupByPath(filepath) {
	return await postgres.queryOne(
		'SELECT * FROM inbound_file_log WHERE filepath = $1 ORDER BY received_at DESC LIMIT 1',
		[filepath]
	);
}

/**
 * Get recent inbound files (for admin display).
 */
async function getRecent(limit) {
	return await postgres.query(
		'SELECT * FROM inbound_file_log ORDER BY received_at DESC LIMIT $1',
		[limit || 50]
	) || [];
}

/**
 * Most recent file received from a connection, for the "last packet in" line
 * on the peer diagnostics panel. Mirrors outboundFileLog.lastForConnection.
 */
async function lastForConnection(connectionId) {
	if (!connectionId) return null;
	return await postgres.queryOne(
		'SELECT * FROM inbound_file_log WHERE peer_connection_id = $1 ' +
		'ORDER BY received_at DESC LIMIT 1',
		[parseInt(connectionId)]
	);
}

/**
 * Recent files received from one connection, newest first.
 */
async function recentForConnection(connectionId, limit) {
	if (!connectionId) return [];
	return await postgres.query(
		'SELECT * FROM inbound_file_log WHERE peer_connection_id = $1 ' +
		'ORDER BY received_at DESC LIMIT $2',
		[parseInt(connectionId), Math.min(parseInt(limit) || 10, 100)]
	) || [];
}

/**
 * Purge entries older than N days.
 */
async function purgeOld(days) {
	if (!days || days <= 0) return 0;
	var cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - days);
	var result = await postgres.pgpool.query(
		'DELETE FROM inbound_file_log WHERE received_at < $1',
		[cutoff]
	);
	return result.rowCount || 0;
}

export { logFile, lookupSender, lookupByPath, lastForConnection,
	recentForConnection, getRecent, purgeOld };
