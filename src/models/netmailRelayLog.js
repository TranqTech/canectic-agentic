// netmailRelayLog.js -- what this system decided to do with netmail addressed
// to somebody else, and whether it actually got there.
//
// Relay left traces before this, but no two of them in the same place. A
// successful relay wrote an alog line and a row in pm_outbox carrying
// transport_data.relayed. A refusal wrote a different alog line. A loop wrote
// an undeliverable row. No route wrote a text dump into ftn/bad. So the
// question a sysop actually has, "did we relay what we should have, and did it
// leave", could not be answered without reading four places, three of which
// roll over or get cleaned up.
//
// One row per decision, written at the decision point, whatever the decision
// was. Refusals matter as much as relays here: a relay gate you cannot see
// refusing anything is a gate you cannot validate.
//
// Diagnostic only. Nothing reads this to make a routing decision, and a failed
// insert is swallowed rather than taking down the netmail path, on the same
// principle as mailerSessions: the record of the work must never be able to
// stop the work.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// Decisions, and what each one means.
var RELAY_SENT     = 'relayed';    // routed and queued outbound
var RELAY_REFUSED  = 'refused';    // the relay gate said no
var RELAY_LOOP     = 'loop';       // we had already handled it, per the Via chain
var RELAY_NO_ROUTE = 'no_route';   // gate allowed it, router could not place it
var RELAY_ERROR    = 'error';      // something threw

/**
 * Record one relay decision. Returns whether the row was written; callers
 * ignore it, but it makes the failure path observable to a test.
 *
 * Every field is optional because this is called from paths that have differing
 * amounts of information: a loop refusal knows the Via chain but has no route,
 * a routing error may have neither.
 */
async function logDecision(entry) {
	var e = entry || {};
	try {
		var res = await postgres.insertObject({
			received_at:   e.receivedAt || new Date(),
			msg_id:        trunc(e.msgId, 255),
			from_user:     trunc(e.fromUser, 255),
			from_address:  trunc(e.fromAddress, 64),
			to_user:       trunc(e.toUser, 255),
			to_address:    trunc(e.toAddress, 64),
			subject:       trunc(e.subject, 255),
			// Who handed us the packet, which on transit mail is not who wrote
			// the message. Keeping both is the only way to tell an uplink
			// feeding us transit traffic from a node writing it directly.
			packet_source: trunc(e.packetSource, 64),
			decision:      trunc(e.decision, 32),
			reason:        e.reason || null,
			relay_mode:    trunc(e.relayMode, 16),
			next_hop:      trunc(e.nextHop, 64),
			route_method:  trunc(e.routeMethod, 64),
			// The chain as it arrived. Stored as text rather than parsed, so a
			// hop written by another system survives verbatim for reading back.
			via_in:        e.viaIn || null,
			via_stamped:   trunc(e.viaStamped, 64),
			// The pm_outbox row this became, so delivery can be followed.
			outbound_uuid: trunc(e.outboundUuid, 64)
		}, 'netmail_relay_log');

		// insertObject reports a failed write in its return value rather than
		// throwing, so ignoring it would make a broken relay log silent, which
		// is the one thing a diagnostic log must never be.
		if (!res || !res.status) {
			alogger.writeAlog(3, 'Relay log write failed (continuing): ' +
				((res && res.errormessages || []).join('; ') || 'unknown reason'), 'yellow');
			return false;
		}
		return true;
	} catch (err) {
		// Anything insertObject does not catch itself. The relay has already
		// happened either way; losing its record must not undo it.
		alogger.writeAlog(3, 'Relay log write threw (continuing): ' + err.message, 'yellow');
		return false;
	}
}

// Column widths are what they are; a long subject must not fail the insert.
function trunc(val, len) {
	if (val === null || val === undefined) return null;
	var s = String(val);
	return s.length > len ? s.substring(0, len) : s;
}

/**
 * Recent decisions, newest first. `decision` filters to one kind.
 */
async function getRecent(limit, decision) {
	var max = parseInt(limit) || 100;
	if (decision) {
		return await postgres.query(
			'SELECT * FROM netmail_relay_log WHERE decision = $1 ORDER BY received_at DESC LIMIT $2',
			[decision, max]
		);
	}
	return await postgres.query(
		'SELECT * FROM netmail_relay_log ORDER BY received_at DESC LIMIT $1', [max]);
}

/**
 * Everything we have on one message, by MSGID. The same message can appear
 * more than once: refused on one pass and relayed on a later one after the
 * nodelist changed, or looped back to us from downstream.
 */
async function getByMsgId(msgId) {
	if (!msgId) return [];
	return await postgres.query(
		'SELECT * FROM netmail_relay_log WHERE msg_id = $1 ORDER BY received_at ASC', [msgId]);
}

/**
 * The validation query: relayed, but the outbound row it became has not gone.
 *
 * This is the failure that is otherwise invisible. Accepting a message for
 * relay and queueing it looks like success at every point the old logging
 * covered, and a message that then sits unsent in pm_outbox forever produces
 * no further event at all. Anything older than `graceHours` has missed enough
 * poll cycles to be worth looking at.
 */
async function pendingDelivery(graceHours) {
	var hours = graceHours === undefined || graceHours === null ? 6 : parseInt(graceHours);
	return await postgres.query(
		'SELECT l.*, o.sent, o.sent_at, o.queued, o.undeliverable, o.send_error ' +
		'  FROM netmail_relay_log l ' +
		'  LEFT JOIN pm_outbox o ON o.uuid = l.outbound_uuid ' +
		' WHERE l.decision = $1 ' +
		'   AND l.received_at < NOW() - ($2 || \' hours\')::interval ' +
		'   AND (o.uuid IS NULL OR o.sent IS NOT TRUE) ' +
		' ORDER BY l.received_at ASC',
		[RELAY_SENT, String(hours)]
	);
}

/**
 * Counts by decision over a window, for "is the gate doing anything".
 */
async function summarise(days) {
	var d = parseInt(days) || 7;
	return await postgres.query(
		'SELECT decision, COUNT(*)::int AS count, MAX(received_at) AS last_seen ' +
		'  FROM netmail_relay_log ' +
		' WHERE received_at > NOW() - ($1 || \' days\')::interval ' +
		' GROUP BY decision ORDER BY count DESC',
		[String(d)]
	);
}

/**
 * Which systems are sending us transit mail, and how it is being treated.
 * A peer showing nothing but refusals is either misconfigured or probing.
 */
async function byPacketSource(days) {
	var d = parseInt(days) || 7;
	return await postgres.query(
		'SELECT packet_source, decision, COUNT(*)::int AS count ' +
		'  FROM netmail_relay_log ' +
		' WHERE received_at > NOW() - ($1 || \' days\')::interval ' +
		' GROUP BY packet_source, decision ORDER BY packet_source, count DESC',
		[String(d)]
	);
}

async function purgeOld(days) {
	var d = parseInt(days) || 90;
	var res = await postgres.write(
		'DELETE FROM netmail_relay_log WHERE received_at < NOW() - ($1 || \' days\')::interval',
		[String(d)]
	);
	return res && res.rowCount ? res.rowCount : 0;
}

export {
	RELAY_SENT,
	RELAY_REFUSED,
	RELAY_LOOP,
	RELAY_NO_ROUTE,
	RELAY_ERROR,
	logDecision,
	getRecent,
	getByMsgId,
	pendingDelivery,
	summarise,
	byPacketSource,
	purgeOld
};
