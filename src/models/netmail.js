//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from "luxon";

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as ftn from "./ftnClasses.js";
import * as ftnUtils from "../utils/ftnUtils.js";

const DefaultAddress = process.env.DefaultAddress || "1:1/1";

async function getInboundMsgByMsgId(msgId) {
	var idupper = msgId.toUpperCase().trim();
	var dbres = await postgres.queryOne('SELECT * FROM netmail_in WHERE UPPER(msg_id) LIKE UPPER($1)', [idupper]);
	return dbres;
}

async function getInboundMsgByUUID(uuid) {
	var idupper = uuid.toUpperCase().trim();
	var dbres = await postgres.queryOne('SELECT * FROM netmail_in WHERE UPPER(uuid) LIKE UPPER($1)', [idupper]);
	return dbres;
}

async function getOutboundMsgByMsgId(msgId) {
	var idupper = msgId.toUpperCase().trim();
	var dbres = await postgres.queryOne('SELECT * FROM netmail_out WHERE UPPER(msg_id) LIKE UPPER($1)', [idupper]);
	return dbres;
}

async function getOutboundMsgByUUID(uuid) {
	var idupper = uuid.toUpperCase().trim();
	var dbres = await postgres.queryOne('SELECT * FROM netmail_out WHERE UPPER(uuid) LIKE UPPER($1)', [idupper]);
	return dbres;
}

async function getOutboundMsgByID(id) {
	var dbres = await postgres.queryOne('SELECT * FROM netmail_out WHERE id = $1', [id]);
	return dbres;
}

async function newInboundNetmail(message) {
	var returnObj = {
		status: false,
		duplicate: false,
		errormessages: []
	};

	if (!message.Direction) {
		message.Direction = "Inbound";
	}

	// Skip dupes
	if (message.MsgId) {
		var isUnique = await checkMsgUnique(message.MsgId);
		if (!isUnique) {
			returnObj.status = true;
			returnObj.duplicate = true;
			returnObj.errormessages.push("Already Imported");
			return returnObj;
		}
	}

	// Save it
	var dbObj = await ftnToDb(message);
	var dbres = await postgres.insertObject(dbObj, "netmail_in");
	if (dbres.status === true) {
		returnObj.status = true;
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function newOutboundNetmail(formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	var dSource = DefaultAddress;
	if (formObj.Source) {
		dSource = formObj.Source;
	}

	var currtime = new Date();
	var destsplit1 = formObj.Destination.split(":");
	var destsplit2 = destsplit1[1].split("/");
	var sourcesplit1 = dSource.split(":");
	var sourcesplit2 = sourcesplit1[1].split("/");
	var idtag = ftnUtils.genMsgId();
	var uuid = uuidv4();
	idtag = dSource + " " + idtag;
	var datetimestring = ftnUtils.getDateTimeString();

	var dbObj = {
		msg_id: idtag,
		uuid: uuid,
		domain: null,
		destination: formObj.Destination,
		destination_zone: destsplit1[0],
		destination_net: destsplit2[0],
		destination_node: destsplit2[1],
		subject: formObj.Subject,
		to_user: formObj.ToUser,
		from_user: formObj.FromUser,
		body_text: formObj.Message,
		source: dSource,
		source_zone: sourcesplit1[0],
		source_net: sourcesplit2[0],
		source_node: sourcesplit2[1],
		datetime_string: datetimestring,
		system_time: currtime,
		created_at: currtime,
		origin_line: "",
		updated_at: null,
		sent: false,
		sent_at: null,
		queued: false
	};

	var dbres = await postgres.insertObject(dbObj, "netmail_out");
	if (dbres.status === true) {
		returnObj.status = true;
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function checkMsgUnique(msgId) {
	var isUnique = await postgres.checkValueUnique("msg_id", msgId, "netmail_in");
	return isUnique;
}

async function getAllInbound() {
	var dblist = await postgres.query('SELECT * FROM netmail_in', []);
	return dblist;
}

async function getAllOutbound() {
	var dblist = await postgres.query('SELECT * FROM netmail_out', []);
	return dblist;
}

async function getPendingNetmail() {
	var sendArray = [];
	var dblist = await postgres.query('SELECT * FROM netmail_out WHERE sent is false OR sent is null', []);
	for (var msg of dblist) {
		var fmsg = await dbToFtn(msg);
		sendArray.push(fmsg);
	}
	return sendArray;
}

async function markMessageSentArray(idarray, tosserid) {
	for (var id of idarray) {
		await markMessageSent(id, tosserid);
	}
}

async function markMessageSent(id, tosserid) {
	var tosserstring = tosserid || "";
	console.log("Marking sent with id", id);
	var dbmessage = await getOutboundMsgByID(id);
	if (dbmessage) {
		if (!dbmessage.sent) {
			var currtime = new Date();
			await postgres.write('UPDATE netmail_out SET sent = true, sent_at = $1, tosser_id = $2 WHERE id = $3', [currtime, tosserstring, id]);
		} else {
			console.log("Already marked sent. Skipping.");
		}
	} else {
		console.log("Message not found!");
	}
}

async function dbToFtn(dbObj) {
	var ftnMessage = new ftn.Message();
	ftnMessage.Destination = dbObj.destination;
	ftnMessage.ToUser = dbObj.to_user;
	ftnMessage.FromUser = dbObj.from_user;
	ftnMessage.DestinationZone = dbObj.destination_zone;
	ftnMessage.DestinationNet = dbObj.destination_net;
	ftnMessage.DestinationNode = dbObj.destination_node;
	ftnMessage.Source = dbObj.source;
	ftnMessage.SourceZone = dbObj.source_zone;
	ftnMessage.SourceNet = dbObj.source_net;
	ftnMessage.SourceNode = dbObj.source_node;
	ftnMessage.BodyText = dbObj.body_text;
	ftnMessage.Subject = dbObj.subject;
	ftnMessage.MsgId = dbObj.msg_id;
	if (dbObj.optional_attributes && dbObj.optional_attributes.length > 0) {
		ftnMessage.OptionalAttributes = dbObj.optional_attributes;
	} else {
		ftnMessage.OptionalAttributes = [];
	}
	ftnMessage.OriginLine = dbObj.origin_line;
	ftnMessage.DateTime = dbObj.datetime_string;
	ftnMessage.Id = dbObj.id;
	ftnMessage.Domain = dbObj.domain;
	return ftnMessage;
}

async function ftnToDb(ftnMessage) {
	var currtime = new Date();
	var systemTime = ftnUtils.getSystemTime(ftnMessage.DateTime, ftnMessage.TZUTC);
	var uuid = uuidv4();
	var dbObj = {
		user_id: 0,
		uuid: uuid,
		msg_id: ftnMessage.MsgId,
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
		subject: ftnMessage.Subject,
		body_text: ftnMessage.BodyText,
		origin_line: ftnMessage.OriginLine,
		raw_text: ftnMessage.RawText,
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

export {
	getInboundMsgByUUID,
	getOutboundMsgByUUID,
	getInboundMsgByMsgId,
	getOutboundMsgByMsgId,
	newInboundNetmail,
	getAllInbound,
	getAllOutbound,
	newOutboundNetmail,
	getPendingNetmail,
	markMessageSentArray,
	markMessageSent
};