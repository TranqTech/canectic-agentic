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
 *
 * Returns the number of rows reset, because the caller has to tell "nothing
 * was wrong" apart from "the reset did not happen", and those look identical
 * from a boolean.
 *
 * Unlike most writes in this module this one THROWS on a database error,
 * because it goes through postgres.query for the RETURNING clause. That is
 * the behaviour we want here: this is a sysop pressing a button and waiting
 * for an answer, so a failure belongs on their screen rather than in a return
 * value nobody reads. The admin route catches it.
 */
async function retryFailed(peerConnectionId) {
	var rows = await postgres.query(
		"UPDATE file_distribution SET status = 'pending', error_message = NULL, attempts = 0 " +
		"WHERE peer_connection_id = $1 AND status = 'failed' RETURNING id",
		[parseInt(peerConnectionId)]
	);
	return rows ? rows.length : 0;
}

/**
 * Status counts plus the most recent failures for one peer connection.
 *
 * There was no way to see any of this. A row that reached `failed` stayed
 * there for ever: nothing called retryFailed, nothing displayed the row, and
 * the only symptom was a file that one downlink never received while every
 * other downlink got it.
 */
async function summaryForConnection(peerConnectionId, failureLimit) {
	var connId = parseInt(peerConnectionId);
	var limit = failureLimit || 10;

	var counts = await postgres.query(
		'SELECT status, COUNT(*) AS cnt FROM file_distribution WHERE peer_connection_id = $1 GROUP BY status',
		[connId]
	);

	var summary = { pending: 0, sent: 0, failed: 0, skipped: 0, total: 0, failures: [] };
	for (var row of (counts || [])) {
		var n = parseInt(row.cnt) || 0;
		if (Object.prototype.hasOwnProperty.call(summary, row.status)) summary[row.status] = n;
		summary.total += n;
	}

	if (summary.failed > 0) {
		summary.failures = await postgres.query(
			`SELECT fd.id, fd.error_message, fd.attempts, fd.last_attempt,
			        fe.filename, fe.area_shortcode
			 FROM file_distribution fd
			 JOIN file_entries fe ON fe.id = fd.file_entry_id
			 WHERE fd.peer_connection_id = $1 AND fd.status = 'failed'
			 ORDER BY fd.last_attempt DESC NULLS LAST
			 LIMIT $2`,
			[connId, limit]
		) || [];
	}

	return summary;
}

// ---------------------------------------------------------------------------
// Deliverability
// ---------------------------------------------------------------------------

/**
 * Split subscribers into those a file can actually be sent to and those it
 * cannot, by whether the area carries an areatag on that peer's network.
 *
 * Pure, so the rule is testable without a database, and shared so that every
 * path which creates distribution rows applies it: an inbound TIC, a web
 * upload and a terminal upload all used to create a row for every subscriber
 * regardless.
 *
 * The outbound pass needs an areatag to build the TIC descriptor and calls
 * markFailed('No areatag mapping') when it cannot find one. Since nothing
 * retried a failed row, a peer subscribed to an area that is not mapped to
 * its network accumulated one dead row per file, for ever, silently. Not
 * creating the row is the honest answer: there is no work to do until the
 * sysop maps the area or unsubscribes the peer, and this is a configuration
 * question rather than a delivery failure.
 *
 * Undeliverable subscribers are RETURNED rather than dropped, because a
 * subscription that cannot be honoured is exactly the thing the sysop needs
 * told about.
 *
 * @param {object[]} subscribers - rows from filePeerSubscriptions.getSubscribedConnections
 * @param {object[]} mappings    - rows from fileNetworkAreas.getNetworksByFileArea
 */
function partitionByAreatag(subscribers, mappings) {
	var networksWithAreatag = new Set();
	for (var m of (mappings || [])) {
		if (m && m.areatag && m.network_id !== undefined && m.network_id !== null) {
			networksWithAreatag.add(Number(m.network_id));
		}
	}

	var deliverable = [];
	var undeliverable = [];
	for (var sub of (subscribers || [])) {
		if (!sub) continue;
		if (networksWithAreatag.has(Number(sub.network_id))) deliverable.push(sub);
		else undeliverable.push(sub);
	}

	return { deliverable: deliverable, undeliverable: undeliverable };
}

export {
	createDistributionRows,
	getPendingForConnection,
	getAllPending,
	getDistributionForEntry,
	markSent,
	markFailed,
	markSkipped,
	retryFailed,
	summaryForConnection,
	partitionByAreatag
};
