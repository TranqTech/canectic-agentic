// qwkTosser.js
// QWK network tosser. Pulls QWK packets (client mode) or REP packets (hub mode)
// from peers, and pushes REP packets to hubs. Supports FTP, SFTP, directory,
// and hub transports.
//
// Conference numbers ARE areatags — enforced at the admin layer when creating
// network_areas for a QWK network.
//
// Both pull (QWK) and push (REP) packet names use connection_data.remote_qwk_id
// — the remote system's BBS ID. Our own QWK-ID comes from systemAddresses
// via the connection's system_address_id.
//
// Dupe ID: composite "{peerConnectionUUID}:{conferenceNum}:{msgNumber}" stored
// in the dedicated qwk_msg_id column (separate from nntp_msg_id so areas can
// be cross-posted to both network types).

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

import * as postgres from '../db/postgres.js';
import * as alogger from '../../utils/alogger.js';
import * as peerConnections from '../../models/peerConnections.js';
import * as systemAddresses from '../../models/systemAddresses.js';
import { formatBodyHtml } from '../../utils/terminalText.js';
import { threadMessage, rollbackThread, pushImportedMsgId } from '../../models/messages.js';
import { makeTransport } from '../../models/qwkTransport.js';
import * as privateMessages from '../../models/privateMessages.js';
import {
	parseControlDat,
	parseMessagesDAT,
	parseHeadersDat,
	applyHeadersDat,
	buildRepPacket,
	unzipQwkPacket
} from '../../models/qwkClasses.js';
import appConfig from "../../config/appConfig.js";


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Parse a QWK date "MM-DD-YY" + time "HH:MM" into a Date object.
// Two-digit year: 00-79 → 2000-2079, 80-99 → 1980-1999.
function parseQwkDateTime(dateStr, timeStr) {
	if (!dateStr) return new Date();
	var parts = dateStr.split('-');
	if (parts.length < 3) return new Date();
	var mm   = parseInt(parts[0], 10);
	var dd   = parseInt(parts[1], 10);
	var yy   = parseInt(parts[2], 10);
	var year = yy < 80 ? 2000 + yy : 1900 + yy;

	var hh = 0, mi = 0;
	if (timeStr) {
		var tp = timeStr.split(':');
		hh = parseInt(tp[0], 10) || 0;
		mi = parseInt(tp[1], 10) || 0;
	}

	var d = new Date(year, mm - 1, dd, hh, mi, 0);
	return isNaN(d.getTime()) ? new Date() : d;
}

// ---------------------------------------------------------------------------
// Message import (pull)
// ---------------------------------------------------------------------------

// Imports a single QWK message into the message tables for the given area.
// Returns { status, imported, duplicate, errormessages[] }
async function importQwkMessage(qwkMsg, area, dupeId, networkId) {
	var returnObj = {
		status: false,
		imported: false,
		duplicate: false,
		errormessages: []
	};

	var shorty      = area.shortcode.toLowerCase().trim();
	var msgtable    = 'mb_' + shorty + '_msgs';
	var threadtable = 'mb_' + shorty + '_threads';

	// Duplicate check on qwk_msg_id
	var isUnique = await postgres.checkValueUnique('qwk_msg_id', dupeId, msgtable);
	if (!isUnique) {
		returnObj.status    = true;
		returnObj.duplicate = true;
		return returnObj;
	}

	var systemTime = parseQwkDateTime(qwkMsg.date, qwkMsg.time);
	var currtime   = new Date();
	var uuid       = uuidv4();
	var fromUser   = qwkMsg.from || 'Unknown';
	var toUser     = qwkMsg.to   || 'All';
	var subject    = qwkMsg.subject || '(no subject)';
	var kludges    = qwkMsg.kludges || {};

	// Extract kludge data for FTN-compatible column mapping
	// @MSGID → msg_id (canonical message ID for threading; dupe check stays on qwk_msg_id)
	var msgId    = kludges.MSGID || dupeId;
	// @REPLY → reply_to (FTN-style parent reference for thread linking)
	var replyTo  = kludges.REPLY || null;
	// @TZUTC / @TZ → tz_utc
	var tzUtc    = kludges.TZUTC || kludges.TZ || null;
	// @PID → tosser_id / product_string
	var tosserId = kludges.PID || null;
	// @VIA → path (routing trace, multiple entries joined)
	var viaPath  = kludges.VIA ? kludges.VIA.join(' ') : null;
	// Origin line extracted from body
	var originLine = qwkMsg.originLine || null;

	// If @TZUTC is available, try to refine system_time with timezone offset
	if (tzUtc && systemTime) {
		var tzMinutes = parseInt(tzUtc, 10);
		if (!isNaN(tzMinutes) && tzMinutes !== 0) {
			// TZUTC is minutes offset from UTC in FTN convention (e.g. "0500" = +5h)
			// Some formats use HHMM; detect by magnitude
			if (Math.abs(tzMinutes) >= 100) {
				var tzH = Math.floor(tzMinutes / 100);
				var tzM = tzMinutes % 100;
				tzMinutes = tzH * 60 + tzM;
			}
			// QWK dates are local time; adjust to UTC using the offset
			systemTime = new Date(systemTime.getTime() - tzMinutes * 60000);
		}
	}

	// Pre-format body as HTML for display (non-fatal)
	var displayText = qwkMsg.utf8 || qwkMsg.bodyText || '';
	var bodyHtml = await formatBodyHtml(displayText);

	// Build message object and let unified threadMessage() handle threading
	var dbObj = {
		uuid:              uuid,
		msg_id:            msgId,
		qwk_msg_id:        dupeId,
		reply_to:          replyTo,
		from_user:         fromUser,
		to_user:           toUser,
		subject:           subject,
		body_text:         qwkMsg.bodyText,
		raw_text:          qwkMsg.rawBody,
		utf8:              qwkMsg.utf8 || null,
		body_html:         bodyHtml,
		origin_line:       originLine,
		datetime_string:   (qwkMsg.date || '') + ' ' + (qwkMsg.time || ''),
		tz_utc:            tzUtc,
		system_time:       systemTime,
		created_at:        currtime,
		updated_at:        null,
		user_id:           0,
		tosser_id:         tosserId,
		product_string:    tosserId,
		path:              viaPath,
		destination:       String(qwkMsg.conferenceNum),
		source_network_id: networkId
	};

	// Unified threading: reply_to lookup -> subject match -> create new thread
	var threadedBefore = dbObj.threadid;
	dbObj = await threadMessage(dbObj, msgtable, threadtable, shorty);

	var mres = await postgres.insertObject(dbObj, msgtable);
	if (!mres.status) {
		// Roll back thread if threadMessage created a new one
		if (!threadedBefore && dbObj.threadid) {
			await rollbackThread(threadtable, dbObj.threadid);
		}
		alogger.writeClog(3,
			'importQwkMessage: failed to insert message ' + dupeId +
			': ' + mres.errormessages.join(', '), 'tosser',
			'redbright'
		, false, false);
		returnObj.errormessages = returnObj.errormessages.concat(mres.errormessages);
		return returnObj;
	}

	pushImportedMsgId(msgId, shorty);
	returnObj.status   = true;
	returnObj.imported = true;
	return returnObj;
}

// ---------------------------------------------------------------------------
// Import a QWK conference 0 message as a private message
// ---------------------------------------------------------------------------

async function importQwkPrivateMessage(qwkMsg, remoteQwkId, peerConnectionUUID) {
	var retObj = {
		delivered: false,
		duplicate: false,
		errormessages: []
	};

	var toUser = (qwkMsg.to || '').trim();
	var fromUser = (qwkMsg.from || '').trim();

	if (!toUser) {
		retObj.errormessages.push('QWK PM has no recipient');
		return retObj;
	}

	// Resolve recipient to a local user
	var resolution = await privateMessages.resolveRecipient(toUser);
	if (!resolution.resolved) {
		// Unresolvable — send to undeliverable queue and notify sysops
		var undeliverableMsg = {
			from_user: fromUser,
			to_user: toUser,
			from_address: remoteQwkId,
			to_address: '',
			subject: qwkMsg.subject || '',
			body_text: qwkMsg.utf8 || qwkMsg.bodyText || '',
			transport_type: 'QWK',
			transport_data: JSON.stringify({
				source: remoteQwkId,
				peer_connection_uuid: peerConnectionUUID,
				conference: 0,
				msg_number: qwkMsg.msgNumber || 0
			}),
			reason: 'Recipient "' + toUser + '" not found (QWK PM from ' + remoteQwkId + ')'
		};
		await privateMessages.insertUndeliverable(undeliverableMsg);
		await privateMessages.notifySysops(
			'Undeliverable QWK PM from ' + remoteQwkId,
			'A private message from ' + fromUser + ' to ' + toUser + ' could not be delivered.\nSubject: ' + (qwkMsg.subject || '(none)') + '\nReason: Recipient not found.'
		);
		retObj.errormessages.push('Recipient "' + toUser + '" not found');
		return retObj;
	}

	// Build the message object for delivery
	var bodyText = qwkMsg.utf8 || qwkMsg.bodyText || '';
	var msgId = '';
	if (qwkMsg.kludges && qwkMsg.kludges.MSGID) {
		msgId = qwkMsg.kludges.MSGID;
	} else {
		msgId = remoteQwkId + ':0:' + (qwkMsg.msgNumber || Date.now());
	}

	var messageObj = {
		user_id: resolution.userId,
		msg_id: msgId,
		from_user: fromUser,
		to_user: resolution.username,
		from_address: remoteQwkId,
		to_address: resolution.username,
		subject: qwkMsg.subject || '',
		body_text: bodyText,
		utf8: bodyText,
		raw_text: qwkMsg.rawUtf8 || qwkMsg.rawBody || '',
		transport_type: 'QWK',
		transport_data: {
			source: remoteQwkId,
			peer_connection_uuid: peerConnectionUUID,
			conference: 0,
			msg_number: qwkMsg.msgNumber || 0,
			msg_id: msgId,
			reply_to: (qwkMsg.kludges && qwkMsg.kludges.REPLY) || ''
		},
		system_time: parseQwkDateTime(qwkMsg.date, qwkMsg.time) || new Date()
	};

	var deliveryResult = await privateMessages.deliverMessage(messageObj);
	if (deliveryResult.duplicate) {
		retObj.duplicate = true;
		return retObj;
	}
	if (!deliveryResult.status) {
		retObj.errormessages = deliveryResult.errormessages;
		return retObj;
	}

	retObj.delivered = true;
	return retObj;
}

// ---------------------------------------------------------------------------
// Pull logic
// ---------------------------------------------------------------------------

// Pulls a QWK packet from a single peer connection.
async function pullFromQwkPeer(peerConnectionUUID) {
	var returnObj = {
		status: false,
		totalImported: 0,
		totalDuplicate: 0,
		errormessages: []
	};

	var dbconn = await peerConnections.getConnectionByUUIDWithNetwork(peerConnectionUUID);
	if (!dbconn) {
		returnObj.errormessages.push('Connection not found: ' + peerConnectionUUID);
		return returnObj;
	}
	if (!dbconn.active) {
		returnObj.errormessages.push('Connection is not active: ' + peerConnectionUUID);
		return returnObj;
	}

	var cd = dbconn.connection_data || {};
	if (!cd.host && cd.transport !== 'directory' && cd.transport !== 'hub') {
		returnObj.errormessages.push('No host configured for connection ' + peerConnectionUUID);
		return returnObj;
	}

	// Pull packet name comes from remote_qwk_id — in client mode this is the
	// hub's BBS ID, in hub mode this is the node's BBS ID.
	var remoteQwkId = (cd.remote_qwk_id || '').trim().toUpperCase();
	if (!remoteQwkId) {
		returnObj.errormessages.push('No remote_qwk_id configured for connection ' + peerConnectionUUID);
		return returnObj;
	}

	var isHubMode = (cd.transport === 'hub');

	// Working directory: cwd()/qwk/<REMOTE_QWK_ID>/in/
	// Persistent so we can inspect downloads and support future filebox features
	var qwkBaseDir = path.join(process.cwd(), 'qnet', remoteQwkId);
	var inDir      = path.join(qwkBaseDir, 'in');
	var extractDir = path.join(inDir, 'extracted');
	fs.mkdirSync(inDir, { recursive: true });

	// Phase 1: Check for existing extracted files from a prior run
	var hasExisting = false;
	if (fs.existsSync(extractDir)) {
		var existingFiles = fs.readdirSync(extractDir);
		var existingMsgs  = existingFiles.find(f =>
			f.toUpperCase() === 'MESSAGES.DAT' || f.toUpperCase().endsWith('.MSG')
		);
		if (existingMsgs) {
			alogger.writeClog(5,
				'pullFromQwkPeer: found existing message data from prior extraction — processing before pulling', 'tosser',
				'cyan'
			, false, false);
			hasExisting = true;
		}
	}

	// Phase 1.5: Check for an existing downloaded .qwk/.rep in inDir that was
	// never extracted (e.g. extraction or processing failed on a prior run).
	// In QWK networking the hub typically deletes the packet after the client
	// downloads it, so we must process the local copy before trying to pull again.
	if (!hasExisting && !isHubMode) {
		var inFiles = fs.readdirSync(inDir);
		var existingQwk = inFiles.find(f => f.toLowerCase().endsWith('.qwk'));
		if (existingQwk) {
			var existingQwkPath = path.join(inDir, existingQwk);
			alogger.writeClog(5,
				'pullFromQwkPeer: found existing QWK packet in inbound: ' + existingQwk +
				' — extracting before pulling new', 'tosser',
				'cyan'
			, false, false);

			try {
				unzipQwkPacket(existingQwkPath, extractDir);

				var freshFiles = fs.readdirSync(extractDir);
				alogger.writeClog(5,
					'pullFromQwkPeer: extracted ' + freshFiles.length + ' file(s) from existing packet: ' +
					freshFiles.join(', '), 'tosser',
					'cyan'
				, false, false);

				// Check that extraction actually produced message data
				var hasMsgData = freshFiles.find(f =>
					f.toUpperCase() === 'MESSAGES.DAT' || f.toUpperCase().endsWith('.MSG')
				);
				if (hasMsgData) {
					hasExisting = true;
				} else {
					alogger.writeClog(5,
						'pullFromQwkPeer: existing packet had no message data — removing and pulling fresh', 'tosser',
						'cyan'
					, false, false);
					fs.rmSync(extractDir, { recursive: true, force: true });
					fs.unlinkSync(existingQwkPath);
				}
			} catch (err) {
				alogger.writeClog(3,
					'pullFromQwkPeer: failed to extract existing QWK ' + existingQwk +
					': ' + err.message + ' — removing corrupt file and pulling fresh', 'tosser',
					'redbright'
				, false, false);
				// Remove the corrupt/unextractable file so we don't loop on it
				try { fs.unlinkSync(existingQwkPath); } catch (_) {}
				try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
			}
		}
	}

	// Phase 2: Acquire new packet if nothing existing to process
	if (!hasExisting) {
		if (isHubMode) {
			// Hub mode: scan in/ for .rep files from the node
			var inFiles = fs.readdirSync(inDir);
			var repFile = inFiles.find(f => f.toLowerCase().endsWith('.rep'));

			if (!repFile) {
				alogger.writeClog(5,
					'pullFromQwkPeer: no REP packet in ' + inDir + ' — nothing to pull', 'tosser',
					'cyan'
				, false, false);
				returnObj.status = true;
				return returnObj;
			}

			var repPath = path.join(inDir, repFile);
			alogger.writeClog(5,
				'pullFromQwkPeer: found REP from node: ' + repFile, 'tosser',
				'cyan'
			, false, false);

			try {
				unzipQwkPacket(repPath, extractDir);

				var freshFiles = fs.readdirSync(extractDir);
				alogger.writeClog(5,
					'pullFromQwkPeer: extracted ' + freshFiles.length + ' file(s): ' +
					freshFiles.join(', '), 'tosser',
					'cyan'
				, false, false);

				// Remove the .rep after successful extraction
				fs.unlinkSync(repPath);

			} catch (err) {
				alogger.writeClog(3,
					'pullFromQwkPeer: REP extract error for ' + peerConnectionUUID +
					': ' + err.message, 'tosser',
					'redbright'
				, false, false);
				returnObj.errormessages.push(err.message);
				return returnObj;
			}

		} else {
			// Client mode: download .qwk from remote
			var transport = null;
			try {
				transport = makeTransport(cd);
				await transport.connect(cd);

			var remoteInbox = cd.remote_inbox || '';
			if (remoteInbox && !remoteInbox.endsWith('/')) remoteInbox += '/';
			var remotePath = remoteInbox + remoteQwkId + '.qwk';
			var localQwk   = path.join(inDir, remoteQwkId + '.qwk');

			// List the inbox directory so we can see what's actually there
			try {
				await transport.listDir(remoteInbox || '.');
			} catch (_) {
				// non-fatal — list is for debugging only
			}

			alogger.writeClog(5,
				'pullFromQwkPeer: downloading ' + remotePath +
				(cd.host ? ' from ' + cd.host + ':' + (cd.port || 21) : ''), 'tosser',
				'cyan'
			, false, false);

			try {
				await transport.downloadFile(remotePath, localQwk);
			} catch (dlErr) {
				await transport.disconnect();
				// 550 (FTP) or ENOENT (directory) = file not found — normal when no packet is waiting
				if ((dlErr.message && dlErr.message.indexOf('550') !== -1) ||
				    dlErr.code === 'ENOENT') {
					alogger.writeClog(5,
						'pullFromQwkPeer: no QWK packet waiting at ' + remotePath +
						' — nothing to pull', 'tosser',
						'cyan'
					, false, false);
					returnObj.status = true;
					return returnObj;
				}
				// Any other download error — bail
				throw dlErr;
			}

			await transport.disconnect();
			transport = null;

			// Extract fresh download
			alogger.writeClog(5,
				'pullFromQwkPeer: extracting ' + localQwk + ' → ' + extractDir, 'tosser',
				'cyan'
			, false, false);
			unzipQwkPacket(localQwk, extractDir);

			// Log what came out of the zip
			var freshFiles = fs.readdirSync(extractDir);
			alogger.writeClog(5,
				'pullFromQwkPeer: extracted ' + freshFiles.length + ' file(s): ' +
				freshFiles.join(', '), 'tosser',
				'cyan'
			, false, false);

		} catch (err) {
			alogger.writeClog(3,
				'pullFromQwkPeer: download/extract error for ' + peerConnectionUUID +
				': ' + err.message, 'tosser',
				'redbright'
			, false, false);
			returnObj.errormessages.push(err.message);
			if (transport) {
				try { await transport.disconnect(); } catch (_) {}
			}
			return returnObj;
		}
		} // end else (client mode)
	}

	// Phase 3: Process whatever is in the extracted directory
	try {
		if (!fs.existsSync(extractDir)) {
			alogger.writeClog(5, 'pullFromQwkPeer: no extracted directory — nothing to process', 'tosser', 'cyan', false, 'tosser', false, false, false);
			returnObj.status = true;
			return returnObj;
		}

		var extractedFiles = fs.readdirSync(extractDir);
		var controlFile  = extractedFiles.find(f => f.toUpperCase() === 'CONTROL.DAT');
		var headersFile  = extractedFiles.find(f => f.toUpperCase() === 'HEADERS.DAT');
		// Look for MESSAGES.DAT (from .qwk) or any .MSG file (from .rep)
		var messagesFile = extractedFiles.find(f => f.toUpperCase() === 'MESSAGES.DAT');
		if (!messagesFile) {
			messagesFile = extractedFiles.find(f => f.toUpperCase().endsWith('.MSG'));
		}

		if (!messagesFile) {
			alogger.writeClog(5,
				'pullFromQwkPeer: no message data in extracted directory — no new messages', 'tosser',
				'cyan'
			, false, false);
			returnObj.status = true;
			return returnObj;
		}

		alogger.writeClog(5,
			'pullFromQwkPeer: using message file: ' + messagesFile, 'tosser',
			'cyan'
		, false, false);

		// CONTROL.DAT is optional — present in offline reader packets but often
		// absent in QWK networking mode. Parse it for logging if available.
		if (controlFile) {
			var controlText = fs.readFileSync(path.join(extractDir, controlFile), 'ascii');
			var controlDat  = parseControlDat(controlText);
			alogger.writeClog(5,
				'pullFromQwkPeer: CONTROL.DAT present — hub is ' +
				controlDat.bbsName + ', ' + controlDat.conferences.length +
				' conference(s) listed', 'tosser',
				'cyan'
			, false, false);
		} else {
			alogger.writeClog(5,
				'pullFromQwkPeer: no CONTROL.DAT — QWK net mode, using subscription map', 'tosser',
				'cyan'
			, false, false);
		}

		var messagesBuf = fs.readFileSync(path.join(extractDir, messagesFile));
		var messages    = parseMessagesDAT(messagesBuf);

		alogger.writeClog(5,
			'pullFromQwkPeer: ' + messages.length + ' message(s) in ' + messagesFile, 'tosser',
			'cyan'
		, false, false);

		// Parse HEADERS.DAT if present — overlays richer metadata onto messages
		// (full-length subjects, Message-IDs, timezone info, UTF-8 flag, etc)
		if (headersFile) {
			try {
				var headersText = fs.readFileSync(path.join(extractDir, headersFile), 'utf8');
				var headersDat  = parseHeadersDat(headersText);
				var hdrCount    = Object.keys(headersDat).length;
				alogger.writeClog(5,
					'pullFromQwkPeer: HEADERS.DAT present — ' + hdrCount +
					' entry(ies), applying overlays', 'tosser',
					'cyan'
				, false, false);
				applyHeadersDat(messages, headersDat);
			} catch (hdrErr) {
				alogger.writeClog(3,
					'pullFromQwkPeer: HEADERS.DAT parse error — ' + hdrErr.message +
					' (continuing without header overlays)', 'tosser',
					'yellow'
				, false, false);
			}
		}

		// Get enabled subscriptions for this connection joined with areatag
		var enabledSubs = await postgres.query(
			`SELECT pas.id, pas.area_id,
			        ma.shortcode, na.areatag
			 FROM peer_area_subscriptions pas
			 JOIN message_areas ma ON ma.id = pas.area_id
			 JOIN network_areas na ON na.area_id = pas.area_id
			                       AND na.network_id = $1
			 WHERE pas.peer_connection_id = $2
			   AND pas.enabled = true
			   AND na.active = true
			 ORDER BY ma.shortcode ASC`,
			[dbconn.network_id, dbconn.id]
		);

		// Build conference number → area map
		// areatag IS the conference number (as a string) for QWK networks
		var confMap = {};
		if (enabledSubs) {
			for (var sub of enabledSubs) {
				var confNum = parseInt(sub.areatag, 10);
				if (!isNaN(confNum)) {
					confMap[confNum] = {
						area_id:   sub.area_id,
						shortcode: sub.shortcode,
						areatag:   sub.areatag
					};
				}
			}
		}

		// Log the conference map for debugging
		var confKeys = Object.keys(confMap);
		alogger.writeClog(5,
			'pullFromQwkPeer: conference map has ' + confKeys.length +
			' subscription(s): ' + confKeys.join(', '), 'tosser',
			'cyan'
		, false, false);

		var highWaterMarks = cd.high_water_marks || {};
		var skippedConfs = {};

		// Import messages
		for (var msg of messages) {
			// Conference 0 = personal/private messages → deliver as PM
			if (msg.conferenceNum === 0) {
				if (!msg.isLive) continue;
				try {
					var pmResult = await importQwkPrivateMessage(msg, remoteQwkId, peerConnectionUUID);
					if (pmResult.delivered) {
						returnObj.totalImported++;
						alogger.writeClog(5,
							'pullFromQwkPeer: delivered PM from ' + msg.from + ' to ' + msg.to, 'tosser',
							'cyan'
						, false, false);
					} else if (pmResult.duplicate) {
						returnObj.totalDuplicate++;
					} else if (pmResult.errormessages && pmResult.errormessages.length > 0) {
						alogger.writeClog(3,
							'pullFromQwkPeer: PM import error: ' + pmResult.errormessages.join(', '), 'tosser',
							'redbright'
						, false, false);
					}
				} catch (pmErr) {
					alogger.writeClog(3,
						'pullFromQwkPeer: PM import exception: ' + pmErr.message, 'tosser',
						'redbright'
					, false, false);
				}
				continue;
			}

			// Skip deleted messages
			if (!msg.isLive) continue;

			// Skip unsubscribed conferences
			var areaInfo = confMap[msg.conferenceNum];
			if (!areaInfo) {
				if (!skippedConfs[msg.conferenceNum]) {
					skippedConfs[msg.conferenceNum] = 0;
				}
				skippedConfs[msg.conferenceNum]++;
				continue;
			}

			var dupeId = peerConnectionUUID + ':' + msg.conferenceNum + ':' + msg.msgNumber;

			var result = await importQwkMessage(
				msg,
				{ shortcode: areaInfo.shortcode, id: areaInfo.area_id },
				dupeId,
				dbconn.network_id
			);

			if (result.imported) {
				returnObj.totalImported++;
			} else if (result.duplicate) {
				returnObj.totalDuplicate++;
			}

			if (result.errormessages.length > 0) {
				alogger.writeClog(3,
					'pullFromQwkPeer: import error for conf ' + msg.conferenceNum +
					' msg ' + msg.msgNumber + ': ' + result.errormessages.join(', '), 'tosser',
					'redbright'
				, false, false);
			}

			// Track HWM per conference (areatag = conference number string)
			var areatag = areaInfo.areatag;
			var prevHwm = highWaterMarks[areatag] || 0;
			if (msg.msgNumber > prevHwm) {
				highWaterMarks[areatag] = msg.msgNumber;
			}
		}

		// Log any conferences that had messages but no subscription
		var skippedKeys = Object.keys(skippedConfs);
		if (skippedKeys.length > 0) {
			var skippedSummary = skippedKeys.map(function(k) {
				return k + '(' + skippedConfs[k] + ')';
			}).join(', ');
			alogger.writeClog(5,
				'pullFromQwkPeer: skipped unsubscribed conferences: ' + skippedSummary, 'tosser',
				'yellow'
			, false, false);
		}

		// Persist high-water marks
		await peerConnections.updateConnectionData(
			peerConnectionUUID,
			{ high_water_marks: highWaterMarks }
		);

		alogger.writeClog(5,
			'pullFromQwkPeer: ' + peerConnectionUUID +
			' — imported=' + returnObj.totalImported +
			' duplicate=' + returnObj.totalDuplicate, 'tosser',
			'greenbright'
		, false, false);

		// Processing complete — remove the extracted directory so it isn't
		// reprocessed next cycle. Also remove the source .qwk packet since
		// Phase 1.5 would otherwise re-extract it on every run.
		fs.rmSync(extractDir, { recursive: true, force: true });
		var processedQwk = path.join(inDir, remoteQwkId + '.qwk');
		if (fs.existsSync(processedQwk)) {
			fs.unlinkSync(processedQwk);
		}
		alogger.writeClog(5,
			'pullFromQwkPeer: cleaned up extracted directory and source packet', 'tosser',
			'cyan'
		, false, false);

		returnObj.status = true;

	} catch (err) {
		alogger.writeClog(3,
			'pullFromQwkPeer: processing error for ' + peerConnectionUUID + ': ' + err.message, 'tosser',
			'redbright'
		, false, false);
		returnObj.errormessages.push(err.message);
	}

	return returnObj;
}

// Pull from all active QWK connections.
async function pullAllQWK() {
	var connections = await peerConnections.getActiveConnectionsByNetworkType('QWK');
	if (!connections || connections.length === 0) {
		alogger.writeClog(5, 'pullAllQWK: no active QWK connections found', 'tosser', 'cyan', false, 'tosser', false, false, false);
		return;
	}

	alogger.writeClog(5,
		'pullAllQWK: processing ' + connections.length + ' QWK connection(s)', 'tosser',
		'cyan'
	, false, false);

	for (var conn of connections) {
		alogger.writeClog(5,
			'pullAllQWK: pulling from ' + conn.peer_name + ' (' + conn.uuid + ')', 'tosser',
			'cyan'
		, false, false);
		var result = await pullFromQwkPeer(conn.uuid);
		if (!result.status) {
			alogger.writeClog(3,
				'pullAllQWK: pull failed for ' + conn.uuid + ': ' +
				result.errormessages.join(', '), 'tosser',
				'redbright'
			, false, false);
		} else {
			alogger.writeClog(5,
				'pullAllQWK: completed ' + conn.uuid +
				' — imported=' + result.totalImported +
				' duplicate=' + result.totalDuplicate, 'tosser',
				'greenbright'
			, false, false);
		}
	}
}

// ---------------------------------------------------------------------------
// Outbound — push local messages to QWK peers as REP packets
// ---------------------------------------------------------------------------

// Push locally-authored messages to a single QWK peer connection.
async function pushToQwkPeer(peerConnectionUUID) {
	var returnObj = {
		status: false,
		totalPosted: 0,
		totalSkipped: 0,
		errormessages: []
	};

	var dbconn = await peerConnections.getConnectionByUUIDWithNetwork(peerConnectionUUID);
	if (!dbconn || !dbconn.active) {
		returnObj.errormessages.push('Connection not found or inactive: ' + peerConnectionUUID);
		return returnObj;
	}

	var cd = dbconn.connection_data || {};

	// Hub mode: QWK packets are built on-demand when the node connects,
	// not during the toss cycle. This ensures packets are always fresh.
	// buildQwkForNode() is called by connection handlers (qnet-directory,
	// FTP hooks, HTTP endpoints, etc.) when the node requests a packet.
	if (cd.transport === 'hub') {
		returnObj.status = true;
		return returnObj;
	}

	if (!cd.host && cd.transport !== 'directory') {
		returnObj.errormessages.push('No host in connection_data for ' + peerConnectionUUID);
		return returnObj;
	}

	// REP packet is named after the hub's ID (remote_qwk_id), same as the QWK.
	// This matches Synchronet's qnet convention where both directions use the hub ID.
	var remoteQwkId = (cd.remote_qwk_id || '').trim().toUpperCase();
	if (!remoteQwkId) {
		returnObj.errormessages.push('No remote_qwk_id configured for connection ' + peerConnectionUUID);
		return returnObj;
	}
	var packetName = remoteQwkId;

	// Our local QWK-ID from system address — used in HEADERS.DAT ExportedFrom
	var localQwkId = '';
	var originLine = '';
	var sysAddr = null;
	if (dbconn.system_address_id) {
		sysAddr = await systemAddresses.getAddressById(dbconn.system_address_id);
	}
	if (!sysAddr && dbconn.network_id) {
		// No explicit address on connection — fall back to network default
		sysAddr = await systemAddresses.getDefaultAddress(dbconn.network_id);
	}
	if (sysAddr) {
		alogger.writeClog(5,
			'pushToQwkPeer: system_address=' + sysAddr.address +
			' origin_line=' + JSON.stringify(sysAddr.origin_line), 'tosser',
			'cyan'
		, false, false);
		if (sysAddr.address) {
			localQwkId = sysAddr.address.trim().toUpperCase();
		}
		if (sysAddr.origin_line) {
			originLine = sysAddr.origin_line.trim();
		}
	} else {
		alogger.writeClog(5,
			'pushToQwkPeer: no system address found (connection or network default)', 'tosser',
			'yellow'
		, false, false);
	}
	if (!localQwkId) {
		// Fallback to FTP username if no system address configured
		localQwkId = (cd.username || 'UNKNOWN').toUpperCase();
	}

	// Build tear line + origin for locally-originated messages.
	// Format: "--- \r || Canectic || <origin text>\r"
	// If origin_line is set on the system address, use it directly.
	// If blank: "<BBS_NAME> - <localQwkId>" or just "<localQwkId>"
	var bbsName = appConfig.get('boardname', 'Canectic BBS');
	var originText;
	if (originLine) {
		originText = originLine;
	} else if (bbsName) {
		originText = bbsName + ' - ' + localQwkId;
	} else {
		originText = localQwkId;
	}
	var tearOrigin = '\r--- \r || Canectic || ' + originText + '\r';
	alogger.writeClog(5,
		'pushToQwkPeer: originText=' + JSON.stringify(originText), 'tosser',
		'cyan'
	, false, false);

	// Get enabled subscriptions for this connection, joined with areatag
	var enabledSubs = await postgres.query(
		`SELECT pas.id, pas.area_id, pas.msg_idx,
		        ma.shortcode, na.areatag
		 FROM peer_area_subscriptions pas
		 JOIN message_areas ma ON ma.id = pas.area_id
		 JOIN network_areas na ON na.area_id = pas.area_id
		                       AND na.network_id = $1
		 WHERE pas.peer_connection_id = $2
		   AND pas.enabled = true
		   AND na.active = true
		 ORDER BY ma.shortcode ASC`,
		[dbconn.network_id, dbconn.id]
	);

	if (!enabledSubs || enabledSubs.length === 0) {
		alogger.writeClog(5,
			'pushToQwkPeer: no enabled echomail subscriptions for ' + peerConnectionUUID, 'tosser',
			'cyan'
		, false, false);
	}

	// Build ordered work list per subscription.
	// Skipped messages (echo suppression) are included as { skip: true } so
	// we can advance past them correctly without blocking on failed posts.
	var workItems = [];

	if (enabledSubs && enabledSubs.length > 0) {
	for (var sub of enabledSubs) {
		var curIdx   = sub.msg_idx || 0;
		var shorty   = sub.shortcode.toLowerCase().trim();
		var msgtable = 'mb_' + shorty + '_msgs';

		var finalIdxResult = await postgres.query(
			'SELECT id FROM ' + msgtable + ' ORDER BY id DESC LIMIT 1', []
		);
		var finalIdx = (finalIdxResult && finalIdxResult[0]) ? finalIdxResult[0].id : 0;

		if (curIdx > finalIdx) curIdx = finalIdx;

		if (finalIdx > curIdx) {
			var msglist = await postgres.query(
				'SELECT * FROM ' + msgtable + ' WHERE id > $1 ORDER BY id ASC LIMIT 500',
				[curIdx]
			);

			if (msglist && msglist.length > 0) {
				var conferenceNum = parseInt(sub.areatag, 10);

				for (var msg of msglist) {
					// Echo suppression — mark as skip
					if (msg.source_network_id && msg.source_network_id === dbconn.network_id) {
						workItems.push({
							pas_id: sub.id, area_id: sub.area_id, msgtable,
							msgId: msg.id, skip: true
						});
						continue;
					}

					workItems.push({
						pas_id: sub.id, area_id: sub.area_id, msgtable,
						msgId: msg.id, skip: false,
						msg: msg,
						conferenceNum: conferenceNum
					});

					// Tear/origin handling for outbound messages.
					// Three cases:
					// 1. Local message: append our network tear/origin, replacing any existing
					// 2. Foreign message, origin stripped (in DB but not in body): re-append original
					// 3. Foreign message, origin in body: leave as-is
					var bodyText = msg.body_text || '';
					var hasTear = /---\s*[\r\n]/.test(bodyText);

					if (!msg.source_network_id) {
						// Case 1: locally originated — strip any existing tear/origin, add ours
						if (hasTear) {
							bodyText = bodyText.replace(/\r?---\s*[\r\n][\s\S]*$/, '');
						}
						bodyText = bodyText + tearOrigin;
						msg.body_text = bodyText;
						if (msg.utf8) {
							var utf8Text = msg.utf8 || '';
							if (/---\s*[\r\n]/.test(utf8Text)) {
								utf8Text = utf8Text.replace(/\r?---\s*[\r\n][\s\S]*$/, '');
							}
							msg.utf8 = utf8Text + tearOrigin;
						}
					} else if (msg.origin_line && !hasTear) {
						// Case 2: foreign message, origin was stripped — re-append original
						var restoredOrigin = '\r--- \r * Origin: ' + msg.origin_line + '\r';
						msg.body_text = bodyText + restoredOrigin;
						if (msg.utf8) {
							msg.utf8 = (msg.utf8 || '') + restoredOrigin;
						}
					}
					// Case 3: foreign with tear/origin in body — leave as-is
				}
			}
		}
	}
	} // end if enabledSubs

	// --- Gather pending QWK private messages (conference 0) ---
	var pendingPMs = await privateMessages.getPendingByTransport('QWK');
	var pmSentIds = []; // track PM outbox IDs for marking sent after delivery

	if (pendingPMs && pendingPMs.length > 0) {
		alogger.writeClog(5,
			'pushToQwkPeer: ' + pendingPMs.length + ' pending QWK PM(s) for conference 0', 'tosser',
			'cyan'
		, false, false);

		for (var pm of pendingPMs) {
			workItems.push({
				pas_id: null, area_id: null, msgtable: null,
				msgId: pm.id, skip: false, isPM: true,
				pmOutboxId: pm.id,
				conferenceNum: 0,
				isPrivate: true,
				msg: {
					id: pm.id,
					from_user: pm.from_user || '',
					to_user: pm.to_user || '',
					subject: pm.subject || '',
					body_text: pm.utf8 || pm.body_text || '',
					utf8: null, // null so buildRepPacket runs utf8ToCp437 conversion
					system_time: pm.system_time || new Date(),
					reply_ref: 0
				}
			});
		}
	}

	if (workItems.filter(i => !i.skip).length === 0) {
		// Only skips — advance past them and return
		alogger.writeClog(5,
			'pushToQwkPeer: nothing to post for ' + peerConnectionUUID, 'tosser',
			'cyan'
		, false, false);
		await advanceQwkIdxForSkips(workItems);
		returnObj.status = true;
		return returnObj;
	}

	// Build REP packet
	var outDir = path.join(process.cwd(), 'qnet', remoteQwkId, 'out');
	fs.mkdirSync(outDir, { recursive: true });

	var repFileName = packetName + '.rep';
	var repPath     = path.join(outDir, repFileName);
	var remoteOutbox = cd.remote_outbox || '';
	if (remoteOutbox && !remoteOutbox.endsWith('/')) remoteOutbox += '/';
	var remotePath = remoteOutbox + repFileName;

	// Phase 1: If a REP file already exists from a prior failed upload,
	// try to deliver it first before building a new one.
	if (fs.existsSync(repPath)) {
		alogger.writeClog(5,
			'pushToQwkPeer: found existing REP from prior build — uploading before building new', 'tosser',
			'cyan'
		, false, false);

		var transport = null;
		try {
			transport = makeTransport(cd);
			await transport.connect(cd);

			alogger.writeClog(5,
				'pushToQwkPeer: uploading existing ' + remotePath +
				(cd.host ? ' to ' + cd.host + ':' + (cd.port || 21) : ''), 'tosser',
				'cyan'
			, false, false);

			await transport.uploadFile(repPath, remotePath);
			await transport.disconnect();
			transport = null;

			// Existing REP delivered — remove it
			fs.unlinkSync(repPath);
			alogger.writeClog(5,
				'pushToQwkPeer: existing REP delivered and removed — ' +
				'skipping new build this cycle to let hub process', 'tosser',
				'greenbright'
			, false, false);

			// Don't immediately build and upload another REP — the hub needs
			// time to process the one we just sent. New messages will be
			// picked up next toss cycle.
			returnObj.status = true;
			return returnObj;
		} catch (err) {
			alogger.writeClog(3,
				'pushToQwkPeer: failed to upload existing REP for ' +
				peerConnectionUUID + ': ' + err.message +
				' — will retry next cycle, skipping new build', 'tosser',
				'redbright'
			, false, false);
			returnObj.errormessages.push(err.message);
			if (transport) {
				try { await transport.disconnect(); } catch (_) {}
			}
			// Don't build a new REP on top of the undelivered one — retry next cycle
			return returnObj;
		}
	}

	// Phase 2: Build new REP from current work items and upload
	var transport = null;

	try {
		var postItems = workItems.filter(i => !i.skip);

		alogger.writeClog(5,
			'pushToQwkPeer: building REP with ' + postItems.length +
			' message(s)' + (cd.host ? ' for ' + cd.host : ''), 'tosser',
			'cyan'
		, false, false);

		buildRepPacket(postItems, packetName, outDir, localQwkId);

		// Upload
		transport = makeTransport(cd);
		await transport.connect(cd);

		alogger.writeClog(5,
			'pushToQwkPeer: uploading ' + remotePath +
			(cd.host ? ' to ' + cd.host + ':' + (cd.port || 21) : ''), 'tosser',
			'cyan'
		, false, false);

		await transport.uploadFile(repPath, remotePath);
		await transport.disconnect();
		transport = null;

		// Upload succeeded — remove the local REP
		fs.unlinkSync(repPath);

		// Mark all posted items as successful
		for (var item of workItems) {
			if (item.skip) {
				item.success = true;
				returnObj.totalSkipped++;
			} else if (item.isPM) {
				// Private message — mark sent in pm_outbox
				item.success = true;
				returnObj.totalPosted++;
				await privateMessages.markSent(item.pmOutboxId);
			} else {
				item.success = true;
				returnObj.totalPosted++;

				// Write qwk_msg_id on the source message so we can track what was sent
				var qwkMsgId = peerConnectionUUID + ':' + item.conferenceNum + ':' + item.msg.id;
				await postgres.write(
					'UPDATE ' + item.msgtable + ' SET qwk_msg_id = $1 WHERE id = $2',
					[qwkMsgId, item.msgId]
				);
			}
		}

	} catch (err) {
		alogger.writeClog(3,
			'pushToQwkPeer: error for ' + peerConnectionUUID + ': ' + err.message, 'tosser',
			'redbright'
		, false, false);
		returnObj.errormessages.push(err.message);
		if (transport) {
			try { await transport.disconnect(); } catch (_) {}
		}
		// REP file stays on disk for retry next cycle.
		// No items succeeded — idx stays unchanged.
	}

	// Advance msg_idx per subscription up through the last consecutive success/skip.
	await advanceQwkIdxAfterPost(workItems, enabledSubs);

	returnObj.status = true;
	alogger.writeClog(5,
		'pushToQwkPeer: ' + peerConnectionUUID +
		' posted=' + returnObj.totalPosted +
		' skipped=' + returnObj.totalSkipped, 'tosser',
		'greenbright'
	, false, false);
	return returnObj;
}

// Advance msg_idx for a list of work items that are all skips (no posts attempted).
async function advanceQwkIdxForSkips(workItems) {
	var byPas = {};
	for (var item of workItems) {
		if (item.pas_id === null || item.pas_id === undefined) continue;
		if (!byPas[item.pas_id] || item.msgId > byPas[item.pas_id]) {
			byPas[item.pas_id] = item.msgId;
		}
	}
	for (var pasId of Object.keys(byPas)) {
		await postgres.write(
			'UPDATE peer_area_subscriptions SET msg_idx = $1 WHERE id = $2',
			[byPas[pasId], parseInt(pasId)]
		);
	}
}

// Advance msg_idx per subscription up through the last consecutive success/skip.
// Stops at the first failure so unposted messages are retried next toss cycle.
async function advanceQwkIdxAfterPost(workItems, enabledSubs) {
	var byPas = {};
	for (var item of workItems) {
		if (item.pas_id === null || item.pas_id === undefined) continue; // skip PM items
		if (!byPas[item.pas_id]) byPas[item.pas_id] = [];
		byPas[item.pas_id].push(item);
	}

	for (var pasId of Object.keys(byPas)) {
		var items  = byPas[pasId];
		var newIdx = null;

		for (var item of items) {
			if (item.success) {
				newIdx = item.msgId;
			} else {
				break;  // stop at first failure — retry from here next time
			}
		}

		if (newIdx !== null) {
			await postgres.write(
				'UPDATE peer_area_subscriptions SET msg_idx = $1 WHERE id = $2',
				[newIdx, parseInt(pasId)]
			);
		}
	}
}

// Push outbound messages to all active QWK connections.
async function pushAllQWK() {
	var connections = await peerConnections.getActiveConnectionsByNetworkType('QWK');
	if (!connections || connections.length === 0) {
		alogger.writeClog(5, 'pushAllQWK: no active QWK connections found', 'tosser', 'cyan', false, 'tosser', false, false, false);
		return;
	}

	alogger.writeClog(5,
		'pushAllQWK: processing ' + connections.length + ' QWK connection(s)', 'tosser',
		'cyan'
	, false, false);

	for (var conn of connections) {
		alogger.writeClog(5,
			'pushAllQWK: pushing to ' + conn.peer_name + ' (' + conn.uuid + ')', 'tosser',
			'cyan'
		, false, false);
		var result = await pushToQwkPeer(conn.uuid);
		if (!result.status) {
			alogger.writeClog(3,
				'pushAllQWK: push failed for ' + conn.uuid + ': ' +
				result.errormessages.join(', '), 'tosser',
				'redbright'
			, false, false);
		} else {
			alogger.writeClog(5,
				'pushAllQWK: completed ' + conn.uuid +
				' — posted=' + result.totalPosted +
				' skipped=' + result.totalSkipped, 'tosser',
				'greenbright'
			, false, false);
		}
	}
}

// ---------------------------------------------------------------------------
// Reset outbound idx
// ---------------------------------------------------------------------------

// Reset outbound msg_idx for all subscriptions on a connection, or optionally
// a single area, so the next toss rescans from the beginning.
async function resetQwkOutboundIdx(peerConnectionUUID, areaId) {
	var dbconn = await peerConnections.getConnectionByUUID(peerConnectionUUID);
	if (!dbconn) return { status: false, errormessages: ['Connection not found'] };

	var sql    = 'UPDATE peer_area_subscriptions SET msg_idx = 0 WHERE peer_connection_id = $1';
	var params = [dbconn.id];

	if (areaId) {
		sql    += ' AND area_id = $2';
		params.push(parseInt(areaId));
	}

	var err = await postgres.write(sql, params);
	if (err) {
		alogger.writeClog(3,
			'resetQwkOutboundIdx: failed for ' + peerConnectionUUID + ': ' + err.message, 'tosser',
			'redbright'
		, false, false);
		return { status: false, errormessages: [err.message] };
	}

	alogger.writeClog(5,
		'resetQwkOutboundIdx: reset msg_idx for connection ' + peerConnectionUUID +
		(areaId ? ' area ' + areaId : ' all areas'), 'tosser',
		'greenbright'
	, false, false);
	return { status: true, errormessages: [] };
}

export {
	pullFromQwkPeer,
	pullAllQWK,
	pushToQwkPeer,
	pushAllQWK,
	resetQwkOutboundIdx
};
