// fileDistribution.js — Tracks outbound file distribution to peers
// Each row represents one file that needs to be (or has been) sent to one peer.
// The TIC tosser creates 'pending' rows on inbound, then the outbound pass
// picks them up and stages TIC files + attached files for the mailer.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Bulk-create pending distribution rows for a file entry.
 * peerConnectionIds is an array of peer_connection IDs that should receive this file.
 * Skips any that already have a row (UNIQUE constraint on file_entry_id + peer_connection_id).
 */
async function createDistributionRows(fileEntryId, peerConnectionIds, protocol) {
	var entryId = parseInt(fileEntryId);
	var proto = protocol || 'tic';
	var now = new Date();
	var created = 0;
	var skipped = 0;

	for (var connId of peerConnectionIds) {
		var cid = parseInt(connId);

		// Check for existing row (idempotent)
		var existing = await postgres.queryOne(
			'SELECT id FROM file_distribution WHERE file_entry_id = $1 AND peer_connection_id = $2',
			[entryId, cid]
		);
		if (existing) {
			skipped++;
			continue;
		}

		var pgObj = {
			file_entry_id: entryId,
			peer_connection_id: cid,
			protocol: proto,
			status: 'pending',
			attempts: 0,
			created_at: now
		};

		var dbres = await postgres.insertObject(pgObj, 'file_distribution');
		if (dbres.status) {
			created++;
		} else {
			alogger.writeAlog(3,
				'fileDistribution.createDistributionRows: insert failed for entry ' +
				entryId + ' conn ' + cid + ': ' + dbres.errormessages.join(', '),
				'redbright'
			);
		}
	}

	alogger.writeAlog(5,
		'fileDistribution: created ' + created + ' distribution row(s) for entry ' +
		entryId + ' (skipped ' + skipped + ' existing)',
		'greenbright'
	);

	return { created: created, skipped: skipped };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Get all pending distribution rows for a specific peer connection.
 * Joins file_entries for filename, path, hash info.
 */
async function getPendingForConnection(peerConnectionId) {
	var rows = await postgres.query(
		`SELECT fd.*, fe.filename, fe.disk_path, fe.file_size, fe.file_date,
		        fe.file_hash_crc32, fe.file_hash_sha256,
		        fe.short_desc, fe.long_desc, fe.area_id, fe.area_shortcode,
		        fe.source_type, fe.source_data
		 FROM file_distribution fd
		 JOIN file_entries fe ON fe.id = fd.file_entry_id
		 WHERE fd.peer_connection_id = $1 AND fd.status = 'pending'
		 ORDER BY fd.created_at ASC`,
		[parseInt(peerConnectionId)]
	);
	return rows || [];
}

/**
 * Get all pending distribution rows grouped by connection.
 * Returns rows with connection info attached.
 */
async function getAllPending() {
	var rows = await postgres.query(
		`SELECT fd.*, fe.filename, fe.disk_path, fe.file_size, fe.file_date,
		        fe.file_hash_crc32, fe.file_hash_sha256,
		        fe.short_desc, fe.long_desc, fe.area_id, fe.area_shortcode,
		        fe.source_type, fe.source_data,
		        pc.uuid AS connection_uuid, pc.peer_id, pc.network_id,
		        pc.connection_data
		 FROM file_distribution fd
		 JOIN file_entries fe ON fe.id = fd.file_entry_id
		 JOIN peer_connections pc ON pc.id = fd.peer_connection_id
		 WHERE fd.status = 'pending' AND pc.active = true
		 ORDER BY fd.peer_connection_id ASC, fd.created_at ASC`
	);
	return rows || [];
}

/**
 * Get all distribution rows for a file entry (any status).
 */
async function getDistributionForEntry(fileEntryId) {
	var rows = await postgres.query(
		`SELECT fd.*, pc.uuid AS connection_uuid,
		        p.name AS peer_name
		 FROM file_distribution fd
		 JOIN peer_connections pc ON pc.id = fd.peer_connection_id
		 JOIN peers p ON p.id = pc.peer_id
		 WHERE fd.file_entry_id = $1
		 ORDER BY fd.created_at ASC`,
		[parseInt(fileEntryId)]
	);
	return rows || [];
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Mark a distribution row as sent.
 */
async function markSent(id) {
	var now = new Date();
	var err = await postgres.write(
		"UPDATE file_distribution SET status = 'sent', sent_at = $1, last_attempt = $1, attempts = attempts + 1 WHERE id = $2",
		[now, parseInt(id)]
	);
	if (err) {
		alogger.writeAlog(3, 'fileDistribution.markSent: failed for id ' + id + ': ' + err.message, 'redbright');
	}
	return !err;
}

/**
 * Mark a distribution row as failed.
 */
async function markFailed(id, errorMessage) {
	var now = new Date();
	var err = await postgres.write(
		"UPDATE file_distribution SET status = 'failed', last_attempt = $1, attempts = attempts + 1, error_message = $2 WHERE id = $3",
		[now, errorMessage || 'Unknown error', parseInt(id)]
	);
	if (err) {
		alogger.writeAlog(3, 'fileDistribution.markFailed: failed for id ' + id + ': ' + err.message, 'redbright');
	}
	return !err;
}

/**
 * Mark a distribution row as skipped (e.g. file no longer exists on disk).
 */
async function markSkipped(id, reason) {
	var now = new Date();
	var err = await postgres.write(
		"UPDATE file_distribution SET status = 'skipped', last_attempt = $1, error_message = $2 WHERE id = $3",
		[now, reason || 'Skipped', parseInt(id)]
	);
	return !err;
}

/**
 * Reset failed rows to pending for retry.
 */
async function retryFailed(peerConnectionId) {
	var err = await postgres.write(
		"UPDATE file_distribution SET status = 'pending', error_message = NULL WHERE peer_connection_id = $1 AND status = 'failed'",
		[parseInt(peerConnectionId)]
	);
	return !err;
}

export {
	createDistributionRows,
	getPendingForConnection,
	getAllPending,
	getDistributionForEntry,
	markSent,
	markFailed,
	markSkipped,
	retryFailed
};
