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
import * as dotenv from 'dotenv';

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as peerConnections from './peerConnections.js';
import * as systemAddresses from './systemAddresses.js';
import { makeTransport } from './qwkTransport.js';
import {
	parseControlDat,
	parseMessagesDAT,
	buildRepPacket,
	unzipQwkPacket
} from './qwkClasses.js';

dotenv.config();

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

// Find an existing thread by subject within a recent window (±30 days).
// Strips leading "Re:" prefixes for matching. Returns thread row or null.
async function findThreadBySubject(subject, systemTime, threadtable) {
	if (!subject) return null;

	var stripped = subject;
	var i = 0;
	while (stripped.toUpperCase().startsWith('RE:')) {
		stripped = stripped.substring(3).trim();
		i++;
		if (i > 10) break;
	}
	if (!stripped) stripped = subject;

	var startDate = new Date(systemTime);
	var endDate   = new Date(systemTime);
	startDate.setDate(startDate.getDate() - 30);
	endDate.setDate(endDate.getDate() + 14);

	// Try exact match on stripped subject first
	var thread = await postgres.queryOne(
		'SELECT * FROM ' + threadtable +
		' WHERE UPPER(subject) LIKE UPPER($1)' +
		' AND started_at BETWEEN $2 AND $3' +
		' ORDER BY last_message DESC LIMIT 1',
		[stripped, startDate, endDate]
	);
	if (thread) return thread;

	// Try with the original subject if different
	if (stripped !== subject) {
		thread = await postgres.queryOne(
			'SELECT * FROM ' + threadtable +
			' WHERE UPPER(subject) LIKE UPPER($1)' +
			' AND started_at BETWEEN $2 AND $3' +
			' ORDER BY last_message DESC LIMIT 1',
			[subject, startDate, endDate]
		);
	}
	return thread || null;
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

	// Threading — subject-based, same approach as FTN echomail.
	// If we have @REPLY, also try to find parent by msg_id for better threading.
	var threadId    = null;
	var threadidStr = null;

	if (replyTo) {
		// Try to find the parent message and its thread by @REPLY msg_id
		var parentMsg = await postgres.queryOne(
			'SELECT threadid, thread_id FROM ' + msgtable + ' WHERE msg_id = $1',
			[replyTo]
		);
		if (parentMsg && parentMsg.thread_id) {
			threadId    = parentMsg.thread_id;
			threadidStr = parentMsg.threadid;
		}
	}

	if (!threadId) {
		var existingThread = await findThreadBySubject(subject, systemTime, threadtable);
		if (existingThread) {
			threadId    = existingThread.id;
			threadidStr = existingThread.threadid;
		}
	}

	if (!threadId) {
		// Create new thread — use msgId as the threadid
		var tuuid     = uuidv4();
		var threadObj = {
			uuid:              tuuid,
			threadid:          msgId,
			subject:           subject,
			started_at:        systemTime,
			started_by:        fromUser,
			message_count:     1,
			last_message:      systemTime,
			last_message_from: fromUser
		};
		var tres = await postgres.insertObject(threadObj, threadtable);
		if (!tres.status || !tres.insertId) {
			alogger.writeAlog(3,
				'importQwkMessage: could not create thread for ' + dupeId +
				': ' + tres.errormessages.join(', '),
				'redbright'
			);
			returnObj.errormessages.push('Failed to create thread');
			return returnObj;
		}
		threadId    = tres.insertId;
		threadidStr = msgId;
	}

	var dbObj = {
		uuid:              uuid,
		msg_id:            msgId,
		qwk_msg_id:        dupeId,
		threadid:          threadidStr,
		thread_id:         threadId,
		reply_to:          replyTo,
		from_user:         fromUser,
		to_user:           toUser,
		subject:           subject,
		body_text:         qwkMsg.bodyText,
		raw_text:          qwkMsg.rawBody,
		utf8:              qwkMsg.utf8 || null,
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

	var mres = await postgres.insertObject(dbObj, msgtable);
	if (!mres.status) {
		// Roll back thread if we just created it
		if (threadidStr === msgId) {
			await postgres.write(
				'DELETE FROM ' + threadtable + ' WHERE threadid = $1',
				[msgId]
			);
		}
		alogger.writeAlog(3,
			'importQwkMessage: failed to insert message ' + dupeId +
			': ' + mres.errormessages.join(', '),
			'redbright'
		);
		returnObj.errormessages = returnObj.errormessages.concat(mres.errormessages);
		return returnObj;
	}

	// Update thread stats if this was a reply into an existing thread
	if (threadidStr !== msgId) {
		await postgres.write(
			'UPDATE ' + threadtable +
			' SET message_count = message_count + 1,' +
			' last_message = GREATEST(last_message, $1),' +
			' last_message_from = $2' +
			' WHERE id = $3',
			[systemTime, fromUser, threadId]
		);
	}

	returnObj.status   = true;
	returnObj.imported = true;
	return returnObj;
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
	var qwkBaseDir = path.join(process.cwd(), 'qwk', remoteQwkId);
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
			alogger.writeAlog(5,
				'pullFromQwkPeer: found existing message data from prior extraction — processing before pulling',
				'cyan'
			);
			hasExisting = true;
		}
	}

	// Phase 2: Acquire new packet if nothing existing to process
	if (!hasExisting) {
		if (isHubMode) {
			// Hub mode: scan in/ for .rep files from the node
			var inFiles = fs.readdirSync(inDir);
			var repFile = inFiles.find(f => f.toLowerCase().endsWith('.rep'));

			if (!repFile) {
				alogger.writeAlog(5,
					'pullFromQwkPeer: no REP packet in ' + inDir + ' — nothing to pull',
					'cyan'
				);
				returnObj.status = true;
				return returnObj;
			}

			var repPath = path.join(inDir, repFile);
			alogger.writeAlog(5,
				'pullFromQwkPeer: found REP from node: ' + repFile,
				'cyan'
			);

			try {
				unzipQwkPacket(repPath, extractDir);

				var freshFiles = fs.readdirSync(extractDir);
				alogger.writeAlog(5,
					'pullFromQwkPeer: extracted ' + freshFiles.length + ' file(s): ' +
					freshFiles.join(', '),
					'cyan'
				);

				// Remove the .rep after successful extraction
				fs.unlinkSync(repPath);

			} catch (err) {
				alogger.writeAlog(3,
					'pullFromQwkPeer: REP extract error for ' + peerConnectionUUID +
					': ' + err.message,
					'redbright'
				);
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

			alogger.writeAlog(5,
				'pullFromQwkPeer: downloading ' + remotePath +
				(cd.host ? ' from ' + cd.host + ':' + (cd.port || 21) : ''),
				'cyan'
			);

			try {
				await transport.downloadFile(remotePath, localQwk);
			} catch (dlErr) {
				await transport.disconnect();
				// 550 (FTP) or ENOENT (directory) = file not found — normal when no packet is waiting
				if ((dlErr.message && dlErr.message.indexOf('550') !== -1) ||
				    dlErr.code === 'ENOENT') {
					alogger.writeAlog(5,
						'pullFromQwkPeer: no QWK packet waiting at ' + remotePath +
						' — nothing to pull',
						'cyan'
					);
					returnObj.status = true;
					return returnObj;
				}
				// Any other download error — bail
				throw dlErr;
			}

			await transport.disconnect();
			transport = null;

			// Extract fresh download
			alogger.writeAlog(5,
				'pullFromQwkPeer: extracting ' + localQwk + ' → ' + extractDir,
				'cyan'
			);
			unzipQwkPacket(localQwk, extractDir);

			// Log what came out of the zip
			var freshFiles = fs.readdirSync(extractDir);
			alogger.writeAlog(5,
				'pullFromQwkPeer: extracted ' + freshFiles.length + ' file(s): ' +
				freshFiles.join(', '),
				'cyan'
			);

		} catch (err) {
			alogger.writeAlog(3,
				'pullFromQwkPeer: download/extract error for ' + peerConnectionUUID +
				': ' + err.message,
				'redbright'
			);
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
			alogger.writeAlog(5, 'pullFromQwkPeer: no extracted directory — nothing to process', 'cyan');
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
			alogger.writeAlog(5,
				'pullFromQwkPeer: no message data in extracted directory — no new messages',
				'cyan'
			);
			returnObj.status = true;
			return returnObj;
		}

		alogger.writeAlog(5,
			'pullFromQwkPeer: using message file: ' + messagesFile,
			'cyan'
		);

		// CONTROL.DAT is optional — present in offline reader packets but often
		// absent in QWK networking mode. Parse it for logging if available.
		if (controlFile) {
			var controlText = fs.readFileSync(path.join(extractDir, controlFile), 'ascii');
			var controlDat  = parseControlDat(controlText);
			alogger.writeAlog(5,
				'pullFromQwkPeer: CONTROL.DAT present — hub is ' +
				controlDat.bbsName + ', ' + controlDat.conferences.length +
				' conference(s) listed',
				'cyan'
			);
		} else {
			alogger.writeAlog(5,
				'pullFromQwkPeer: no CONTROL.DAT — QWK net mode, using subscription map',
				'cyan'
			);
		}

		var messagesBuf = fs.readFileSync(path.join(extractDir, messagesFile));
		var messages    = parseMessagesDAT(messagesBuf);

		alogger.writeAlog(5,
			'pullFromQwkPeer: ' + messages.length + ' message(s) in MESSAGES.DAT',
			'cyan'
		);

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
		alogger.writeAlog(5,
			'pullFromQwkPeer: conference map has ' + confKeys.length +
			' subscription(s): ' + confKeys.join(', '),
			'cyan'
		);

		var highWaterMarks = cd.high_water_marks || {};
		var skippedConfs = {};

		// Import messages
		for (var msg of messages) {
			// Skip conference 0 (personal/netmail)
			if (msg.conferenceNum === 0) continue;

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
				alogger.writeAlog(3,
					'pullFromQwkPeer: import error for conf ' + msg.conferenceNum +
					' msg ' + msg.msgNumber + ': ' + result.errormessages.join(', '),
					'redbright'
				);
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
			alogger.writeAlog(5,
				'pullFromQwkPeer: skipped unsubscribed conferences: ' + skippedSummary,
				'yellow'
			);
		}

		// Persist high-water marks
		await peerConnections.updateConnectionData(
			peerConnectionUUID,
			{ high_water_marks: highWaterMarks }
		);

		alogger.writeAlog(5,
			'pullFromQwkPeer: ' + peerConnectionUUID +
			' — imported=' + returnObj.totalImported +
			' duplicate=' + returnObj.totalDuplicate,
			'greenbright'
		);

		// Processing complete — remove the extracted directory so it isn't
		// reprocessed next cycle. The .QWK file stays for reference.
		fs.rmSync(extractDir, { recursive: true, force: true });
		alogger.writeAlog(5,
			'pullFromQwkPeer: cleaned up extracted directory',
			'cyan'
		);

		returnObj.status = true;

	} catch (err) {
		alogger.writeAlog(3,
			'pullFromQwkPeer: processing error for ' + peerConnectionUUID + ': ' + err.message,
			'redbright'
		);
		returnObj.errormessages.push(err.message);
	}

	return returnObj;
}

// Pull from all active QWK connections.
async function pullAllQWK() {
	var connections = await peerConnections.getActiveConnectionsByNetworkType('QWK');
	if (!connections || connections.length === 0) {
		alogger.writeAlog(5, 'pullAllQWK: no active QWK connections found', 'cyan');
		return;
	}

	alogger.writeAlog(5,
		'pullAllQWK: processing ' + connections.length + ' QWK connection(s)',
		'cyan'
	);

	for (var conn of connections) {
		alogger.writeAlog(5,
			'pullAllQWK: pulling from ' + conn.peer_name + ' (' + conn.uuid + ')',
			'cyan'
		);
		var result = await pullFromQwkPeer(conn.uuid);
		if (!result.status) {
			alogger.writeAlog(3,
				'pullAllQWK: pull failed for ' + conn.uuid + ': ' +
				result.errormessages.join(', '),
				'redbright'
			);
		} else {
			alogger.writeAlog(5,
				'pullAllQWK: completed ' + conn.uuid +
				' — imported=' + result.totalImported +
				' duplicate=' + result.totalDuplicate,
				'greenbright'
			);
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

	// Hub mode: outbound is QWK packet generation, not REP uploads.
	// QWK generation will be handled by a separate module — skip for now.
	if (cd.transport === 'hub') {
		alogger.writeAlog(5,
			'pushToQwkPeer: skipping hub connection ' + peerConnectionUUID +
			' — QWK generation not yet implemented',
			'cyan'
		);
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
		alogger.writeAlog(5,
			'pushToQwkPeer: system_address=' + sysAddr.address +
			' origin_line=' + JSON.stringify(sysAddr.origin_line),
			'cyan'
		);
		if (sysAddr.address) {
			localQwkId = sysAddr.address.trim().toUpperCase();
		}
		if (sysAddr.origin_line) {
			originLine = sysAddr.origin_line.trim();
		}
	} else {
		alogger.writeAlog(5,
			'pushToQwkPeer: no system address found (connection or network default)',
			'yellow'
		);
	}
	if (!localQwkId) {
		// Fallback to FTP username if no system address configured
		localQwkId = (cd.username || 'UNKNOWN').toUpperCase();
	}

	// Build tear line + origin for locally-originated messages.
	// Format: "--- \r || Canectic || <origin text>\r"
	// If origin_line is set on the system address, use it directly.
	// If blank: "<BBS_NAME> - <localQwkId>" or just "<localQwkId>"
	var bbsName = process.env.boardname || 'Canectic BBS';
	var originText;
	if (originLine) {
		originText = originLine;
	} else if (bbsName) {
		originText = bbsName + ' - ' + localQwkId;
	} else {
		originText = localQwkId;
	}
	var tearOrigin = '\r--- \r || Canectic || ' + originText + '\r';
	alogger.writeAlog(5,
		'pushToQwkPeer: originText=' + JSON.stringify(originText),
		'cyan'
	);

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
		alogger.writeAlog(5,
			'pushToQwkPeer: no enabled subscriptions for ' + peerConnectionUUID,
			'cyan'
		);
		returnObj.status = true;
		return returnObj;
	}

	// Build ordered work list per subscription.
	// Skipped messages (echo suppression) are included as { skip: true } so
	// we can advance past them correctly without blocking on failed posts.
	var workItems = [];

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

	if (workItems.filter(i => !i.skip).length === 0) {
		// Only skips — advance past them and return
		alogger.writeAlog(5,
			'pushToQwkPeer: nothing to post for ' + peerConnectionUUID,
			'cyan'
		);
		await advanceQwkIdxForSkips(workItems);
		returnObj.status = true;
		return returnObj;
	}

	// Build REP packet
	var outDir = path.join(process.cwd(), 'qwk', remoteQwkId, 'out');
	fs.mkdirSync(outDir, { recursive: true });

	var repFileName = packetName + '.rep';
	var repPath     = path.join(outDir, repFileName);
	var remoteOutbox = cd.remote_outbox || '';
	if (remoteOutbox && !remoteOutbox.endsWith('/')) remoteOutbox += '/';
	var remotePath = remoteOutbox + repFileName;

	// Phase 1: If a REP file already exists from a prior failed upload,
	// try to deliver it first before building a new one.
	if (fs.existsSync(repPath)) {
		alogger.writeAlog(5,
			'pushToQwkPeer: found existing REP from prior build — uploading before building new',
			'cyan'
		);

		var transport = null;
		try {
			transport = makeTransport(cd);
			await transport.connect(cd);

			alogger.writeAlog(5,
				'pushToQwkPeer: uploading existing ' + remotePath +
				(cd.host ? ' to ' + cd.host + ':' + (cd.port || 21) : ''),
				'cyan'
			);

			await transport.uploadFile(repPath, remotePath);
			await transport.disconnect();
			transport = null;

			// Existing REP delivered — remove it
			fs.unlinkSync(repPath);
			alogger.writeAlog(5,
				'pushToQwkPeer: existing REP delivered and removed — ' +
				'skipping new build this cycle to let hub process',
				'greenbright'
			);

			// Don't immediately build and upload another REP — the hub needs
			// time to process the one we just sent. New messages will be
			// picked up next toss cycle.
			returnObj.status = true;
			return returnObj;
		} catch (err) {
			alogger.writeAlog(3,
				'pushToQwkPeer: failed to upload existing REP for ' +
				peerConnectionUUID + ': ' + err.message +
				' — will retry next cycle, skipping new build',
				'redbright'
			);
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

		alogger.writeAlog(5,
			'pushToQwkPeer: building REP with ' + postItems.length +
			' message(s)' + (cd.host ? ' for ' + cd.host : ''),
			'cyan'
		);

		buildRepPacket(postItems, packetName, outDir, localQwkId);

		// Upload
		transport = makeTransport(cd);
		await transport.connect(cd);

		alogger.writeAlog(5,
			'pushToQwkPeer: uploading ' + remotePath +
			(cd.host ? ' to ' + cd.host + ':' + (cd.port || 21) : ''),
			'cyan'
		);

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
		alogger.writeAlog(3,
			'pushToQwkPeer: error for ' + peerConnectionUUID + ': ' + err.message,
			'redbright'
		);
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
	alogger.writeAlog(5,
		'pushToQwkPeer: ' + peerConnectionUUID +
		' posted=' + returnObj.totalPosted +
		' skipped=' + returnObj.totalSkipped,
		'greenbright'
	);
	return returnObj;
}

// Advance msg_idx for a list of work items that are all skips (no posts attempted).
async function advanceQwkIdxForSkips(workItems) {
	var byPas = {};
	for (var item of workItems) {
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
		alogger.writeAlog(5, 'pushAllQWK: no active QWK connections found', 'cyan');
		return;
	}

	alogger.writeAlog(5,
		'pushAllQWK: processing ' + connections.length + ' QWK connection(s)',
		'cyan'
	);

	for (var conn of connections) {
		alogger.writeAlog(5,
			'pushAllQWK: pushing to ' + conn.peer_name + ' (' + conn.uuid + ')',
			'cyan'
		);
		var result = await pushToQwkPeer(conn.uuid);
		if (!result.status) {
			alogger.writeAlog(3,
				'pushAllQWK: push failed for ' + conn.uuid + ': ' +
				result.errormessages.join(', '),
				'redbright'
			);
		} else {
			alogger.writeAlog(5,
				'pushAllQWK: completed ' + conn.uuid +
				' — posted=' + result.totalPosted +
				' skipped=' + result.totalSkipped,
				'greenbright'
			);
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
		alogger.writeAlog(3,
			'resetQwkOutboundIdx: failed for ' + peerConnectionUUID + ': ' + err.message,
			'redbright'
		);
		return { status: false, errormessages: [err.message] };
	}

	alogger.writeAlog(5,
		'resetQwkOutboundIdx: reset msg_idx for connection ' + peerConnectionUUID +
		(areaId ? ' area ' + areaId : ' all areas'),
		'greenbright'
	);
	return { status: true, errormessages: [] };
}

export {
	pullFromQwkPeer,
	pullAllQWK,
	pushToQwkPeer,
	pushAllQWK,
	resetQwkOutboundIdx
};
