// messages.js — Message viewing and posting model.
// Owns all view-facing and user-posting logic. echomail.js retains only
// network import/export (handleInboundEchoMessage, ftnToDb/dbToFtn,
// threadMessage, formatBodyHtml for import-time, outbound delivery).

//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as msgAreas from './msgAreas.js';
import * as msgGroups from './msgGroups.js';
import * as networkAreas from './networkAreas.js';
import * as systemAddresses from './systemAddresses.js';
import * as ftnUtils from '../utils/ftnUtils.js';
import * as codepageConversions from '../utils/codepageConversions.js';
import * as terminalText from '../utils/terminalText.js';
import * as alogger from '../utils/alogger.js';

dotenv.config();

const default_tzutc   = "-0600";
const currentversion  = process.env.currentversion  || "0.1a";
const product_string  = "Canectic BBS v" + currentversion;
const boardname       = process.env.boardname        || "Canectic BBS";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// escapeHtml — prevents XSS when rendering plain text as HTML.
// Used by formatBodyHtml's plain-text path. ANSI/pipe formatters handle
// their own escaping.
// ---------------------------------------------------------------------------

function escapeHtml(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// sanitizeMessageFields — removes dangerous HTML constructs from text fields.
// Called at the model layer so it covers both web posts and inbound network
// packets (FTN/NNTP/QWK). Targets script injection and dangerous elements
// while preserving legitimate text content and safe HTML for future rich
// editing support.
//
// What gets stripped:
//   - <script>, <style>, <iframe>, <object>, <embed>, <link>, <meta>, <base>,
//     <form>, <input>, <button>, <select>, <textarea> (tags and content)
//   - Event handler attributes (onclick, onerror, onload, etc.)
//   - javascript:, vbscript:, data: URI schemes in attributes
//
// What is preserved:
//   - Plain text including literal < and > characters
//   - Safe HTML tags (b, i, u, br, p, div, span, font, table, etc.)
//   - ANSI escape sequences, pipe codes, Ctrl-A codes (byte sequences, not HTML)
//   - &entities; (handled at render time)
//
// Exported so echomail.js, nntpTosser.js, qwkTosser.js can call on inbound.
// ---------------------------------------------------------------------------

function sanitizeMessageFields(formObj) {
	var sanitize = function(str) {
		if (!str || typeof str !== 'string') return str;
		// Remove dangerous tags and their content
		str = str.replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '');
		str = str.replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '');
		// Remove dangerous self-closing/void tags
		str = str.replace(/<\s*\/?\s*(iframe|object|embed|link|meta|base|form|input|button|select|textarea)\b[^>]*>/gi, '');
		// Remove event handler attributes from any remaining tags
		str = str.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
		// Remove javascript:, vbscript:, data: URI schemes in attributes
		str = str.replace(/(href|src|action|formaction)\s*=\s*["']?\s*(javascript|vbscript|data)\s*:/gi, '$1="removed:');
		return str;
	};
	if (formObj.subject)   formObj.subject   = sanitize(formObj.subject);
	if (formObj.from_user) formObj.from_user = sanitize(formObj.from_user);
	if (formObj.to_user)   formObj.to_user   = sanitize(formObj.to_user);
	if (formObj.body_text) formObj.body_text = sanitize(formObj.body_text);
	return formObj;
}

// ---------------------------------------------------------------------------
// formatBodyHtml — view-layer copy.
// Detects ANSI/pipe/Ctrl-A codes and routes to the appropriate formatter.
// Non-fatal — returns null on failure so callers always get a usable value.
// echomail.js keeps its own identical copy for import-time pre-rendering.
// ---------------------------------------------------------------------------

async function formatBodyHtml(displayText) {
	if (!displayText) return null;
	try {
		if (displayText.includes("\x1b[") ||
			/\|\d{2}/.test(displayText) ||
			displayText.includes("\x01")) {
			return await terminalText.formatTerminalText(displayText, {
				terminalWidth: 80,
				replaceAllSpaces: true,
				handlePipeCodes: true,
				handleAnsiCodes: true,
				handleCtrlACodes: true,
				resetOnNewline: true
			});
		}
		if (displayText.includes("   ")) {
			return codepageConversions.formatTextForHtml(displayText);
		}
		return escapeHtml(displayText).replace(/\r?\n/g, '<br>').replace(/\r/g, '<br>');
	} catch (_) {
		return null;
	}
}

// ---------------------------------------------------------------------------
// detectIsAnsi — check raw body text for terminal codes
// ---------------------------------------------------------------------------

function detectIsAnsi(text) {
	if (!text) return false;
	return text.includes("\x1b[") ||
		/\|\d{2}/.test(text) ||
		text.includes("\x01");
}

// ---------------------------------------------------------------------------
// Message tree builder — organises flat message lists into reply trees
// ---------------------------------------------------------------------------

function buildMessageTree(messages) {
	const messageMap   = new Map();
	const rootMessages = [];

	messages.forEach(msg => {
		messageMap.set(msg.msg_id, { ...msg, replies: [] });
	});

	messages.forEach(msg => {
		if (msg.reply_to && messageMap.has(msg.reply_to)) {
			messageMap.get(msg.reply_to).replies.push(messageMap.get(msg.msg_id));
		} else {
			rootMessages.push(messageMap.get(msg.msg_id));
		}
	});

	return rootMessages;
}

// ---------------------------------------------------------------------------
// Thread retrieval
// ---------------------------------------------------------------------------

async function getThreadsForArea(shortcode) {
	var shorty = shortcode.toLowerCase();
	var threadtablename = "mb_" + shorty + "_threads";
	var threadlist = await postgres.query(
		"SELECT * FROM " + threadtablename + " ORDER BY last_message DESC",
		[]
	);
	return threadlist || [];
}

async function getRecentThreadsForArea(shortcode) {
	var shorty = shortcode.toLowerCase();
	var threadtablename = "mb_" + shorty + "_threads";
	var threadlist = await postgres.query(
		"SELECT * FROM " + threadtablename + " WHERE last_message >= NOW() - INTERVAL '180 DAYS' ORDER BY last_message DESC",
		[]
	);
	if (!threadlist || threadlist.length < 50) {
		threadlist = await postgres.query(
			"SELECT * FROM " + threadtablename + " ORDER BY last_message DESC LIMIT 50",
			[]
		);
	}
	return threadlist || [];
}

// Paginated thread retrieval for lazy-scroll.
// options:
//   limit       — batch size (default 30)
//   beforeDate  — ISO timestamp string; fetch threads with last_message < this value
//   beforeId    — integer; tie-break when last_message matches (fetch id < this)
async function getThreadsPage(shortcode, options) {
	var shorty = shortcode.toLowerCase();
	var threadtablename = "mb_" + shorty + "_threads";
	var opts = options || {};
	var limit = opts.limit || 30;

	var conditions = [];
	var params = [];
	var pi = 1;

	if (opts.beforeDate) {
		if (opts.beforeId) {
			// Keyset pagination: (last_message, id) < (beforeDate, beforeId)
			conditions.push("(last_message < $" + pi + " OR (last_message = $" + pi + " AND id < $" + (pi + 1) + "))");
			params.push(opts.beforeDate, opts.beforeId);
			pi += 2;
		} else {
			conditions.push("last_message < $" + pi);
			params.push(opts.beforeDate);
			pi++;
		}
	}

	var whereClause = conditions.length > 0
		? " WHERE " + conditions.join(" AND ")
		: "";

	params.push(limit);
	var limitParam = "$" + pi;

	var queryText = "SELECT * FROM " + threadtablename + whereClause +
		" ORDER BY last_message DESC, id DESC LIMIT " + limitParam;

	var threadlist = await postgres.query(queryText, params);
	return threadlist || [];
}

async function getThreadCount(shortcode) {
	var shorty = shortcode.toLowerCase();
	var threadtablename = "mb_" + shorty + "_threads";
	var result = await postgres.queryOne(
		"SELECT COUNT(*) AS cnt FROM " + threadtablename,
		[]
	);
	return result ? parseInt(result.cnt) : 0;
}

async function getThreadByUUID(uuid, shortcode) {
	var shorty = shortcode.toLowerCase();
	var threadtablename = "mb_" + shorty + "_threads";
	var thread = await postgres.queryOne(
		"SELECT * FROM " + threadtablename + " WHERE uuid = $1",
		[uuid]
	);
	return thread;
}

// Batch lookup thread UUIDs by integer IDs. Returns { threadId: uuid, ... }
async function getThreadUUIDMap(shortcode, threadIds) {
	if (!threadIds || threadIds.length === 0) return {};
	var shorty = shortcode.toLowerCase();
	var threadtablename = "mb_" + shorty + "_threads";
	var rows = await postgres.query(
		"SELECT id, uuid FROM " + threadtablename + " WHERE id = ANY($1)",
		[threadIds]
	);
	var map = {};
	if (rows) {
		for (var row of rows) {
			map[row.id] = row.uuid;
		}
	}
	return map;
}

// ---------------------------------------------------------------------------
// Message retrieval
// ---------------------------------------------------------------------------

async function getMessageById(id, shortcode) {
	var shorty = shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";
	var msg = await postgres.queryOne(
		"SELECT * FROM " + msgtablename + " WHERE id = $1",
		[id]
	);
	return msg;
}

async function getMessagesForThread(shortcode, threadid) {
	var shorty = shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";
	var msglist = await postgres.query(
		"SELECT optional_attributes, msg_id, from_user, to_user, system_time, subject, reply_to, id, uuid, body_text, utf8, body_html FROM " +
		msgtablename + " WHERE thread_id = $1 ORDER BY system_time ASC",
		[threadid]
	);

	if (!msglist) return [];

	for (var msg of msglist) {
		// Use pre-rendered body_html if available (populated at import time).
		// Fall back to on-the-fly formatting for older messages.
		if (!msg.body_html) {
			var displayText = msg.utf8 || msg.body_text || '';
			msg.body_html = await formatBodyHtml(displayText);
			msg.isAnsi = detectIsAnsi(displayText);
		} else {
			// Pre-rendered — still need to detect if terminal rendering is needed
			var checkText = msg.utf8 || msg.body_text || '';
			msg.isAnsi = detectIsAnsi(checkText);
		}
	}

	return msglist;
}

async function getMessagesForArea(shortcode, options) {
	var shorty = shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";

	var opts = options || {};
	var limit  = opts.limit  || 100;
	var offset = opts.offset || 0;
	var order  = opts.order  || 'DESC';

	// Validate order to prevent injection
	order = (order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

	var msglist = await postgres.query(
		"SELECT optional_attributes, msg_id, from_user, to_user, system_time, subject, reply_to, thread_id, id, uuid, body_text, utf8, body_html " +
		"FROM " + msgtablename + " ORDER BY system_time " + order + " LIMIT $1 OFFSET $2",
		[limit, offset]
	);

	if (!msglist) return [];

	for (var msg of msglist) {
		if (!msg.body_html) {
			var displayText = msg.utf8 || msg.body_text || '';
			msg.body_html = await formatBodyHtml(displayText);
			msg.isAnsi = detectIsAnsi(displayText);
		} else {
			var checkText = msg.utf8 || msg.body_text || '';
			msg.isAnsi = detectIsAnsi(checkText);
		}
	}

	return msglist;
}

// ---------------------------------------------------------------------------
// getMessage — enhanced single-message retrieval with body_html fallback.
// Preferred over raw getMessageById for view-layer callers.
// ---------------------------------------------------------------------------

async function getMessage(id, shortcode) {
	var msg = await getMessageById(id, shortcode);
	if (!msg) return null;

	if (!msg.body_html) {
		var displayText = msg.utf8 || msg.body_text || '';
		msg.body_html = await formatBodyHtml(displayText);
		msg.isAnsi = detectIsAnsi(displayText);
	} else {
		var checkText = msg.utf8 || msg.body_text || '';
		msg.isAnsi = detectIsAnsi(checkText);
	}

	return msg;
}

// ---------------------------------------------------------------------------
// getMessageCount — total messages in an area
// ---------------------------------------------------------------------------

async function getMessageCount(shortcode) {
	var shorty = shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";
	var countResult = await postgres.query(
		"SELECT COUNT(*) FROM " + msgtablename,
		[]
	);
	return (countResult && countResult[0]) ? parseInt(countResult[0].count) : 0;
}

// Count messages before a given ID (optionally within a thread).
// Used for position-aware progress bars.
async function countMessagesBefore(shortcode, beforeId, threadId) {
	var shorty = shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";
	var conditions = ["id < $1"];
	var params = [beforeId];
	if (threadId) {
		conditions.push("thread_id = $2");
		params.push(threadId);
	}
	var result = await postgres.queryOne(
		"SELECT COUNT(*) AS cnt FROM " + msgtablename + " WHERE " + conditions.join(" AND "),
		params
	);
	return result ? parseInt(result.cnt) : 0;
}

// ---------------------------------------------------------------------------
// getMessages — paginated message retrieval with flexible filtering.
// options:
//   limit, offset, order ('ASC'|'DESC'),
//   threadId     — filter to a single thread
//   afterId      — messages with id > afterId (for pointer-based paging)
//   beforeId     — messages with id < beforeId
// ---------------------------------------------------------------------------

async function getMessages(shortcode, options) {
	var shorty = shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";

	var opts   = options || {};
	var limit  = opts.limit  || 100;
	var order  = opts.order  || 'ASC';
	order = (order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

	var conditions = [];
	var params     = [];
	var pi         = 1;

	if (opts.threadId) {
		conditions.push("thread_id = $" + pi);
		params.push(opts.threadId);
		pi++;
	}
	if (opts.afterId) {
		conditions.push("id > $" + pi);
		params.push(opts.afterId);
		pi++;
	}
	if (opts.beforeId) {
		conditions.push("id < $" + pi);
		params.push(opts.beforeId);
		pi++;
	}

	var whereClause = conditions.length > 0
		? " WHERE " + conditions.join(" AND ")
		: "";

	params.push(limit);
	var limitParam = "$" + pi;
	pi++;

	var offsetParam = "";
	if (opts.offset) {
		params.push(opts.offset);
		offsetParam = " OFFSET $" + pi;
	}

	var queryText =
		"SELECT optional_attributes, msg_id, from_user, to_user, system_time, subject, reply_to, thread_id, id, uuid, body_text, utf8, body_html " +
		"FROM " + msgtablename + whereClause +
		" ORDER BY id " + order +
		" LIMIT " + limitParam + offsetParam;

	var msglist = await postgres.query(queryText, params);
	if (!msglist) return [];

	for (var msg of msglist) {
		if (!msg.body_html) {
			var displayText = msg.utf8 || msg.body_text || '';
			msg.body_html = await formatBodyHtml(displayText);
			msg.isAnsi = detectIsAnsi(displayText);
		} else {
			var checkText = msg.utf8 || msg.body_text || '';
			msg.isAnsi = detectIsAnsi(checkText);
		}
	}

	return msglist;
}

// ---------------------------------------------------------------------------
// Group and area listing — security-filtered for user-facing views
// ---------------------------------------------------------------------------

async function listMsgGroups(userSecurity) {
	var sec = (userSecurity !== undefined && userSecurity !== null)
		? parseInt(userSecurity)
		: 255;

	var dblist = await postgres.query(
		"SELECT * FROM message_groups WHERE active AND security <= $1 ORDER BY name ASC",
		[sec]
	);
	return dblist || [];
}

async function getAreasInGroup(groupShortcode, userSecurity) {
	var sec = (userSecurity !== undefined && userSecurity !== null)
		? parseInt(userSecurity)
		: 255;

	var shorty = groupShortcode.toUpperCase().trim();
	var dbgroup = await msgGroups.getGroupByShortcode(shorty);
	if (!dbgroup) return [];

	// Filter by read_security — only return areas the user can read
	var dblist = await postgres.query(
		"SELECT * FROM message_areas WHERE active AND group_id = $1 AND read_security <= $2 ORDER BY name ASC",
		[dbgroup.id, sec]
	);
	return dblist || [];
}

// ---------------------------------------------------------------------------
// Message posting — startNewThread / replyToThread / saveMessage
// ---------------------------------------------------------------------------

// Resolve the FTN system address and origin line for a given area.
// Used by both startNewThread and replyToThread to stamp outgoing messages.
async function resolveAreaAddress(areaId) {
	var result = { address: null, path: null, origin_line: boardname };

	var areaNetworks = await networkAreas.getNetworksByArea(areaId);
	var ftnNet = areaNetworks.find(an => an.network_type === "FTN" && an.network_active);
	if (ftnNet) {
		var defaultAddr = await systemAddresses.getDefaultAddress(ftnNet.network_id);
		if (!defaultAddr) {
			var addrs = await systemAddresses.getAddressesForDomain(ftnNet.domain);
			if (addrs && addrs.length > 0) defaultAddr = addrs[0];
		}
		if (defaultAddr) {
			result.address = defaultAddr.address;
			result.origin_line = defaultAddr.origin_line
				? defaultAddr.origin_line
				: boardname + " " + defaultAddr.address;
		}
	}
	if (!result.origin_line) result.origin_line = boardname;
	if (result.address) {
		result.path = result.address.split(":")[1];
	}
	return result;
}

async function startNewThread(formObj, shortcode) {
	var shorty      = shortcode.toLowerCase().trim();
	var msgtable    = "mb_" + shorty + "_msgs";
	var threadtable = "mb_" + shorty + "_threads";
	var returnObj   = {
		status: false,
		insertId: 0,
		threaduuid: "",
		errormessages: []
	};

	sanitizeMessageFields(formObj);

	if (!formObj.subject || formObj.subject.trim().length === 0) {
		returnObj.errormessages.push("Subject cannot be blank!");
	}
	if (!formObj.from_user || formObj.from_user.trim().length === 0) {
		returnObj.errormessages.push("Cannot determine user!");
	}
	if (!formObj.body_text || formObj.body_text.trim().length === 0) {
		returnObj.errormessages.push("Cannot post an empty message!");
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	formObj.Subject = formObj.subject.trim();

	var area = await msgAreas.getAreaByShortcode(shorty);
	if (!area) {
		returnObj.errormessages.push("Could not find area to post message!");
		return returnObj;
	}

	var addrInfo = await resolveAreaAddress(area.id);

	var millihex       = ftnUtils.getMilliHex();
	var datetimestring = await ftnUtils.getDateTimeString();
	var msgid          = (addrInfo.address ? addrInfo.address + " " : "") + millihex;
	var tuuid          = uuidv4();
	var uuid           = uuidv4();
	var touser         = formObj.to_user || "All";
	var currtime       = new Date();

	var threadObj = {
		uuid: tuuid,
		threadid: msgid,
		subject: formObj.Subject,
		started_at: currtime,
		started_by: formObj.from_user,
		message_count: 1,
		last_message: currtime,
		last_message_from: formObj.from_user
	};

	var result = await postgres.insertObject(threadObj, threadtable);
	if (result.status !== true) {
		returnObj.errormessages.push("Couldn't save thread!");
		return returnObj;
	}
	var thread_id = result.insertId;

	var dbObj = {
		uuid: uuid,
		threadid: msgid,
		thread_id: thread_id,
		msg_id: msgid,
		tz_utc: default_tzutc,
		created_at: currtime,
		source: addrInfo.address,
		from_user: formObj.from_user,
		to_user: touser,
		subject: formObj.subject,
		body_text: formObj.body_text,
		datetime_string: datetimestring,
		system_time: currtime,
		path: addrInfo.path,
		origin_line: addrInfo.origin_line,
		product_string: product_string
	};

	var msgresult = await postgres.insertObject(dbObj, msgtable);
	if (msgresult.status === true) {
		returnObj.status     = true;
		returnObj.insertId   = msgresult.insertId;
		returnObj.threaduuid = tuuid;
	} else {
		// Roll back thread record if message failed to save
		await postgres.write("DELETE FROM " + threadtable + " WHERE id = $1", [thread_id]);
	}

	return returnObj;
}

async function replyToThread(formObj, shortcode, threaduuid) {
	var shorty      = shortcode.toLowerCase().trim();
	var msgtable    = "mb_" + shorty + "_msgs";
	var threadtable = "mb_" + shorty + "_threads";
	var returnObj   = {
		status: false,
		insertId: 0,
		errormessages: []
	};

	sanitizeMessageFields(formObj);

	if (!formObj.subject || formObj.subject.trim().length === 0) {
		returnObj.errormessages.push("Subject cannot be blank!");
	}
	if (!formObj.from_user || formObj.from_user.trim().length === 0) {
		returnObj.errormessages.push("Cannot determine user!");
	}
	if (!formObj.body_text || formObj.body_text.trim().length === 0) {
		returnObj.errormessages.push("Cannot post an empty message!");
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	formObj.Subject = formObj.subject.trim();

	var area = await msgAreas.getAreaByShortcode(shorty);
	if (!area) {
		returnObj.errormessages.push("Could not find area to post message!");
		return returnObj;
	}

	var dbthread = await postgres.queryOne(
		"SELECT * FROM " + threadtable + " WHERE uuid = $1",
		[threaduuid]
	);
	if (!dbthread) {
		returnObj.errormessages.push("Could not retrieve thread!");
		return returnObj;
	}

	var threadid  = dbthread.threadid;
	var thread_id = dbthread.id;
	var replyto   = formObj.reply_to || dbthread.threadid;

	var addrInfo = await resolveAreaAddress(area.id);

	var millihex       = ftnUtils.getMilliHex();
	var datetimestring = await ftnUtils.getDateTimeString();
	var msgid          = (addrInfo.address ? addrInfo.address + " " : "") + millihex;
	var uuid           = uuidv4();
	var touser         = formObj.to_user || "All";
	var currtime       = new Date();

	var dbObj = {
		uuid: uuid,
		threadid: threadid,
		reply_to: replyto,
		thread_id: thread_id,
		msg_id: msgid,
		tz_utc: default_tzutc,
		created_at: currtime,
		source: addrInfo.address,
		from_user: formObj.from_user,
		to_user: touser,
		subject: formObj.subject,
		body_text: formObj.body_text,
		datetime_string: datetimestring,
		system_time: currtime,
		path: addrInfo.path,
		origin_line: addrInfo.origin_line,
		product_string: product_string
	};

	var msgresult = await postgres.insertObject(dbObj, msgtable);
	if (msgresult.status === true) {
		returnObj.status   = true;
		returnObj.insertId = msgresult.insertId;
		// Update thread stats (message count, last_message, last_message_from)
		await updateThread(thread_id, shortcode);
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(msgresult.errormessages);
	}

	return returnObj;
}

// ---------------------------------------------------------------------------
// saveMessage — unified posting interface.
// If formObj.threaduuid is set → reply mode, otherwise → new thread mode.
// ---------------------------------------------------------------------------

async function saveMessage(formObj, shortcode, threaduuid) {
	if (threaduuid) {
		return await replyToThread(formObj, shortcode, threaduuid);
	}
	return await startNewThread(formObj, shortcode);
}

// ---------------------------------------------------------------------------
// Thread stat update — called after posting a reply
// ---------------------------------------------------------------------------

async function updateThread(id, shortcode) {
	var shorty          = shortcode.toLowerCase();
	var msgtablename    = "mb_" + shorty + "_msgs";
	var threadtablename = "mb_" + shorty + "_threads";

	var thread = await postgres.queryOne(
		"SELECT id, subject, threadid, last_message, message_count, last_message_from FROM " + threadtablename + " WHERE id = $1",
		[id]
	);
	if (!thread) return;

	var countResult = await postgres.query(
		"SELECT COUNT(*) FROM " + msgtablename + " WHERE thread_id = $1",
		[thread.id]
	);
	var msgcount = (countResult && countResult[0]) ? parseInt(countResult[0].count) : 0;

	var lastMsgResult = await postgres.query(
		"SELECT system_time, from_user FROM " + msgtablename + " WHERE thread_id = $1 ORDER BY system_time DESC LIMIT 1",
		[thread.id]
	);
	var lastmsg = (lastMsgResult && lastMsgResult[0]) ? lastMsgResult[0] : null;
	if (!lastmsg) return;

	var lastfrom = thread.last_message_from;
	var lasttime = thread.last_message;
	var doupdate = false;

	if (thread.last_message_from !== lastmsg.from_user) {
		lastfrom = lastmsg.from_user;
		doupdate = true;
	}
	if (lastmsg.system_time) {
		lasttime = lastmsg.system_time;
	}
	if (msgcount > thread.message_count) doupdate = true;
	if (lasttime > thread.last_message)  doupdate = true;

	if (doupdate) {
		await postgres.write(
			"UPDATE " + threadtablename + " SET last_message = $1, message_count = $2, last_message_from = $3 WHERE id = $4",
			[lasttime, msgcount, lastmsg.from_user, thread.id]
		);
	}
}

// ---------------------------------------------------------------------------
// Message deletion
// ---------------------------------------------------------------------------

async function deleteMessageByUUID(uuid, shortcode) {
	if (!uuid || !shortcode) return false;

	var shorty      = shortcode.toLowerCase().trim();
	var msgtable    = "mb_" + shorty + "_msgs";
	var threadtable = "mb_" + shorty + "_threads";

	var dbmsg = await postgres.queryOne(
		"SELECT * FROM " + msgtable + " WHERE uuid = $1",
		[uuid]
	);
	if (!dbmsg) return false;

	try {
		if (dbmsg.msg_id === dbmsg.threadid) {
			await postgres.write(
				"DELETE FROM " + threadtable + " WHERE threadid = $1",
				[dbmsg.threadid]
			);
		}
		await postgres.write(
			"DELETE FROM " + msgtable + " WHERE id = $1",
			[dbmsg.id]
		);
		return true;
	} catch (error) {
		alogger.writeAlog(3, "deleteMessageByUUID: error deleting " + uuid + ": " + error.message, "redbright");
		return false;
	}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	// Group/area listing (new)
	listMsgGroups,
	getAreasInGroup,

	// Message retrieval (new)
	getMessage,
	getMessageCount,
	countMessagesBefore,
	getMessages,

	// Message posting (new unified + migrated originals)
	saveMessage,
	startNewThread,
	replyToThread,

	// Migrated view methods
	getMessagesForThread,
	getThreadsForArea,
	getRecentThreadsForArea,
	getMessagesForArea,
	getMessageById,
	getThreadByUUID,
	getThreadUUIDMap,
	getThreadsPage,
	getThreadCount,
	buildMessageTree,

	// Message deletion (migrated)
	deleteMessageByUUID,

	// Utilities (view-layer copies)
	formatBodyHtml,
	updateThread,
	sanitizeMessageFields
};
