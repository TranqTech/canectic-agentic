// smbImport.js - Import Synchronet Message Base (SMB) files into a message area.
//
// Reads .shd/.sdt/.sid files, converts to our echomail format, and inserts
// into the target area's backing tables with dupe checking and threading.

import { iterateSMB, previewSMB, statSMB } from '../utils/smbParser.js';
import {
	resolveImportTarget,
	importParsedMessages,
	stripNulls,
	failResult,
} from './msgBaseImport.js';
import * as ftnUtils from '../utils/ftnUtils.js';
import { v4 as uuidv4 } from 'uuid';
import * as alogger from '../utils/alogger.js';

// --- Convert SMB message to our DB format ---

function smbToDbObj(msg, target) {
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

	// Store MSGID in the tuple format the rest of the platform uses: msg_id
	// holds the serial, msg_orig_addr holds the origin address. Matching
	// ftnToDb here is what lets dupe detection recognise the same message
	// arriving later over FTN.
	var msgidSplit = ftnUtils.splitFullMsgid(hdr.msgId || '');
	var replySplit = ftnUtils.splitFullMsgid(hdr.replyId || '');

	return {
		user_id: 0,
		uuid: uuidv4(),
		msg_id: stripNulls(msgidSplit.msg_id || ('smb-' + hdr.number)),
		msg_orig_addr: stripNulls(msgidSplit.msg_orig_addr || ''),
		reply_to: stripNulls(replySplit.msg_id || ''),
		reply_orig_addr: stripNulls(replySplit.msg_orig_addr || ''),
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
		// `imported` is what stops getOutboundForConnection echoing this
		// history back out to peers. source_network_id stays for bookkeeping
		// but is no longer used for outbound suppression: it is stamped on all
		// inbound echomail, so filtering on it stopped a hub forwarding at all.
		imported: true,
		source_network_id: (target && target.networkId) || null,
		system_time: systemTime,
		created_at: currtime,
		updated_at: null,
	};
}

// --- Import SMB files into a message area ---
// Returns { status, imported, duplicates, skipped, errors, total, lastId }

async function importSMB(shdPath, sdtPath, sidPath, areaShortcode, options) {
	var opts = options || {};

	// Validate area before parsing so a bad shortcode fails without reading files
	var target = await resolveImportTarget(areaShortcode, opts);
	if (!target) {
		return failResult(['Message area not found: ' + areaShortcode]);
	}

	alogger.writeAlog(3, '[SMB Import] Reading ' + shdPath, 'cyan');

	// Fail on an unreadable base before touching the database. The cheap stat
	// also gives progress logging a denominator.
	var stat = statSMB(shdPath);
	if (!stat.status) {
		return failResult([stat.error]);
	}

	// Streamed, not collected: the importer sees one message at a time so a
	// large base cannot exhaust the heap.
	var source;
	try {
		source = iterateSMB(shdPath, sdtPath, sidPath);
	} catch (err) {
		return failResult([err.message]);
	}

	return await importParsedMessages(source, target, smbToDbObj, {
		label: opts.label || 'SMB Import',
		seal: opts.seal,
		expectedTotal: stat.totalMsgs,
	});
}

export {
	importSMB,
	previewSMB,
	smbToDbObj,
	importParsedMessages,
	resolveImportTarget,
};
