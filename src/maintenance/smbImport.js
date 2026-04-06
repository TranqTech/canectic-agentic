// smbImport.js - Import Synchronet Message Base (SMB) files into a message area.
//
// Reads .shd/.sdt/.sid files, converts to our echomail format, and inserts
// into the target area's backing tables with dupe checking and threading.

import { parseSMB, previewSMB } from '../utils/smbParser.js';
import * as postgres from '../middleware/db/postgres.js';
import * as echomail from '../models/echomail.js';
import * as msgAreas from '../models/msgAreas.js';
import { formatBodyHtml } from '../utils/terminalText.js';
import { cp437ToUtf8 as convertCP437toUTF8 } from '../utils/codepageConversions.js';
import { v4 as uuidv4 } from 'uuid';
import * as alogger from '../utils/alogger.js';

// --- Helpers ---

// Strip null bytes (0x00) from strings — PostgreSQL rejects them in text columns.
// SMB data files use nulls as padding/terminators.
function stripNulls(str) {
	if (typeof str !== 'string') return str;
	return str.replace(/\x00/g, '');
}

// --- Convert SMB message to our DB format ---

function smbToDbObj(msg) {
	var hdr = msg.header;
	var currtime = new Date();

	// Convert Unix timestamp to JS Date
	var systemTime = hdr.whenWritten.time > 0
		? new Date(hdr.whenWritten.time * 1000)
		: currtime;

	// Build body text - combine body and tail (origin/tearline)
	var rawBody = stripNulls(msg.bodyText || '');
	var rawTail = stripNulls(msg.tailText || '');
	var fullText = rawBody + (rawTail ? '\r\n' + rawTail : '');

	// The SMB parser now returns utf8 strings directly.
	// Use the text as-is for the utf8 column.
	var utf8Text = fullText;

	// Extract origin line from tail or body
	var originLine = '';
	var originMatch = fullText.match(/\* Origin: (.+)/);
	if (originMatch) {
		originLine = originMatch[1].trim();
	}

	// Build FTN address components from sender address
	var sourceZone = null;
	var sourceNet = null;
	var sourceNode = null;
	if (hdr.senderAddr) {
		var addrParts = hdr.senderAddr.match(/(\d+):(\d+)\/(\d+)/);
		if (addrParts) {
			sourceZone = parseInt(addrParts[1]);
			sourceNet = parseInt(addrParts[2]);
			sourceNode = parseInt(addrParts[3]);
		}
	}

	var destZone = null;
	var destNet = null;
	var destNode = null;
	if (hdr.recipientAddr) {
		var destParts = hdr.recipientAddr.match(/(\d+):(\d+)\/(\d+)/);
		if (destParts) {
			destZone = parseInt(destParts[1]);
			destNet = parseInt(destParts[2]);
			destNode = parseInt(destParts[3]);
		}
	}

	return {
		user_id: 0,
		uuid: uuidv4(),
		msg_id: stripNulls(hdr.msgId || ('smb-' + hdr.number)),
		reply_to: stripNulls(hdr.replyId || null),
		tosser_id: stripNulls(hdr.fidoPid || 'SMB Import'),
		source: stripNulls(hdr.senderAddr || ''),
		domain: '',
		destination: stripNulls(hdr.recipientAddr || ''),
		source_zone: sourceZone,
		source_net: sourceNet,
		source_node: sourceNode,
		destination_zone: destZone,
		destination_net: destNet,
		destination_node: destNode,
		to_user: stripNulls(hdr.recipient || 'All'),
		from_user: stripNulls(hdr.sender || 'Unknown'),
		subject: stripNulls(hdr.subject || '(no subject)'),
		body_text: fullText,
		utf8: utf8Text,
		origin_line: stripNulls(originLine),
		raw_text: fullText,
		datetime_string: '',
		tz_utc: '',
		seen_by: stripNulls(hdr.fidoSeenBy || ''),
		path: stripNulls(hdr.fidoPath || ''),
		system_time: systemTime,
		created_at: currtime,
		updated_at: null,
	};
}

// --- Import SMB files into a message area ---
// Returns { status, imported, duplicates, errors, messages[] }

async function importSMB(shdPath, sdtPath, sidPath, areaShortcode, options) {
	var opts = options || {};
	var result = {
		status: false,
		imported: 0,
		duplicates: 0,
		skipped: 0,
		errors: [],
		total: 0,
	};

	// Validate area exists
	var area = await msgAreas.getAreaByShortcode(areaShortcode);
	if (!area) {
		result.errors.push('Message area not found: ' + areaShortcode);
		return result;
	}

	var shorty = areaShortcode.toLowerCase();
	var msgtable = 'mb_' + shorty + '_msgs';
	var threadtable = 'mb_' + shorty + '_threads';

	// Parse SMB files
	alogger.writeAlog(3, '[SMB Import] Parsing ' + shdPath, 'cyan');
	var parsed = parseSMB(shdPath, sdtPath, sidPath);
	if (!parsed.status) {
		result.errors.push(parsed.error);
		return result;
	}

	result.total = parsed.messages.length;
	alogger.writeAlog(3, '[SMB Import] Found ' + result.total + ' messages', 'cyan');

	// Import each message
	for (var i = 0; i < parsed.messages.length; i++) {
		var msg = parsed.messages[i];

		try {
			var dbObj = smbToDbObj(msg);

			// Dupe check
			var isUnique = await postgres.checkValueUnique('msg_id', dbObj.msg_id, msgtable);
			if (!isUnique) {
				result.duplicates++;
				continue;
			}

			// Generate body_html
			var displayText = dbObj.utf8 || dbObj.body_text || '';
			try {
				dbObj.body_html = await formatBodyHtml(displayText);
			} catch (e) {
				dbObj.body_html = null;
			}

			// Thread the message
			dbObj = await echomail.threadMessage(dbObj, msgtable, threadtable, shorty);

			// Insert
			var dbres = await postgres.insertObject(dbObj, msgtable);
			if (dbres.status) {
				result.imported++;
			} else {
				result.errors.push('Insert failed for msg #' + (msg.header.number || i) + ': ' + (dbres.errormessages || []).join(', '));
				result.skipped++;
			}
		} catch (err) {
			result.errors.push('Error on msg #' + (msg.header.number || i) + ': ' + err.message);
			result.skipped++;
		}

		// Progress logging every 100 messages
		if ((i + 1) % 100 === 0) {
			alogger.writeAlog(4, '[SMB Import] Progress: ' + (i + 1) + '/' + result.total, 'cyan');
		}
	}

	// Finalize threads
	var updatearray = echomail.drainThreadUpdateArray();
	if (updatearray.length > 0) {
		await echomail.updateThreadArray(updatearray);
	}

	// Update area stats
	await msgAreas.updateAreaStats();

	result.status = true;
	alogger.writeAlog(2, '[SMB Import] Complete: ' + result.imported + ' imported, ' +
		result.duplicates + ' dupes, ' + result.skipped + ' skipped (of ' + result.total + ')', 'greenbright');

	return result;
}

export { importSMB, previewSMB, smbToDbObj };
