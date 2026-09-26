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
import * as wall from './wall.js';
import * as announcements from './announcements.js';
import * as bulletins from './bulletins.js';
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

	// Load user record. last_qwk_download_at gates the system-conference
	// content (announcements/wall/bulletins) so each download only carries
	// new material since the previous successful fetch.
	var user = await postgres.queryOne(
		"SELECT id, username, security, permissionflags, restrictionflags, last_qwk_download_at FROM users WHERE id = $1",
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
					body_text: pm.body_text || '',
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

	// ---------------------------------------------------------------------
	// System conferences: announcements, wall, bulletins.
	//
	// These use conference numbers from the reserved range (1-100, see
	// msgAreas.RESERVED_CONF_COUNT). Filtered by users.last_qwk_download_at
	// so each download only includes content new since the last successful
	// download. Emitted in CONTROL.DAT immediately after conference 0 so
	// they appear near the top of mail-client conference lists.
	// ---------------------------------------------------------------------
	var systemConfs = [];
	var lastDl = user.last_qwk_download_at ? new Date(user.last_qwk_download_at) : null;

	// --- Announcements (read-only; REP imports to this conference are rejected) ---
	var annConf = appConfig.getNumber('qwk_announcements_conf', 1);
	if (annConf > 0) {
		var activeAnnouncements = await announcements.getActiveAnnouncements(50);
		var newAnnouncements = activeAnnouncements.filter(function(a) {
			if (!lastDl) return true;
			var created = a.created_at ? new Date(a.created_at) : null;
			return created && created > lastDl;
		});
		if (newAnnouncements.length > 0) {
			systemConfs.push({ number: annConf, name: 'Announce' });
			for (var ann of newAnnouncements) {
				var annBody = (ann.body_text || ann.title || '').trim();
				messageItems.push({
					msg: {
						id: 'ann-' + ann.id,
						from_user: ann.author_name || appConfig.get('sysopname', 'Sysop'),
						to_user: user.username,
						subject: (ann.title || 'Announcement').substring(0, 25),
						body_text: annBody,
						utf8: annBody,
						system_time: ann.created_at || new Date(),
						msg_id: '<announce-' + ann.id + '@canectic.local>',
						reply_to: null
					},
					conferenceNum: annConf,
					isPrivate: true
				});
			}
		}
	}

	// --- Wall ---
	// No time-based cap: include everything since last_qwk_download_at so
	// infrequent QWK users still see the full activity since their last
	// sync. Wall messages are short (max 160 chars) so volume is bounded.
	var wallConf = appConfig.getNumber('qwk_wall_conf', 2);
	if (wallConf > 0) {
		var wallWhere = lastDl
			? "SELECT * FROM wall_messages WHERE created_at > $1 ORDER BY created_at ASC"
			: "SELECT * FROM wall_messages ORDER BY created_at ASC LIMIT 100";
		var wallParams = lastDl ? [lastDl] : [];
		var newWall = await postgres.query(wallWhere, wallParams) || [];
		if (newWall.length > 0) {
			systemConfs.push({ number: wallConf, name: 'Wall' });
			for (var wm of newWall) {
				var wmBody = (wm.message || '').trim();
				// Subject line = first 25 chars of the body as a preview so
				// the post is readable directly from the reader's message list
				// without opening it. Full (up to 160-char) post is in the body.
				var wmSubject = wmBody.substring(0, 25);
				messageItems.push({
					msg: {
						id: 'wall-' + wm.id,
						from_user: wm.username || 'unknown',
						to_user: 'All',
						subject: wmSubject,
						body_text: wmBody,
						utf8: wmBody,
						system_time: wm.created_at || new Date(),
						msg_id: '<wall-' + wm.id + '@canectic.local>',
						reply_to: null
					},
					conferenceNum: wallConf,
					isPrivate: false
				});
			}
		}
	}

	// --- Bulletins (read-only; REP imports to this conference are rejected) ---
	// Bulletins don't have active windows or created_at filtering -- they're
	// "evergreen" info pages (rules, help, info). Include everything active
	// on first download; subsequent downloads only re-include bulletins that
	// have been updated since the last download.
	var bulConf = appConfig.getNumber('qwk_bulletins_conf', 3);
	if (bulConf > 0) {
		var activeBulletins = await bulletins.getActiveBulletins();
		var newBulletins = activeBulletins.filter(function(b) {
			if (!lastDl) return true;
			var changed = b.updated_at
				? new Date(b.updated_at)
				: (b.created_at ? new Date(b.created_at) : null);
			return changed && changed > lastDl;
		});
		if (newBulletins.length > 0) {
			systemConfs.push({ number: bulConf, name: 'Bulletin' });
			for (var bul of newBulletins) {
				var bulBody = (bul.body_text || '').trim() || '(empty)';
				messageItems.push({
					msg: {
						id: 'bul-' + bul.id,
						from_user: appConfig.get('sysopname', 'Sysop'),
						to_user: user.username,
						subject: (bul.title || 'Bulletin').substring(0, 25),
						body_text: bulBody,
						utf8: bulBody,
						system_time: bul.updated_at || bul.created_at || new Date(),
						msg_id: '<bulletin-' + bul.id + '@canectic.local>',
						reply_to: null
					},
					conferenceNum: bulConf,
					isPrivate: true
				});
			}
		}
	}

	if (messageItems.length === 0) {
		returnObj.status = true;
		return returnObj;
	}

	// Build packet components. System conferences (announcements, wall,
	// bulletins) emit FIRST in CONTROL.DAT so mail clients that respect
	// emission order show them immediately after conference 0. Readers
	// that sort numerically also show them near the top because the
	// reserved range is below the message-area range (1-100 vs 101+).
	var allConferences = systemConfs.concat(conferences);
	var controlDat = buildControlDat({
		bbsName:       appConfig.get('boardname', 'Canectic BBS'),
		bbsLocation:   appConfig.get('boardlocation', ''),
		bbsPhone:      appConfig.get('boardphone', 'N/A'),
		sysopName:     appConfig.get('sysopname', 'Sysop'),
		qwkId:         bbsId,
		recipientName: user.username,
		conferences:   allConferences,
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

	// Advance the user's QWK download watermark so the next download
	// only includes system-conference content (announcements, wall,
	// bulletins) that has appeared since now.
	try {
		await postgres.write(
			"UPDATE users SET last_qwk_download_at = NOW() WHERE id = $1",
			[userId]
		);
	} catch (err) {
		alogger.writeAlog(3,
			'buildQwkForUser: last_qwk_download_at update failed for ' + user.username +
			': ' + (err.message || err),
			'yellow');
	}

	returnObj.status = true;
	returnObj.qwkPath = qwkPath;
	returnObj.totalMessages = messageItems.length;
	returnObj.areaCount = allConferences.length;

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
			var headersText = fs.readFileSync(path.join(extractDir, headersFile), 'latin1');  // bytes: each entry names its own charset (#71)
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

	// Preload system conference numbers so the per-message dispatch
	// can match against them without re-reading config on every loop.
	var annConfNum = appConfig.getNumber('qwk_announcements_conf', 1);
	var wallConfNum = appConfig.getNumber('qwk_wall_conf', 2);
	var bulConfNum = appConfig.getNumber('qwk_bulletins_conf', 3);

	// Rejection tracking for the post-import feedback PM. Each entry is
	// a short string summarising why a message was rejected; these are
	// assembled into a LOCAL PM delivered to the user's inbox after the
	// import loop so they see the failures on their next QWK download.
	var rejectionsForPm = [];
	var wallAccepted = false;

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
				rejectionsForPm.push('PM to ' + (msg.to || 'Unknown') + ': ' + pmResult.error);
			}
			continue;
		}

		// Announcements conference -- always read-only, reject
		if (annConfNum > 0 && msg.conferenceNum === annConfNum) {
			returnObj.totalErrors++;
			var annReason = 'Announcements conference is read-only';
			returnObj.details.push('Conference ' + annConfNum + ' (Announce): ' + annReason);
			rejectionsForPm.push('Announcement reply (subject "' +
				(msg.subject || '').substring(0, 40) + '"): ' + annReason);
			continue;
		}

		// Bulletins conference -- always read-only, reject
		if (bulConfNum > 0 && msg.conferenceNum === bulConfNum) {
			returnObj.totalErrors++;
			var bulReason = 'Bulletins conference is read-only';
			returnObj.details.push('Conference ' + bulConfNum + ' (Bulletin): ' + bulReason);
			rejectionsForPm.push('Bulletin reply (subject "' +
				(msg.subject || '').substring(0, 40) + '"): ' + bulReason);
			continue;
		}

		// Wall conference -- one post per REP, take first and reject rest
		if (wallConfNum > 0 && msg.conferenceNum === wallConfNum) {
			if (wallAccepted) {
				returnObj.totalErrors++;
				var wallDupReason = 'Wall posts are limited to one per REP upload';
				returnObj.details.push('Conference ' + wallConfNum + ' (Wall): ' + wallDupReason);
				rejectionsForPm.push('Wall post (subject "' +
					(msg.subject || '').substring(0, 40) + '"): ' + wallDupReason);
				continue;
			}
			var wallResult = await importRepWall(user, msg);
			if (wallResult.status) {
				wallAccepted = true;
				returnObj.totalPosted++;
				returnObj.details.push('Conference ' + wallConfNum + ' (Wall): posted "' +
					(wallResult.posted || '').substring(0, 40) + '"');
			} else {
				returnObj.totalErrors++;
				returnObj.details.push('Conference ' + wallConfNum + ' (Wall): ' + wallResult.error);
				rejectionsForPm.push('Wall post: ' + wallResult.error);
			}
			continue;
		}

		// Area post — resolve conference number
		var area = await msgAreas.getAreaByConfNumber(msg.conferenceNum);
		if (!area) {
			returnObj.totalErrors++;
			var unknownReason = 'unknown conference';
			returnObj.details.push('Conference ' + msg.conferenceNum + ': ' + unknownReason);
			rejectionsForPm.push('Message in conference ' + msg.conferenceNum +
				' (subject "' + (msg.subject || '').substring(0, 40) + '"): ' + unknownReason);
			continue;
		}

		// Check write access
		if (!checkAreaPostAccess(user, area)) {
			returnObj.totalErrors++;
			var denyReason = 'access denied';
			returnObj.details.push(area.shortcode + ': ' + denyReason);
			rejectionsForPm.push(area.shortcode + ' (subject "' +
				(msg.subject || '').substring(0, 40) + '"): ' + denyReason);
			continue;
		}

		var postResult = await importRepMessage(user, msg, area);
		if (postResult.status) {
			returnObj.totalPosted++;
			returnObj.details.push(area.shortcode + ': posted "' + (msg.subject || '').substring(0, 40) + '"');
		} else {
			returnObj.totalErrors++;
			returnObj.details.push(area.shortcode + ': ' + postResult.error);
			rejectionsForPm.push(area.shortcode + ' (subject "' +
				(msg.subject || '').substring(0, 40) + '"): ' + postResult.error);
		}
	}

	// Clean up
	fs.rmSync(extractDir, { recursive: true, force: true });

	// Post-import feedback PM: if any messages were rejected, deliver a
	// LOCAL system PM back to the user summarising the failures so they
	// see them on their next QWK download. Most mail clients don't
	// surface per-message rejection details from the upload response,
	// so this is the only realistic feedback loop for offline users.
	if (rejectionsForPm.length > 0) {
		try {
			await deliverRepErrorPm(user, rejectionsForPm);
		} catch (pmErr) {
			alogger.writeAlog(3,
				'importRepForUser: error PM delivery failed for ' + user.username +
				': ' + (pmErr.message || pmErr),
				'yellow');
		}
	}

	returnObj.status = true;

	alogger.writeAlog(5,
		'importRepForUser: ' + user.username + ' — posted=' + returnObj.totalPosted +
		' errors=' + returnObj.totalErrors,
		'greenbright'
	);

	return returnObj;
}

// Wall post handling: take the first line of the body, strip whitespace,
// truncate to wall_max_length, silently. Honour wall.canPost() for the
// access check (rejects Unverified etc). Empty bodies are rejected.
async function importRepWall(user, msg) {
	if (!wall.canPost(user)) {
		return { status: false, error: 'wall posting denied for this user' };
	}
	var rawBody = (msg.bodyText || msg.body || '').toString();
	// Strip carriage returns, split on first newline of any flavour
	var firstLine = rawBody.replace(/\r/g, '').split('\n')[0] || '';
	firstLine = firstLine.replace(/\s+$/, '').replace(/^\s+/, '');
	if (!firstLine) {
		return { status: false, error: 'empty wall post body' };
	}
	var maxLen = appConfig.getNumber('wall_max_length', 78);
	if (firstLine.length > maxLen) {
		firstLine = firstLine.substring(0, maxLen);
	}
	var addResult = await wall.addMessage(user.id, user.username, firstLine);
	if (!addResult || addResult.status !== true) {
		return { status: false, error: 'wall DB write failed' };
	}
	return { status: true, posted: firstLine };
}

// Compose a LOCAL/SYSTEM PM explaining the rejected messages from a REP
// import so the user sees them on their next QWK download. Uses the same
// privateMessages.deliverMessage path as every other system notification.
async function deliverRepErrorPm(user, rejections) {
	var bodyLines = [
		'The following messages from your last REP upload were not processed:',
		''
	];
	for (var r of rejections) {
		bodyLines.push('  * ' + r);
	}
	bodyLines.push('');
	bodyLines.push('Notes:');
	bodyLines.push('  - The announcements and bulletins conferences are read-only.');
	bodyLines.push('  - The wall accepts one post per REP upload; extras are rejected.');
	bodyLines.push('  - Replies in other conferences must target a valid message area.');
	var bodyText = bodyLines.join('\r');

	var messageObj = {
		user_id: user.id,
		from_user: 'SYSTEM',
		to_user: user.username,
		from_address: 'SYSTEM',
		to_address: user.username,
		subject: 'REP import — rejected messages',
		body_text: bodyText,
		utf8: bodyText,
		transport_type: 'LOCAL',
		transport_data: {
			system_notification: true,
			source: 'qwk_rep_error_feedback'
		},
		system_time: new Date()
	};
	return await privateMessages.deliverMessage(messageObj);
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

	var bodyText = msg.bodyText || '';
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
	var bodyText = msg.bodyText || '';
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
			// No parent message uuid available from the REP — replyToThread
			// falls back to the thread root's threadid for the @REPLY tuple.
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
