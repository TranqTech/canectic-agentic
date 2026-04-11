// qwkUser.js — User-facing QWK packet generation and REP import.
//
// Generates personal .qwk packets for offline reading and imports .rep
// packets containing user replies. Uses the low-level packet building
// functions from qwkPacketBuilder.js and the standard posting path from
// messages.js.
//
// Conference 0 = private messages (PMs).
// Conference N = message area with message_areas.qwk_conf_number = N.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as msgAreas from './msgAreas.js';
import * as userMsgPointers from './userMsgPointers.js';
import * as userAreaSubs from './userAreaSubs.js';
import * as privateMessages from './privateMessages.js';
import * as messages from './messages.js';
import { checkAreaReadAccess, checkAreaPostAccess } from '../utils/areaAccess.js';
import {
	buildControlDat,
	buildMessagesDat,
	buildHeadersDatText,
	assembleQwkPacket
} from './qwkPacketBuilder.js';
import {
	parseMessagesDAT,
	parseHeadersDat,
	applyHeadersDat,
	unzipQwkPacket
} from './qwkClasses.js';
import appConfig from '../config/appConfig.js';

// ---------------------------------------------------------------------------
// QWK BBS ID resolution
// ---------------------------------------------------------------------------

function getQwkBbsId() {
	var configured = (appConfig.get('qwk_bbsid', '') || '').trim().toUpperCase();
	if (configured) return configured.substring(0, 8);

	var boardname = (appConfig.get('boardname', 'BBS') || '').trim().toUpperCase();
	// Strip non-alphanumeric for a safe BBS ID
	var safe = boardname.replace(/[^A-Z0-9]/g, '');
	return (safe || 'BBS').substring(0, 8);
}

// ---------------------------------------------------------------------------
// QWK Packet Generation
// ---------------------------------------------------------------------------

// Build a personal QWK packet for a user.
// Returns { status, qwkPath, totalMessages, areaCount, errormessages }
async function buildQwkForUser(userId) {
	var returnObj = {
		status: false,
		qwkPath: null,
		totalMessages: 0,
		areaCount: 0,
		errormessages: []
	};

	if (!appConfig.getBoolean('qwk_enabled', true)) {
		returnObj.errormessages.push('QWK downloads are disabled');
		return returnObj;
	}

	// Load user record
	var user = await postgres.queryOne(
		"SELECT id, username, security, permissionflags, restrictionflags FROM users WHERE id = $1",
		[userId]
	);
	if (!user) {
		returnObj.errormessages.push('User not found');
		return returnObj;
	}

	var bbsId = getQwkBbsId();
	var maxPerArea = appConfig.getNumber('qwk_max_msgs_per_area', 500);

	// Get all active areas with their groups (for access checking)
	var allAreas = await postgres.query(
		`SELECT ma.*, mg.read_security AS group_read_security
		 FROM message_areas ma
		 JOIN message_groups mg ON mg.id = ma.group_id
		 WHERE ma.active = true AND ma.qwk_conf_number IS NOT NULL
		 ORDER BY ma.qwk_conf_number ASC`,
		[]
	);
	if (!allAreas) allAreas = [];

	// Filter by read access
	var accessibleAreas = allAreas.filter(function(area) {
		return checkAreaReadAccess(user, area);
	});

	// Filter by subscription
	var areasWithDefaults = accessibleAreas.map(function(a) {
		return { shortcode: a.shortcode, newscan_default: a.newscan_default };
	});
	var subscribedShortcodes = await userAreaSubs.getSubscribedAreas(userId, areasWithDefaults);
	var subscribedSet = new Set(subscribedShortcodes);

	var targetAreas = accessibleAreas.filter(function(a) {
		return subscribedSet.has(a.shortcode);
	});

	// Gather messages per area
	var conferences = [];
	var messageItems = [];
	var pointerUpdates = []; // { shortcode, highestMsgId }

	for (var area of targetAreas) {
		var pointer = await userMsgPointers.getPointer(userId, area.shortcode);
		var scanPtr = pointer.scan_pointer || 0;
		var shorty = area.shortcode.toLowerCase().trim();
		var msgtable = 'mb_' + shorty + '_msgs';

		var msgs = await postgres.query(
			'SELECT * FROM ' + msgtable + ' WHERE id > $1 ORDER BY id ASC LIMIT $2',
			[scanPtr, maxPerArea]
		);

		if (!msgs || msgs.length === 0) continue;

		conferences.push({
			number: area.qwk_conf_number,
			name: (area.name || area.shortcode).substring(0, 10)
		});

		var highestId = 0;
		for (var msg of msgs) {
			messageItems.push({
				msg: msg,
				conferenceNum: area.qwk_conf_number
			});
			if (msg.id > highestId) highestId = msg.id;
		}

		pointerUpdates.push({ shortcode: area.shortcode, highestMsgId: highestId });
	}

	// Gather unread PMs (conference 0). Excludes purged rows tagged for
	// background hard-delete by the trash purge flow.
	var unreadPMs = await postgres.query(
		"SELECT * FROM pm_inbox WHERE user_id = $1 AND read = false AND deleted = false AND purged IS NOT TRUE ORDER BY created_at ASC",
		[userId]
	);
	var pmIds = [];

	if (unreadPMs && unreadPMs.length > 0) {
		for (var pm of unreadPMs) {
			messageItems.push({
				msg: {
					id: pm.id,
					from_user: pm.from_user || '',
					to_user: pm.to_user || user.username,
					subject: pm.subject || '',
					body_text: pm.utf8 || pm.body_text || '',
					utf8: pm.utf8 ? pm.utf8 : null,
					system_time: pm.system_time || pm.created_at || new Date(),
					msg_id: pm.msg_id || '',
					reply_to: null
				},
				conferenceNum: 0,
				isPrivate: true
			});
			pmIds.push(pm.id);
		}
	}

	if (messageItems.length === 0) {
		returnObj.status = true;
		return returnObj;
	}

	// Build packet components
	var controlDat = buildControlDat({
		bbsName:       appConfig.get('boardname', 'Canectic BBS'),
		bbsLocation:   appConfig.get('boardlocation', ''),
		bbsPhone:      appConfig.get('boardphone', 'N/A'),
		sysopName:     appConfig.get('sysopname', 'Sysop'),
		qwkId:         bbsId,
		recipientName: user.username,
		conferences:   conferences,
		totalMessages: messageItems.length
	});

	var msgResult = buildMessagesDat(messageItems, bbsId);

	var headersDat = buildHeadersDatText(
		messageItems, msgResult.itemOffsets, bbsId
	);

	// Assemble packet in temp directory
	var tmpDir = path.join(os.tmpdir(), 'canectic-qwk-' + userId + '-' + Date.now());

	var qwkPath;
	try {
		qwkPath = assembleQwkPacket({
			packetName:  bbsId,
			tmpDir:      tmpDir,
			controlDat:  controlDat,
			messagesDat: msgResult.buffer,
			headersDat:  headersDat
		});
	} catch (err) {
		returnObj.errormessages.push('Failed to assemble QWK packet: ' + err.message);
		// Clean up temp dir
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
		return returnObj;
	}

	// Advance area pointers
	for (var pu of pointerUpdates) {
		await userMsgPointers.advancePointer(userId, pu.shortcode, pu.highestMsgId);
	}

	// Mark PMs as read
	for (var pmId of pmIds) {
		await postgres.write(
			"UPDATE pm_inbox SET read = true, read_at = NOW(), updated_at = NOW() WHERE id = $1",
			[pmId]
		);
	}

	returnObj.status = true;
	returnObj.qwkPath = qwkPath;
	returnObj.totalMessages = messageItems.length;
	returnObj.areaCount = conferences.length;

	alogger.writeAlog(5,
		'buildQwkForUser: built ' + path.basename(qwkPath) + ' for ' + user.username +
		' — ' + messageItems.length + ' msg(s) across ' + conferences.length + ' area(s)',
		'greenbright'
	);

	return returnObj;
}

// ---------------------------------------------------------------------------
// REP Import
// ---------------------------------------------------------------------------

// Import a REP packet uploaded by a user.
// Returns { status, totalPosted, totalErrors, details[], errormessages }
async function importRepForUser(userId, repFilePath) {
	var returnObj = {
		status: false,
		totalPosted: 0,
		totalErrors: 0,
		details: [],
		errormessages: []
	};

	if (!appConfig.getBoolean('qwk_enabled', true)) {
		returnObj.errormessages.push('QWK uploads are disabled');
		return returnObj;
	}

	// Load user record
	var user = await postgres.queryOne(
		"SELECT id, username, fullname, security, permissionflags, restrictionflags FROM users WHERE id = $1",
		[userId]
	);
	if (!user) {
		returnObj.errormessages.push('User not found');
		return returnObj;
	}

	var bbsId = getQwkBbsId();
	var extractDir = repFilePath + '_extracted';

	try {
		unzipQwkPacket(repFilePath, extractDir);
	} catch (err) {
		returnObj.errormessages.push('Failed to extract REP packet: ' + err.message);
		return returnObj;
	}

	// Find message file: <BBSID>.MSG or MESSAGES.DAT
	var extractedFiles = fs.readdirSync(extractDir);
	var messagesFile = extractedFiles.find(function(f) {
		return f.toUpperCase() === bbsId + '.MSG';
	});
	if (!messagesFile) {
		messagesFile = extractedFiles.find(function(f) {
			return f.toUpperCase() === 'MESSAGES.DAT' || f.toUpperCase().endsWith('.MSG');
		});
	}

	if (!messagesFile) {
		returnObj.errormessages.push('No message data found in REP packet');
		fs.rmSync(extractDir, { recursive: true, force: true });
		return returnObj;
	}

	var messagesBuf = fs.readFileSync(path.join(extractDir, messagesFile));
	var messages = parseMessagesDAT(messagesBuf);

	// Parse HEADERS.DAT if present
	var headersFile = extractedFiles.find(function(f) {
		return f.toUpperCase() === 'HEADERS.DAT';
	});
	if (headersFile) {
		try {
			var headersText = fs.readFileSync(path.join(extractDir, headersFile), 'utf8');
			var headersDat = parseHeadersDat(headersText);
			applyHeadersDat(messages, headersDat);
		} catch (hdrErr) {
			alogger.writeAlog(3,
				'importRepForUser: HEADERS.DAT parse error: ' + hdrErr.message + ' — continuing without',
				'yellow'
			);
		}
	}

	alogger.writeAlog(5,
		'importRepForUser: ' + messages.length + ' message(s) from ' + user.username,
		'cyan'
	);

	// Process each message
	for (var msg of messages) {
		if (!msg.isLive) continue;

		// Conference 0 = PM
		if (msg.conferenceNum === 0) {
			var pmResult = await importRepPM(user, msg);
			if (pmResult.status) {
				returnObj.totalPosted++;
				returnObj.details.push('PM to ' + (msg.to || 'Unknown') + ': delivered');
			} else {
				returnObj.totalErrors++;
				returnObj.details.push('PM to ' + (msg.to || 'Unknown') + ': ' + pmResult.error);
			}
			continue;
		}

		// Area post — resolve conference number
		var area = await msgAreas.getAreaByConfNumber(msg.conferenceNum);
		if (!area) {
			returnObj.totalErrors++;
			returnObj.details.push('Conference ' + msg.conferenceNum + ': unknown area');
			continue;
		}

		// Check write access
		if (!checkAreaPostAccess(user, area)) {
			returnObj.totalErrors++;
			returnObj.details.push(area.shortcode + ': access denied');
			continue;
		}

		var postResult = await importRepMessage(user, msg, area);
		if (postResult.status) {
			returnObj.totalPosted++;
			returnObj.details.push(area.shortcode + ': posted "' + (msg.subject || '').substring(0, 40) + '"');
		} else {
			returnObj.totalErrors++;
			returnObj.details.push(area.shortcode + ': ' + postResult.error);
		}
	}

	// Clean up
	fs.rmSync(extractDir, { recursive: true, force: true });

	returnObj.status = true;

	alogger.writeAlog(5,
		'importRepForUser: ' + user.username + ' — posted=' + returnObj.totalPosted +
		' errors=' + returnObj.totalErrors,
		'greenbright'
	);

	return returnObj;
}

// ---------------------------------------------------------------------------
// REP import helpers
// ---------------------------------------------------------------------------

// Import a conference 0 message as a PM.
async function importRepPM(user, msg) {
	var toUser = (msg.to || '').trim();
	if (!toUser) return { status: false, error: 'No recipient' };

	var resolution = await privateMessages.resolveRecipient(toUser);
	if (!resolution.resolved) {
		return { status: false, error: 'Recipient "' + toUser + '" not found' };
	}

	var bodyText = msg.utf8 || msg.bodyText || '';
	var messageObj = {
		user_id: resolution.userId,
		from_user: user.username,
		to_user: resolution.username,
		from_address: user.username,
		to_address: resolution.username,
		subject: msg.subject || '',
		body_text: bodyText,
		utf8: bodyText,
		raw_text: bodyText,
		transport_type: 'LOCAL',
		transport_data: { source: 'QWK REP' },
		system_time: new Date()
	};

	var result = await privateMessages.deliverMessage(messageObj);
	if (!result.status) {
		return { status: false, error: (result.errormessages || []).join(', ') };
	}

	return { status: true };
}

// Import an area message from a REP packet.
async function importRepMessage(user, msg, area) {
	var bodyText = msg.utf8 || msg.bodyText || '';
	var subject = (msg.subject || '').trim();
	if (!subject) return { status: false, error: 'Empty subject' };
	if (!bodyText.trim()) return { status: false, error: 'Empty message body' };

	// Determine post-as name from area setting
	var fromName = user.username;
	if (area.post_as === 'realname' && user.fullname) {
		fromName = user.fullname;
	}

	// Determine if this is a reply or a new thread.
	// Check for "Re:" prefix or HEADERS.DAT Reply-ID.
	var isReply = false;
	var replyId = (msg.kludges && msg.kludges.REPLY) || null;
	var subjectUpper = subject.toUpperCase();

	if (replyId || subjectUpper.startsWith('RE:')) {
		isReply = true;
	}

	var formObj = {
		from_user: fromName,
		to_user: msg.to || 'All',
		subject: subject,
		body_text: bodyText,
		user_id: user.id
	};

	if (isReply) {
		// Try to find the parent thread
		var shorty = area.shortcode.toLowerCase().trim();
		var threadtable = 'mb_' + shorty + '_threads';
		var msgtable = 'mb_' + shorty + '_msgs';
		var thread = null;

		// First try Reply-ID from HEADERS.DAT
		if (replyId) {
			var parentMsg = await postgres.queryOne(
				'SELECT thread_id FROM ' + msgtable + ' WHERE msg_id = $1',
				[replyId]
			);
			if (parentMsg && parentMsg.thread_id) {
				thread = await postgres.queryOne(
					'SELECT * FROM ' + threadtable + ' WHERE id = $1',
					[parentMsg.thread_id]
				);
			}
		}

		// Fall back to subject-based thread matching
		if (!thread) {
			var stripped = subject;
			while (stripped.toUpperCase().startsWith('RE:')) {
				stripped = stripped.substring(3).trim();
			}
			if (stripped) {
				thread = await postgres.queryOne(
					'SELECT * FROM ' + threadtable +
					' WHERE UPPER(subject) = UPPER($1)' +
					' ORDER BY last_message DESC LIMIT 1',
					[stripped]
				);
			}
		}

		if (thread) {
			formObj.reply_to = thread.threadid;
			var result = await messages.replyToThread(formObj, area.shortcode, thread.uuid);
			if (result.status) return { status: true };
			return { status: false, error: result.errormessages.join(', ') };
		}

		// No matching thread found — fall through to start new thread
	}

	// New thread
	var result = await messages.startNewThread(formObj, area.shortcode);
	if (result.status) return { status: true };
	return { status: false, error: result.errormessages.join(', ') };
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

// Remove a QWK packet temp file and its parent temp directory.
function cleanupQwkPacket(qwkPath) {
	if (!qwkPath) return;
	try {
		var dir = path.dirname(qwkPath);
		fs.rmSync(dir, { recursive: true, force: true });
	} catch (_) {}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	getQwkBbsId,
	buildQwkForUser,
	importRepForUser,
	cleanupQwkPacket
};
