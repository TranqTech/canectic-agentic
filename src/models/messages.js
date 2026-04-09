// messages.js — Canonical message model.
// All message CRUD, threading, posting, sanitization, and read operations
// live here. echomail.js is now reduced to FTN-specific tosser helpers
// (ftnToDb/dbToFtn, getOutboundForConnection).

//imports
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
import { formatBodyHtml } from '../utils/terminalText.js';
import * as alogger from '../utils/alogger.js';
import appConfig from "../config/appConfig.js";


const default_tzutc   = "-0600";

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
		product_string: "Canectic BBS v" + appConfig.get('currentversion', '0.1a')
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
		product_string: "Canectic BBS v" + appConfig.get('currentversion', '0.1a')
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
function pushImportedMsgId(msgId, shortcode) {
	if (!msgId || !shortcode) return;
	importedMsgIds.push({ msgId: msgId, shortcode: shortcode });
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

async function getExistingThreadBySubject(message, threadtable, subject, strippedre, maxAgeDays) {
	var uselike  = !!strippedre;
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
		querytext = uselike
			? "SELECT * FROM " + threadtable + " WHERE subject LIKE $1 AND last_message >= $2 ORDER BY last_message DESC"
			: "SELECT * FROM " + threadtable + " WHERE subject = $1 AND last_message >= $2 ORDER BY last_message DESC";
		existingthread = await postgres.queryOne(querytext, [subject, starttime]);
	} else {
		// Archival message
		querytext = uselike
			? "SELECT * FROM " + threadtable + " WHERE subject LIKE $1 AND started_at >= $2 AND started_at <= $3 ORDER BY started_at DESC"
			: "SELECT * FROM " + threadtable + " WHERE subject = $1 AND started_at >= $2 AND started_at <= $3 ORDER BY started_at DESC";
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

	// Step A: Pre-assigned threadid (used by rethreadAreas)
	if (message.threadid) {
		querytext = "SELECT * FROM " + threadtable + " WHERE threadid = $1";
		existingthread = await postgres.queryOne(querytext, [message.threadid]);
		if (existingthread) {
			message.thread_id = existingthread.id;
			await pushThreadIdToUpdateQueue(existingthread.id, shortcode);
		}
		return message;
	}

	// Step B: reply_to lookup (case-insensitive MSGID match)
	if (message.reply_to) {
		querytext = "SELECT threadid, thread_id FROM " + messagetable + " WHERE UPPER(msg_id) = UPPER($1)";
		var upstreammsg = await postgres.queryOne(querytext, [message.reply_to]);
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

	existingthread = await getExistingThreadBySubject(message, threadtable, checksubject, true, subjectAgeDays);
	if (!existingthread && checksubject !== message.subject) {
		existingthread = await getExistingThreadBySubject(message, threadtable, message.subject, false, subjectAgeDays);
	}

	if (existingthread) {
		message.threadid  = existingthread.threadid;
		message.thread_id = existingthread.id;
		await pushThreadIdToUpdateQueue(existingthread.id, shortcode);
		return message;
	}

	// Step D: Create new thread (guaranteed -- never leave message threadless)
	var threadidStr = message.msg_id;
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

	// Check for duplicate
	var isUnique = await postgres.checkValueUnique("msg_id", message.MsgId, msgtablename);
	if (!isUnique) {
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
	var displayText = dbObj.utf8 || dbObj.body_text || '';
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
		if (dbObj.msg_id) pushImportedMsgId(dbObj.msg_id, shorty);
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

		var querytext   = "SELECT * FROM " + threadtable + " WHERE subject LIKE $1 AND id != $2 AND last_message >= $3 ORDER BY last_message DESC";
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
 * Post-batch orphan reconciliation. For each msg_id that was just imported,
 * find messages whose reply_to matches it and whose thread differs from the
 * parent's thread. Re-link them to the correct thread.
 */
async function reconcileOrphans(shortcode, msgIds) {
	if (!msgIds || msgIds.length === 0) return 0;
	var shorty          = shortcode.toLowerCase();
	var msgtablename    = "mb_" + shorty + "_msgs";
	var fixed = 0;

	for (var msgId of msgIds) {
		// Find the parent message's thread info
		var parent = await postgres.queryOne(
			'SELECT threadid, thread_id FROM ' + msgtablename + ' WHERE UPPER(msg_id) = UPPER($1)',
			[msgId]
		);
		if (!parent || !parent.thread_id) continue;

		// Find children that reference this parent but have wrong/missing thread
		var children = await postgres.query(
			'SELECT id, threadid, thread_id FROM ' + msgtablename +
			' WHERE UPPER(reply_to) = UPPER($1) AND (thread_id IS NULL OR thread_id != $2)',
			[msgId, parent.thread_id]
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
