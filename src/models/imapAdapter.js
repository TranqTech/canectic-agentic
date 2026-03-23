// imapAdapter.js — IMAP adapter for private messages.
//
// Maps PM records (pm_inbox, pm_outbox) to IMAP concepts:
// - RFC 2822 message rendering
// - UID mapping (PM id → IMAP UID)
// - Envelope generation for FETCH responses
// - Mailbox queries for SELECT/STATUS

import * as postgres from '../middleware/db/postgres.js';

// --- RFC 2822 rendering ---

function formatDate2822(date) {
	if (!date) return new Date().toUTCString();
	var d = (date instanceof Date) ? date : new Date(date);
	return d.toUTCString();
}

function encodeAddress(displayName, localPart, domain) {
	if (displayName) {
		return '"' + displayName.replace(/"/g, '\\"') + '" <' + localPart + '@' + domain + '>';
	}
	return localPart + '@' + domain;
}

function renderRfc2822(pmRow, mailDomain) {
	var from = encodeAddress(
		pmRow.from_user || 'Unknown',
		(pmRow.from_user || 'unknown').toLowerCase().replace(/\s+/g, '.'),
		mailDomain
	);
	var to = encodeAddress(
		pmRow.to_user || 'Unknown',
		(pmRow.to_user || 'unknown').toLowerCase().replace(/\s+/g, '.'),
		mailDomain
	);

	var source = pmRow._source || 'inbox';
	var msgId = '<pm-' + source + '-' + pmRow.id + '@' + mailDomain + '>';
	var date = formatDate2822(pmRow.system_time || pmRow.created_at);
	var subject = pmRow.subject || '(no subject)';

	var plainBody = pmRow.utf8 || pmRow.body_text || '';
	var htmlBody = pmRow.body_html || '';

	var headers = [];
	headers.push('From: ' + from);
	headers.push('To: ' + to);
	headers.push('Date: ' + date);
	headers.push('Subject: ' + subject);
	headers.push('Message-ID: ' + msgId);
	headers.push('MIME-Version: 1.0');

	// Add FTN transport headers if applicable
	if (pmRow.from_address) headers.push('X-FTN-From: ' + pmRow.from_address);
	if (pmRow.to_address) headers.push('X-FTN-To: ' + pmRow.to_address);
	if (pmRow.transport_type && pmRow.transport_type !== 'LOCAL') {
		headers.push('X-Transport: ' + pmRow.transport_type);
	}

	var body;
	if (htmlBody && plainBody) {
		var boundary = 'canectic-pm-' + (pmRow.id || Date.now());
		headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
		body = '--' + boundary + '\r\n' +
			'Content-Type: text/plain; charset=utf-8\r\n' +
			'Content-Transfer-Encoding: 8bit\r\n\r\n' +
			plainBody + '\r\n' +
			'--' + boundary + '\r\n' +
			'Content-Type: text/html; charset=utf-8\r\n' +
			'Content-Transfer-Encoding: 8bit\r\n\r\n' +
			htmlBody + '\r\n' +
			'--' + boundary + '--\r\n';
	} else {
		headers.push('Content-Type: text/plain; charset=utf-8');
		headers.push('Content-Transfer-Encoding: 8bit');
		body = plainBody;
	}

	return headers.join('\r\n') + '\r\n\r\n' + body;
}

// --- Envelope generation (for FETCH ENVELOPE) ---

function renderEnvelope(pmRow, mailDomain) {
	var date = formatDate2822(pmRow.system_time || pmRow.created_at);
	var subject = pmRow.subject || '';
	var fromLocal = (pmRow.from_user || 'unknown').toLowerCase().replace(/\s+/g, '.');
	var toLocal = (pmRow.to_user || 'unknown').toLowerCase().replace(/\s+/g, '.');
	var source = pmRow._source || 'inbox';
	var msgId = '<pm-' + source + '-' + pmRow.id + '@' + mailDomain + '>';

	// IMAP ENVELOPE format: (date subject from sender reply-to to cc bcc in-reply-to message-id)
	// Each address is ((display NIL local domain))
	var fromAddr = '(("' + (pmRow.from_user || 'Unknown').replace(/"/g, '\\"') + '" NIL "' + fromLocal + '" "' + mailDomain + '"))';
	var toAddr = '(("' + (pmRow.to_user || 'Unknown').replace(/"/g, '\\"') + '" NIL "' + toLocal + '" "' + mailDomain + '"))';

	return '("' + date + '" "' + subject.replace(/"/g, '\\"') + '" ' +
		fromAddr + ' ' + fromAddr + ' ' + fromAddr + ' ' +
		toAddr + ' NIL NIL NIL "' + msgId + '")';
}

// --- Mailbox queries ---

async function getMailboxMessages(userId, mailbox) {
	switch (mailbox) {
		case 'INBOX':
			return await postgres.query(
				"SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
				"read, transport_type, system_time, created_at " +
				"FROM pm_inbox WHERE user_id = $1 AND deleted = false " +
				"ORDER BY id ASC",
				[userId]
			);
		case 'Sent':
			return await postgres.query(
				"SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
				"transport_type, system_time, created_at " +
				"FROM pm_outbox WHERE user_id = $1 AND deleted = false " +
				"ORDER BY id ASC",
				[userId]
			);
		case 'Trash':
			// Inbox trash: even UIDs (id * 2), Outbox trash: odd UIDs (id * 2 + 1)
			var inboxTrash = await postgres.query(
				"SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
				"read, transport_type, system_time, 'inbox' AS _source " +
				"FROM pm_inbox WHERE user_id = $1 AND deleted = true " +
				"ORDER BY id ASC",
				[userId]
			);
			var outboxTrash = await postgres.query(
				"SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
				"transport_type, system_time, 'sent' AS _source " +
				"FROM pm_outbox WHERE user_id = $1 AND deleted = true " +
				"ORDER BY id ASC",
				[userId]
			);
			return (inboxTrash || []).concat(outboxTrash || []);
		default:
			return [];
	}
}

async function getFullMessage(userId, table, id) {
	var tableName = table === 'sent' ? 'pm_outbox' : 'pm_inbox';
	return await postgres.queryOne(
		"SELECT * FROM " + tableName + " WHERE id = $1 AND user_id = $2",
		[id, userId]
	);
}

async function getMailboxStatus(userId, mailbox) {
	switch (mailbox) {
		case 'INBOX': {
			var total = await postgres.queryOne(
				"SELECT COUNT(*) AS cnt FROM pm_inbox WHERE user_id = $1 AND deleted = false", [userId]);
			var unseen = await postgres.queryOne(
				"SELECT COUNT(*) AS cnt FROM pm_inbox WHERE user_id = $1 AND deleted = false AND read = false", [userId]);
			return { messages: parseInt(total.cnt), unseen: parseInt(unseen.cnt) };
		}
		case 'Sent': {
			var total = await postgres.queryOne(
				"SELECT COUNT(*) AS cnt FROM pm_outbox WHERE user_id = $1 AND deleted = false", [userId]);
			return { messages: parseInt(total.cnt), unseen: 0 };
		}
		case 'Trash': {
			var inT = await postgres.queryOne(
				"SELECT COUNT(*) AS cnt FROM pm_inbox WHERE user_id = $1 AND deleted = true", [userId]);
			var outT = await postgres.queryOne(
				"SELECT COUNT(*) AS cnt FROM pm_outbox WHERE user_id = $1 AND deleted = true", [userId]);
			return { messages: parseInt(inT.cnt) + parseInt(outT.cnt), unseen: 0 };
		}
		default:
			return { messages: 0, unseen: 0 };
	}
}

// --- UID mapping for Trash ---
// Trash interleaves inbox and outbox IDs:
//   inbox row id → UID = id * 2
//   outbox row id → UID = id * 2 + 1

function trashUid(id, source) {
	return source === 'sent' ? id * 2 + 1 : id * 2;
}

function trashUidToSource(uid) {
	return (uid % 2 === 1) ? { table: 'sent', id: (uid - 1) / 2 } : { table: 'inbox', id: uid / 2 };
}

export {
	renderRfc2822,
	renderEnvelope,
	formatDate2822,
	encodeAddress,
	getMailboxMessages,
	getFullMessage,
	getMailboxStatus,
	trashUid,
	trashUidToSource
};
