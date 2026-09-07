// outboundFileLog.js -- what this system sent to each peer, and when.
//
// The mirror of inboundFileLog.js. Kept as its own table rather than a
// direction column on inbound_file_log because the tosser looks packets up in
// that table by filename to trace who sent them, and a widened table would
// have to exclude our own sends from every one of those lookups. Two tables,
// each true to its name, and no migration on an existing install.
//
// Written on M_GOT, so a row here means the peer acknowledged the file, not
// merely that we started pushing it.

import * as postgres from '../middleware/db/postgres.js';

/**
 * Log a file the peer acknowledged receiving.
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
		sent_at:            new Date()
	}, 'outbound_file_log');
}

/**
 * Most recent file sent to a connection, for the "last packet out" line.
 */
async function lastForConnection(connectionId) {
	if (!connectionId) return null;
	return await postgres.queryOne(
		'SELECT * FROM outbound_file_log WHERE peer_connection_id = $1 ' +
		'ORDER BY sent_at DESC LIMIT 1',
		[parseInt(connectionId)]
	);
}

/**
 * Recent files sent to one connection, newest first.
 */
async function recentForConnection(connectionId, limit) {
	if (!connectionId) return [];
	return await postgres.query(
		'SELECT * FROM outbound_file_log WHERE peer_connection_id = $1 ' +
		'ORDER BY sent_at DESC LIMIT $2',
		[parseInt(connectionId), Math.min(parseInt(limit) || 10, 100)]
	) || [];
}

/**
 * Recent files sent to anyone (admin display).
 */
async function getRecent(limit) {
	return await postgres.query(
		'SELECT * FROM outbound_file_log ORDER BY sent_at DESC LIMIT $1',
		[Math.min(parseInt(limit) || 50, 500)]
	) || [];
}

/**
 * Purge entries older than N days. 0 or null keeps everything.
 */
async function purgeOld(days) {
	if (!days || days <= 0) return 0;
	var cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - parseInt(days));
	var result = await postgres.pgpool.query(
		'DELETE FROM outbound_file_log WHERE sent_at < $1',
		[cutoff]
	);
	return result.rowCount || 0;
}

export { logFile, lastForConnection, recentForConnection, getRecent, purgeOld };
