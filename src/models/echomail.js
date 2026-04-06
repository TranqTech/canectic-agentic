//imports
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as msgAreas from './msgAreas.js';
import * as ftn from "./ftnClasses.js";
import * as ftnUtils from "../utils/ftnUtils.js";
import * as ftnTosser from "../middleware/tossers/ftnTosser.js";
import * as systemAddresses from "./systemAddresses.js";
import * as peerConnections from "./peerConnections.js";
import * as peerAreaSubscriptions from "./peerAreaSubscriptions.js";
import * as networkAreas from "./networkAreas.js";
import { formatBodyHtml } from "../utils/terminalText.js";
import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";


const maxOutbound     = 1000;
const default_tzutc   = "-0600";

var threadUpdateArray = [];

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

async function getMessagesForArea(shortcode, startindex) {
	// TODO: implement paginated message retrieval
}

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
			msg.isAnsi = displayText.includes("\x1b[") ||
				/\|\d{2}/.test(displayText) ||
				displayText.includes("\x01");
		} else {
			// Pre-rendered — still need to detect if terminal rendering is needed
			var checkText = msg.utf8 || msg.body_text || '';
			msg.isAnsi = checkText.includes("\x1b[") ||
				/\|\d{2}/.test(checkText) ||
				checkText.includes("\x01");
		}
	}

	return msglist;
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
	var dbObj = await ftnToDb(message);
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
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

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
// be lost.  Short-lived CLI processes can still read threadUpdateArray
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

async function getExistingThreadBySubject(message, threadtable, subject, strippedre) {
	var uselike  = !!strippedre;
	var currtime = new Date();
	var existingthread;

	var starttime  = new Date(message.system_time);
	var moderntime = new Date(message.system_time);
	starttime.setDate(starttime.getDate() - 30);
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

async function threadMessage(message, messagetable, threadtable, shortcode) {
	var existingthread;
	var querytext;

	if (message.threadid) {
		querytext = "SELECT * FROM " + threadtable + " WHERE threadid = $1";
		existingthread = await postgres.queryOne(querytext, [message.threadid]);
		if (existingthread) {
			message.thread_id = existingthread.id;
			await pushThreadIdToUpdateQueue(existingthread.id, shortcode);
		}
		return message;
	}

	if (!message.reply_to) {
		var checksubject = message.subject;
		if (message.subject.toUpperCase().startsWith('RE:')) {
			var i = 0;
			while (checksubject.toUpperCase().startsWith('RE:')) {
				checksubject = checksubject.substring(3).trim();
				i++;
				if (i > 10) break;
			}
		}

		existingthread = await getExistingThreadBySubject(message, threadtable, checksubject, true);
		if (!existingthread && checksubject !== message.subject) {
			existingthread = await getExistingThreadBySubject(message, threadtable, message.subject, false);
		}

		if (existingthread) {
			message.threadid  = existingthread.threadid;
			message.thread_id = existingthread.id;
		} else {
			// Create new thread
			var threadid     = message.msg_id;
			var uniqueThread = await postgres.checkValueUnique("threadid", threadid, threadtable);
			if (uniqueThread) {
				var uuid = uuidv4();
				var threadObj = {
					uuid: uuid,
					subject: message.subject,
					threadid: message.msg_id,
					started_at: message.system_time,
					started_by: message.from_user,
					message_count: 1,
					last_message: message.system_time
				};
				var result = await postgres.insertObject(threadObj, threadtable);
				if (result.status === true && result.insertId) {
					message.thread_id = result.insertId;
					message.threadid  = threadid;
				} else {
					alogger.writeAlog(3, "threadMessage: could not save thread for " + message.msg_id, "redbright");
				}
			} else {
				// Thread already exists — find and attach
				querytext = "SELECT * FROM " + threadtable + " WHERE UPPER(threadid) LIKE UPPER($1)";
				var dbthread = await postgres.queryOne(querytext, [threadid]);
				if (dbthread) {
					message.threadid  = dbthread.threadid;
					message.thread_id = dbthread.id;
					await pushThreadIdToUpdateQueue(dbthread.id, shortcode);
				}
			}
		}
	} else {
		querytext = "SELECT threadid, thread_id FROM " + messagetable + " WHERE UPPER(msg_id) LIKE UPPER($1)";
		var upstreammsg = await postgres.queryOne(querytext, [message.reply_to]);
		if (upstreammsg) {
			var hasthread = false;
			if (upstreammsg.threadid) {
				message.threadid = upstreammsg.threadid;
				hasthread = true;
			}
			if (upstreammsg.thread_id) {
				message.thread_id = upstreammsg.thread_id;
				hasthread = true;
			}
			if (hasthread) {
				await pushThreadIdToUpdateQueue(upstreammsg.thread_id, shortcode);
			}
		} else {
			// Parent message not found (deleted or not imported).
			// Fall back to subject matching so the reply joins an existing thread
			// rather than becoming an orphan.
			var checksubject = message.subject;
			if (checksubject.toUpperCase().startsWith('RE:')) {
				var j = 0;
				while (checksubject.toUpperCase().startsWith('RE:')) {
					checksubject = checksubject.substring(3).trim();
					j++;
					if (j > 10) break;
				}
			}

			existingthread = await getExistingThreadBySubject(message, threadtable, checksubject, true);
			if (!existingthread && checksubject !== message.subject) {
				existingthread = await getExistingThreadBySubject(message, threadtable, message.subject, false);
			}

			if (existingthread) {
				message.threadid  = existingthread.threadid;
				message.thread_id = existingthread.id;
				await pushThreadIdToUpdateQueue(existingthread.id, shortcode);
			}
		}
	}

	return message;
}

async function ftnToDb(ftnMessage) {
	var currtime   = new Date();
	var systemTime = await ftnUtils.getSystemTime(ftnMessage.DateTime, ftnMessage.TZUTC);
	var uuid       = uuidv4();
	var dbObj = {
		user_id: 0,
		uuid: uuid,
		msg_id: ftnMessage.MsgId,
		reply_to: ftnMessage.ReplyTo,
		tosser_id: ftnMessage.TosserId,
		optional_attributes: ftnMessage.OptionalAttributes,
		source: ftnMessage.Source,
		domain: "",
		destination: ftnMessage.Destination,
		source_zone: ftnMessage.Source ? ftnMessage.Source.split(":")[0] : "",
		source_net: ftnMessage.SourceNet,
		source_node: ftnMessage.SourceNode,
		destination_zone: ftnMessage.Destination ? ftnMessage.Destination.split(":")[0] : "",
		destination_net: ftnMessage.DestinationNet,
		destination_node: ftnMessage.DestinationNode,
		to_user: ftnMessage.ToUser,
		from_user: ftnMessage.FromUser,
		subject: ftnMessage.Subject     ? ftnMessage.Subject.replace(/\x00/g, '').trim() : "",
		body_text: ftnMessage.BodyText  ? ftnMessage.BodyText.replace(/\x00/g, '')       : "",
		origin_line: ftnMessage.OriginLine ? ftnMessage.OriginLine.replace(/\x00/g, '')  : "",
		raw_text: ftnMessage.RawText    ? ftnMessage.RawText.replace(/\x00/g, '')        : "",
		datetime_string: ftnMessage.DateTime,
		tz_utc: ftnMessage.TZUTC,
		seen_by: ftnMessage.SeenBy,
		path: ftnMessage.Path,
		system_time: systemTime,
		created_at: currtime,
		updated_at: null
	};
	return dbObj;
}

async function dbToFtn(dbMessage) {
	var optional_attributes = dbMessage.optional_attributes || [];
	var ftnMsg = {
		Type: "Echomail",
		Id: dbMessage.id,
		MsgId: dbMessage.msg_id,
		ReplyTo: dbMessage.reply_to,
		OptionalAttributes: optional_attributes,
		Source: dbMessage.source,
		SourceZone: dbMessage.source_zone,
		SourceNet: dbMessage.source_net,
		SourceNode: dbMessage.source_node,
		Domain: dbMessage.domain,
		Destination: dbMessage.destination,       // fixed: was dbMessage.Destination
		DestinationZone: dbMessage.destination_zone,
		DestinationNet: dbMessage.destination_net,
		DestinationNode: dbMessage.destination_node,
		ToUser: dbMessage.to_user,
		FromUser: dbMessage.from_user,
		Subject: dbMessage.subject,
		BodyText: dbMessage.body_text,
		OriginLine: dbMessage.origin_line,
		ProductLine: dbMessage.product_string,
		SignatureString: dbMessage.signature_string,
		DateTime: dbMessage.datetime_string,
		TZUTC: dbMessage.tz_utc,
		SeenBy: dbMessage.seen_by,
		Path: dbMessage.path                       // fixed: was dbMessage.Path
	};
	return ftnMsg;
}

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

async function applyThreadingForArea(shortcode) {
	var shorty       = shortcode.toLowerCase();
	var msgtablename = "mb_" + shorty + "_msgs";
	var idarray      = [];
	var noupstreamarray = [];
	var utarray      = [];

	var idlist = await postgres.query("SELECT msg_id FROM " + msgtablename, []);
	if (idlist && idlist.length > 0) {
		for (var mi of idlist) {
			idarray.push(mi.msg_id);
		}
	}

	var unthreadedlist = await postgres.query(
		"SELECT id, uuid, msg_id, thread_id, threadid, reply_to, subject, system_time FROM " +
		msgtablename + " WHERE threadid is null AND reply_to is not null",
		[]
	);
	if (!unthreadedlist || unthreadedlist.length === 0) return;

	for (var msg of unthreadedlist) {
		if (!idarray.includes(msg.reply_to)) {
			noupstreamarray.push(msg.msg_id);
		}
		if (!utarray.includes(msg.msg_id)) {
			utarray.push(msg.msg_id);
		}
	}

	// TODO: implement full upstream matching and threading pass
}

async function updateSeenbyArray(sbArray) {
	if (!sbArray || sbArray.length < 1) return false;
	for (var sb of sbArray) {
		try {
			await postgres.write(
				"UPDATE " + sb.msgtable + " SET seen_by = $1 WHERE id = $2",
				[sb.newsbstring, sb.id]
			);
		} catch (error) {
			alogger.writeAlog(3, "updateSeenbyArray: error for id " + sb.id + ": " + error.message, "redbright");
		}
	}
}

async function getOutboundForConnection(conn) {
	// conn is a peer_connections row joined with network fields.
	// connection_data holds FTN-specific transport fields.
	var cd = conn.connection_data || {};
	var nodeAddress = cd.address;

	if (!nodeAddress) {
		alogger.writeAlog(3, "getOutboundForConnection: no address in connection_data for conn " + conn.uuid, "redbright");
		return;
	}

	alogger.writeAlog(5, "Checking echomail for " + conn.peer_name + " - " + nodeAddress, "cyan");

	// Resolve our system address for this connection.
	// Priority: 1) explicitly set system_address_id on connection
	//           2) default address for this network
	//           3) first active address matching zone + domain (legacy fallback)
	var systemaddress = {};
	var resolvedRow   = null;

	if (conn.system_address_id) {
		resolvedRow = await systemAddresses.getAddressById(conn.system_address_id);
		if (resolvedRow && !resolvedRow.active) {
			alogger.writeAlog(4,
				"getOutboundForConnection: assigned system address " + resolvedRow.address +
				" is inactive for conn " + conn.uuid + " — falling back to network default",
				"yellow"
			);
			resolvedRow = null;
		}
	}

	if (!resolvedRow) {
		resolvedRow = await systemAddresses.getDefaultAddress(conn.network_id);
	}

	if (!resolvedRow) {
		// Legacy fallback: zone + domain scan
		var zone   = nodeAddress.split(":")[0];
		var domain = conn.domain || "";
		var dblist = await systemAddresses.getAddressesForZone(zone, domain);
		if (!dblist || dblist.length === 0) {
			if (domain) dblist = await systemAddresses.getAddressesForDomain(domain);
		}
		if (dblist && dblist.length > 0) resolvedRow = dblist[0];
	}

	if (!resolvedRow) {
		alogger.writeAlog(3,
			"getOutboundForConnection: no system address available for conn " + conn.uuid +
			" — cannot toss outbound",
			"redbright"
		);
		return;
	}

	var bzsplit  = resolvedRow.address.split(":");
	var bnnsplit = bzsplit[1].split("/");
	var bnpsplit = bnnsplit[1].split(".");
	systemaddress.address = resolvedRow.address;
	systemaddress.zone    = bzsplit[0];
	systemaddress.net     = bnnsplit[0];
	systemaddress.node    = bnpsplit[0];
	systemaddress.netnode = systemaddress.net + "/" + systemaddress.node;
	if (bnpsplit.length > 1) systemaddress.point = bnpsplit[1];

	// Parse destination node address and strip point component
	var netnode   = nodeAddress.split(":")[1];
	if (netnode.includes(".")) {
		var netnodeParts = netnode.split(".");
		netnode = netnodeParts[0];
	}

	// Get all enabled subscriptions for this connection, joined with areatag
	// from network_areas so we can stamp the FTN AreaTag on each message
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
		[conn.network_id, conn.id]
	);

	if (!enabledSubs || enabledSubs.length === 0) {
		alogger.writeAlog(5, "No areas enabled for connection " + conn.uuid, "cyan");
		return;
	}

	var nodeSeenByUpdateArray = [];
	var tossableArray         = [];
	// Collect {pas_id, area_id, newIdx} for bulk msg_idx update on success
	var idxUpdateArray        = [];

	for (var sub of enabledSubs) {
		var curIdx  = sub.msg_idx || 0;
		var shorty  = sub.shortcode.toLowerCase().trim();
		var msgtable = "mb_" + shorty + "_msgs";

		var finalidxResult = await postgres.query(
			"SELECT id FROM " + msgtable + " ORDER BY id DESC LIMIT 1", []
		);
		var finalidx = (finalidxResult && finalidxResult[0]) ? finalidxResult[0].id : 0;

		if (curIdx > finalidx) {
			// Index got ahead somehow — reset
			curIdx = finalidx;
		}

		if (finalidx > curIdx) {
			outerLoop: while (finalidx > curIdx) {
				var msglist = await postgres.query(
					"SELECT * FROM " + msgtable + " WHERE id > $1 LIMIT 500",
					[curIdx]
				);

				if (msglist && msglist.length > 0) {
					for (var msg of msglist) {
						if (tossableArray.length >= maxOutbound) break outerLoop;

						var istossable   = true;
						var updateseenby = false;
						var seenbystring = "";

						// Skip messages that originated on this connection's network
						// (catches both FTN source-address check and NNTP-imported messages)
						if (msg.source_network_id && msg.source_network_id === conn.network_id) {
							istossable = false;
						}

						// FTN-specific: skip if we received it from this node
						if (istossable && msg.source === nodeAddress) {
							istossable = false;
						}

						if (istossable) {
							msg.source           = systemaddress.address;
							msg.source_zone      = systemaddress.zone;
							msg.source_net       = systemaddress.net;
							msg.source_node      = systemaddress.node;
							msg.destination      = nodeAddress;
							msg.destination_zone = nodeAddress.split(":")[0];
							msg.destination_net  = netnode.split("/")[0];
							msg.destination_node = netnode.split("/")[1];

							if (msg.seen_by) {
								var netpresent = false;
								var sbArray    = msg.seen_by.split(" ");
								var sbnets     = [];
								var netobj;

								for (var sb of sbArray) {
									if (sb.includes("/")) {
										if (netobj) sbnets.push(netobj);
										var sbsplit = sb.split("/");
										netobj = {
											net: sbsplit[0],
											netstring: sb,
											nodes: [sbsplit[1]]
										};
									} else if (netobj) {
										netobj.nodes.push(sb);
										netobj.netstring += " " + sb;
									}
								}
								if (netobj) sbnets.push(netobj);

								for (var net of sbnets) {
									if (net.net === msg.destination_net) {
										netpresent = true;
										if (net.nodes.includes(msg.destination_node)) {
											istossable = false;
										} else {
											net.nodes.push(msg.destination_node);
											net.netstring += " " + msg.destination_node;
										}
									}
								}

								if (istossable) {
									updateseenby = true;
									if (netpresent) {
										for (var sn of sbnets) {
											if (seenbystring.length > 0) seenbystring += " ";
											seenbystring += sn.netstring;
										}
									} else {
										seenbystring = (msg.seen_by ? msg.seen_by + " " : "");
										seenbystring += msg.destination_net + "/" + msg.destination_node;
									}
								}
							} else {
								updateseenby = true;
								seenbystring = systemaddress.netnode;
								if (msg.destination_net === systemaddress.net) {
									seenbystring += " " + msg.destination_node;
								} else {
									seenbystring += " " + msg.destination_net + "/" + msg.destination_node;
								}
							}

							if (msg.path) {
								var patharr = msg.path.split(" ");
								if (patharr.includes(netnode)) istossable = false;
							}
						}

						if (istossable) {
							if (updateseenby) {
								msg.seen_by = seenbystring;
								nodeSeenByUpdateArray.push({
									id: msg.id,
									msgtable: msgtable,
									newsbstring: seenbystring
								});
							}
							msg.path = systemaddress.netnode;
							var ftnObj = await dbToFtn(msg);
							ftnObj.AreaTag = sub.areatag;
							tossableArray.push(ftnObj);
						}

						curIdx = msg.id;
					}
				} else {
					break;
				}
			}
		}

		idxUpdateArray.push({ pas_id: sub.id, area_id: sub.area_id, newIdx: curIdx });
	}

	if (tossableArray.length > 0) {
		var msgcount  = tossableArray.length;
		var pktresult = await ftnTosser.WritePktsToNode(tossableArray, conn, systemaddress);
		if (pktresult && pktresult.processedcount) {
			if (pktresult.processedcount >= msgcount) {
				alogger.writeAlog(5,
					"Wrote " + pktresult.processedcount + " messages in " + pktresult.pktcount +
					" packets to " + conn.peer_name,
					"greenbright"
				);
				await updateMsgIndexes(idxUpdateArray);
				await updateSeenbyArray(nodeSeenByUpdateArray);
			} else {
				// TODO: more graceful partial-send handling to allow re-tossing
				alogger.writeAlog(3,
					"getOutboundForConnection: failed to process all messages for " + conn.peer_name,
					"redbright"
				);
			}
		}
	} else {
		await updateMsgIndexes(idxUpdateArray);
	}
}

// Writes updated msg_idx values back to peer_area_subscriptions.
// Called after a successful outbound toss or when there was nothing to send.
async function updateMsgIndexes(idxUpdateArray) {
	if (!idxUpdateArray || idxUpdateArray.length === 0) return;
	var currtime = new Date();
	for (var entry of idxUpdateArray) {
		var err = await postgres.write(
			"UPDATE peer_area_subscriptions SET msg_idx = $1, updated_at = $2 WHERE id = $3",
			[entry.newIdx, currtime, entry.pas_id]
		);
		if (err) {
			alogger.writeAlog(3,
				"updateMsgIndexes: failed to update msg_idx for pas id " + entry.pas_id +
				": " + err.message,
				"redbright"
			);
		}
	}
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

	// Resolve system FTN address for this area via network_areas + system_addresses.
	// Uses the default address for the network if set, otherwise first active address.
	// origin_line: use address's custom origin_line if set, else "boardname address".
	var boardname = appConfig.get('boardname', 'Canectic BBS');
	var address = null;
	var path    = null;
	var origin_line = boardname;

	var areaNetworks = await networkAreas.getNetworksByArea(area.id);
	var ftnNet = areaNetworks.find(an => an.network_type === "FTN" && an.network_active);
	if (ftnNet) {
		var defaultAddr = await systemAddresses.getDefaultAddress(ftnNet.network_id);
		if (!defaultAddr) {
			var addrs = await systemAddresses.getAddressesForDomain(ftnNet.domain);
			if (addrs && addrs.length > 0) defaultAddr = addrs[0];
		}
		if (defaultAddr) {
			address = defaultAddr.address;
			origin_line = defaultAddr.origin_line
				? defaultAddr.origin_line
				: boardname + " " + address;
		}
	}
	if (!origin_line) origin_line = boardname;
	if (address) {
		path = address.split(":")[1];
	}

	var millihex       = ftnUtils.getMilliHex();
	var datetimestring = await ftnUtils.getDateTimeString();
	var msgid          = (address ? address + " " : "") + millihex;
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
		returnObj.errormessages.push("Couldn't save thread!");  // fixed: was resultObj (undefined)
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
		source: address,
		from_user: formObj.from_user,
		to_user: touser,
		subject: formObj.subject,
		body_text: formObj.body_text,
		datetime_string: datetimestring,
		system_time: currtime,
		path: path,
		origin_line: origin_line,
		product_string: "Canectic BBS v" + appConfig.get('currentversion', '0.1a')
	};

	var msgresult = await postgres.insertObject(dbObj, msgtable);
	if (msgresult.status === true) {
		returnObj.status     = true;
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

	// Resolve system FTN address for this area via network_areas + system_addresses.
	// Uses the default address for the network if set, otherwise first active address.
	// origin_line: use address's custom origin_line if set, else "boardname address".
	var boardname = appConfig.get('boardname', 'Canectic BBS');
	var address = null;
	var path    = null;
	var origin_line = boardname;

	var areaNetworks = await networkAreas.getNetworksByArea(area.id);
	var ftnNet = areaNetworks.find(an => an.network_type === "FTN" && an.network_active);
	if (ftnNet) {
		var defaultAddr = await systemAddresses.getDefaultAddress(ftnNet.network_id);
		if (!defaultAddr) {
			var addrs = await systemAddresses.getAddressesForDomain(ftnNet.domain);
			if (addrs && addrs.length > 0) defaultAddr = addrs[0];
		}
		if (defaultAddr) {
			address = defaultAddr.address;
			origin_line = defaultAddr.origin_line
				? defaultAddr.origin_line
				: boardname + " " + address;
		}
	}
	if (!origin_line) origin_line = boardname;
	if (address) {
		path = address.split(":")[1];
	}

	var millihex       = ftnUtils.getMilliHex();
	var datetimestring = await ftnUtils.getDateTimeString();
	var msgid          = (address ? address + " " : "") + millihex;
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
		source: address,
		from_user: formObj.from_user,
		to_user: touser,
		subject: formObj.subject,
		body_text: formObj.body_text,
		datetime_string: datetimestring,
		system_time: currtime,
		path: path,
		origin_line: origin_line,
		product_string: "Canectic BBS v" + appConfig.get('currentversion', '0.1a')
	};

	var msgresult = await postgres.insertObject(dbObj, msgtable);
	if (msgresult.status === true) {
		returnObj.status = true;
		await updateThread(thread_id, shortcode);
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(msgresult.errormessages);
	}

	return returnObj;
}

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
// Thread helpers — shared by all tossers (FTN, QWK, NNTP)
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

export {
	deleteMessageByUUID,
	handleInboundEchoMessage,
	getMessagesForArea,
	getThreadsForArea,
	getRecentThreadsForArea,
	getMessagesForThread,
	applyThreadingForArea,
	getMessageById,
	getThreadByUUID,
	updateAreaThreads,
	updateThread,
	updateThreadArray,
	updateDailyThreads,
	threadUpdateArray,
	drainThreadUpdateArray,
	mergeRecentThreads,
	getOutboundForConnection,
	startNewThread,
	replyToThread,
	// Thread helpers for tossers and importers
	threadMessage,
	createThreadRow,
	updateThreadStats,
	rollbackThread
};