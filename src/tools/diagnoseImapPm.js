#!/usr/bin/env node
// src/tools/diagnoseImapPm.js -- Diagnostic for IMAP PM rendering.
//
// Loads a specific pm_inbox row by id and prints exactly what the IMAP
// server would send for FETCH ENVELOPE + FETCH BODY[]. Use this to
// verify a row is server-renderable and inspect the raw bytes that go
// over the wire.
//
// Usage:
//   node src/tools/diagnoseImapPm.js <pm_inbox_id>
//   node src/tools/diagnoseImapPm.js --user <user_id> --trash      # list trash IDs

import * as dotenv from 'dotenv';
dotenv.config();

import * as postgres from '../middleware/db/postgres.js';
import {
	renderRfc2822, renderEnvelope, getMailboxMessages, getFullMessage, trashUid,
} from '../models/imapAdapter.js';
import { getAttachments } from '../models/pmAttachments.js';
import appConfig from '../config/appConfig.js';

async function listTrash(userId) {
	console.log('--- IMAP Trash listing for user_id=' + userId + ' ---');
	var rows = await getMailboxMessages(userId, 'Trash');
	console.log('Server returns ' + rows.length + ' rows for IMAP SELECT Trash');
	console.log('');
	for (var row of rows) {
		var uid = trashUid(parseInt(row.id), row._source || 'inbox');
		console.log('  pm_' + row._source + '.id=' + row.id + ' uid=' + uid +
			' from=' + row.from_user +
			' subject=' + JSON.stringify((row.subject || '').substring(0, 50)));
	}
}

async function diagOne(pmId) {
	var mailDomain = appConfig.get('mail_domain', 'localhost');
	console.log('--- Rendering pm_inbox.id=' + pmId + ' (mailDomain=' + mailDomain + ') ---');
	console.log('');

	var row = await postgres.queryOne('SELECT * FROM pm_inbox WHERE id = $1', [pmId]);
	if (!row) {
		console.log('Row not found.');
		return;
	}

	console.log('DB row:');
	console.log('  id:                   ' + row.id);
	console.log('  uuid:                 ' + row.uuid);
	console.log('  user_id:              ' + row.user_id);
	console.log('  msg_id:               ' + JSON.stringify(row.msg_id));
	console.log('  msg_orig_addr:        ' + JSON.stringify(row.msg_orig_addr));
	console.log('  from_user:            ' + JSON.stringify(row.from_user));
	console.log('  from_address:         ' + JSON.stringify(row.from_address));
	console.log('  to_user:              ' + JSON.stringify(row.to_user));
	console.log('  to_address:           ' + JSON.stringify(row.to_address));
	console.log('  subject:              ' + JSON.stringify(row.subject));
	console.log('  transport_type:       ' + row.transport_type);
	console.log('  deleted:              ' + row.deleted);
	console.log('  purged:               ' + row.purged);
	console.log('  read:                 ' + row.read);
	console.log('  has_attachments:      ' + row.has_attachments);
	console.log('  body_text length:     ' + (row.body_text || '').length);
	console.log('  utf8 length:          ' + (row.utf8 || '').length);
	console.log('  body_html length:     ' + (row.body_html || '').length);
	console.log('  system_time:          ' + row.system_time);
	console.log('');

	row._source = 'inbox';
	var attachments = row.has_attachments ? await getAttachments(row.uuid) : [];

	console.log('--- ENVELOPE response ---');
	try {
		var env = renderEnvelope(row, mailDomain);
		console.log(env);
	} catch (e) {
		console.log('ENVELOPE render threw: ' + e.message);
		console.log(e.stack);
	}
	console.log('');

	console.log('--- RFC2822 message (BODY[]) ---');
	try {
		var rfc = renderRfc2822(row, mailDomain, attachments);
		// Show byte length and a hex dump of the first 200 bytes
		var buf = Buffer.from(rfc, 'utf8');
		console.log('Total bytes: ' + buf.length);
		console.log('');
		console.log(rfc);
		console.log('');
		console.log('--- First 200 bytes (hex) ---');
		console.log(buf.slice(0, 200).toString('hex').replace(/(..)/g, '$1 ').trim());
	} catch (e) {
		console.log('RFC2822 render threw: ' + e.message);
		console.log(e.stack);
	}
}

async function main() {
	var args = process.argv.slice(2);

	if (args.includes('--trash')) {
		var userIdx = args.indexOf('--user');
		if (userIdx === -1 || !args[userIdx + 1]) {
			console.error('Usage: --user <user_id> --trash');
			process.exit(1);
		}
		await listTrash(parseInt(args[userIdx + 1]));
	} else {
		var pmId = parseInt(args[0]);
		if (!pmId) {
			console.error('Usage: node src/tools/diagnoseImapPm.js <pm_inbox_id>');
			console.error('   or: node src/tools/diagnoseImapPm.js --user <user_id> --trash');
			process.exit(1);
		}
		await diagOne(pmId);
	}

	postgres.pgpool.end();
}

main().catch(err => {
	console.error(err.stack || err);
	process.exit(1);
});
