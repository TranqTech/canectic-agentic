//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';

//internal modules
import * as mongoquick from "../middleware/db/mongoquick.js"
import * as postgres from '../middleware/db/postgres.js'
import * as tableTools from '../middleware/db/tableTools.js'
import * as msgGroups from "./msgGroups.js"

async function updateAreaStats(){
	var arealist = await postgres.query("SELECT shortcode FROM message_areas WHERE active")
	if ((arealist)&&(arealist.length > 0)){
		for await (var area of arealist){
			//console.log(area)
			await updateStatsForArea(area.shortcode)
		}
	}
}

async function updateStatsForArea(shortcode){
	console.log("Updating Stats For", shortcode)
	var shorty = shortcode.toLowerCase().trim()
	var dbarea = await getAreaByShortcode(shortcode)
	if (!dbarea){
		return
	}
	var msgtable = "mb_" + shorty + "_msgs"	
	var doupdate = false
	var querytext = "SELECT COUNT(*) FROM "+ msgtable
	//console.log(querytext)
	var msgcount = await postgres.query(querytext, [])
	if ((msgcount)&&(msgcount[0])){
		//console.log(msgcount)
		msgcount = msgcount[0].count
	}else{
		msgcount = 0
	}
	if (msgcount != dbarea.msg_count){
		doupdate = true
	}
	querytext = "SELECT system_time, from_user, subject FROM " + msgtable + " WHERE system_time IS NOT NULL ORDER BY system_time DESC LIMIT 1"
	var lastmsg = await postgres.query(querytext)
	if ((lastmsg)&&(lastmsg[0])){
		lastmsg = lastmsg[0]
	}
	var lastfrom = dbarea.last_from
	var lastsubject = dbarea.last_subject
	var lasttime = dbarea.last_message
	if (lastmsg.from_user != dbarea.last_from){
		lastfrom = lastmsg.from_user
		doupdate = true
	}
	if (lastmsg.subject != dbarea.last_subject){
		lastsubject = lastmsg.subject.trim()
		doupdate = true
	}
	if (lastmsg.system_time != dbarea.last_message){
		lasttime = lastmsg.system_time
		doupdate = true
	}
	//check for need to update once new columns are in place
	querytext = "UPDATE message_areas SET msg_count = $1, last_from = $2, last_subject = $3, last_message = $4 WHERE id = $5"
	var upres = await postgres.query(querytext, [msgcount, lastfrom, lastsubject, lasttime, dbarea.id])
}

async function newArea(formObj){
	console.log("Creating New Message Area")
	var returnObj = {
		status: false,
		errormessages: []
	}
	//validate
	if (!formObj.groupshortcode){
		returnObj.errormessages.push("Could not determine group!")
		return returnObj
	}
	if (!formObj.name){
		returnObj.errormessages.push("Name cannot be empty!")
	}
	if (!formObj.description){
		returnObj.errormessages.push("Description cannot be empty!")
	}
	if (!formObj.shortcode){
		returnObj.errormessages.push("Must have a shortcode!")
	}
	if (returnObj.errormessages.length > 0){
		return returnObj
	}
	var groupshort = formObj.groupshortcode.toUpperCase().trim()
	var areatag = formObj.areatag.toUpperCase().trim()
	var shorty = formObj.shortcode.toUpperCase().trim()
	if (formObj.areatag){
		var uniquetag = await postgres.checkValueUnique("areatag", areatag, "message_areas")
		if (!uniquetag){
			returnObj.errormessages.push("Area tag already in use")
		}
	}
	var uniqueShortcode = await postgres.checkValueUnique("shortcode", shorty, "message_areas")
	if (!uniqueShortcode){
		returnObj.errormessages.push("Shortcode must be unique!")
	}
	var dbgroup = await msgGroups.getGroupByShortcode(formObj.groupshortcode)	
	if (!dbgroup){
		console.log("Cannot find group!")
		returnObj.errormessages.push("Could not find parent group!")
	}
	if (returnObj.errormessages.length > 0){
		console.log("Errors Occured!")
		return returnObj
	}
	var isnetworked = false
	if (formObj.networked){
		if (formObj.networked == "networked"){
			isnetworked = true
		}
	}
	if (isnetworked){
		if (!formObj.areatag){
			console.log("Network without area tag!")
			returnObj.errormessages.push("You cannot have a networked area with no tag!")
			return returnObj
		}		
	}
	returnObj.shortcode = shorty
	var currtime = await new Date()
	var uuid = await uuidv4()
	//get group.
	var pgObj = {
		uuid: uuid,
		group_shortcode: groupshort,
		group_id: dbgroup.id,
		group_uuid: dbgroup.uuid,
		name: formObj.name,
		description: formObj.description,
		shortcode: shorty,
		areatag: areatag,
		read_security: formObj.readsecurity,
		post_security: formObj.postsecurity,
		min_age: formObj.minage,
		max_age: formObj.maxage,
		created_at: currtime,
		default_address: formObj.default_address,
		networked: isnetworked,
		updated_at: null,
		active: true,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		msg_count: 0
	}
	console.log("Writing to DB")
	//var dbres = await mongoquick.insertObject(dbObj, "MessageGroups")
	var dbres = await postgres.insertObject(pgObj, "message_areas")
	//var dbres = await mongoquick.insertObject(dbObj, "MessageAreas")
	if (dbres.status == true){
		returnObj.status = true
	}else{
		returnObj.errormessages.push("Could not write to DB")
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages)
	}
	//call msggroup update area count.
	return returnObj
}

async function getAreaByShortcode(shortcode){
	var shorty = shortcode.toUpperCase().trim()
	//console.log("Finding Area for shortcode", shortcode)
	var dbarea = await postgres.singlereadquery('SELECT * FROM message_areas WHERE UPPER(shortcode) LIKE UPPER($1)', [shorty])
	return dbarea
}

async function getAreaByAreatag(areatag){
	var taggy = areatag.toUpperCase().trim()
	//console.log("Finding Area for areatag", taggy)
	var dbarea = await postgres.singlereadquery('SELECT * FROM message_areas WHERE UPPER(areatag) LIKE UPPER($1)', [taggy])
	return dbarea
}

async function getListByGroupShortcode(shortcode){
	var shorty = shortcode.toUpperCase().trim()
	//var dblist = await mongoquick.getCollectionByFilter({groupshortcode: shorty}, "MessageAreas")
	var dblist = await postgres.query('SELECT * FROM message_areas WHERE UPPER(group_shortcode) LIKE UPPER($1)', [shorty])
	return dblist
}


async function createMsgTables(){
	var shortcodeArray = []
	var msgTableTemplate = process.cwd() + "/src/templates/msgTable.conf"
	var threadTableTemplate = process.cwd() + "/src/templates/threadTable.conf"
	var msgTableRemoved = process.cwd() + "/src/templates/msgTableRemoved.conf"
	var threadTableRemoved = process.cwd() + "/src/templates/threadTableRemoved.conf"
	var msgCols = await tableTools.getColumnsFromFile(msgTableTemplate)
	var msgRemoveCols = []
	var threadRemoveCols = []
	var fmsgRemoveCols = await tableTools.getColumnsFromFile(msgTableRemoved)
	if ((fmsgRemoveCols)&&(fmsgRemoveCols.length > 0)){
		msgRemoveCols = fmsgRemoveCols
	}
	var threadCols = await tableTools.getColumnsFromFile(threadTableTemplate)
	var fthreadRemoveCols = await tableTools.getColumnsFromFile(threadTableRemoved)
	if ((fthreadRemoveCols)&&(fthreadRemoveCols.length > 0)){
		threadRemoveCols = fthreadRemoveCols
	}
	console.log("Files", msgTableTemplate)
	console.log("Columns for tables:", msgCols, threadCols)
	var dblist = await postgres.query("SELECT shortcode FROM message_areas WHERE active", [])
	for await (var area of dblist){
		if ((area.shortcode)&&(area.shortcode.length > 0)){
			var shorty = area.shortcode.toLowerCase()
			shortcodeArray.push(shorty)
			console.log(area.shortcode)
			const mTable = "mb_" + shorty + "_msgs"
			const tTable = "mb_" + shorty + "_threads"
			var result1 = await tableTools.checkOrCreateTable(mTable, msgCols, msgRemoveCols)
			console.log(result1)
			var result2 = await tableTools.checkOrCreateTable(tTable, threadCols, threadRemoveCols)
			console.log(result2)
		}
	}
}

async function GetShortcodeList(){
	var scarray = []
	var shortcodelist = await postgres.query("SELECT shortcode FROM message_areas WHERE active", [])
	if ((shortcodelist)&&(shortcodelist.length > 0)){
		for await (var sc of shortcodelist){
			if(sc.shortcode){
				scarray.push(sc.shortcode)
			}
		}
	}
	return scarray
}

//add area delete method -> drop msg and thread tables, confirm dropped, then delete area.
//add individual area table creation and call on area creation

export{newArea, getAreaByShortcode, getListByGroupShortcode, createMsgTables, getAreaByAreatag, GetShortcodeList, updateAreaStats}