// badEchomail.js — Bad echomail holding table and tag tracking.
//
// Stores echomail messages received for areatags we don't carry locally.
// Tracks which areatags we've seen, when, and from whom. Messages can
// be recovered (imported to a real area) when the sysop creates the area,
// or purged after a configurable retention period.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Store a bad echomail message and update the tag tracker
// ---------------------------------------------------------------------------

async function storeBadMessage(message, connectionInfo) {
	var areatag = (message.AreaTag || '').toUpperCase().trim();
	if (!areatag) return;

	var connInfo = connectionInfo || {};

	// Store the message
	var dbObj = {
		areatag:                    areatag,
		from_user:                  message.FromUser || '',
		to_user:                    message.ToUser || '',
		subject:                    message.Subject || '',
		msg_id:                     message.MsgId || '',
		reply_to:                   message.ReplyTo || '',
		body_text:                  message.BodyText || '',
		origin_line:                message.OriginLine || '',
		seen_by:                    message.SeenBy || '',
		path:                       message.Path || '',
		kludges:                    JSON.stringify(message.OptionalAttributes || []),
		source_address:             message.Source || message.SourceAddress || ((message.SourceZone || '') + ':' + (message.SourceNet || '') + '/' + (message.SourceNode || '')) || '',
		received_from_address:      connInfo.address || '',
		received_from_connection_id: connInfo.connectionId || null,
		datetime:                   message.DateTime || '',
		received_at:                new Date()
	};

	await postgres.insertObject(dbObj, 'echomail_bad');

	// Update tag tracker (upsert)
	await postgres.write(
		`INSERT INTO bad_echo_tags (areatag, first_seen, last_seen, total_received, last_source_address, last_connection_id, active)
		 VALUES ($1, NOW(), NOW(), 1, $2, $3, true)
		 ON CONFLICT (areatag) DO UPDATE SET
		   last_seen = NOW(),
		   total_received = bad_echo_tags.total_received + 1,
		   last_source_address = $2,
		   last_connection_id = $3,
		   active = true`,
		[areatag, connInfo.address || '', connInfo.connectionId || null]
	);

	alogger.writeAlog(5, '[BadEcho] Stored message for unknown areatag: ' + areatag + ' from ' + (connInfo.address || 'unknown'), 'yellow');
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// Get all tracked bad echo tags with current message counts
async function getAllTags() {
	return await postgres.query(
		`SELECT bet.*,
		        (SELECT COUNT(*) FROM echomail_bad eb WHERE eb.areatag = bet.areatag) AS pending_count
		 FROM bad_echo_tags bet
		 ORDER BY bet.last_seen DESC`
	) || [];
}

// Get active tags only (have pending messages)
async function getActiveTags() {
	return await postgres.query(
		`SELECT bet.*,
		        (SELECT COUNT(*) FROM echomail_bad eb WHERE eb.areatag = bet.areatag) AS pending_count
		 FROM bad_echo_tags bet
		 WHERE bet.active = true
		 ORDER BY bet.last_seen DESC`
	) || [];
}

// Get messages for a specific areatag
async function getMessagesForTag(areatag, limit) {
	return await postgres.query(
		'SELECT * FROM echomail_bad WHERE areatag = $1 ORDER BY received_at DESC LIMIT $2',
		[areatag.toUpperCase().trim(), limit || 100]
	) || [];
}

// Get count of messages for a specific areatag
async function getCountForTag(areatag) {
	var row = await postgres.queryOne(
		'SELECT COUNT(*) AS cnt FROM echomail_bad WHERE areatag = $1',
		[areatag.toUpperCase().trim()]
	);
	return row ? parseInt(row.cnt) : 0;
}

// ---------------------------------------------------------------------------
// Recovery — import bad echomail into a real area
// ---------------------------------------------------------------------------

async function recoverMessages(areatag, echomail) {
	var tag = areatag.toUpperCase().trim();
	var messages = await postgres.query(
		'SELECT * FROM echomail_bad WHERE areatag = $1 ORDER BY received_at ASC',
		[tag]
	);

	if (!messages || messages.length === 0) return { recovered: 0 };

	var recovered = 0;
	var dupes = 0;

	for (var msg of messages) {
		// Reconstruct an FTN-style message object for handleInboundEchoMessage
		var kludges = [];
		try { kludges = JSON.parse(msg.kludges || '[]'); } catch (_) {}

		var ftnMsg = {
			Type: 'Echomail',
			AreaTag: msg.areatag,
			FromUser: msg.from_user,
			ToUser: msg.to_user,
			Subject: msg.subject,
			MsgId: msg.msg_id,
			ReplyTo: msg.reply_to,
			BodyText: msg.body_text,
			OriginLine: msg.origin_line,
			SeenBy: msg.seen_by,
			Path: msg.path,
			DateTime: msg.datetime,
			OptionalAttributes: kludges,
			SourceZone: 0, SourceNet: 0, SourceNode: 0,
			DestinationZone: 0, DestinationNet: 0, DestinationNode: 0
		};

		// Parse source address back
		if (msg.source_address) {
			var parts = msg.source_address.split(':');
			if (parts.length === 2) {
				ftnMsg.SourceZone = parseInt(parts[0]) || 0;
				var nn = parts[1].split('/');
				ftnMsg.SourceNet = parseInt(nn[0]) || 0;
				ftnMsg.SourceNode = parseInt(nn[1]) || 0;
			}
		}

		var result = await echomail.handleInboundEchoMessage(ftnMsg);
		if (result.status) {
			if (result.duplicate) {
				dupes++;
			} else if (result.imported) {
				recovered++;
			}
			// Remove from bad table
			await postgres.write('DELETE FROM echomail_bad WHERE id = $1', [msg.id]);
		}
	}

	// Update tag tracker
	var remaining = await getCountForTag(tag);
	if (remaining === 0) {
		await postgres.write(
			'UPDATE bad_echo_tags SET active = false WHERE areatag = $1',
			[tag]
		);
	}

	alogger.writeAlog(3,
		'[BadEcho] Recovery for ' + tag + ': ' + recovered + ' imported, ' + dupes + ' dupes, ' + remaining + ' remaining',
		recovered > 0 ? 'greenbright' : 'yellow'
	);

	return { recovered, dupes, remaining };
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

// Purge messages older than N days
async function purgeOld(days) {
	if (!days || days <= 0) return 0;
	var cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - days);

	var result = await postgres.pgpool.query(
		'DELETE FROM echomail_bad WHERE received_at < $1',
		[cutoff]
	);
	var purged = result.rowCount || 0;

	if (purged > 0) {
		// Deactivate tags with no remaining messages
		await postgres.write(
			`UPDATE bad_echo_tags SET active = false
			 WHERE active = true
			   AND NOT EXISTS (SELECT 1 FROM echomail_bad eb WHERE eb.areatag = bad_echo_tags.areatag)`
		);
		alogger.writeAlog(3, '[BadEcho] Purged ' + purged + ' message(s) older than ' + days + ' days', 'cyan');
	}
	return purged;
}

// Purge all messages for a specific areatag
async function purgeTag(areatag) {
	var tag = areatag.toUpperCase().trim();
	var result = await postgres.pgpool.query(
		'DELETE FROM echomail_bad WHERE areatag = $1', [tag]
	);
	var purged = result.rowCount || 0;

	await postgres.write(
		'UPDATE bad_echo_tags SET active = false WHERE areatag = $1', [tag]
	);

	alogger.writeAlog(5, '[BadEcho] Purged ' + purged + ' message(s) for tag: ' + tag, 'cyan');
	return purged;
}

export {
	storeBadMessage,
	getAllTags,
	getActiveTags,
	getMessagesForTag,
	getCountForTag,
	recoverMessages,
	purgeOld,
	purgeTag
};
