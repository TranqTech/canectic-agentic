// mailerSessions.js -- durable history of mailer sessions, one row per attempt.
//
// The mailer already knew all of this while a session was running: who
// answered, what software they run, how many files moved and how big, how long
// it took, and why it ended. None of it survived the session. The only durable
// trace was the backoff state on peer_connections.connection_data, which is
// overwritten on every attempt, so "what happened the last five times we called
// this node" had no answer short of grepping logs that may have rotated.
//
// A row is written for every attempt including the ones that never reach a
// session at all. A connection refused or a DNS failure is exactly the kind of
// thing a sysop is trying to see, and if only completed handshakes were
// recorded, the peer that is failing hardest would be the one with no history.
//
// Rows are diagnostic, not operational: nothing reads them to make a decision,
// so a failed insert is logged and swallowed rather than breaking a session.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

var TABLE = 'mailer_sessions';
var _indexesReady = false;

// Outcomes worth distinguishing. Anything else is stored as given and
// displayed as-is rather than being forced into one of these.
const OUTCOME_COMPLETE = 'complete';
const OUTCOME_CONNECT_FAILED = 'connect_failed';

/**
 * Indexes. Every query here is "latest first for one peer" or "latest first
 * across everything", so both need started_at descending.
 */
async function ensureIndexes() {
	if (_indexesReady) return;
	try {
		await postgres.write(
			'CREATE INDEX IF NOT EXISTS idx_mailer_sessions_conn ON ' + TABLE +
			'(peer_connection_id, started_at DESC)');
		await postgres.write(
			'CREATE INDEX IF NOT EXISTS idx_mailer_sessions_peer ON ' + TABLE +
			'(peer_id, started_at DESC)');
		await postgres.write(
			'CREATE INDEX IF NOT EXISTS idx_mailer_sessions_started ON ' + TABLE +
			'(started_at DESC)');
		_indexesReady = true;
	} catch (err) {
		alogger.writeAlog(3, 'mailerSessions: index creation failed: ' +
			(err?.message || err), 'redbright');
	}
}

/**
 * Record one attempt.
 *
 * @param {object} info
 *   uuid, direction ('in'|'out'), peerId, peerConnectionId, networkId,
 *   remoteAddress, remoteAddresses[], remoteHost, protocol, peerSoftware,
 *   peerSystem, peerSysop, outcome, reason, filesSent, filesReceived,
 *   bytesSent, bytesReceived, startedAt, endedAt, durationSeconds
 * @returns {object|null} the inserted row's id, or null if the write failed
 */
async function record(info) {
	var i = info || {};
	var started = i.startedAt instanceof Date ? i.startedAt
		: (i.startedAt ? new Date(i.startedAt) : new Date());
	var ended = i.endedAt instanceof Date ? i.endedAt
		: (i.endedAt ? new Date(i.endedAt) : new Date());

	// Prefer a duration the caller measured; fall back to the timestamps so a
	// row is never left claiming a session took no time at all.
	var duration = (i.durationSeconds !== undefined && i.durationSeconds !== null)
		? parseInt(i.durationSeconds) || 0
		: Math.max(0, Math.floor((ended.getTime() - started.getTime()) / 1000));

	try {
		await ensureIndexes();
		var result = await postgres.insertObject({
			uuid:               i.uuid || null,
			direction:          i.direction === 'in' ? 'in' : 'out',
			peer_id:            i.peerId || null,
			peer_connection_id: i.peerConnectionId || null,
			network_id:         i.networkId || null,
			remote_address:     trim(i.remoteAddress, 64),
			remote_addresses:   JSON.stringify(i.remoteAddresses || []),
			remote_host:        trim(i.remoteHost, 255),
			protocol:           trim(i.protocol, 16),
			peer_software:      trim(i.peerSoftware, 255),
			peer_system:        trim(i.peerSystem, 255),
			peer_sysop:         trim(i.peerSysop, 255),
			outcome:            trim(i.outcome || 'unknown', 32),
			reason:             trim(i.reason, 512),
			files_sent:         parseInt(i.filesSent) || 0,
			files_received:     parseInt(i.filesReceived) || 0,
			bytes_sent:         parseInt(i.bytesSent) || 0,
			bytes_received:     parseInt(i.bytesReceived) || 0,
			started_at:         started,
			ended_at:           ended,
			duration_seconds:   duration,
			created_at:         new Date()
		}, TABLE);
		// insertObject reports failure in the returned object rather than
		// throwing, so checking status is the only way to notice.
		if (!result || !result.status) {
			alogger.writeAlog(3, 'mailerSessions: failed to record session ' +
				(i.uuid || '?') + ': ' + ((result && result.errormessages) || []).join(', '),
				'redbright');
			return null;
		}
		return result;
	} catch (err) {
		// Diagnostics must never take a session down with them.
		alogger.writeAlog(3, 'mailerSessions: failed to record session ' +
			(i.uuid || '?') + ': ' + (err?.message || err), 'redbright');
		return null;
	}
}

function trim(val, len) {
	if (val === null || val === undefined) return null;
	var s = String(val);
	return s.length > len ? s.substring(0, len) : s;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Recent attempts for one peer connection, newest first.
 */
async function recentForConnection(connectionId, limit) {
	if (!connectionId) return [];
	return await postgres.query(
		'SELECT * FROM ' + TABLE + ' WHERE peer_connection_id = $1 ' +
		'ORDER BY started_at DESC LIMIT $2',
		[parseInt(connectionId), Math.min(parseInt(limit) || 20, 200)]
	) || [];
}

/**
 * Recent attempts for every connection belonging to one peer, newest first.
 */
async function recentForPeer(peerId, limit) {
	if (!peerId) return [];
	return await postgres.query(
		'SELECT * FROM ' + TABLE + ' WHERE peer_id = $1 ' +
		'ORDER BY started_at DESC LIMIT $2',
		[parseInt(peerId), Math.min(parseInt(limit) || 20, 200)]
	) || [];
}

/**
 * Recent attempts across all peers, newest first. The dashboard feed.
 */
async function recent(limit) {
	return await postgres.query(
		'SELECT * FROM ' + TABLE + ' ORDER BY started_at DESC LIMIT $1',
		[Math.min(parseInt(limit) || 50, 500)]
	) || [];
}

/**
 * Per-connection rollup over a window, for the dashboard table.
 *
 * Counts and byte totals come from the same scan as last_contact so the row is
 * internally consistent: a peer cannot show a successful session more recent
 * than its last contact.
 *
 * `last_success_at` is deliberately not bounded by the window. A peer that has
 * failed for a week should still show when it last worked, which is the single
 * most useful number when something has broken.
 */
async function statsByConnection(windowHours) {
	var hours = parseInt(windowHours) || 24;
	return await postgres.query(
		'SELECT peer_connection_id, ' +
		'       COUNT(*)::int AS attempts, ' +
		'       COUNT(*) FILTER (WHERE outcome = $1)::int AS successes, ' +
		'       COALESCE(SUM(files_sent), 0)::int AS files_sent, ' +
		'       COALESCE(SUM(files_received), 0)::int AS files_received, ' +
		'       COALESCE(SUM(bytes_sent), 0)::bigint AS bytes_sent, ' +
		'       COALESCE(SUM(bytes_received), 0)::bigint AS bytes_received ' +
		'  FROM ' + TABLE +
		' WHERE peer_connection_id IS NOT NULL ' +
		'   AND started_at > NOW() - ($2 || \' hours\')::interval ' +
		' GROUP BY peer_connection_id',
		[OUTCOME_COMPLETE, String(hours)]
	) || [];
}

/**
 * Last contact and last success per connection, over all history rather than
 * the dashboard window.
 */
async function lastContactByConnection() {
	return await postgres.query(
		'SELECT peer_connection_id, ' +
		'       MAX(started_at) AS last_contact, ' +
		'       MAX(started_at) FILTER (WHERE outcome = $1) AS last_success, ' +
		'       (ARRAY_AGG(outcome ORDER BY started_at DESC))[1] AS last_outcome, ' +
		'       (ARRAY_AGG(reason ORDER BY started_at DESC))[1] AS last_reason, ' +
		'       (ARRAY_AGG(peer_software ORDER BY started_at DESC) ' +
		'          FILTER (WHERE peer_software IS NOT NULL))[1] AS peer_software ' +
		'  FROM ' + TABLE +
		' WHERE peer_connection_id IS NOT NULL ' +
		' GROUP BY peer_connection_id',
		[OUTCOME_COMPLETE]
	) || [];
}

/**
 * Sessions from nodes we have no peer record for. Inbound calls from unknown
 * systems and nodelist-resolved outbound both land here, and both are worth
 * seeing: the first may be someone trying to link, the second is a route we
 * took without a configured peer.
 */
async function recentUnmatched(limit) {
	return await postgres.query(
		'SELECT * FROM ' + TABLE + ' WHERE peer_connection_id IS NULL ' +
		'ORDER BY started_at DESC LIMIT $1',
		[Math.min(parseInt(limit) || 25, 200)]
	) || [];
}

/**
 * Purge rows older than N days. 0 or null keeps everything.
 */
async function purgeOld(days) {
	if (!days || days <= 0) return 0;
	var cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - parseInt(days));
	var result = await postgres.pgpool.query(
		'DELETE FROM ' + TABLE + ' WHERE started_at < $1',
		[cutoff]
	);
	return result.rowCount || 0;
}

export {
	record,
	recentForConnection,
	recentForPeer,
	recent,
	recentUnmatched,
	statsByConnection,
	lastContactByConnection,
	purgeOld,
	ensureIndexes,
	OUTCOME_COMPLETE,
	OUTCOME_CONNECT_FAILED
};
