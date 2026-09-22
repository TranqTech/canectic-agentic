// messages.js — Canonical message model.
// All message CRUD, threading, posting, sanitization, and read operations
// live here. echomail.js is now reduced to FTN-specific tosser helpers
// (ftnToDb/dbToFtn, getOutboundForConnection).

//imports
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import { canModerateArea } from '../utils/areaAccess.js';
import * as msgAreas from './msgAreas.js';
import * as msgGroups from './msgGroups.js';
import * as networkAreas from './networkAreas.js';
import * as systemAddresses from './systemAddresses.js';
import * as ftnUtils from '../utils/ftnUtils.js';
import * as codepageConversions from '../utils/codepageConversions.js';
import * as terminalText from '../utils/terminalText.js';
import { formatBodyHtml } from '../utils/terminalText.js';
import * as alogger from '../utils/alogger.js';
import appConfig from "../config/appConfig.js";
import * as systeminfo from "../utils/systeminfo.js";



// Thread update queue: tracks threads that need stats recalculation after batch toss.
// Format: array of "threadId[shortcode" pseudo-IDs (deduped).
var threadUpdateArray = [];

// Imported msg_id queue: tracks msg_ids inserted during a batch toss for
// post-batch orphan reconciliation.
var importedMsgIds = [];

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
// Exported so handleInboundEchoMessage, nntpTosser.js, and qwkTosser.js can call on inbound.
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
// formatBodyHtml is imported from ../utils/terminalText.js (canonical version
// with reflow + ANSI art detection + noWrap mode). Re-exported for callers.
// ---------------------------------------------------------------------------

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
		"SELECT optional_attributes, msg_id, msg_orig_addr, from_user, to_user, system_time, subject, reply_to, reply_orig_addr, id, uuid, body_text, utf8, body_html FROM " +
		msgtablename + " WHERE thread_id = $1 ORDER BY system_time ASC",
		[threadid]
	);

	if (!msglist) return [];

	for (var msg of msglist) {
		// Use pre-rendered body_html if available (populated at import time).
		// Fall back to on-the-fly formatting for older messages.
		if (!msg.body_html) {
			var displayText = msg.body_text || '';
			msg.body_html = await formatBodyHtml(displayText);
			msg.isAnsi = detectIsAnsi(displayText);
		} else {
			// Pre-rendered — still need to detect if terminal rendering is needed
			var checkText = msg.body_text || '';
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
		"SELECT optional_attributes, msg_id, msg_orig_addr, from_user, to_user, system_time, subject, reply_to, reply_orig_addr, thread_id, id, uuid, body_text, utf8, body_html " +
		"FROM " + msgtablename + " ORDER BY system_time " + order + " LIMIT $1 OFFSET $2",
		[limit, offset]
	);

	if (!msglist) return [];

	for (var msg of msglist) {
		if (!msg.body_html) {
			var displayText = msg.body_text || '';
			msg.body_html = await formatBodyHtml(displayText);
			msg.isAnsi = detectIsAnsi(displayText);
		} else {
			var checkText = msg.body_text || '';
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
		var displayText = msg.body_text || '';
		msg.body_html = await formatBodyHtml(displayText);
		msg.isAnsi = detectIsAnsi(displayText);
	} else {
		var checkText = msg.body_text || '';
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
		"SELECT optional_attributes, msg_id, msg_orig_addr, from_user, to_user, system_time, subject, reply_to, reply_orig_addr, thread_id, id, uuid, body_text, utf8, body_html " +
		"FROM " + msgtablename + whereClause +
		" ORDER BY id " + order +
		" LIMIT " + limitParam + offsetParam;

	var msglist = await postgres.query(queryText, params);
	if (!msglist) return [];

	for (var msg of msglist) {
		if (!msg.body_html) {
			var displayText = msg.body_text || '';
			msg.body_html = await formatBodyHtml(displayText);
			msg.isAnsi = detectIsAnsi(displayText);
		} else {
			var checkText = msg.body_text || '';
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
		"SELECT * FROM message_groups WHERE active AND (read_security IS NULL OR read_security <= $1) ORDER BY sort_order ASC, name ASC",
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
		"SELECT * FROM message_areas WHERE active AND group_id = $1 AND read_security <= $2 ORDER BY sort_order ASC, name ASC",
		[dbgroup.id, sec]
	);
	return dblist || [];
}

// ---------------------------------------------------------------------------
// Message posting — startNewThread / replyToThread / saveMessage
// ---------------------------------------------------------------------------

// Resolve the FTN system address and origin line for a given area.
// Used by both startNewThread and replyToThread to stamp outgoing messages.
// Origin line format per FTS: "BoardName (zone:net/node)". Custom origin lines
// have the address appended in parentheses if not already present.
async function resolveAreaAddress(areaId) {
	var boardname = appConfig.get('boardname', 'Canectic BBS');
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
			if (defaultAddr.origin_line) {
				// Custom origin -- append address in parentheses if not already present
				result.origin_line = defaultAddr.origin_line;
				if (result.address && !result.origin_line.includes('(' + result.address + ')')) {
					result.origin_line += ' (' + result.address + ')';
				}
			} else {
				// Default: boardname (address)
				result.origin_line = boardname + ' (' + result.address + ')';
			}
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

	var serial        = await ftnUtils.getMilliHex();
	var origAddr      = addrInfo.address || '';
	// threadid stays in the legacy "address serial" format because thread
	// tables don't have a tuple split and threading lookups still use the
	// full string as an opaque key. joinMsgidTuple handles missing address.
	var threadidStr   = ftnUtils.joinMsgidTuple(origAddr, serial);
	var datetimestring = await ftnUtils.getDateTimeString();
	var tuuid          = uuidv4();
	var uuid           = uuidv4();
	var touser         = formObj.to_user || "All";
	var currtime       = new Date();

	var threadObj = {
		uuid: tuuid,
		threadid: threadidStr,
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
		threadid: threadidStr,
		thread_id: thread_id,
		msg_id: serial,
		msg_orig_addr: origAddr,
		tz_utc: ftnUtils.tzutcFor(currtime),
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
		product_string: systeminfo.versionMsg()
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

	// Resolve the parent MSGID tuple (reply_to + reply_orig_addr) from the
	// authoritative DB row, not from a client-supplied "ADDR SERIAL" string.
	// Caller should pass formObj.reply_to_uuid (the parent message's DB uuid);
	// we look up and split msg_id / msg_orig_addr directly.
	// Fall back to the thread root's threadid (full "ADDR SERIAL") if no
	// parent uuid was supplied -- happens for first-reply-to-root from
	// callers that don't know the root msg uuid.
	var replyTupled = { msg_id: '', msg_orig_addr: '' };
	if (formObj.reply_to_uuid) {
		var parentRow = await postgres.queryOne(
			"SELECT msg_id, msg_orig_addr FROM " + msgtable + " WHERE uuid = $1 AND thread_id = $2",
			[formObj.reply_to_uuid, thread_id]
		);
		if (parentRow) {
			replyTupled.msg_id         = parentRow.msg_id || '';
			replyTupled.msg_orig_addr  = parentRow.msg_orig_addr || '';
		}
	}
	if (!replyTupled.msg_id) {
		replyTupled = ftnUtils.splitFullMsgid(dbthread.threadid);
	}

	var addrInfo = await resolveAreaAddress(area.id);

	var serial        = await ftnUtils.getMilliHex();
	var origAddr      = addrInfo.address || '';
	var datetimestring = await ftnUtils.getDateTimeString();
	var uuid           = uuidv4();
	var touser         = formObj.to_user || "All";
	var currtime       = new Date();

	var dbObj = {
		uuid: uuid,
		threadid: threadid,
		reply_to: replyTupled.msg_id,
		reply_orig_addr: replyTupled.msg_orig_addr,
		thread_id: thread_id,
		msg_id: serial,
		msg_orig_addr: origAddr,
		tz_utc: ftnUtils.tzutcFor(currtime),
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
		product_string: systeminfo.versionMsg()
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
// Thread update queue management
// ---------------------------------------------------------------------------

async function pushThreadIdToUpdateQueue(id, shortcode) {
	if (!id || !shortcode) return;
	var psuedoid = id + "[" + shortcode;
	if (!threadUpdateArray.includes(psuedoid)) {
		threadUpdateArray.push(psuedoid);
	}
}

// Return the current contents of threadUpdateArray (parsed) and clear it.
// This is the safe way for long-lived processes (worker, embedded mode) to
// consume the queue — no window between read and clear where items could
// be lost. Short-lived CLI processes can still read threadUpdateArray
// directly since they exit after one run.
function drainThreadUpdateArray() {
	var items = [];
	for (var entry of threadUpdateArray) {
		items.push({
			id: entry.split("[")[0],
			shortcode: entry.split("[")[1]
		});
	}
	threadUpdateArray.length = 0;
	return items;
}

// Track imported message IDs for post-batch orphan reconciliation.
// Takes the tuple form (msgId serial, origAddr) so the reconciler can
// match reply_to tuples correctly. Callers that only have the full
// "address serial" string can pass it as msgId and leave origAddr
// undefined -- splitFullMsgid will be applied in reconcileOrphans.
function pushImportedMsgId(msgId, shortcode, origAddr) {
	if (!msgId || !shortcode) return;
	importedMsgIds.push({
		msgId: msgId,
		origAddr: origAddr == null ? undefined : origAddr,
		shortcode: shortcode
	});
}

function drainImportedMsgIds() {
	var items = importedMsgIds.slice();
	importedMsgIds.length = 0;
	return items;
}

// ---------------------------------------------------------------------------
// Thread row helpers (low-level, used by threadMessage and tossers)
// ---------------------------------------------------------------------------

// Create a new thread row. Returns { threadId, threadidStr } on success, null on failure.
async function createThreadRow(threadtable, threadidStr, subject, systemTime, fromUser) {
	var uuid = uuidv4();
	var threadObj = {
		uuid:              uuid,
		threadid:          threadidStr,
		subject:           subject,
		started_at:        systemTime,
		started_by:        fromUser,
		message_count:     1,
		last_message:      systemTime,
		last_message_from: fromUser
	};
	var result = await postgres.insertObject(threadObj, threadtable);
	if (result.status && result.insertId) {
		return { threadId: result.insertId, threadidStr: threadidStr };
	}
	return null;
}

// Update thread stats after inserting a reply. Bumps message_count and
// advances last_message / last_message_from if this message is newer.
async function updateThreadStats(threadtable, threadId, systemTime, fromUser) {
	await postgres.write(
		'UPDATE ' + threadtable +
		' SET message_count = message_count + 1,' +
		' last_message = GREATEST(last_message, $1),' +
		' last_message_from = $2' +
		' WHERE id = $3',
		[systemTime, fromUser, threadId]
	);
}

// Roll back a thread row when the message insert that created it fails.
// Only removes threads matching the given threadid string (the message's
// canonical ID) so we don't accidentally delete pre-existing threads.
async function rollbackThread(threadtable, threadidStr) {
	await postgres.write(
		'DELETE FROM ' + threadtable + ' WHERE threadid = $1',
		[threadidStr]
	);
}

// ---------------------------------------------------------------------------
// Subject-based thread matching
// ---------------------------------------------------------------------------

async function getExistingThreadBySubject(message, threadtable, subject, maxAgeDays) {
	var currtime = new Date();
	var existingthread;
	var ageDays = maxAgeDays || 30;

	var starttime  = new Date(message.system_time);
	var moderntime = new Date(message.system_time);
	starttime.setDate(starttime.getDate() - ageDays);
	moderntime.setDate(moderntime.getDate() + 14);

	var querytext;
	if (moderntime >= currtime) {
		// Current message
		querytext = "SELECT * FROM " + threadtable + " WHERE subject = $1 AND last_message >= $2 ORDER BY last_message DESC";
		existingthread = await postgres.queryOne(querytext, [subject, starttime]);
	} else {
		// Archival message
		querytext = "SELECT * FROM " + threadtable + " WHERE subject = $1 AND started_at >= $2 AND started_at <= $3 ORDER BY started_at DESC";
		existingthread = await postgres.queryOne(querytext, [subject, starttime, message.system_time]);
	}

	return existingthread;
}

// ---------------------------------------------------------------------------
// Unified threading: called by all tossers (FTN, QWK, NNTP) and importers
// ---------------------------------------------------------------------------

async function threadMessage(message, messagetable, threadtable, shortcode) {
	var existingthread;
	var querytext;

	// Step A: Pre-assigned threadid (used by rethreadAreas and by moves)
	//
	// Only returns early when the thread is actually found. It used to return
	// regardless, so a message carrying a threadid with no matching row in this
	// table came back with thread_id unset, breaking the guarantee this
	// function exists to make. That happens whenever content arrives from
	// somewhere else: a move between areas always does, and rethreadAreas can.
	// Such a message is invisible in the thread list, because the reader lists
	// threads and looks up their messages.
	//
	// When it is not found, create the thread under the same threadid rather
	// than falling through, so the identity the caller assigned survives.
	if (message.threadid) {
		querytext = "SELECT * FROM " + threadtable + " WHERE threadid = $1";
		existingthread = await postgres.queryOne(querytext, [message.threadid]);
		if (existingthread) {
			message.thread_id = existingthread.id;
			await pushThreadIdToUpdateQueue(existingthread.id, shortcode);
			return message;
		}

		var madeThread = await createThreadRow(threadtable, message.threadid, message.subject,
			message.system_time, message.from_user);
		if (madeThread && madeThread.threadId) {
			message.thread_id = madeThread.threadId;
			return message;
		}
		// Could not create one under that id: fall through to the normal
		// reply_to / subject / new-thread path rather than returning orphaned.
	}

	// Step B: reply_to lookup (case-insensitive tuple match)
	//
	// message.reply_to may have been split by ftnToDb into (reply_to serial,
	// reply_orig_addr) or may still be a full "address serial" string from
	// a tosser that hasn't been migrated. Split defensively so both
	// formats work during migration, and for QWK/NNTP messages whose
	// reply_to isn't an FTN MSGID the split leaves orig_addr empty and
	// the query matches other messages in the same empty-address scope.
	if (message.reply_to) {
		var replyLookup;
		if (message.reply_orig_addr !== undefined && message.reply_orig_addr !== null) {
			// Already in tuple format (ftnToDb output)
			replyLookup = {
				msg_id: message.reply_to,
				msg_orig_addr: message.reply_orig_addr || ''
			};
		} else {
			// Legacy full-string format -- split on first space
			replyLookup = ftnUtils.splitFullMsgid(message.reply_to);
		}
		querytext = 'SELECT threadid, thread_id FROM ' + messagetable +
			' WHERE UPPER(msg_id) = UPPER($1) AND UPPER(COALESCE(msg_orig_addr, \'\')) = UPPER($2)';
		var upstreammsg = await postgres.queryOne(
			querytext,
			[replyLookup.msg_id, replyLookup.msg_orig_addr]
		);
		if (upstreammsg && (upstreammsg.threadid || upstreammsg.thread_id)) {
			if (upstreammsg.threadid) message.threadid = upstreammsg.threadid;
			if (upstreammsg.thread_id) message.thread_id = upstreammsg.thread_id;
			await pushThreadIdToUpdateQueue(upstreammsg.thread_id, shortcode);
			return message;
		}
		// Parent not found or has no thread -- fall through to subject matching
	}

	// Step C: Subject matching
	var isReply = !!(message.reply_to) || message.subject.toUpperCase().startsWith('RE:');
	var checksubject = message.subject;
	if (checksubject.toUpperCase().startsWith('RE:')) {
		var i = 0;
		while (checksubject.toUpperCase().startsWith('RE:')) {
			checksubject = checksubject.substring(3).trim();
			i++;
			if (i > 10) break;
		}
	}
	var subjectAgeDays = isReply ? 365 : 30;

	existingthread = await getExistingThreadBySubject(message, threadtable, checksubject, subjectAgeDays);
	if (!existingthread && checksubject !== message.subject) {
		existingthread = await getExistingThreadBySubject(message, threadtable, message.subject, subjectAgeDays);
	}

	if (existingthread) {
		message.threadid  = existingthread.threadid;
		message.thread_id = existingthread.id;
		await pushThreadIdToUpdateQueue(existingthread.id, shortcode);
		return message;
	}

	// Step D: Create new thread (guaranteed -- never leave message threadless)
	//
	// threadid in the DB stays in the legacy "address serial" full-string
	// format so it's self-contained as an opaque key. Rebuild from the
	// tuple columns if we have them; fall back to msg_id alone if the
	// message hasn't been split yet.
	var threadidStr = ftnUtils.joinMsgidTuple(message.msg_orig_addr, message.msg_id);
	if (!threadidStr) threadidStr = message.msg_id;
	var tResult = await createThreadRow(threadtable, threadidStr, message.subject, message.system_time, message.from_user);
	if (tResult) {
		message.thread_id = tResult.threadId;
		message.threadid  = tResult.threadidStr;
	} else {
		// Race condition: another process created a thread with the same threadid.
		// Look it up and attach.
		querytext = "SELECT * FROM " + threadtable + " WHERE UPPER(threadid) = UPPER($1)";
		var dbthread = await postgres.queryOne(querytext, [threadidStr]);
		if (dbthread) {
			message.threadid  = dbthread.threadid;
			message.thread_id = dbthread.id;
			await pushThreadIdToUpdateQueue(dbthread.id, shortcode);
		} else {
			// Absolute last resort: create with a unique threadid
			var fallbackId = threadidStr + '_' + Date.now();
			var fallback = await createThreadRow(threadtable, fallbackId, message.subject, message.system_time, message.from_user);
			if (fallback) {
				message.thread_id = fallback.threadId;
				message.threadid  = fallback.threadidStr;
			} else {
				alogger.writeAlog(1, "threadMessage: FAILED to create thread for " + message.msg_id, "redbright");
			}
		}
	}

	return message;
}

// ---------------------------------------------------------------------------
// Inbound echomail orchestrator (called by FTN tosser)
// ---------------------------------------------------------------------------

async function handleInboundEchoMessage(message) {
	var returnObj = {
		status: false,
		imported: false,
		duplicate: false,
		bad: false,
		errormessages: []
	};

	if (!message) {
		returnObj.errormessages.push("Invalid Message!");
		return returnObj;
	}
	if (!message.AreaTag) {
		returnObj.errormessages.push("Invalid Area Tag.");
		return returnObj;
	}

	var msgArea = await msgAreas.getAreaByAreatag(message.AreaTag);
	if (!msgArea) {
		alogger.writeAlog(4, "handleInboundEchoMessage: no area found for tag " + message.AreaTag, "yellow");
		returnObj.errormessages.push("No Area with that AreaTag.");
		return returnObj;
	}

	var shorty = msgArea.shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";

	// Check for duplicate against the (msg_id serial, msg_orig_addr) tuple.
	// message.MsgId is the full "address serial" format from the FTN parser;
	// split it so the DB query matches our tuple storage columns. Two
	// messages with the same serial from different origin addresses are
	// NOT duplicates per FTS-0009 (the uniqueness scope is per-origin).
	var msgidSplit = ftnUtils.splitFullMsgid(message.MsgId);
	var dupRow = null;
	if (msgidSplit.msg_id) {
		dupRow = await postgres.queryOne(
			'SELECT id FROM ' + msgtablename +
			' WHERE UPPER(msg_id) = UPPER($1) AND UPPER(COALESCE(msg_orig_addr, \'\')) = UPPER($2)',
			[msgidSplit.msg_id, msgidSplit.msg_orig_addr]
		);
	}
	if (dupRow) {
		returnObj.status    = true;
		returnObj.duplicate = true;
		return returnObj;
	}

	var threadtablename = "mb_" + shorty + "_threads";
	// Convert FTN message to DB format -- delegated to echomail.js (FTN-specific)
	var echomailModule = await import('./echomail.js');
	var dbObj = await echomailModule.ftnToDb(message);
	if (message.utf8) {
		dbObj.utf8 = message.utf8;
	}

	// Pre-format body as HTML for display (non-fatal)
	var displayText = dbObj.body_text || '';
	dbObj.body_html = await formatBodyHtml(displayText);

	// Resolve source_network_id so outbound delivery can suppress re-sending
	// a message back to the network it arrived from
	var netRows = await networkAreas.getNetworksByArea(msgArea.id);
	if (netRows && netRows.length > 0) {
		// For FTN inbound, use the network whose areatag matches the message AreaTag
		var matchingNet = netRows.find(nr =>
			nr.areatag && nr.areatag.toUpperCase() === message.AreaTag.toUpperCase()
		);
		if (matchingNet) {
			dbObj.source_network_id = matchingNet.network_id;
		}
	}

	dbObj = await threadMessage(dbObj, msgtablename, threadtablename, shorty);

	var dbres = await postgres.insertObject(dbObj, msgtablename);
	if (dbres.status === true) {
		returnObj.status   = true;
		returnObj.imported = true;
		// Track for post-batch orphan reconciliation (use correct local shortcode)
		if (dbObj.msg_id) pushImportedMsgId(dbObj.msg_id, shorty, dbObj.msg_orig_addr || '');
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

// ---------------------------------------------------------------------------
// Thread maintenance (batch updates and rebuilds)
// ---------------------------------------------------------------------------

async function updateThreadArray(threadArray) {
	if (!threadArray) return null;
	for (var thread of threadArray) {
		await updateThread(thread.id, thread.shortcode);
	}
}

async function updateDailyThreads(shortcode) {
	var shorty       = shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";
	var threadArray  = [];

	var msgarray = await postgres.query(
		"SELECT thread_id FROM " + msgtablename + " WHERE system_time >= NOW() - INTERVAL '24 HOURS' ORDER BY system_time DESC",
		[]
	);
	if (!msgarray || msgarray.length === 0) return;

	for (var msg of msgarray) {
		if (!threadArray.includes(msg.thread_id)) {
			threadArray.push(msg.thread_id);
		}
	}
	for (var threadId of threadArray) {
		await updateThread(threadId, shortcode);
	}
}

async function updateAreaThreads(shortcode) {
	var shorty          = shortcode.toLowerCase();
	var threadtablename = "mb_" + shorty + "_threads";

	var dbthreads = await postgres.query(
		"SELECT id FROM " + threadtablename + " ORDER BY last_message DESC",
		[]
	);
	if (!dbthreads || dbthreads.length === 0) return;

	for (var thread of dbthreads) {
		await updateThread(thread.id, shortcode);
	}
}

// ---------------------------------------------------------------------------
// Thread merging (deduplication of threads with matching subjects)
// ---------------------------------------------------------------------------

async function mergeThreads(parent, child, shortcode) {
	var shorty      = shortcode.toLowerCase();
	var msgtable    = "mb_" + shorty + "_msgs";
	var threadtable = "mb_" + shorty + "_threads";

	var messageArray = await postgres.query(
		"SELECT id FROM " + msgtable + " WHERE thread_id = $1",
		[parent.id]
	);
	if (!messageArray || messageArray.length === 0) return;

	var scount = 0;
	for (var msg of messageArray) {
		try {
			await postgres.write(
				"UPDATE " + msgtable + " SET threadid = $1, thread_id = $2 WHERE id = $3",
				[parent.threadid, parent.id, msg.id]
			);
			scount++;
		} catch (error) {
			alogger.writeAlog(3, "mergeThreads: error updating msg " + msg.id + ": " + error.message, "redbright");
		}
	}

	if (scount === messageArray.length) {
		await postgres.write(
			"DELETE FROM " + threadtable + " WHERE id = $1",
			[child.id]
		);
	}
}

async function mergeRecentThreads(shortcode) {
	var shorty      = shortcode.toLowerCase();
	var threadtable = "mb_" + shorty + "_threads";

	var threadArray = await postgres.query(
		"SELECT id, threadid, subject, started_at, last_message FROM " + threadtable +
		" WHERE last_message >= NOW() - INTERVAL '60 DAYS' ORDER BY last_message DESC",
		[]
	);
	if (!threadArray || threadArray.length === 0) return;

	for (var thread of threadArray) {
		thread.subject = thread.subject.trim();
		var checksubject = thread.subject;

		if (thread.subject.toUpperCase().startsWith('RE:')) {
			var i = 0;
			while (checksubject.toUpperCase().startsWith('RE:')) {
				checksubject = checksubject.substring(3).trim();
				i++;
				if (i > 10) break;
			}
		}

		var starttime = new Date(thread.started_at);
		starttime.setDate(starttime.getDate() - 30);

		var querytext   = "SELECT * FROM " + threadtable + " WHERE subject = $1 AND id != $2 AND last_message >= $3 ORDER BY last_message DESC";
		var existingthread = await postgres.queryOne(querytext, [checksubject, thread.id, starttime]);
		if (!existingthread && checksubject !== thread.subject) {
			existingthread = await postgres.queryOne(querytext, [thread.subject, thread.id, starttime]);
		}

		if (existingthread) {
			await mergeThreads(existingthread, thread, shortcode);
			await pushThreadIdToUpdateQueue(existingthread.id, shortcode);
		}
	}
}

// ---------------------------------------------------------------------------
// Orphan reconciliation
// ---------------------------------------------------------------------------

/**
 * Fix orphaned messages (threadid IS NULL) in an area by re-running threadMessage().
 * Returns the number of messages fixed.
 */
async function applyThreadingForArea(shortcode) {
	var shorty          = shortcode.toLowerCase();
	var msgtablename    = "mb_" + shorty + "_msgs";
	var threadtablename = "mb_" + shorty + "_threads";
	var fixed = 0;

	var orphans = await postgres.query(
		"SELECT id, msg_id, reply_to, subject, system_time, from_user, threadid, thread_id FROM " +
		msgtablename + " WHERE threadid IS NULL OR thread_id IS NULL ORDER BY system_time ASC",
		[]
	);
	if (!orphans || orphans.length === 0) return 0;

	alogger.writeAlog(3, '[Threading] Found ' + orphans.length + ' orphaned message(s) in ' + shortcode, 'yellow');

	for (var msg of orphans) {
		msg.threadid = null;
		msg.thread_id = null;
		var threaded = await threadMessage(msg, msgtablename, threadtablename, shorty);
		if (threaded.threadid && threaded.thread_id) {
			await postgres.write(
				'UPDATE ' + msgtablename + ' SET threadid = $1, thread_id = $2 WHERE id = $3',
				[threaded.threadid, threaded.thread_id, msg.id]
			);
			fixed++;
		}
	}

	// Drain any queued thread updates from the re-threading pass
	var pending = drainThreadUpdateArray();
	if (pending.length > 0) await updateThreadArray(pending);

	if (fixed > 0) {
		alogger.writeAlog(2, '[Threading] Fixed ' + fixed + ' orphaned message(s) in ' + shortcode, 'greenbright');
	}
	return fixed;
}

/**
 * Post-batch orphan reconciliation. For each (msg_id, orig_addr) tuple that
 * was just imported, find messages whose reply_to tuple matches it and
 * whose thread differs from the parent's thread. Re-link them to the
 * correct thread.
 *
 * Accepts items in two forms for backward compatibility:
 *   - { msgId, origAddr, shortcode }  -- already split tuple
 *   - { msgId, shortcode }            -- full "address serial" string;
 *                                        split via splitFullMsgid
 *   - plain string                    -- legacy callers that pass raw strings
 */
async function reconcileOrphans(shortcode, msgIds) {
	if (!msgIds || msgIds.length === 0) return 0;
	var shorty          = shortcode.toLowerCase();
	var msgtablename    = "mb_" + shorty + "_msgs";
	var fixed = 0;

	for (var item of msgIds) {
		var msgId, origAddr;
		if (typeof item === 'string') {
			var s = ftnUtils.splitFullMsgid(item);
			msgId = s.msg_id;
			origAddr = s.msg_orig_addr;
		} else if (item && typeof item === 'object') {
			if (item.origAddr !== undefined && item.origAddr !== null) {
				msgId = item.msgId;
				origAddr = item.origAddr;
			} else {
				var s2 = ftnUtils.splitFullMsgid(item.msgId || '');
				msgId = s2.msg_id;
				origAddr = s2.msg_orig_addr;
			}
		}
		if (!msgId) continue;

		// Find the parent message's thread info using the tuple
		var parent = await postgres.queryOne(
			'SELECT threadid, thread_id FROM ' + msgtablename +
			' WHERE UPPER(msg_id) = UPPER($1) AND UPPER(COALESCE(msg_orig_addr, \'\')) = UPPER($2)',
			[msgId, origAddr || '']
		);
		if (!parent || !parent.thread_id) continue;

		// Find children that reference this parent via the reply_to tuple
		// but have wrong/missing thread
		var children = await postgres.query(
			'SELECT id, threadid, thread_id FROM ' + msgtablename +
			' WHERE UPPER(reply_to) = UPPER($1) ' +
			' AND UPPER(COALESCE(reply_orig_addr, \'\')) = UPPER($2) ' +
			' AND (thread_id IS NULL OR thread_id != $3)',
			[msgId, origAddr || '', parent.thread_id]
		);
		if (!children || children.length === 0) continue;

		for (var child of children) {
			var oldThreadId = child.thread_id;
			await postgres.write(
				'UPDATE ' + msgtablename + ' SET threadid = $1, thread_id = $2 WHERE id = $3',
				[parent.threadid, parent.thread_id, child.id]
			);
			fixed++;

			// Queue stats updates for both old and new threads
			if (oldThreadId && oldThreadId !== parent.thread_id) {
				await pushThreadIdToUpdateQueue(oldThreadId, shortcode);
			}
			await pushThreadIdToUpdateQueue(parent.thread_id, shortcode);
		}
	}

	if (fixed > 0) {
		alogger.writeAlog(3, '[Threading] Reconciled ' + fixed + ' orphan(s) in ' + shortcode, 'greenbright');
	}
	return fixed;
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

async function deleteThreadByUUID(uuid, shortcode) {
	if (!uuid || !shortcode) return { status: false, deleted: 0 };

	var shorty      = shortcode.toLowerCase().trim();
	var msgtable    = "mb_" + shorty + "_msgs";
	var threadtable = "mb_" + shorty + "_threads";

	var thread = await postgres.queryOne(
		"SELECT * FROM " + threadtable + " WHERE uuid = $1",
		[uuid]
	);
	if (!thread) return { status: false, deleted: 0 };

	try {
		// Delete all messages in the thread
		var msgResult = await postgres.query(
			"SELECT id FROM " + msgtable + " WHERE thread_id = $1",
			[thread.id]
		);
		var msgCount = msgResult ? msgResult.length : 0;

		await postgres.write(
			"DELETE FROM " + msgtable + " WHERE thread_id = $1",
			[thread.id]
		);

		// Delete the thread row
		await postgres.write(
			"DELETE FROM " + threadtable + " WHERE id = $1",
			[thread.id]
		);

		// Update area message count
		try {
			var msgAreasModule = await import('./msgAreas.js');
			await msgAreasModule.updateStatsForArea(shortcode);
		} catch (e) { /* stats update is non-critical */ }

		alogger.writeAlog(5, 'Deleted thread ' + uuid + ' (' + msgCount + ' messages) from ' + shortcode, 'yellow');
		return { status: true, deleted: msgCount };
	} catch (error) {
		alogger.writeAlog(3, 'deleteThreadByUUID: error deleting thread ' + uuid + ': ' + error.message, 'redbright');
		return { status: false, deleted: 0 };
	}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Prune old messages from areas that have a retention limit set.
 *
 * Opt-in per area: both limits are NULL by default and NULL means keep
 * everything. Mirrors the file side (fileEntries.enforceRetentionLimits), and
 * the two limits combine, so an area can cap both age and count.
 *
 *   max_age_days  delete messages older than N days
 *   max_messages  keep the N newest, delete the rest
 *
 * Age is the message's OWN date (system_time), not when we received it, which
 * is what a sysop means by "keep 90 days" and what Synchronet and Mystic do.
 * Note the consequence for migrations: a JAM or SMB import carries its original
 * dates, so importing an old base into an area that already has max_age_days
 * set will prune most of it on the next run. Preview first (dryRun) when
 * setting a limit on an area holding imported mail.
 *
 * Pruning is per message, not per thread. In FTN a reply whose parent has
 * already rolled off the base is normal, every node prunes at its own depth,
 * and threadMessage() never produces a NULL thread. Whole-thread pruning would
 * also mean one late reply keeps an ancient thread alive forever, which defeats
 * the point on a busy ads or nodelist area. Thread rows are kept honest
 * afterwards: recounted, last_message recomputed, and emptied threads removed.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]     report what would go, delete nothing
 * @param {string}  [opts.shortcode]  limit to a single area
 * @returns {object} { areasChecked, messagesRemoved, threadsRemoved, areas: [...] }
 */
async function enforceRetentionLimits(opts) {
	opts = opts || {};
	var dryRun = !!opts.dryRun;

	var sql = "SELECT id, shortcode, max_age_days, max_messages FROM message_areas " +
	          "WHERE active = true AND (max_age_days IS NOT NULL OR max_messages IS NOT NULL)";
	var params = [];
	if (opts.shortcode) {
		sql += " AND UPPER(shortcode) = $1";
		params.push(String(opts.shortcode).toUpperCase().trim());
	}

	var areas = await postgres.query(sql, params);
	var result = { areasChecked: 0, messagesRemoved: 0, threadsRemoved: 0, areas: [] };
	if (!areas || areas.length === 0) return result;

	for (var area of areas) {
		try {
			var areaResult = await pruneArea(area, dryRun);
			result.areasChecked++;
			result.messagesRemoved += areaResult.messagesRemoved;
			result.threadsRemoved  += areaResult.threadsRemoved;
			result.areas.push(areaResult);
		} catch (err) {
			alogger.writeAlog(2, "enforceRetentionLimits: " + area.shortcode + " failed: " +
				(err.message || err), "redbright");
			result.areas.push({
				shortcode: area.shortcode,
				error: err.message || String(err),
				messagesRemoved: 0,
				threadsRemoved: 0
			});
		}
	}

	if (!dryRun && (result.messagesRemoved > 0 || result.threadsRemoved > 0)) {
		alogger.writeAlog(1, "[retention] pruned " + result.messagesRemoved + " message(s) and " +
			result.threadsRemoved + " empty thread(s) across " + result.areasChecked + " area(s)",
			"cyan", true);
	}

	return result;
}

/**
 * Preview a prune for one area without touching anything.
 *
 * Takes an area-shaped object rather than a shortcode so a proposed limit can
 * be previewed before it is saved. Runs the same pruneArea() selection logic
 * the real job uses, so the preview and the run can never disagree.
 */
async function previewRetentionForArea(area) {
	return await pruneArea(area, true);
}

/**
 * The outbound floor for an area: the highest message id that every enabled
 * peer subscription has already been sent.
 *
 * Echomail export runs `WHERE id > msg_idx`, so deleting a message above a
 * peer's high water mark drops it from that feed permanently and silently. On
 * a hub that is downstream nodes losing mail with no error anywhere, so
 * pruning never crosses this line.
 *
 * Returns null when the area has no enabled subscriptions, meaning there is no
 * export obligation and anything may be pruned.
 */
async function getOutboundFloor(areaId) {
	var row = await postgres.queryOne(
		"SELECT MIN(COALESCE(msg_idx, 0)) AS floor_idx, COUNT(*) AS sub_count " +
		"FROM peer_area_subscriptions WHERE area_id = $1 AND enabled = true",
		[areaId]
	);
	if (!row || parseInt(row.sub_count) === 0) return null;
	return parseInt(row.floor_idx) || 0;
}

/**
 * Prune a single area. Split out so a dry run and the real thing walk exactly
 * the same selection logic and can never disagree.
 */
async function pruneArea(area, dryRun) {
	var shorty      = area.shortcode.toLowerCase().trim();
	var msgtable    = "mb_" + shorty + "_msgs";
	var threadtable = "mb_" + shorty + "_threads";

	var out = {
		shortcode: area.shortcode,
		maxAgeDays: area.max_age_days || null,
		maxMessages: area.max_messages || null,
		messagesRemoved: 0,
		threadsRemoved: 0,
		peersAdvanced: 0,
		peersBehind: [],
		outboundFloor: null
	};

	// Recorded for reporting only. Retention is authoritative: a peer that has
	// stopped collecting must not be able to pin a hub's message base forever.
	var floor = await getOutboundFloor(area.id);
	out.outboundFloor = floor;

	// Candidate ids, as a set so the two limits can overlap freely.
	var ids = new Set();

	if (area.max_age_days && area.max_age_days > 0) {
		var oldRows = await postgres.query(
			"SELECT id FROM " + msgtable +
			" WHERE COALESCE(system_time, created_at) < NOW() - ($1::text || ' days')::interval",
			[String(area.max_age_days)]
		);
		for (var r of (oldRows || [])) ids.add(parseInt(r.id));
	}

	if (area.max_messages && area.max_messages > 0) {
		var excessRows = await postgres.query(
			"SELECT id FROM " + msgtable + " ORDER BY id DESC OFFSET $1",
			[area.max_messages]
		);
		for (var r2 of (excessRows || [])) ids.add(parseInt(r2.id));
	}

	if (ids.size === 0) return out;

	// Retention is authoritative. An earlier version capped pruning at the
	// lowest enabled peer's high water mark so nothing was deleted before every
	// peer had collected it. That is the right instinct and the wrong rule: a
	// single downlink that stopped polling a year ago pins the floor at its old
	// position and retention silently does nothing forever, which is a worse
	// outcome than that peer missing mail it was never going to fetch.
	//
	// Pruning above a watermark does not corrupt anything. Export selects
	// `WHERE id > msg_idx`, so a deleted row is simply absent and the peer
	// receives what survives. The watermarks are dragged forward below purely
	// so the recorded state stays honest, and which peers lost how much is
	// reported rather than left silent.
	var eligible = Array.from(ids);

	if (eligible.length === 0) return out;

	// Which threads are affected, so they can be repaired afterwards.
	var threadRows = await postgres.query(
		"SELECT DISTINCT thread_id FROM " + msgtable + " WHERE id = ANY($1::int[]) AND thread_id IS NOT NULL",
		[eligible]
	);
	var threadIds = (threadRows || []).map(function (t) { return parseInt(t.thread_id); });

	if (dryRun) {
		out.messagesRemoved = eligible.length;

		// Report which peers would lose mail. This is the main thing a sysop
		// needs to see before committing, now that retention overrides
		// watermarks rather than deferring to them.
		var dryHighest = 0;
		for (var dpid of eligible) { if (dpid > dryHighest) dryHighest = dpid; }
		try {
			var dryBehind = await postgres.query(
				"SELECT pas.msg_idx, pc.uuid AS conn_uuid, p.name AS peer_name " +
				"FROM peer_area_subscriptions pas " +
				"JOIN peer_connections pc ON pc.id = pas.peer_connection_id " +
				"JOIN peers p ON p.id = pc.peer_id " +
				"WHERE pas.area_id = $1 AND COALESCE(pas.msg_idx, 0) < $2",
				[area.id, dryHighest]
			);
			for (var drow of (dryBehind || [])) {
				var dlost = 0;
				for (var deid of eligible) { if (deid > (parseInt(drow.msg_idx) || 0)) dlost++; }
				out.peersBehind.push({
					peer: drow.peer_name,
					connectionUUID: drow.conn_uuid,
					previousIdx: parseInt(drow.msg_idx) || 0,
					messagesLost: dlost
				});
			}
			out.peersAdvanced = (dryBehind || []).length;
		} catch (_) { /* reporting only */ }

		// Count threads that would be left with nothing.
		if (threadIds.length) {
			var emptied = await postgres.query(
				"SELECT t.id FROM " + threadtable + " t WHERE t.id = ANY($1::int[]) AND NOT EXISTS (" +
				"  SELECT 1 FROM " + msgtable + " m WHERE m.thread_id = t.id AND NOT (m.id = ANY($2::int[]))" +
				")",
				[threadIds, eligible]
			);
			out.threadsRemoved = (emptied || []).length;
		}
		return out;
	}

	await postgres.write("DELETE FROM " + msgtable + " WHERE id = ANY($1::int[])", [eligible]);
	out.messagesRemoved = eligible.length;

	// Drag any watermark that now points into deleted space up to the highest
	// pruned id, and record what each peer lost. Nothing breaks without this,
	// but leaving msg_idx below a pruned range makes the number meaningless and
	// hides the loss from anyone reading it later.
	var highestPruned = 0;
	for (var pid of eligible) { if (pid > highestPruned) highestPruned = pid; }

	try {
		var behindRows = await postgres.query(
			"SELECT pas.id, pas.msg_idx, pc.uuid AS conn_uuid, p.name AS peer_name " +
			"FROM peer_area_subscriptions pas " +
			"JOIN peer_connections pc ON pc.id = pas.peer_connection_id " +
			"JOIN peers p ON p.id = pc.peer_id " +
			"WHERE pas.area_id = $1 AND COALESCE(pas.msg_idx, 0) < $2",
			[area.id, highestPruned]
		);

		for (var row of (behindRows || [])) {
			var lost = 0;
			for (var eid of eligible) { if (eid > (parseInt(row.msg_idx) || 0)) lost++; }
			out.peersBehind.push({
				peer: row.peer_name,
				connectionUUID: row.conn_uuid,
				previousIdx: parseInt(row.msg_idx) || 0,
				messagesLost: lost
			});
		}

		if (behindRows && behindRows.length > 0) {
			await postgres.write(
				"UPDATE peer_area_subscriptions SET msg_idx = $1, updated_at = NOW() " +
				"WHERE area_id = $2 AND COALESCE(msg_idx, 0) < $1",
				[highestPruned, area.id]
			);
			out.peersAdvanced = behindRows.length;

			for (var b of out.peersBehind) {
				alogger.writeAlog(2,
					"[retention] " + area.shortcode + ": advanced " + b.peer +
					" from msg_idx " + b.previousIdx + " to " + highestPruned + "; " +
					b.messagesLost + " pruned message(s) will not be sent to it",
					"yellowbright");
			}
		}
	} catch (err) {
		alogger.writeAlog(2, "pruneArea: watermark advance failed for " + area.shortcode +
			": " + (err.message || err), "redbright");
	}

	// Repair thread bookkeeping. The reader lists threads straight out of the
	// thread table and orders by last_message, so a stale count or a thread with
	// no messages left would show up as an empty, mis-sorted entry.
	if (threadIds.length) {
		var emptyRows = await postgres.query(
			"SELECT t.id FROM " + threadtable + " t WHERE t.id = ANY($1::int[]) AND NOT EXISTS (" +
			"  SELECT 1 FROM " + msgtable + " m WHERE m.thread_id = t.id)",
			[threadIds]
		);
		var emptyIds = (emptyRows || []).map(function (e) { return parseInt(e.id); });

		if (emptyIds.length) {
			// Drop the per-thread read pointers too, or they accumulate forever.
			// user_thread_pointers.thread_id holds the integer thread row id
			// (callers pass thread.id), so emptyIds match it directly.
			try {
				await postgres.write(
					"DELETE FROM user_thread_pointers WHERE area_shortcode = $1 AND thread_id = ANY($2::int[])",
					[area.shortcode, emptyIds]
				);
			} catch (ptrErr) {
				alogger.writeAlog(3, "pruneArea: thread pointer cleanup failed for " +
					area.shortcode + ": " + (ptrErr.message || ptrErr), "yellow");
			}

			await postgres.write("DELETE FROM " + threadtable + " WHERE id = ANY($1::int[])", [emptyIds]);
			out.threadsRemoved = emptyIds.length;
		}

		// Survivors get an accurate count and last_message.
		await postgres.write(
			"UPDATE " + threadtable + " t SET " +
			"  message_count = s.cnt, last_message = s.last_msg " +
			"FROM (SELECT thread_id, COUNT(*) AS cnt, MAX(COALESCE(system_time, created_at)) AS last_msg " +
			"      FROM " + msgtable + " WHERE thread_id = ANY($1::int[]) GROUP BY thread_id) s " +
			"WHERE t.id = s.thread_id",
			[threadIds]
		);
	}

	// Area-level counters (message_count, last_message, last_subject, ...)
	try {
		var msgAreasModule = await import('./msgAreas.js');
		await msgAreasModule.updateStatsForArea(area.shortcode);
	} catch (e) {
		alogger.writeAlog(3, "pruneArea: area stats update failed for " + area.shortcode +
			": " + (e.message || e), "yellow");
	}

	alogger.writeAlog(3, "[retention] " + area.shortcode + ": removed " + out.messagesRemoved +
		" message(s), " + out.threadsRemoved + " empty thread(s)" +
		(out.peersAdvanced ? ", advanced " + out.peersAdvanced + " lagging peer watermark(s)" : ""),
		"cyan");

	return out;
}

export {
	// Group/area listing
	listMsgGroups,
	getAreasInGroup,

	// Message retrieval
	getMessage,
	getMessageCount,
	countMessagesBefore,
	getMessages,
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

	// User posting
	saveMessage,
	startNewThread,
	replyToThread,
	resolveAreaAddress,

	// Inbound message handling (called by tossers)
	handleInboundEchoMessage,

	// Moderation
	moderationFor,
	moderationForArea,
	moderationTargetAllowed,
	buildMoveTargets,
	attachModeration,
	messageForClient,

	// Moving between areas
	getMessageByUUID,
	threadOriginSummary,
	canMoveMessageToArea,
	areaIsNetworked,
	networkedAreaIds,
	moveThreadToArea,
	moveMessageToArea,

	// Retention
	enforceRetentionLimits,
	previewRetentionForArea,

	// Threading helpers (used by all tossers and importers)
	threadMessage,
	createThreadRow,
	updateThreadStats,
	rollbackThread,
	getExistingThreadBySubject,

	// Thread update queue
	threadUpdateArray,
	drainThreadUpdateArray,
	pushThreadIdToUpdateQueue,

	// Imported msg_id tracking and orphan reconciliation
	pushImportedMsgId,
	drainImportedMsgIds,
	reconcileOrphans,
	applyThreadingForArea,

	// Thread maintenance
	updateThread,
	updateThreadArray,
	updateDailyThreads,
	updateAreaThreads,
	mergeThreads,
	mergeRecentThreads,

	// Message deletion
	deleteMessageByUUID,
	deleteThreadByUUID,

	// Utilities
	formatBodyHtml,
	sanitizeMessageFields
};

// ---------------------------------------------------------------------------
// Moving content between areas
// ---------------------------------------------------------------------------

/**
 * Fetch a message by uuid. getMessage() takes the numeric id; moderation works
 * in uuids because that is what the views carry.
 */
async function getMessageByUUID(uuid, shortcode) {
	var msgtable = 'mb_' + String(shortcode).toLowerCase().trim() + '_msgs';
	return await postgres.queryOne('SELECT * FROM ' + msgtable + ' WHERE uuid = $1', [uuid]);
}

/**
 * Where did a thread's messages come from?
 *
 * A thread is as restricted as its most restricted message: if any part of it
 * arrived off a network, moving the whole thread into a networked area would
 * republish that part, so the whole thread is treated as network-origin.
 */
async function threadOriginSummary(threadUUID, shortcode) {
	var shorty = String(shortcode).toLowerCase().trim();
	var msgtable = 'mb_' + shorty + '_msgs';
	var threadtable = 'mb_' + shorty + '_threads';

	var thread = await postgres.queryOne(
		'SELECT id FROM ' + threadtable + ' WHERE uuid = $1', [threadUUID]);
	if (!thread) return { found: false, anyFromNetwork: false, total: 0 };

	var row = await postgres.queryOne(
		'SELECT COUNT(*)::int AS total, ' +
		'COUNT(source_network_id)::int AS from_network ' +
		'FROM ' + msgtable + ' WHERE thread_id = $1', [thread.id]);

	return {
		found: true,
		total: row ? row.total : 0,
		anyFromNetwork: !!(row && row.from_network > 0)
	};
}

/**
 * May this message be moved into this area?
 *
 * Re-export on arrival is the point of moving, not a hazard: a thread that now
 * lives in a networked area should reach that network's peers. The risk is
 * different, and it is about provenance. Pushing mail that arrived from one
 * network into a different network's echo republishes someone else's traffic
 * under this system's name, which is antisocial and hard to undo once tossed.
 *
 * So:
 *
 *   locally written  may go anywhere, including a networked area. It is ours
 *                    to publish.
 *   from a network   may only go to a local-only area. Useful for pulling
 *                    something into a holding or archive area, and incapable
 *                    of re-injecting it into another network.
 *
 * Origin is read from `source_network_id`, which handleInboundEchoMessage
 * stamps on everything arriving off the wire and local posting never sets.
 *
 * @param {object} message           needs source_network_id
 * @param {boolean} destIsNetworked  whether the destination area is mapped to
 *                                   any network
 * @returns {object} { allowed, reason }
 */
function canMoveMessageToArea(message, destIsNetworked) {
	var locallyWritten = !message || message.source_network_id === null ||
		message.source_network_id === undefined;

	if (locallyWritten) return { allowed: true, reason: null };
	if (!destIsNetworked) return { allowed: true, reason: null };

	return {
		allowed: false,
		reason: 'This message arrived from a network. It can only be moved to a ' +
			'local area, so it is not republished into another network.'
	};
}

/**
 * Is this area carried on any network?
 */
async function areaIsNetworked(areaId) {
	var row = await postgres.queryOne(
		'SELECT COUNT(*)::int AS cnt FROM network_areas WHERE area_id = $1 AND active = true',
		[parseInt(areaId)]
	);
	return !!(row && row.cnt > 0);
}

/**
 * The same answer for every area at once, as a Set of area ids.
 *
 * buildMoveTargets needs it for the whole area list on every page render of a
 * thread, and asking per area is one query per area on a board that may carry
 * hundreds.
 */
async function networkedAreaIds() {
	var rows = await postgres.query(
		'SELECT DISTINCT area_id FROM network_areas WHERE active = true');
	var set = new Set();
	for (var r of (rows || [])) set.add(parseInt(r.area_id));
	return set;
}

/**
 * Copy a message row into another area's table.
 *
 * The id is dropped so the destination assigns its own: ids are per area and
 * carry the outbound high water mark meaning, so reusing one would put the
 * message behind peers' pointers and it would never be exported.
 */
function rowForInsert(row, threadRowId) {
	var copy = {};
	for (var key in row) {
		if (!row.hasOwnProperty(key)) continue;
		if (key === 'id' || key === 'thread_id') continue;
		copy[key] = row[key];
	}
	copy.thread_id = threadRowId;
	copy.updated_at = new Date();
	return copy;
}

/**
 * Move a whole thread, messages and all, into another area.
 *
 * @returns {object} { status, moved, errormessages }
 */
async function moveThreadToArea(threadUUID, fromShortcode, toShortcode) {
	var out = { status: false, moved: 0, errormessages: [] };

	var from = String(fromShortcode).toLowerCase().trim();
	var to   = String(toShortcode).toLowerCase().trim();
	if (from === to) {
		out.errormessages.push('Source and destination are the same area');
		return out;
	}

	var fromMsgs = 'mb_' + from + '_msgs';
	var fromThreads = 'mb_' + from + '_threads';
	var toMsgs = 'mb_' + to + '_msgs';
	var toThreads = 'mb_' + to + '_threads';

	var thread = await postgres.queryOne('SELECT * FROM ' + fromThreads + ' WHERE uuid = $1', [threadUUID]);
	if (!thread) {
		out.errormessages.push('Thread not found');
		return out;
	}

	var msgs = await postgres.query(
		'SELECT * FROM ' + fromMsgs + ' WHERE thread_id = $1 ORDER BY id ASC', [thread.id]);
	if (!msgs || msgs.length === 0) {
		out.errormessages.push('Thread has no messages');
		return out;
	}

	try {
		var created = await createThreadRow(toThreads, thread.threadid, thread.subject,
			thread.started_at, thread.started_by);
		if (!created || !created.threadId) {
			out.errormessages.push('Could not create the thread in the destination');
			return out;
		}

		for (var m of msgs) {
			await postgres.insertObject(rowForInsert(m, created.threadId), toMsgs);
			out.moved++;
		}

		// Set the totals rather than calling updateThreadStats, which bumps the
		// count by one for a single reply. createThreadRow already seeded it at
		// 1 and we have just inserted the whole thread.
		await postgres.write(
			'UPDATE ' + toThreads + ' SET message_count = $1, last_message = $2, ' +
			'last_message_from = $3 WHERE id = $4',
			[msgs.length, thread.last_message, thread.last_message_from, created.threadId]
		);

		await postgres.write('DELETE FROM ' + fromMsgs + ' WHERE thread_id = $1', [thread.id]);
		await postgres.write('DELETE FROM ' + fromThreads + ' WHERE id = $1', [thread.id]);

		// Per-thread read pointers are keyed to the source thread row and mean
		// nothing once it is gone.
		try {
			await postgres.write(
				'DELETE FROM user_thread_pointers WHERE area_shortcode = $1 AND thread_id = $2',
				[String(fromShortcode).toUpperCase(), thread.id]);
		} catch (_) { /* pointer cleanup is not worth failing the move over */ }

		await refreshAreaStats([fromShortcode, toShortcode]);

		out.status = true;
		alogger.writeAlog(2, 'moveThreadToArea: moved ' + out.moved + ' message(s) from ' +
			fromShortcode + ' to ' + toShortcode, 'cyan');
	} catch (err) {
		out.errormessages.push(err.message || String(err));
		alogger.writeAlog(2, 'moveThreadToArea failed: ' + (err.message || err), 'redbright');
	}

	return out;
}

/**
 * Move a single message into another area, threading it there.
 *
 * If it was the only message in its thread the empty thread row is removed
 * behind it, the same as a delete would.
 */
async function moveMessageToArea(msgUUID, fromShortcode, toShortcode) {
	var out = { status: false, errormessages: [] };

	var from = String(fromShortcode).toLowerCase().trim();
	var to   = String(toShortcode).toLowerCase().trim();
	if (from === to) {
		out.errormessages.push('Source and destination are the same area');
		return out;
	}

	var fromMsgs = 'mb_' + from + '_msgs';
	var fromThreads = 'mb_' + from + '_threads';
	var toMsgs = 'mb_' + to + '_msgs';
	var toThreads = 'mb_' + to + '_threads';

	var msg = await postgres.queryOne('SELECT * FROM ' + fromMsgs + ' WHERE uuid = $1', [msgUUID]);
	if (!msg) {
		out.errormessages.push('Message not found');
		return out;
	}

	try {
		var sourceThreadId = msg.thread_id;

		// Let the destination thread it: by reply_to, then subject, then a new
		// thread. Carrying the source thread_id across would point at a row in
		// another area's table.
		var placed = Object.assign({}, msg);
		delete placed.id;
		delete placed.thread_id;
		// threadMessage guarantees a thread: reply_to, then subject, then a new
		// one. No special handling needed here for content arriving from
		// another area.
		placed = await threadMessage(placed, toMsgs, toThreads, to);
		if (!placed.thread_id) {
			out.errormessages.push('Destination threading failed');
			return out;
		}

		await postgres.insertObject(placed, toMsgs);

		await postgres.write('DELETE FROM ' + fromMsgs + ' WHERE id = $1', [msg.id]);

		// Tidy the source thread: recount, or remove it if that was the last
		// message in it.
		if (sourceThreadId) {
			var remaining = await postgres.queryOne(
				'SELECT COUNT(*)::int AS cnt, MAX(COALESCE(system_time, created_at)) AS last_msg ' +
				'FROM ' + fromMsgs + ' WHERE thread_id = $1', [sourceThreadId]);

			if (!remaining || remaining.cnt === 0) {
				await postgres.write('DELETE FROM ' + fromThreads + ' WHERE id = $1', [sourceThreadId]);
				try {
					await postgres.write(
						'DELETE FROM user_thread_pointers WHERE area_shortcode = $1 AND thread_id = $2',
						[String(fromShortcode).toUpperCase(), sourceThreadId]);
				} catch (_) { /* not worth failing the move over */ }
			} else {
				await postgres.write(
					'UPDATE ' + fromThreads + ' SET message_count = $1, last_message = $2 WHERE id = $3',
					[remaining.cnt, remaining.last_msg, sourceThreadId]);
			}
		}

		await refreshAreaStats([fromShortcode, toShortcode]);

		out.status = true;
		alogger.writeAlog(2, 'moveMessageToArea: moved a message from ' + fromShortcode +
			' to ' + toShortcode, 'cyan');
	} catch (err) {
		out.errormessages.push(err.message || String(err));
		alogger.writeAlog(2, 'moveMessageToArea failed: ' + (err.message || err), 'redbright');
	}

	return out;
}

/**
 * Refresh area counters after content moves. last_message drives both the
 * areas list and its recently-active sort, so a stale one leaves an area
 * looking busier than it is.
 */
async function refreshAreaStats(shortcodes) {
	try {
		var msgAreasModule = await import('./msgAreas.js');
		for (var sc of shortcodes) {
			await msgAreasModule.updateStatsForArea(sc);
		}
	} catch (e) {
		alogger.writeAlog(3, 'refreshAreaStats failed: ' + (e.message || e), 'yellow');
	}
}

// ---------------------------------------------------------------------------
// Moderation affordances, attached to the content itself
// ---------------------------------------------------------------------------

/**
 * What may this user do with this message or thread?
 *
 * Deliberately answered here rather than in each view. The web thread view, the
 * flat view, the terminal reader and anything else that shows a message all
 * need the same answer, and working it out separately in each is how they drift
 * apart: a rule tightened in one place silently stays loose in another.
 *
 * Callers attach the result to the item as `.moderation` and views read it.
 * Adding a consumer means reading a field, not reimplementing a policy.
 *
 * @param {object} user
 * @param {object} area     the area the content currently lives in
 * @param {object} item     message or thread; needs source_network_id for a
 *                          message, or anyFromNetwork for a thread
 * @param {Array}  targets  candidate destinations from buildMoveTargets()
 * @returns {object} { canDelete, canMove, targets }
 */
function moderationFor(user, area, item, targets) {
	var allowed = canModerateArea(user, area);
	if (!allowed) return { canDelete: false, canMove: false, fromNetwork: false, targets: [] };

	// A thread reports anyFromNetwork; a single message carries the column.
	var fromNetwork = (item && item.anyFromNetwork !== undefined)
		? !!item.anyFromNetwork
		: !(item && (item.source_network_id === null || item.source_network_id === undefined));

	var usable = (targets || []).filter(function (t) {
		return moderationTargetAllowed(fromNetwork, t.networked);
	});

	return {
		canDelete: true,
		canMove: usable.length > 0,
		fromNetwork: fromNetwork,
		targets: usable
	};
}

/**
 * The area-level answer: may this user moderate here at all, and what are all
 * the candidate destinations before any single item narrows them?
 *
 * A view uses this to decide whether to render the moderation dialogs and the
 * destination list at all, and reads item.moderation for each individual
 * control. Both come from here so a view never asks the permission question
 * itself.
 */
function moderationForArea(user, area, targets) {
	var enabled = canModerateArea(user, area);
	return { enabled: enabled, targets: enabled ? (targets || []) : [] };
}

/**
 * The destination half of the move rule, kept separate so both the decorator
 * and the route guard read the same line.
 */
function moderationTargetAllowed(fromNetwork, targetIsNetworked) {
	if (!fromNetwork) return true;         // ours to publish anywhere
	return !targetIsNetworked;             // theirs: local destinations only
}

/**
 * Candidate destinations for a move: active areas the user may post to, minus
 * the one the content is already in, each flagged with whether it is carried on
 * a network.
 *
 * Computed once per request and handed to moderationFor for each item, since
 * the expensive part is the same for every message on the page.
 */
async function buildMoveTargets(user, excludeShortcode, postAccessCheck) {
	if (!user) return [];

	var msgAreasModule = await import('./msgAreas.js');
	var all = await msgAreasModule.getAllAreas();
	var networked = await networkedAreaIds();
	var targets = [];

	for (var a of (all || [])) {
		if (!a.active) continue;
		if (excludeShortcode && a.shortcode === excludeShortcode) continue;
		if (postAccessCheck && !postAccessCheck(user, a)) continue;
		targets.push({
			shortcode: a.shortcode,
			name: a.name,
			group_shortcode: a.group_shortcode,
			networked: networked.has(parseInt(a.id))
		});
	}

	return targets;
}

/**
 * The shape a message takes when it is sent to the browser.
 *
 * Both lazy-load endpoints append messages to a page that already rendered the
 * first batch server side, so the two have to agree on every field the row
 * builder reads. Defining it twice is how `uuid` came to be missing from the
 * JSON while the builder was still reading it, which left an appended
 * message's delete control addressing nothing.
 *
 * The full destination list is deliberately not included. It is already on the
 * page once from moderationForArea, and repeating it per message would send
 * the whole area list thirty times over.
 */
function messageForClient(m, threadUUID) {
	var mod = (m && m.moderation) || {};
	return {
		id: m.id,
		uuid: m.uuid || '',
		msg_id: m.msg_id,
		from_user: m.from_user,
		to_user: m.to_user,
		subject: m.subject,
		system_time: m.system_time,
		body_text: m.body_text,
		body_html: m.body_html,
		isAnsi: m.isAnsi || false,
		thread_uuid: threadUUID || m.thread_uuid || '',
		moderation: {
			canDelete: !!mod.canDelete,
			canMove: !!mod.canMove,
			fromNetwork: !!mod.fromNetwork
		}
	};
}

/**
 * Attach `.moderation` to every item in a list.
 *
 * One pass, one target list, so a page of thirty messages does not run the
 * area lookup thirty times.
 */
function attachModeration(user, area, items, targets) {
	for (var item of (items || [])) {
		item.moderation = moderationFor(user, area, item, targets);
	}
	return items;
}
