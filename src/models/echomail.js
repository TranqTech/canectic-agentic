//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { DateTime } from "luxon";

//internal modules
import * as postgres from '../middleware/db/postgres.js'
import * as msgAreas from './msgAreas.js'
import * as ftn from "./ftnClasses.js"
import * as ftnUtils from "../utils/ftnUtils.js"
import * as ftnTosser from "../middleware/ftnTosser.js"
import * as systemAddresses from "./systemAddresses.js"
import * as codepageConversions from "../utils/codepageConversions.js"
import * as terminalText from "../utils/terminalText.js"

const DefaultAddress = process.env.DefaultAddress || "1:1/1"
const maxOutbound = 1000
const default_tzutc = "-0600"
const currentversion = process.env.currentversion || "0.1a"
const product_string = "Canectic BBS v" + currentversion
const boardname = process.env.boardname || "Canectic BBS"

var threadUpdateArray = []

function buildMessageTree(messages) {
	const messageMap = new Map();
	const rootMessages = [];

	// First pass: create map of all messages
	messages.forEach(msg => {
		messageMap.set(msg.msg_id, { ...msg, replies: [] });
	});
	console.log(messageMap)
	// Second pass: build the tree structure
	messages.forEach(msg => {
		if (msg.reply_to && messageMap.has(msg.reply_to)) {
			// This is a reply, add it to parent's replies
			messageMap.get(msg.reply_to).replies.push(messageMap.get(msg.msg_id));
		} else {
			// This is a root message
			rootMessages.push(messageMap.get(msg.msg_id));
		}
	});
	console.log(rootMessages)
	return rootMessages;
}


async function getMessagesForArea(shortcode, startindex){
	//
}

async function getThreadsForArea(shortcode){
	var shorty = shortcode.toLowerCase()
	var threadtablename = "mb_" + shorty + "_threads"
	var querytext = "SELECT * FROM " + threadtablename + " ORDER BY last_message DESC"
	var threadlist = await postgres.query(querytext, [])
	return threadlist
}

async function getRecentThreadsForArea(shortcode){
	var shorty = shortcode.toLowerCase()
	var threadtablename = "mb_" + shorty + "_threads"
	var querytext = "SELECT * FROM " + threadtablename + " WHERE last_message >= NOW() - INTERVAL '180 DAYS' ORDER BY last_message DESC"
	var threadlist = await postgres.query(querytext, [])
	if ((!threadlist)||(threadlist.length < 50)){
		querytext = "SELECT * FROM " + threadtablename + " ORDER BY last_message DESC LIMIT 50"
		threadlist = await postgres.query(querytext, [])
	}
	return threadlist
}

async function getMessageById(id, shortcode){
	var shorty = shortcode.toLowerCase()
	var msgtablename = "mb_" + shorty + "_msgs"
	var querytext = "SELECT * FROM " + msgtablename + " WHERE id = $1"
	var msg = await postgres.singlereadquery(querytext, [id])
	return msg
}

async function getMessagesForThread(shortcode, threadid){
	var shorty = shortcode.toLowerCase()
	var msgtablename = "mb_" + shorty + "_msgs"
	var querytext = "SELECT optional_attributes, msg_id, from_user, to_user, system_time, subject, reply_to, id, uuid, body_text FROM " + msgtablename + " WHERE thread_id = $1 ORDER BY system_time ASC"
	var msglist = await postgres.query(querytext, [threadid])
	for await(var msg of msglist){
		
		if (msg.body_text.includes("\x1b[")){
			msg.isAnsi = true
			msg.body_html = await terminalText.formatTerminalText(msg.body_text, {
				terminalWidth: 80,
				replaceAllSpaces: true,
				handlePipeCodes: true,
				handleAnsiCodes: true,
				resetOnNewline: true  // Pipe codes reset on \r
			});
		}else{
			msg.isAnsi = false
			if (msg.body_text.includes("   ")){
				msg.body_html = codepageConversions.formatTextForHtml(msg.body_text)
			}else{
				msg.body_html = msg.body_text.replace(/\r/g, '<br>')
			}
			
		}
		//msg.body_text = msg.body_text.replace(/\n/g, '')
		//msg.body_text = msg.body_text.replace(/\n/g, '<br>')
		
		//console.log(msg.body_text)
	}
	return msglist

	// if ((msglist)&&(msglist.length > 0)){
	// 	var msgtree = buildMessageTree(msglist)
	// 	return msgtree
	// }else{
	// 	return msglist
	// }
	
}

async function getThreadByUUID(uuid, shortcode){
	var shorty = shortcode.toLowerCase()
	var threadtablename = "mb_" + shorty + "_threads"
	var querytext = "SELECT * FROM " + threadtablename + " WHERE uuid = $1"
	var thread = await postgres.singlereadquery(querytext, [uuid])
	return thread
}

async function handleInboundEchoMessage(message){
	var returnObj = {
		status: false,
		imported: false,
		duplicate: false,
		bad: false,
		errormessages: []
	}
	if (!message){
		returnObj.errormessages.push("Invalid Message!")
		return returnObj
	}
	if (!message.AreaTag){
		returnObj.errormessages.push("Invalid Area Tag.")
		return returnObj
	}
	var msgArea = await msgAreas.getAreaByAreatag(message.AreaTag)
	var msgtablename = "mb_badecho"
	if (!msgArea){
		console.log("No Area found for AreaTag", message.AreaTag)
		returnObj.errormessages.push("No Area with that AreaTag.")
		//import to bad?
		return returnObj
	}
	var shorty = msgArea.shortcode.toLowerCase()
	msgtablename = "mb_" + shorty + "_msgs"	
	//check for dupe
	var isUnique = await postgres.checkValueUnique("msg_id", message.MsgId, msgtablename)
	if (!isUnique){
		//console.log("Duplicate Echomail")
		returnObj.status = true
		returnObj.duplicate = true
		return returnObj
	}
	//no dupe, save to db.
	//Todo: check if new thread and save thread record if so then add thread_id to this.
	var threadtablename = "mb_" + shorty + "_threads"
	var dbObj = await ftnToDb(message)
	if (message.utf8){
		dbObj.utf8 = message.utf8
	}

	dbObj = await threadMessage(dbObj, msgtablename, threadtablename, shorty)
	//console.log(dbObj)
	var dbres = await postgres.insertObject(dbObj, msgtablename)
	if (dbres.status == true){
		returnObj.status = true
		returnObj.imported = true
	}else{
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages)
	}	
	return returnObj
}

async function pushThreadIdToUpdateQueue(id, shortcode){
	if ((!id)||(!shortcode)){
		return
	}
	var psuedoid = id + "[" + shortcode
	if (!threadUpdateArray.includes(psuedoid)){
		threadUpdateArray.push(psuedoid)
	}
	return
}

async function getExistingThreadBySubject(message, threadtable, subject, strippedre){
	var querytext
	var uselike = false
	if (strippedre){
		uselike = true
	}
	var currtime = await new Date()
	var existingthread
	//see if there is an existing thread with the subject line in the last two weeks.
	//adjust this to use last_message instead of started if system_time on message is within x of current time
	//ie, parse more appropriately if processing current messages and try to map at all on archivals
	console.log("Checking existing within timeframe")
	var starttime = new Date(message.system_time)
	var moderntime = new Date(message.system_time)
	starttime.setDate(starttime.getDate() - 30);
	//see if message time is within last 2 weeks
	moderntime.setDate(moderntime.getDate() + 14)
	if (moderntime >= currtime) {
		console.log("Current message. Apply appropriately.")
		querytext = "SELECT * FROM " + threadtable + " WHERE subject = $1 AND last_message >= $2 ORDER BY last_message DESC"
		if (uselike){
			//see if subject starts with search string (for when stripping re: and original line may have been clipped)
			querytext = "SELECT * FROM " + threadtable + " WHERE subject LIKE $1 AND last_message >= $2 ORDER BY last_message DESC"
		}		
		existingthread = await postgres.singlereadquery(querytext, [subject, starttime])
	}
	else{
		console.log("Archival message")
		querytext = "SELECT * FROM " + threadtable + " WHERE subject = $1 AND started_at >= $2 AND started_at <= $3 ORDER BY started_at DESC"
		if (uselike){
			querytext = "SELECT * FROM " + threadtable + " WHERE subject LIKE $1 AND started_at >= $2 AND started_at <= $3 ORDER BY started_at DESC"
		}
		existingthread = await postgres.singlereadquery(querytext, [subject, starttime, message.system_time])
	}
	return existingthread
}

async function threadMessage(message, messagetable, threadtable, shortcode){	
	var existingthread
	var querytext
	if (message.threadid){
		querytext = "SELECT * FROM " + threadtable + " WHERE threadid = $1"
		existingthread = await postgres.singlereadquery(querytext, [message.ThreadId])
		if (existingthread){
			message.thread_id = existingthread.id
			await pushThreadIdToUpdateQueue(existingthread.id, shortcode)
		}
		return message
	}
	if (!message.reply_to){
		var checksubject = message.subject
		if (message.subject.toUpperCase().startsWith('RE:')){
			var i=0
			while(checksubject.toUpperCase().startsWith('RE:')){
				checksubject = checksubject.substring(3).trim()
				i++
				if (i > 10){
					break;
				}
			}
		}
		//check subject trimmed down for re: etc.
		existingthread = await getExistingThreadBySubject(message, threadtable, checksubject, true)
		if (!existingthread){
			//check if subject was trimmed, and if so test full subject line
			if (checksubject != message.subject){
				console.log("Checking non trimmed subject")
				existingthread = await getExistingThreadBySubject(message, threadtable, message.subject, false)
			}			
		}
		if (existingthread){
			console.log("Determined existing.")
			message.threadid = existingthread.threadid
			message.thread_id = existingthread.id
		}else{
			//create new thread.
			console.log("Creating Thread")
			var threadid = message.msg_id
			var uniqueThread = await postgres.checkValueUnique("threadid", threadid, threadtable)
			if (uniqueThread){				
				//Todo: double check if there is another thread with the same subject within timeframe and add there instead if so.
				var uuid = await uuidv4()
				var threadObj = {
					uuid: uuid,
					subject: message.subject,
					threadid: message.msg_id,
					started_at: message.system_time,
					started_by: message.from_user,
					message_count: 1,
					last_message: message.system_time,
				}
				var result = await postgres.insertObject(threadObj, threadtable)
				if (result.status == true){
					if (result.insertId){
						message.thread_id = result.insertId
						message.threadid = threadid
					}
				}else{
					console.log("Couldn't save thread!")
				}
			}else{
				console.log("Thread not unique!")
				//get thread and apply ownership.
				var querytext = "SELECT * FROM " + threadtable + " WHERE UPPER(threadid) LIKE UPPER($1)"
				var dbthread = await postgres.singlereadquery(querytext, [threadid])
				if (dbthread){
					message.threadid = dbthread.threadid
					message.thread_id = dbthread.id
					await pushThreadIdToUpdateQueue(dbthread.id, shortcode)
				}
			}
			//end create
		}
	}else{		
		querytext = "SELECT threadid, thread_id FROM " + messagetable + " WHERE UPPER(msg_id) LIKE UPPER($1)"
		var upstreammsg = await postgres.singlereadquery(querytext, [message.reply_to])
		if (upstreammsg){
			var hasthread = false
			if (upstreammsg.threadid){
				message.threadid = upstreammsg.threadid
				hasthread = true
			}
			if (upstreammsg.thread_id){
				message.thread_id = upstreammsg.thread_id
				hasthread = true
			}
			if (hasthread){
				await pushThreadIdToUpdateQueue(upstreammsg.thread_id, shortcode)
			}			
		}else{
			console.log("Could not get upstream message")
		}
	}
	return message
}

async function ftnToDb(ftnMessage){
	var currtime = await new Date()
	var systemTime = await ftnUtils.getSystemTime(ftnMessage.DateTime, ftnMessage.TZUTC)
	var uuid = await uuidv4()
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
		source_zone: ftnMessage.Source.split(":")[0],
		source_net: ftnMessage.SourceNet,
		source_node: ftnMessage.SourceNode,
		destination_zone: ftnMessage.Destination.split(":")[0],
		destination_net: ftnMessage.DestinationNet,
		destination_node: ftnMessage.DestinationNode,
		to_user: ftnMessage.ToUser,
		from_user: ftnMessage.FromUser,
		subject: ftnMessage.Subject.replace(/\x00/g, '').trim(),
		body_text: ftnMessage.BodyText.replace(/\x00/g, ''),
		origin_line: ftnMessage.OriginLine.replace(/\x00/g, ''),
		raw_text: ftnMessage.RawText.replace(/\x00/g, ''),
		datetime_string: ftnMessage.DateTime,
		tz_utc: ftnMessage.TZUTC,
		seen_by: ftnMessage.SeenBy,
		path: ftnMessage.Path,
		system_time: systemTime,
		created_at: currtime,
		updated_at: null
	}
	return dbObj
}

async function dbToFtn(dbMessage){
	var optional_attributes = []
	if (dbMessage.optional_attributes){
		optional_attributes = dbMessage.optional_attributes
	}
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
		Destination: dbMessage.Destination,
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
		Path: dbMessage.Path,
	}
	return ftnMsg
}

async function updateThread(id, shortcode){
	//console.log("Checking update for thread", id)
	var shorty = shortcode.toLowerCase()
	var msgtablename = "mb_" + shorty + "_msgs"
	var threadtablename = "mb_" + shorty + "_threads"
	var querytext = "SELECT id, subject, threadid, last_message, message_count, last_message_from FROM " + threadtablename + " WHERE id = $1"
	var thread = await postgres.singlereadquery(querytext, [id])
	if (thread){
		//console.log("Checking Thread", thread.subject)
		var doupdate = false
		var querytext = "SELECT COUNT(*) FROM "+ msgtablename + " WHERE thread_id = $1"
		var msgcount = await postgres.query(querytext, [thread.id])
		if ((msgcount[0])&&(msgcount[0].count)){
			msgcount = msgcount[0].count
		}else{
			msgcount = 0
		}
		//console.log("Msg count:", msgcount)
		querytext = "SELECT system_time, from_user FROM " + msgtablename + " WHERE thread_id = $1 ORDER BY system_time DESC LIMIT 1"
		var lastmsg = await postgres.query(querytext, [thread.id])
		if ((lastmsg)&&(lastmsg[0])){
			lastmsg = lastmsg[0]
		}
		var lastfrom = thread.last_message_from
		var lasttime = thread.last_message
		if (thread.last_message_from != lastmsg.from_user){
			console.log("Updating from!")
			lastfrom = lastmsg.from_user
			doupdate = true
		}
		if ((lastmsg)&&(lastmsg.system_time)){
			lasttime = lastmsg.system_time
		}
		if (msgcount > thread.message_count){
			doupdate = true
		}
		if (lasttime > thread.last_message){
			doupdate = true
		}
		if (doupdate){
			//console.log("Updating", thread.subject)
			var currtime = await new Date()
			querytext = "UPDATE " + threadtablename + " SET last_message = $1, message_count = $2, last_message_from = $3 WHERE id = $4"
			await postgres.query(querytext, [lasttime, msgcount, lastmsg.from_user, thread.id])
		}
	}
}

async function mergeThreads(parent, child, shortcode){
	var shorty = shortcode.toLowerCase()
	var msgtable = "mb_" + shorty + "_msgs"
	var threadtable = "mb_" + shorty + "_threads"
	console.log("Merging threads")
	var querytext = "SELECT id FROM " + msgtable + " WHERE thread_id = $1"
	var messageArray = await postgres.query(querytext, [parent.id])
	if ((messageArray)&&(messageArray.length > 0)){
		console.log(messageArray.length, "messages to merge to parent")
		var scount = 0
		for await (var msg of messageArray){
			querytext = "UPDATE " + msgtable + " SET threadid = $1, thread_id = $2 WHERE id = $3"			
			try{
				var mres = await postgres.query(querytext, [parent.threadid, parent.id, msg.id])
				//console.log(mres)
				scount ++
			}catch(error){
				console.log(error)
			}			
		}
		if (scount == messageArray.length){
			console.log("All messages merged. Deleting child thread")
			querytext = "DELETE FROM " + threadtable + " WHERE id = $1"
			var delres = await postgres.query(querytext, [child.id])
			//console.log(delres)
		}
	}
	console.log("Merging complete.")
	return
}

async function mergeRecentThreads(shortcode){
	console.log("Checking threads for merge in", shortcode)
	var shorty = shortcode.toLowerCase()
	var msgtable = "mb_" + shorty + "_msgs"
	var threadtable = "mb_" + shorty + "_threads"
	//get threads with activity in the last 60 days.
	var querytext = "SELECT id, threadid, subject, started_at, last_message FROM " + threadtable + " WHERE last_message >= NOW() - INTERVAL '60 DAYS' ORDER BY last_message DESC"
	var threadArray = await postgres.query(querytext, [])
	//only bother continuing if there actually are any
	if ((threadArray)&&(threadArray.length > 0)){
		console.log("There are", threadArray.length, "threads to check")
		for await (var thread of threadArray){
			thread.subject = thread.subject.trim()
			var checksubject = thread.subject
			var existingthread
			if (thread.subject.toUpperCase().startsWith('RE:')){
				var i=0
				while(checksubject.toUpperCase().startsWith('RE:')){
					checksubject = checksubject.substring(3).trim()
					i++
					if (i > 10){
						break;
					}
				}
			}
			//do check
			var starttime = new Date(thread.started_at)
			starttime.setDate(starttime.getDate() - 30);
			//console.log(thread.subject, starttime)
			//first check if there is a thread matching root subject
			querytext = "SELECT * FROM " + threadtable + " WHERE subject LIKE $1 AND id != $2 AND last_message >= $3 ORDER BY last_message DESC"
			existingthread = await postgres.singlereadquery(querytext, [checksubject, thread.id, starttime])
			if (!existingthread){
				//if not check if there is an earlier one matching exact subject line
				if (checksubject != thread.subject){
					//only do another check if subject was trimmed
					existingthread = await postgres.singlereadquery(querytext, [thread.subject, thread.id, starttime])
				}				
			}

			if (existingthread){
				console.log("Thread", thread.id, "matches an earlier thread with subject:", existingthread.subject)
				//do merge if a matching thread has been found
				await mergeThreads(existingthread, thread, shortcode)
				await pushThreadIdToUpdateQueue(existingthread.id, shortcode)
			}
		}
	}
}


async function updateThreadArray(threadArray){
	if (!threadArray){
		return null
	}
	for await (var thread of threadArray){
		await updateThread(thread.id, thread.shortcode)
	}
}

async function updateDailyThreads(shortcode){
	console.log("Updating threads in", shortcode)
	var shorty = shortcode.toLowerCase()
	var msgtablename = "mb_" + shorty + "_msgs"
	var threadArray = []
	var querytext = "SELECT thread_id FROM " + msgtablename + " WHERE system_time >= NOW() - INTERVAL '24 HOURS' ORDER BY system_time DESC"
	var msgarray = await postgres.query(querytext, [])
	if ((msgarray)&&(msgarray.length > 0)){
		console.log(msgarray.length, "Messages today")
		for await (var msg of msgarray){
			if (!threadArray.includes(msg.thread_id)){
				threadArray.push(msg.thread_id)
			}
		}
		console.log(threadArray.length, "Threads to update in area")
		for await (var thread of threadArray){
			await updateThread(thread, shortcode)
		}
	}else{
		console.log("No Msgs or threads to update")
	}
}

async function updateAreaThreads(shortcode){
	console.log("Updating threads in", shortcode)
	var shorty = shortcode.toLowerCase()
	var msgtablename = "mb_" + shorty + "_msgs"
	var threadtablename = "mb_" + shorty + "_threads"
	var threadarray = []
	//var querytext = "SELECT id, subject, threadid, last_message, message_count FROM " + threadtablename + " ORDER BY last_message DESC"
	var querytext = "SELECT id FROM " + threadtablename + " ORDER BY last_message DESC"
	var dbthreads = await postgres.query(querytext, [])
	if (dbthreads && dbthreads.length > 0){
		threadarray = dbthreads
	}
	for await (var thread of threadarray){
		await updateThread(thread.id, shortcode)
	}
}

async function applyThreadingForArea(shortcode){
	console.log("Doing threading for", shortcode)
	var shorty = shortcode.toLowerCase()
	var msgtablename = "mb_" + shorty + "_msgs"
	var threadtablename = "mb_" + shorty + "_threads"
	var idarray = []
	var noupstreamarray = []
	var utarray = []
	var querytext = "SELECT msg_id FROM " + msgtablename
	var idlist = await postgres.query(querytext, [])
	if ((idlist)&&(idlist.length > 0)){
		for await (var mi of idlist){
			idarray.push(mi.msg_id)
		}
	}
	//console.log("IDs in this area:", idarray)
	querytext = "SELECT id, uuid, msg_id, thread_id, threadid, reply_to, subject, system_time FROM " + msgtablename + " WHERE threadid is null AND reply_to is not null"
	var unthreadedlist = await postgres.query(querytext, [])
	if ((unthreadedlist)&&(unthreadedlist.length > 0)){
		console.log("We have", unthreadedlist.length, "Messages to try to thread.")
		//cycle once to determine where upstreams end.
		for await (var msg of unthreadedlist){
			if (!idarray.includes(msg.reply_to)){
				//check age. If over certain age use this as new primary. Add a tag in base to allow rechecking. alternative tag them for non checking on most future passes.
				//console.log(msg.subject, msg.reply_to)
				noupstreamarray.push(msg.msg_id)

			}
			if (!utarray.includes(msg.msg_id)){
				utarray.push(msg.msg_id)
			}
		}
		console.log("There are", noupstreamarray.length, "that we have no upstream for")
		//cycle to try and source upstream
		//I'm currently not sure the best way to do this, so just grabbind a stat or two for now.
		var potentialcount = 0
		for await (var msg of unthreadedlist){
			if ((!utarray.includes(msg.reply_to))&&(idarray.includes(msg.reply_to))){
				potentialcount ++
			}
		}
		console.log("We can potentially match", potentialcount)
	}
}

async function updateSeenbyArray(sbArray){
	//console.log("Updating SeenBy Array", sbArray)
	if ((!sbArray)||(sbArray.length < 1)){
		//console.log("No valid seenby data to update")
		//if array not present, kick out
		return false
	}
	for await (var sb of sbArray){
		//console.log("Updating", sb)
		var querytext = "UPDATE " + sb.msgtable + " SET seen_by = $1 WHERE id = $2"
		try{
			await postgres.query(querytext, [sb.newsbstring, sb.id])
		}catch(error){
			console.log(error)
		}		
	}
	return
}

async function getOutboundForNode(node){
	console.log("Checking for echomail for", node.name, "-", node.address)
	var nodeSeenByUpdateArray = []
	//console.log(node.area_indexes)
	var domain
	var systemaddress = {}
	if (node.use_address){
		systemaddress.address = node.use_address
		var zsplit = node.use_address.split(":")
		var nnsplit = zsplit[1].split("/")
		var npsplit = nnsplit[1].split(".")
		systemaddress.zone = zsplit[0]
		systemaddress.net = nnsplit[0]
		systemaddress.node = nnsplit[0]
		systemaddress.netnode = systemaddress.net + "/" + systemAddresses.node
		if (nnsplit.length > 1){
			systemaddress.point = nnsplit[1]
		}
	}else{
		var bestaddress
		var zone = node.address.split(":")[0]
		if(node.domain){
			domain = node.domain
		}
		var dblist = await systemAddresses.getAddressesForZone(zone, domain)
		if ((dblist)&&(dblist.length > 0)){			
			bestaddress = dblist[0]
		}else{
			if ((domain)&&(domain != "")){
				dblist = await systemAddresses.getAddressesForDomain(domain)
				if ((dblist)&&(dblist.length > 0)){			
					bestaddress = dblist[0]
				}
			}			
		}
		if ((bestaddress)&&(bestaddress.address)){
			systemaddress.address = bestaddress.address
			var bzsplit = bestaddress.address.split(":")
			var bnnsplit = bzsplit[1].split("/")
			var bnpsplit = bnnsplit[1].split(".")
			systemaddress.zone = bzsplit[0]
			systemaddress.net = bnnsplit[0]
			systemaddress.node = bnpsplit[0]
			systemaddress.netnode = systemaddress.net + "/" + systemaddress.node
			if (bnpsplit.length > 1){
				systemaddress.point = bnpsplit[1]
			}
		}

	}
	if ((!systemaddress)||(!systemaddress.address)){
		console.log("Could not determine address to use. Cannot continue for Node")
		return
	}else{
		console.log("Using local address", systemaddress.address)
	}
	var nodepoint
	var netnode = node.address.split(":")[1]
	//check for and remove point component
	if (netnode.includes(".")){
		netnode = netnode.split(".")[0]
		nodepoint = netnode.split(".")[1]
	}
	var indexUpdateArray = []
	var tossableArray = []	
	if ((!node.areas_enabled)||(node.areas_enabled.length < 1)){
		console.log("No Areas found for", node.name)
		return
	}
	if ((node.area_indexes)&&(node.area_indexes.length > 0)){
		var newArray = []
		for await (var idx of node.area_indexes){
			var ni = JSON.parse(idx)
			newArray.push(ni)
		}
		node.area_indexes = newArray
	}
	for await (var shortcode of node.areas_enabled){
		var area = await msgAreas.getAreaByShortcode(shortcode)
		if (!area){
			console.log("Area not found for", shortcode)
			break;
		}
		//console.log("Checking", area.name)
		//get current index
		var curIdx = 0
		var isrescan = false
		if ((node.area_indexes)&&(node.area_indexes.length > 0)){
			const indexEntry = node.area_indexes.find(item => item.areaId === area.id)
			if (indexEntry){
				//console.log("Starting from index", indexEntry.msgIdx)
				if (indexEntry.msgIdx){
					curIdx = indexEntry.msgIdx					
				}
				if (indexEntry.doRescan){
					isrescan = true
				}
			}
		}
		
		var indexUpdateObj = {
			areaId: area.id,
			msgIdx: curIdx
		}
		//console.log(indexUpdateObj)
		var shorty = shortcode.toLowerCase().trim()
		var msgtable = "mb_" + shorty + "_msgs"
		var idxquery = "SELECT id FROM " + msgtable + " ORDER BY id DESC LIMIT 1"
		var finalidx = await postgres.query(idxquery, [])
		if ((finalidx)&&(finalidx[0])&&(finalidx[0].id)){
			finalidx = finalidx[0].id
		}else{
			finalidx = 0
		}
		if (finalidx > curIdx){
			outerLoop: while (finalidx > curIdx){
				//grab a chunk of messages to see if tossable. This loop will cycle until we hit max send limit or reach the final idx in area
				var querytext = "SELECT * FROM " + msgtable + " WHERE id > $1 LIMIT 500"
				var msglist = await postgres.query(querytext, [curIdx])

				if ((msglist)&&(msglist.length > 0)){
					for await (var msg of msglist){
						var updateseenby = false
						//use maxOutbound to determine if array is overfull at any time and stop further gathering for this node and just send
						if (tossableArray.length >= maxOutbound){
							break outerLoop;
						}
						//test if message should be tossed				
						var istossable = true
						//bypass tossable checks on rescan.
						var seenbystring
						if (!isrescan){
							if (msg.source == node.address){
								//Don't toss back to source
								istossable = false
							}
							//do check for whether address is in seen fields. Bypass check if already determined not to toss
							if (istossable){
								//set further variables for checking seen-bys and ultimately tossing
								msg.source = systemaddress.address
								msg.source_zone = systemaddress.zone
								msg.source_net = systemaddress.net
								msg.source_node = systemaddress.node
								msg.destination = node.address
								msg.destination_zone = node.address.split(":")[0]
								msg.destination_net = netnode.split("/")[0]
								msg.destination_node = netnode.split("/")[1]

								if (msg.seen_by){
									//create a map for checking here.
									var netpresent = false
									var sbArray = msg.seen_by.split(" ")
									var sbnets = []
									var netobj
									for await (var sb of sbArray){
										if (sb.includes("/")){
											if (netobj){
												sbnets.push(netobj)
											}
											var sbsplit = sb.split("/")
											netobj = {
												net: sbsplit[0],
												netstring: sb,
												nodes: []
											}
											netobj.nodes.push(sbsplit[1])
										}else{
											netobj.nodes.push(sb)
											netobj.netstring += " " + sb
										}
									}
									if (netobj){
										sbnets.push(netobj)
									}
									//parse this to see if node address in seen list
									for await (var net of sbnets){
										if (net.net == msg.destination_net){
											netpresent = true
											if (net.nodes.includes(msg.destination_node)){
												istossable = false
											}else{
												net.nodes.push(msg.destination_node)
												net.netstring += " " + msg.destination_node
											}
										}
									}
									if (istossable){
										updateseenby = true										
										if (netpresent){
											//reconstitute the string from map
											for await (var net of sbnets){
												if ((seenbystring)&&(seenbystring.length > 0)){
													seenbystring += " "
												}
												console.log("Adding netstring", net.netstring)
												seenbystring += net.netstring
											}
											
										}else{
											if (msg.seen_by){
												seenbystring += msg.seen_by + " "
											}
											//just use original string and add net/node
											seenbystring  += msg.destination_net + "/" + msg.destination_node
										}
									}
								}else{
									updateseenby = true
									seenbystring = systemaddress.netnode
									if (msg.destination_net == systemaddress.net){
										seenbystring += " " + msg.destination_node
									}else{
										seenbystring += " " + msg.destination_net + "/" + msg.destination_node
									}									
								}
							}
							if (msg.path){
								//check if node is in path
								var patharr = msg.path.split(" ")
								if (patharr.includes(netnode)){
									istossable = false
								}
							}
						}
						if (istossable){
							
							
							//should do any additional processing to msg here.

							if (updateseenby){
								msg.seen_by = seenbystring
								var sbobj = {
									id: msg.id,
									msgtable: msgtable,
									newsbstring: seenbystring
								}
								nodeSeenByUpdateArray.push(sbobj)
							}
							//TODO: OptAtt stuff here too.
							//TODO: Apply thread opt.
							msg.path = systemaddress.netnode
							//do db to ftn conversion and push to array
							var ftnObj = await dbToFtn(msg)
							ftnObj.AreaTag = area.areatag
							tossableArray.push(ftnObj)
						}
						//increment index. Do this at the end to avoid exiting loop before final message has been added
						curIdx = msg.id
					}
				}
				//end while
			}
		}else{
			if (curIdx > finalidx){
				//fix situations where current index may have somehow ended up higher than actual max
				//important to avoid missing future messages
				console.log("Reseting index", curIdx, "to", finalidx)
				curIdx = finalidx
			}
			
		}
		

		//set CurIdx to index id of last message gathered from this area to update object
		indexUpdateObj.msgIdx = curIdx
		indexUpdateArray.push(indexUpdateObj)

	}

	if (tossableArray.length > 0){
		var msgcount = tossableArray.length
		console.log("There are", tossableArray.length, "Message to write")
		var pktresult = await ftnTosser.WritePktsToNode(tossableArray, node, systemaddress)
		if ((pktresult)&&(pktresult.processedcount)){
			if (pktresult.processedcount >= msgcount){
				console.log("Wrote", pktresult.processedcount, "messages in", pktresult.pktcount, "Packets")
				//update indexes.			
				console.log("Updating Indexes")
				//console.log(indexUpdateArray)
				var dbres = await postgres.query("UPDATE linked_nodes SET area_indexes = $1 WHERE id = $2", [indexUpdateArray, node.id])
				//update seenby fields where needed.
				console.log("Updating SeenBy's")
				await updateSeenbyArray(nodeSeenByUpdateArray)				
			}else{
				//TODO: More gracefully handle this rather than just skipping index update to allow re-tossing later.
				console.log("Failed to process all messages")
			}
			
			
		}else{
			console.log("No outbound msgs processed")
		}
	}else{
		console.log("No messages to toss for node. Updating indexes and exiting.")
		//console.log(indexUpdateArray)
		var dbres = await postgres.query("UPDATE linked_nodes SET area_indexes = $1 WHERE id = $2", [indexUpdateArray, node.id])
	}
	return
}

async function startNewThread(formObj, shortcode){
	var shorty = shortcode.toLowerCase().trim()
	var msgtable = "mb_" + shorty + "_msgs"
	var threadtable = "mb_" + shorty + "_threads"
	var returnObj = {
		status: false,
		insertId: 0,
		threaduuid: "",
		errormessages: [],
	}
	var touser = "All"
	var currtime = await new Date()
	var datetimestring = await ftnUtils.getDateTimeString()
	if (!formObj.subject){
		returnObj.errormessages.push("Subject cannot be blank!")
	}
	if (!formObj.from_user){
		returnObj.errormessages.push("Cannot determine user!")
	}
	if (!formObj.body_text){
		returnObj.errormessages.push("Cannot post an empty message!")
	}
	if (returnObj.errormessages.length > 0){
		return returnObj
	}
	formObj.Subject = formObj.subject.trim()
	var area = await msgAreas.getAreaByShortcode(shorty)
	if (!area){
		returnObj.errormessages.push("Could not find area to post message!")
		return returnObj
	}
	var address
	var path
	var thread_id
	var origin_line = boardname
	var msgid = ""
	if (area.networked){
		//determine local address
		if (area.default_address){
			address = area.default_address
		}
	}
	if (address){
		msgid += address + " "
		path = address.split(":")[1]
		origin_line += " " + address
	}
	//determine the rest of msgid
	var millihex = await ftnUtils.getMilliHex()
	// if (area.areatag){
	// 	msg_id += area.areatag + "-"
	// }
	msgid += millihex
	var uuid = await uuidv4()
	var tuuid = await uuidv4()
	if (formObj.to_user){
		touser = formObj.to_user
	}
	var threadObj = {
		uuid: tuuid,
		threadid: msgid,
		subject: formObj.Subject,
		started_at: currtime,
		started_by: formObj.from_user,
		message_count: 1,
		last_message: currtime,
		last_message_from: formObj.from_user
	}
	var result = await postgres.insertObject(threadObj, threadtable)
	if (result.status == true){
		if (result.insertId){
			thread_id = result.insertId
		}
	}else{
		resultObj.errormessages.push("Couldn't save thread!")
		return returnObj
	}
	var dbObj = {
		uuid: uuid,
		threadid: msgid,
		thread_id: thread_id,
		msg_id: msgid,
		tz_utc: default_tzutc,
		created_at: currtime,
		source: address,
		from_user: formObj.from_user,
		to_user: formObj.to_user,
		subject: formObj.subject,
		body_text: formObj.body_text,
		datetime_string: datetimestring,
		system_time: currtime,
		path: path,
		origin_line: origin_line,
		product_string: product_string
	}
	var msgresult = await postgres.insertObject(dbObj, msgtable)
	if (msgresult.status == true){
		returnObj.status = true
		returnObj.threaduuid = tuuid
	}else{
		//delete thread from db if msg not written.
		var delquery = "DELETE FROM " + threadtable + " WHERE id = $1"
		await postgres.query(delquery, [thread_id])		
	}

	return returnObj
}

async function replyToThread(formObj, shortcode, threaduuid){
	var shorty = shortcode.toLowerCase().trim()
	var msgtable = "mb_" + shorty + "_msgs"
	var threadtable = "mb_" + shorty + "_threads"
	var returnObj = {
		status: false,
		insertId: 0,
		errormessages: [],
	}
	var touser = "All"
	var currtime = await new Date()
	var datetimestring = await ftnUtils.getDateTimeString()
	if (!formObj.subject){
		returnObj.errormessages.push("Subject cannot be blank!")
	}
	if (!formObj.from_user){
		returnObj.errormessages.push("Cannot determine user!")
	}
	if (!formObj.body_text){
		returnObj.errormessages.push("Cannot post an empty message!")
	}
	if (returnObj.errormessages.length > 0){
		return returnObj
	}
	formObj.Subject = formObj.subject.trim()
	var area = await msgAreas.getAreaByShortcode(shorty)
	if (!area){
		returnObj.errormessages.push("Could not find area to post message!")
		return returnObj
	}
	var querytext = "SELECT * FROM " + threadtable + " WHERE uuid = $1 LIMIT 1"
	var dbthread = await postgres.query(querytext, [threaduuid])
	if ((dbthread)&&(dbthread[0])){
		dbthread = dbthread[0]
	}else{
		returnObj.errormessages.push("Could not retrieve thread!")
		return returnObj
	}
	if (!dbthread){
		returnObj.errormessages.push("Could not retrieve thread!")
		return returnObj
	}
	var threadid
	var thread_id
	if (dbthread.threadid){
		threadid = dbthread.threadid
	}
	if (dbthread.id){
		thread_id = dbthread.id
	}
	var address
	var replyto = dbthread.threadid
	if (formObj.reply_to){
		replyto = formObj.reply_to
	}
	var path
	var origin_line = boardname
	var msgid = ""
	if (area.networked){
		//determine local address
		if (area.default_address){
			address = area.default_address
			origin_line += " " + address
		}
	}
	if (address){
		msgid += address + " "
		path = address.split(":")[1]
	}
	//determine the rest of msgid
	var millihex = await ftnUtils.getMilliHex()
	msgid += millihex
	var uuid = await uuidv4()	
	if (formObj.to_user){
		touser = formObj.to_user
	}	
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
		to_user: formObj.to_user,
		subject: formObj.subject,
		body_text: formObj.body_text,
		datetime_string: datetimestring,
		system_time: currtime,
		path: path,
		origin_line: origin_line,
		product_string: product_string
	}
	var msgresult = await postgres.insertObject(dbObj, msgtable)
	if (msgresult.status == true){
		returnObj.status = true
		await updateThread(thread_id, shortcode)
	}else{
		console.log(msgresult)
	}

	return returnObj
}

async function deleteMessageByUUID(uuid, shortcode){
	if ((!uuid)||(!shortcode)){
		console.log("Invalid request")
		return false
	}
	console.log("Starting Message Delete")
	var shorty = shortcode.toLowerCase().trim()
	var msgtable = "mb_" + shorty + "_msgs"
	var threadtable = "mb_" + shorty + "_threads"
	var querytext = "SELECT * FROM " + msgtable + " WHERE uuid = $1"
	var dbmsg = await postgres.singlereadquery(querytext, [uuid])
	if (dbmsg){
		if (dbmsg.msg_id == dbmsg.threadid){
			var tdelquery = "DELETE FROM " + threadtable + " WHERE threadid = $1"
			try{
				await postgres.query(tdelquery, [dbmsg.threadid])
			}catch(error){
				console.log("Could not delete thread")
				return false
			}
			
		}
		querytext = "DELETE FROM " + msgtable + " WHERE id = $1"
		console.log("Deleting Msg -", querytext)
		try{
			await postgres.query(querytext, [dbmsg.id])
			return true
		}catch(error){
			console.log("Could not delete msg")
			return false
		}
		
	}else{
		console.log("No message found")
		return false
	}
	console.log("Unknonw error")
	return false
}

export{
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
	mergeRecentThreads,
	getOutboundForNode,
	startNewThread,
	replyToThread,
}