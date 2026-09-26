// qwkPacketBuilder.js
// QWK packet generation module for Canectic BBS.
//
// Two layers:
//   Low-level (reusable for nodes, users, and future callers):
//     - buildControlDat()    → CONTROL.DAT text
//     - buildMessagesDat()   → MESSAGES.DAT buffer
//     - buildHeadersDatText() → HEADERS.DAT text
//     - assembleQwkPacket()  → .qwk file path
//
//   High-level (node connection specific):
//     - buildQwkForNode()    → gathers messages per subscriptions + HWM,
//                               applies echo suppression and tear/origin,
//                               returns path to .qwk ready for delivery

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as peerConnections from './peerConnections.js';
import * as systemAddresses from './systemAddresses.js';
import * as privateMessages from './privateMessages.js';
import { pendingQwkPmsFor } from './qwkPmRouting.js';
import { utf8ToCp437 } from '../utils/codepageConversions.js';
import {
	QWK_RECORD_SIZE,
	QWK_LINE_TERM,
	buildQwkHeader,
	buildQwkBody
} from './qwkClasses.js';
import appConfig from "../config/appConfig.js";


// ---------------------------------------------------------------------------
// Low-level: CONTROL.DAT
// ---------------------------------------------------------------------------

// Build CONTROL.DAT text (CRLF line endings).
//
// options:
//   bbsName      — BBS name string
//   bbsLocation  — city / location string
//   bbsPhone     — phone string (or 'N/A')
//   sysopName    — sysop display name
//   qwkId        — this system's QWK ID
//   recipientName — username/node this packet is for
//   conferences  — array of { number, name }
//   totalMessages — total message count in the packet
function buildControlDat(options) {
	var bbsName       = options.bbsName      || 'Canectic BBS';
	var bbsLocation   = options.bbsLocation  || '';
	var bbsPhone      = options.bbsPhone     || 'N/A';
	var sysopName     = options.sysopName    || 'Sysop';
	var qwkId         = options.qwkId        || 'UNKNOWN';
	var recipientName = options.recipientName || '';
	var conferences   = options.conferences  || [];
	var totalMessages = options.totalMessages || 0;

	var now = new Date();
	var mm  = String(now.getMonth() + 1).padStart(2, '0');
	var dd  = String(now.getDate()).padStart(2, '0');
	var yyyy = String(now.getFullYear());
	var hh  = String(now.getHours()).padStart(2, '0');
	var mi  = String(now.getMinutes()).padStart(2, '0');
	var ss  = String(now.getSeconds()).padStart(2, '0');
	var dateTimeStr = mm + '-' + dd + '-' + yyyy + ',' + hh + ':' + mi + ':' + ss;

	var lines = [];
	lines.push(bbsName);
	lines.push(bbsLocation);
	lines.push(bbsPhone);
	lines.push(sysopName);
	lines.push('0000,' + qwkId.toUpperCase());
	lines.push(dateTimeStr);
	lines.push(recipientName);
	lines.push('');                         // password (blank)
	lines.push('0');                        // starting message number
	lines.push(String(totalMessages));      // total messages
	lines.push(String(conferences.length)); // number of conferences - 1 (conf 0 = mail)

	// Conference 0 — personal email (always first, even if empty)
	lines.push('0');
	lines.push('E-mail');

	// Subscribed conferences
	for (var conf of conferences) {
		lines.push(String(conf.number));
		lines.push((conf.name || '').substring(0, 10));
	}

	// Bulletin filenames (optional — leave standard placeholders)
	lines.push('HELLO');
	lines.push('BBSNEWS');
	lines.push('GOODBYE');

	return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Low-level: MESSAGES.DAT
// ---------------------------------------------------------------------------

// Build a MESSAGES.DAT buffer from an array of message items.
// Each item: { msg, conferenceNum }
// msg must have: system_time, to_user, from_user, subject, body_text, utf8, reply_ref
//
// Returns { buffer, itemOffsets } where itemOffsets[i] = byte offset of
// message i's header in the buffer (for HEADERS.DAT cross-reference).
function buildMessagesDat(messageItems, qwkId) {
	var chunks = [];
	var itemOffsets = [];
	var currentOffset = 0;

	// Record 0: 128-byte header block with our QWK-ID
	var headerBlock = Buffer.alloc(QWK_RECORD_SIZE, 0x20);
	var idString = (qwkId || 'UNKNOWN').toUpperCase();
	headerBlock.write(idString, 0, Math.min(idString.length, QWK_RECORD_SIZE), 'ascii');
	chunks.push(headerBlock);
	currentOffset += QWK_RECORD_SIZE;

	// Identification block (same as Record 0 in Synchronet, sometimes
	// contains the producing software name — space-padded)
	// Already done above as Record 0.

	for (var i = 0; i < messageItems.length; i++) {
		var item = messageItems[i];

		// Ask what the body says rather than guessing from which column is set.
		// See messageText.canonicalText: "utf8 is set, so body_text is raw
		// CP437" holds for a QWK message and not for an FTN one.
		var bodyForPack = '';
		var cp437Bytes = utf8ToCp437(item.msg.body_text || '');
		for (var j = 0; j < cp437Bytes.length; j++) {
			bodyForPack += String.fromCharCode(cp437Bytes[j]);
		}

		var bodyBuf = buildQwkBody(bodyForPack);
		var hdrBuf  = buildQwkHeader(item.msg, item.conferenceNum, bodyBuf.length, item.isPrivate || false);

		itemOffsets.push(currentOffset);

		chunks.push(hdrBuf);
		chunks.push(bodyBuf);
		currentOffset += hdrBuf.length + bodyBuf.length;
	}

	return {
		buffer: Buffer.concat(chunks),
		itemOffsets: itemOffsets
	};
}

// ---------------------------------------------------------------------------
// Low-level: HEADERS.DAT
// ---------------------------------------------------------------------------

// Build HEADERS.DAT text from message items and their byte offsets.
// messageItems[i] and offsets[i] must correspond.
function buildHeadersDatText(messageItems, offsets, localQwkId) {
	var entries = [];

	for (var i = 0; i < messageItems.length; i++) {
		var item   = messageItems[i];
		var offset = offsets[i];
		var msg    = item.msg;

		var lines = [];

		// Section header — hex offset
		lines.push('[' + offset.toString(16).toUpperCase() + ']');

		// UTF-8 flag
		lines.push('Utf8 = ' + (msg.utf8 ? 'true' : 'false'));

		// Message-ID
		if (msg.msg_id) {
			lines.push('Message-ID: ' + msg.msg_id);
		}

		// Reply-ID
		if (msg.reply_to) {
			lines.push('Reply-ID: ' + msg.reply_to);
		}

		// Timestamps
		var dt  = msg.system_time ? new Date(msg.system_time) : new Date();
		var now = new Date();
		lines.push('WhenWritten:  ' + formatTimestamp(dt));
		lines.push('WhenExported: ' + formatTimestamp(now));

		// ExportedFrom
		if (localQwkId) {
			var destStr = item.conferenceNum ? String(item.conferenceNum) : '0';
			lines.push('ExportedFrom: ' + localQwkId.toUpperCase() +
				' ' + destStr + ' ' + (msg.id || 0));
		}

		// Sender / recipient
		lines.push('Sender: ' + (msg.from_user || 'Unknown'));
		lines.push('To: ' + (msg.to_user || 'All'));
		lines.push('Subject: ' + (msg.subject || ''));

		// Conference
		lines.push('Conference: ' + (item.conferenceNum || 0));

		// Product ID
		lines.push('X-FTN-PID: Canectic QWK Tosser');

		// Blank line terminates entry
		lines.push('');

		entries.push(lines.join('\n'));
	}

	return entries.join('\n') + '\n';
}

// Format a Date as HEADERS.DAT timestamp: YYYYMMDDHHMMSS+0000  0000
function formatTimestamp(dt) {
	var yyyy = String(dt.getUTCFullYear());
	var mm   = String(dt.getUTCMonth() + 1).padStart(2, '0');
	var dd   = String(dt.getUTCDate()).padStart(2, '0');
	var hh   = String(dt.getUTCHours()).padStart(2, '0');
	var mi   = String(dt.getUTCMinutes()).padStart(2, '0');
	var ss   = String(dt.getUTCSeconds()).padStart(2, '0');
	return yyyy + mm + dd + hh + mi + ss + '+0000  0000';
}

// ---------------------------------------------------------------------------
// Low-level: Assemble QWK packet
// ---------------------------------------------------------------------------

// Assembles a complete .QWK packet from components.
//
// options:
//   packetName     — filename base (our QWK-ID, e.g. "UNDREDUX")
//   tmpDir         — working directory for temp files
//   controlDat     — CONTROL.DAT text (string)
//   messagesDat    — MESSAGES.DAT buffer (Buffer)
//   headersDat     — HEADERS.DAT text (string, optional)
//   netflagsDat    — NETFLAGS.DAT buffer (Buffer, optional)
//
// Returns path to the generated .qwk file.
function assembleQwkPacket(options) {
	var packetName  = (options.packetName || 'UNKNOWN').toUpperCase();
	var tmpDir      = options.tmpDir;
	var qwkFileName = packetName + '.qwk';
	var qwkPath     = path.join(tmpDir, qwkFileName);

	fs.mkdirSync(tmpDir, { recursive: true });

	// Write component files
	var filesToZip = [];

	var controlPath = path.join(tmpDir, 'CONTROL.DAT');
	fs.writeFileSync(controlPath, options.controlDat);
	filesToZip.push(controlPath);

	var msgPath = path.join(tmpDir, 'MESSAGES.DAT');
	fs.writeFileSync(msgPath, options.messagesDat);
	filesToZip.push(msgPath);

	if (options.headersDat) {
		var headersPath = path.join(tmpDir, 'HEADERS.DAT');
		fs.writeFileSync(headersPath, options.headersDat);
		filesToZip.push(headersPath);
	}

	if (options.netflagsDat) {
		var netflagsPath = path.join(tmpDir, 'NETFLAGS.DAT');
		fs.writeFileSync(netflagsPath, options.netflagsDat);
		filesToZip.push(netflagsPath);
	}

	// Create zip using system zip
	var fileArgs = filesToZip.map(f => JSON.stringify(f)).join(' ');
	try {
		execSync('zip -j ' + JSON.stringify(qwkPath) + ' ' + fileArgs);
	} catch (err) {
		throw new Error('Failed to create QWK zip (is zip installed?): ' + err.message);
	}

	// Remove intermediate files
	for (var f of filesToZip) {
		fs.unlinkSync(f);
	}

	return qwkPath;
}

// ---------------------------------------------------------------------------
// High-level: Build QWK for a node connection
// ---------------------------------------------------------------------------

// Builds a complete QWK packet for a hub-mode node connection.
// Gathers new messages from all subscribed conferences since last HWM,
// applies echo suppression and tear/origin, then assembles the packet.
//
// Returns { status, qwkPath, packetId, totalMessages, totalSkipped, reused,
// errormessages }.
//
// Nothing is committed here. The packet is written with a sidecar
// (<packet>.json) holding what delivering it will commit: each
// subscription's new high-water mark and the PM outbox rows it carries. The
// caller delivers the packet and then calls commitNodePacket() with its
// packetId once the node confirms receipt. Until then every request gets the
// SAME packet back, so a download that fails part way loses nothing; before,
// the HWM advanced when the packet was built and a failed download lost every
// message in it.
async function buildQwkForNode(peerConnectionUUID) {
	var returnObj = {
		status: false,
		qwkPath: null,
		packetId: null,
		totalMessages: 0,
		totalSkipped: 0,
		reused: false,
		errormessages: []
	};

	var dbconn = await peerConnections.getConnectionByUUIDWithNetwork(peerConnectionUUID);
	if (!dbconn || !dbconn.active) {
		returnObj.errormessages.push('Connection not found or inactive: ' + peerConnectionUUID);
		return returnObj;
	}

	var cd = dbconn.connection_data || {};
	var remoteQwkId = (cd.remote_qwk_id || '').trim().toUpperCase();
	if (!remoteQwkId) {
		returnObj.errormessages.push('No remote_qwk_id configured');
		return returnObj;
	}

	// Resolve our local QWK-ID and origin line from system address
	var localQwkId = '';
	var originLine = '';
	var sysAddr = null;
	if (dbconn.system_address_id) {
		sysAddr = await systemAddresses.getAddressById(dbconn.system_address_id);
	}
	if (!sysAddr && dbconn.network_id) {
		sysAddr = await systemAddresses.getDefaultAddress(dbconn.network_id);
	}
	if (sysAddr) {
		if (sysAddr.address) localQwkId = sysAddr.address.trim().toUpperCase();
		if (sysAddr.origin_line) originLine = sysAddr.origin_line.trim();
	}
	if (!localQwkId) {
		returnObj.errormessages.push('No local QWK-ID configured (set a system address)');
		return returnObj;
	}

	// Build tear/origin for locally-originated messages
	var bbsName = appConfig.get('boardname', 'Canectic BBS');
	var originText;
	if (originLine) {
		originText = originLine;
	} else {
		originText = bbsName + ' - ' + localQwkId;
	}
	var tearOrigin = '\r--- \r || Canectic || ' + originText + '\r';

	// Output directory for this node
	var outDir = path.join(process.cwd(), 'qnet', remoteQwkId, 'out');
	fs.mkdirSync(outDir, { recursive: true });

	// If a packet already exists, skip building — the node hasn't picked up
	// the last one yet. Overwriting risks data loss if a transfer is in
	// progress or failed mid-stream. The connection handler is responsible
	// for removing the packet after confirmed delivery.
	var existingQwk = path.join(outDir, localQwkId.toUpperCase() + '.qwk');

	// A sidecar with no packet beside it means the node took the packet: a
	// directory node (qnet-directory.js) copies it out of out/ and deletes it,
	// and that is the only acknowledgement it gives. Commit what the packet
	// carried before building the next one, or its messages go again. Also
	// finishes a commitNodePacket interrupted between its two deletes; the
	// commit is idempotent (msg_idx only moves forward, markSent repeats).
	if (!fs.existsSync(existingQwk)) {
		var collected = readPending(existingQwk);
		if (collected) {
			await commitPending(collected);
			try { fs.unlinkSync(pendingPath(existingQwk)); } catch (_) {}
			alogger.writeClog(5, 'buildQwkForNode: ' + remoteQwkId + ' collected ' + path.basename(existingQwk) +
				' (' + (collected.totalMessages || 0) + ' message(s))', 'tosser', 'greenbright', false, false);
		}
	}

	if (fs.existsSync(existingQwk)) {
		var pending = readPending(existingQwk);
		alogger.writeClog(5,
			'buildQwkForNode: existing QWK packet in ' + outDir +
			' not yet acknowledged, offering it again', 'tosser',
			'cyan'
		, false, false);
		returnObj.status = true;
		returnObj.reused = true;
		returnObj.qwkPath = existingQwk;
		returnObj.packetId = pending ? pending.packetId : null;
		returnObj.totalMessages = pending ? pending.totalMessages : 0;
		return returnObj;
	}

	// Get enabled subscriptions
	var enabledSubs = await postgres.query(
		`SELECT pas.id, pas.area_id, pas.msg_idx,
		        ma.shortcode, ma.name AS area_name, na.areatag
		 FROM peer_area_subscriptions pas
		 JOIN message_areas ma ON ma.id = pas.area_id
		 JOIN network_areas na ON na.area_id = pas.area_id
		                       AND na.network_id = $1
		 WHERE pas.peer_connection_id = $2
		   AND pas.enabled = true
		   AND na.active = true
		 ORDER BY na.areatag ASC`,
		[dbconn.network_id, dbconn.id]
	);

	// No conferences still leaves private mail to carry, so this is not a
	// reason to stop: it returned here, and a node with no subscriptions
	// never received a PM.
	if (!enabledSubs || enabledSubs.length === 0) {
		alogger.writeClog(5,
			'buildQwkForNode: no enabled subscriptions for ' + peerConnectionUUID, 'tosser',
			'cyan'
		, false, false);
		enabledSubs = [];
	}

	// Build conference list and gather messages
	var conferences = [];
	var messageItems = [];
	var workTracker = []; // tracks { pas_id, msgId, skip } for HWM advancement

	for (var sub of enabledSubs) {
		var conferenceNum = parseInt(sub.areatag, 10);
		if (isNaN(conferenceNum)) continue;

		conferences.push({
			number: conferenceNum,
			name:   (sub.area_name || sub.shortcode || '').substring(0, 10)
		});

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
				for (var msg of msglist) {
					// Echo suppression — don't send back messages that came from this network
					if (msg.source_network_id && msg.source_network_id === dbconn.network_id) {
						workTracker.push({
							pas_id: sub.id, msgId: msg.id, skip: true
						});
						returnObj.totalSkipped++;
						continue;
					}

					// Tear/origin handling
					var bodyText = msg.body_text || '';
					var hasTear = /---\s*[\r\n]/.test(bodyText);

					if (!msg.source_network_id) {
						// Local message — add our tear/origin
						if (hasTear) {
							bodyText = bodyText.replace(/\r?---\s*[\r\n][\s\S]*$/, '');
						}
						msg.body_text = bodyText + tearOrigin;
						if (msg.utf8) {
							var utf8Text = msg.utf8 || '';
							if (/---\s*[\r\n]/.test(utf8Text)) {
								utf8Text = utf8Text.replace(/\r?---\s*[\r\n][\s\S]*$/, '');
							}
							msg.utf8 = utf8Text + tearOrigin;
						}
					} else if (msg.origin_line && !hasTear) {
						// Foreign message, origin stripped — restore it
						var restoredOrigin = '\r--- \r * Origin: ' + msg.origin_line + '\r';
						msg.body_text = bodyText + restoredOrigin;
						if (msg.utf8) {
							msg.utf8 = (msg.utf8 || '') + restoredOrigin;
						}
					}

					messageItems.push({
						msg: msg,
						conferenceNum: conferenceNum
					});

					workTracker.push({
						pas_id: sub.id, msgId: msg.id, skip: false
					});
				}
			}
		}
	}

	// --- Gather pending QWK private messages (conference 0) ---
	var pendingPMs = await pendingQwkPmsFor(peerConnectionUUID);
	var pmWorkItems = [];

	if (pendingPMs && pendingPMs.length > 0) {
		// Add conference 0 to the conference list if not already there
		var hasConf0 = conferences.some(function(c) { return c.number === 0; });
		if (!hasConf0) {
			conferences.unshift({ number: 0, name: 'Personal' });
		}

		for (var pm of pendingPMs) {
			messageItems.push({
				msg: {
					id: pm.id,
					from_user: pm.from_user || '',
					to_user: pm.to_user || '',
					subject: pm.subject || '',
					body_text: pm.body_text || '',
					utf8: null, // null so buildMessagesDat runs utf8ToCp437 conversion
					system_time: pm.system_time || new Date(),
					reply_ref: 0
				},
				conferenceNum: 0,
				isPrivate: true
			});
			pmWorkItems.push({ pmOutboxId: pm.id });
		}

		alogger.writeClog(5,
			'buildQwkForNode: ' + pendingPMs.length + ' QWK PM(s) added as conference 0', 'tosser',
			'cyan'
		, false, false);
	}

	if (messageItems.length === 0) {
		alogger.writeClog(5,
			'buildQwkForNode: no new messages for ' + remoteQwkId, 'tosser',
			'cyan'
		, false, false);
		// Still advance HWM past skipped messages
		await advanceHwmForItems(workTracker, enabledSubs);
		returnObj.status = true;
		return returnObj;
	}

	// Build packet components
	var controlDat = buildControlDat({
		bbsName:       bbsName,
		bbsLocation:   appConfig.get('boardlocation', ''),
		bbsPhone:      appConfig.get('boardphone', 'N/A'),
		sysopName:     appConfig.get('sysopname', 'Sysop'),
		qwkId:         localQwkId,
		recipientName: remoteQwkId,
		conferences:   conferences,
		totalMessages: messageItems.length
	});

	var msgResult = buildMessagesDat(messageItems, localQwkId);

	var headersDat = buildHeadersDatText(
		messageItems, msgResult.itemOffsets, localQwkId
	);

	// Build NETFLAGS.DAT — all 0x01 bytes, one per conference + 1 for conf 0
	var netflagsBuf = Buffer.alloc(conferences.length + 1, 0x01);

	// Assemble packet — outDir already created during existing-packet check
	var qwkPath = assembleQwkPacket({
		packetName:  localQwkId,
		tmpDir:      outDir,
		controlDat:  controlDat,
		messagesDat: msgResult.buffer,
		headersDat:  headersDat,
		netflagsDat: netflagsBuf
	});

	alogger.writeClog(5,
		'buildQwkForNode: built ' + path.basename(qwkPath) + ' with ' +
		messageItems.length + ' message(s) for ' + remoteQwkId, 'tosser',
		'greenbright'
	, false, false);

	// What delivering this packet commits, written beside it. Committed by
	// commitNodePacket() when the node acknowledges, not here.
	var packetId = crypto.randomUUID();
	writePending(qwkPath, {
		packetId:      packetId,
		connection:    peerConnectionUUID,
		builtAt:       new Date().toISOString(),
		totalMessages: messageItems.length,
		hwm:           hwmFor(workTracker),
		pmIds:         pmWorkItems.map(function (p) { return p.pmOutboxId; })
	});

	returnObj.status = true;
	returnObj.qwkPath = qwkPath;
	returnObj.packetId = packetId;
	returnObj.totalMessages = messageItems.length;
	return returnObj;
}

function pendingPath(qwkPath) { return qwkPath + '.json'; }

function readPending(qwkPath) {
	try { return JSON.parse(fs.readFileSync(pendingPath(qwkPath), 'utf8')); } catch (_) { return null; }
}

function writePending(qwkPath, data) {
	var tmp = pendingPath(qwkPath) + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
	fs.renameSync(tmp, pendingPath(qwkPath));
}

// The highest message id per subscription among the items in a packet
// (posted or echo-suppressed). Pure.
//
// Numeric on purpose: postgres returns ids as STRINGS, and compared as text
// "10" < "9", so a packet of messages 1 to 10 committed 9 and delivered 10
// again in the next packet. advanceHwmForItems had the same comparison.
function hwmFor(workTracker) {
	var byPas = {};
	for (var item of workTracker || []) {
		var id = Number(item.msgId);
		if (!Number.isFinite(id)) continue;
		if (byPas[item.pas_id] === undefined || id > byPas[item.pas_id]) byPas[item.pas_id] = id;
	}
	return byPas;
}

/**
 * The node has the packet: advance its HWMs, mark its PMs sent, remove it.
 *
 * `packetId` must match the packet on disk. A stale or repeated
 * acknowledgement matches nothing and commits nothing, so it can never
 * advance past a packet the node has not seen. A packet with no sidecar
 * (built by a release before acknowledgements) is removed with nothing to
 * commit, since that release had already advanced its HWMs.
 *
 * @returns {{status: boolean, committed: boolean, errormessages: string[]}}
 */
async function commitNodePacket(peerConnectionUUID, packetId) {
	var out = { status: false, committed: false, errormessages: [] };
	var dbconn = await peerConnections.getConnectionByUUIDWithNetwork(peerConnectionUUID);
	if (!dbconn) { out.errormessages.push('Connection not found'); return out; }
	var cd = dbconn.connection_data || {};
	var remoteQwkId = (cd.remote_qwk_id || '').trim().toUpperCase();
	var outDir = path.join(process.cwd(), 'qnet', remoteQwkId, 'out');
	var packets = [];
	try { packets = fs.readdirSync(outDir).filter(function (f) { return /\.qwk$/i.test(f); }); } catch (_) {}
	if (packets.length === 0) { out.errormessages.push('No packet waiting'); return out; }

	var qwkPath = path.join(outDir, packets[0]);
	var pending = readPending(qwkPath);
	if (pending && pending.packetId !== packetId) {
		out.errormessages.push('Packet id does not match the packet waiting');
		return out;
	}
	if (pending) await commitPending(pending);
	try { fs.unlinkSync(qwkPath); } catch (_) {}
	try { fs.unlinkSync(pendingPath(qwkPath)); } catch (_) {}
	alogger.writeClog(5, 'commitNodePacket: ' + remoteQwkId + ' acknowledged ' + packets[0] +
		(pending ? ' (' + pending.totalMessages + ' message(s))' : ''), 'tosser', 'greenbright', false, false);
	out.status = true;
	out.committed = true;
	return out;
}

// What delivering a packet commits: its subscriptions' HWMs and its PMs.
async function commitPending(pending) {
	await advanceHwmForItems(Object.keys(pending.hwm || {}).map(function (k) {
		return { pas_id: k, msgId: pending.hwm[k] };
	}));
	for (var pmId of pending.pmIds || []) await privateMessages.markSent(pmId);
}

// Advance msg_idx for each subscription up to the highest consecutive
// message ID that was either posted or skipped.
async function advanceHwmForItems(workTracker, enabledSubs) {
	// Max msgId per subscription, compared as numbers (see hwmFor).
	var byPas = hwmFor(workTracker);

	for (var pasId in byPas) {
		var maxId = byPas[pasId];
		try {
			await postgres.write(
				'UPDATE peer_area_subscriptions SET msg_idx = $1 WHERE id = $2 AND msg_idx < $1',
				[maxId, parseInt(pasId)]
			);
		} catch (err) {
			alogger.writeClog(3,
				'advanceHwmForItems: failed to update pas ' + pasId + ': ' + err.message, 'tosser',
				'redbright'
			, false, false);
		}
	}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	// Low-level — reusable for user QWK packets, API endpoints, etc.
	buildControlDat,
	buildMessagesDat,
	buildHeadersDatText,
	assembleQwkPacket,

	// High-level — node connection specific
	buildQwkForNode,
	commitNodePacket,
	hwmFor
};
