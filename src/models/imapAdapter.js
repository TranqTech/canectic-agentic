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

// Build an email address encoding the network transport in the domain.
// The pseudo-TLD indicates transport type, the domain encodes the address.
//
//   FTN  "1:134/101"           → local: "kostie",  domain: "1.134.101.ftn"
//   FTN  "1:134/101.2"         → local: "kostie",  domain: "1.134.101.2.ftn"
//   FTN  "1:134/101@fidonet"   → local: "kostie",  domain: "1.134.101-fidonet.ftn"
//   FTN  "1:134/101.2@fidonet" → local: "kostie",  domain: "1.134.101.2-fidonet.ftn"
//   QWK  "UNDRMINE"            → local: "kostie",  domain: "undrmine.qwk"
//   LOCAL / empty               → local: "kostie",  domain: mailDomain
//
function networkEmailAddress(username, networkAddress, transportType, mailDomain) {
	var local = (username || 'unknown').toLowerCase().replace(/\s+/g, '.');
	if (!networkAddress || !transportType || transportType === 'LOCAL') {
		return { local: local, domain: mailDomain };
	}

	if (transportType === 'FTN') {
		var addr = networkAddress;
		var ftnDomain = '';
		var atIdx = addr.indexOf('@');
		if (atIdx >= 0) {
			ftnDomain = addr.substring(atIdx + 1);
			addr = addr.substring(0, atIdx);
		}
		// zone:net/node[.point] → zone.net.node[.point]
		var encoded = addr.replace(/:/g, '.').replace(/\//g, '.');
		// 5D domain appended as trailing dot-label (always non-numeric, so unambiguous)
		if (ftnDomain) encoded += '.' + ftnDomain.toLowerCase();
		return { local: local, domain: encoded + '.ftn' };
	}

	if (transportType === 'QWK') {
		return { local: local, domain: networkAddress.toLowerCase() + '.qwk' };
	}

	if (transportType === 'EMAIL' && networkAddress) {
		// networkAddress is a real email address — split at @
		var emailAt = networkAddress.indexOf('@');
		if (emailAt >= 0) {
			return { local: networkAddress.substring(0, emailAt), domain: networkAddress.substring(emailAt + 1) };
		}
		// Bare address (no @) — use as local part with mailDomain
		return { local: networkAddress, domain: mailDomain };
	}

	// Other transports — fall back to mailDomain
	return { local: local, domain: mailDomain };
}

// Build a display name that includes the network address for non-local messages.
//   FTN:   "kostie (1:134/101)"
//   QWK:   "kostie (UNDRMINE)"
//   LOCAL:  "kostie"
function networkDisplayName(username, networkAddress, transportType) {
	var name = username || 'Unknown';
	if (!networkAddress || !transportType || transportType === 'LOCAL') return name;
	if (transportType === 'EMAIL') {
		return name + ' <' + networkAddress + '>';
	}
	return name + ' (' + networkAddress + ')';
}

function renderRfc2822(pmRow, mailDomain) {
	var fromAddr = networkEmailAddress(pmRow.from_user, pmRow.from_address, pmRow.transport_type, mailDomain);
	var toAddr = networkEmailAddress(pmRow.to_user, pmRow.to_address, pmRow.transport_type, mailDomain);
	var fromName = networkDisplayName(pmRow.from_user, pmRow.from_address, pmRow.transport_type);
	var toName = networkDisplayName(pmRow.to_user, pmRow.to_address, pmRow.transport_type);
	var from = encodeAddress(fromName, fromAddr.local, fromAddr.domain);
	var to = encodeAddress(toName, toAddr.local, toAddr.domain);

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
	var fromEmail = networkEmailAddress(pmRow.from_user, pmRow.from_address, pmRow.transport_type, mailDomain);
	var toEmail = networkEmailAddress(pmRow.to_user, pmRow.to_address, pmRow.transport_type, mailDomain);
	var source = pmRow._source || 'inbox';
	var msgId = '<pm-' + source + '-' + pmRow.id + '@' + mailDomain + '>';

	// IMAP ENVELOPE format: (date subject from sender reply-to to cc bcc in-reply-to message-id)
	// Each address is ((display NIL local domain))
	var fromName = networkDisplayName(pmRow.from_user, pmRow.from_address, pmRow.transport_type);
	var toName = networkDisplayName(pmRow.to_user, pmRow.to_address, pmRow.transport_type);
	var fromAddr = '(("' + fromName.replace(/"/g, '\\"') + '" NIL "' + fromEmail.local + '" "' + fromEmail.domain + '"))';
	var toAddr = '(("' + toName.replace(/"/g, '\\"') + '" NIL "' + toEmail.local + '" "' + toEmail.domain + '"))';

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
