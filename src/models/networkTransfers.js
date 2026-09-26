// networkTransfers.js -- durable history of QWK and NNTP transfers, one row per
// pull or push attempt.
//
// The counterpart of mailerSessions.js for the two networks that are tossed to
// rather than dialled. Before this, a QWK pull left its detail in tosser.log
// and the worker reported every one as finished, so an FTP server timing out on
// every pull for days was indistinguishable from one with nothing waiting.
//
// A row is written for every attempt, including those that never reached the
// server (bad configuration, refused connection, timeout), since those are the
// ones a sysop is looking for. `track()` wraps the tosser functions so every
// caller gets a row: the schedule, the admin buttons, and the CLI's pull-all.
//
// Diagnostic only. Nothing reads these rows to decide anything, so a failed
// insert is logged and swallowed rather than failing the transfer it describes.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as peerConnections from './peerConnections.js';
import { classifyTransfer, SUCCESS_OUTCOMES } from '../utils/transferFormat.js';

var TABLE = 'network_transfers';
var _indexesReady = false;

async function ensureIndexes() {
	if (_indexesReady) return;
	try {
		await postgres.write(
			'CREATE INDEX IF NOT EXISTS idx_network_transfers_conn ON ' + TABLE +
			'(peer_connection_id, started_at DESC)');
		await postgres.write(
			'CREATE INDEX IF NOT EXISTS idx_network_transfers_started ON ' + TABLE +
			'(started_at DESC)');
		_indexesReady = true;
	} catch (err) {
		alogger.writeAlog(3, 'networkTransfers: index creation failed: ' + (err?.message || err), 'redbright');
	}
}

function trim(val, len) {
	if (val === null || val === undefined) return null;
	var s = String(val);
	return s.length > len ? s.substring(0, len) : s;
}

function count(v) { return parseInt(v) || 0; }

/**
 * The row for one attempt, from the connection it was for and what the tosser
 * returned. Pure; `record` writes it.
 */
function rowFor(protocol, direction, uuid, conn, result, startedAt, endedAt) {
	var r = result || {};
	var c = conn || null;
	var cd = (c && c.connection_data) || {};
	var errs = r.errormessages || [];
	return {
		protocol:           trim(protocol, 8),
		direction:          direction === 'push' ? 'push' : 'pull',
		peer_id:            c ? c.peer_id || null : null,
		peer_connection_id: c ? c.id || null : null,
		connection_uuid:    trim(uuid, 64),
		network_id:         c ? c.network_id || null : null,
		remote_host:        trim(cd.host ? cd.host + (cd.port ? ':' + cd.port : '') : null, 255),
		transport:          trim(cd.transport || (protocol === 'NNTP' ? (cd.use_tls ? 'nntps' : 'nntp') : 'ftp'), 16),
		outcome:            trim(r.outcome || classifyTransfer(r, direction), 32),
		stage:              trim(r.stage || null, 16),
		reason:             trim(errs.length ? errs.join('; ') : null, 512),
		bytes:              count(r.bytes),
		messages_in:        count(r.totalImported),
		duplicates:         count(r.totalDuplicate),
		messages_out:       count(r.totalPosted),
		skipped:            count(r.totalSkipped),
		rejected:           count(r.totalRejected),
		started_at:         startedAt,
		ended_at:           endedAt,
		duration_ms:        Math.max(0, endedAt.getTime() - startedAt.getTime()),
		created_at:         new Date()
	};
}

async function record(row) {
	try {
		await ensureIndexes();
		var result = await postgres.insertObject(row, TABLE);
		// insertObject reports failure in its result rather than throwing.
		if (!result || !result.status) {
			alogger.writeAlog(3, 'networkTransfers: failed to record ' + row.protocol + ' ' + row.direction +
				' for ' + (row.connection_uuid || '?') + ': ' + ((result && result.errormessages) || []).join(', '),
				'redbright');
			return null;
		}
		return result;
	} catch (err) {
		alogger.writeAlog(3, 'networkTransfers: failed to record ' + row.protocol + ' ' + row.direction +
			': ' + (err?.message || err), 'redbright');
		return null;
	}
}

/**
 * Run one pull or push and record what it came to.
 *
 * The result is returned unchanged apart from `outcome`, so callers see
 * exactly what they did before. A result marked `notRecorded` is not written:
 * the tosser sets it when it succeeded WITHOUT contacting anyone (nothing to
 * send, nothing mapped, a hub connection with no REP waiting). Those are not
 * transfers, and recorded as successes they made a link whose every pull was
 * timing out read "last success: just now" because its empty push had
 * "worked". An exception is recorded as a failure at whatever stage the
 * tosser had reached, then rethrown: this must not change what a caller sees
 * go wrong.
 */
async function track(protocol, direction, uuid, fn) {
	var startedAt = new Date();
	var result, thrown = null;
	try {
		result = await fn();
	} catch (err) {
		thrown = err;
		result = { status: false, errormessages: [err && err.message ? err.message : String(err)] };
	}
	var endedAt = new Date();

	if (result && !result.notRecorded) {
		result.outcome = classifyTransfer(result, direction);
		var conn = null;
		try { conn = await peerConnections.getConnectionByUUID(uuid); } catch (_) {}
		await record(rowFor(protocol, direction, uuid, conn, result, startedAt, endedAt));
	}

	if (thrown) throw thrown;
	return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function recent(limit, filter) {
	var f = filter || {};
	var where = [], params = [];
	if (f.protocol) { params.push(f.protocol); where.push('protocol = $' + params.length); }
	if (f.connectionId) { params.push(parseInt(f.connectionId)); where.push('peer_connection_id = $' + params.length); }
	if (f.failedOnly) { params.push(SUCCESS_OUTCOMES); where.push('NOT (outcome = ANY($' + params.length + '))'); }
	params.push(Math.min(parseInt(limit) || 50, 500));
	return await postgres.query(
		'SELECT * FROM ' + TABLE + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
		' ORDER BY started_at DESC LIMIT $' + params.length, params) || [];
}

/**
 * Per-connection totals over a window. Field names match mailerSessions'
 * statsByConnection so the shared summary rules apply.
 */
async function statsByConnection(windowHours) {
	var hours = parseInt(windowHours) || 24;
	return await postgres.query(
		'SELECT peer_connection_id, ' +
		'       COUNT(*)::int AS attempts, ' +
		'       COUNT(*) FILTER (WHERE outcome = ANY($1))::int AS successes, ' +
		'       COALESCE(SUM(messages_in), 0)::int AS messages_in, ' +
		'       COALESCE(SUM(duplicates), 0)::int AS duplicates, ' +
		'       COALESCE(SUM(messages_out), 0)::int AS messages_out, ' +
		'       COALESCE(SUM(bytes), 0)::bigint AS bytes ' +
		'  FROM ' + TABLE +
		' WHERE peer_connection_id IS NOT NULL ' +
		'   AND started_at > NOW() - ($2 || \' hours\')::interval ' +
		' GROUP BY peer_connection_id',
		[SUCCESS_OUTCOMES, String(hours)]) || [];
}

/**
 * Last attempt, last success and last time mail actually arrived, over all
 * history. The last of those is the one that would have shown DOVE-Net going
 * quiet: every pull can succeed for a fortnight with nothing in it.
 */
async function lastContactByConnection() {
	return await postgres.query(
		'SELECT peer_connection_id, ' +
		'       MAX(started_at) AS last_contact, ' +
		'       MAX(started_at) FILTER (WHERE outcome = ANY($1)) AS last_success, ' +
		'       MAX(started_at) FILTER (WHERE direction = \'pull\' AND messages_in > 0) AS last_mail, ' +
		'       (ARRAY_AGG(outcome ORDER BY started_at DESC))[1] AS last_outcome, ' +
		'       (ARRAY_AGG(reason ORDER BY started_at DESC))[1] AS last_reason ' +
		'  FROM ' + TABLE +
		' WHERE peer_connection_id IS NOT NULL ' +
		' GROUP BY peer_connection_id',
		[SUCCESS_OUTCOMES]) || [];
}

/**
 * Purge rows older than N days. 0 or null keeps everything.
 */
async function purgeOld(days) {
	if (!days || days <= 0) return 0;
	var cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - parseInt(days));
	var result = await postgres.pgpool.query('DELETE FROM ' + TABLE + ' WHERE started_at < $1', [cutoff]);
	return result.rowCount || 0;
}

export {
	rowFor,
	record,
	track,
	recent,
	statsByConnection,
	lastContactByConnection,
	purgeOld,
	ensureIndexes
};
