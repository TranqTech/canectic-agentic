//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { DateTime } from "luxon";

import * as postgres from '../middleware/db/postgres.js'
import * as tableTools from '../middleware/db/tableTools.js'

const validStatusArray = ["NORMAL", "CRASH", "HOLD"]

async function newNode(formObj){
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0
	}
	//do validation
	var direct = true
	var status = "NORMAL"
	var currtime = await new Date()
	if (!formObj.name){
		returnObj.errormessages.push("Name cannot be empty")
	}
	if (!formObj.address){
		returnObj.errormessages.push("Address cannot be empty")
	}
	if (!formObj.domain){
		returnObj.errormessages.push("Domain cannot be empty")
	}
	if (!formObj.connectiontype){
		returnObj.errormessages.push("Could not determine connection type")
	}
	var enableareafix = false
	if ((formObj.direct)&&(formObj.direct == "No")){
		direct = false
	}
	if (formObj.status){
		if (validStatusArray.includes(formObj.status.toUpperCase().trim()))
		status = formObj.status.toUpperCase().trim()
	}
	if ((formObj.enableareafix)&&(formObj.enableareafix == "Yes")){
		enableareafix = true
	}
	if (returnObj.errormessages.length > 0){
		return returnObj
	}
	var uuid = await uuidv4()
	var dbObj = {
		name: formObj.name,
		uuid: uuid,
		address: formObj.address.trim(),
		domain: formObj.domain.trim(),
		status: status,
		session_password: formObj.sessionpw.trim(),
		packet_password: formObj.packetpw.trim(),
		tic_password: formObj.ticpw.trim(),
		connection_type: formObj.connectiontype,
		areafix_password: formObj.areafixpw.trim(),
		areafix_enabled: enableareafix,
		direct: direct,
		active: true,
		route_to: formObj.routeto.trim(),
		remote_host: formObj.remotehost,
		remote_port: formObj.remoteport,
		created_at: currtime,
	}
	var dbres = await postgres.insertObject(dbObj, "linked_nodes")
	if (dbres.status == true){
		if (dbres.insertId){
			returnObj.insertId = dbres.insertId
			returnObj.status = true
		}
	}
	return returnObj
}

async function getAllNodes(){
	var nodelist = await postgres.query("SELECT * FROM linked_nodes")
	return nodelist
}

async function getActiveNodes(){
	var nodelist = await postgres.query("SELECT * FROM linked_nodes WHERE active")
	return nodelist
}

async function getNodeByAddress(address){
	var dbres = await postgres.singlereadquery("SELECT * FROM linked_nodes WHERE address = $1", [address])
	return dbres
}

async function getNodeById(id){
	var dbres = await postgres.singlereadquery("SELECT * FROM linked_nodes WHERE id = $1", [id])
	return dbres
}

async function getNodeByUUID(uuid){
	var dbres = await postgres.singlereadquery("SELECT * FROM linked_nodes WHERE uuid = $1", [uuid])
	return dbres
}

async function updateAllowedAreas(uuid, allowedareas){
	var insertArray = []
	var returnObj = {
		status: false,
		errormessages: []
	}
	if ((!uuid)||(!allowedareas)){
		returnObj.errormessages.push("Invalid request!")
		return returnObj
	}
	if (Array.isArray(allowedareas)){
		insertArray = allowedareas
	}else{
		insertArray.push(allowedareas)
	}
	var dbnode = await getNodeByUUID(uuid)
	if (!dbnode){
		returnObj.errormessages.push("Invalid Node")
		return returnObj
	}
	try{
		var dbres = await postgres.query("UPDATE linked_nodes SET areas_allowed = $1", [insertArray])
		console.log(dbres)	
		returnObj.status = true
	}catch(error){
		console.log("Error writing to DB", error)
		returnObj.errormessages.push("Error updating DB entry")
	}
	return returnObj
}

async function updateEnabledAreas(uuid, enabledareas){
	var insertArray = []
	var returnObj = {
		status: false,
		errormessages: []
	}
	if ((!uuid)||(!enabledareas)){
		returnObj.errormessages.push("Invalid request!")
		return returnObj
	}
	if (Array.isArray(enabledareas)){
		insertArray = enabledareas
	}else{
		insertArray.push(enabledareas)
	}
	var dbnode = await getNodeByUUID(uuid)
	if (!dbnode){
		returnObj.errormessages.push("Invalid Node")
		return returnObj
	}
	try{
		var dbres = await postgres.query("UPDATE linked_nodes SET areas_enabled = $1", [insertArray])
		console.log(dbres)	
		returnObj.status = true
	}catch(error){
		console.log("Error writing to DB", error)
		returnObj.errormessages.push("Error updating DB entry")
	}
	return returnObj
}

async function updateAddress(uuid, formObj){
	var returnObj = {
		status: false,
		errormessages: []
	}
	var status = "NORMAL"
	if (formObj.status){
		if (validStatusArray.includes(formObj.status.toUpperCase().trim()))
		status = formObj.status.toUpperCase().trim()
	}
	var direct = true
	if (!formObj.address){
		returnObj.errormessages.push("Address cannot be empty")
	}
	if (!formObj.name){
		returnObj.errormessages.push("Name cannot be empty")
	}
	if (!formObj.domain){
		returnObj.errormessages.push("Domain cannot be empty")
	}
	if ((formObj.direct)&&(formObj.direct == "No")){
		direct = false
	}
	if (returnObj.errormessages.length > 0){
		return returnObj
	}
	try{
		var dbres = await postgres.query("UPDATE linked_nodes SET address = $1, status = $2, direct = $3, route_to = $4, name = $5 WHERE uuid = $6", [formObj.address, status, direct, formObj.routeto, formObj.name, uuid])
		console.log(dbres)	
		returnObj.status = true
	}catch(error){
		console.log("Error writing to DB", error)
		returnObj.errormessages.push("Error updating DB entry")
	}	
	return returnObj
}

async function updatePasswords(uuid, formObj){
	var returnObj = {
		status: false,
		errormessages: []
	}

	try{
		var dbres = await postgres.query("UPDATE linked_nodes SET session_password = $1, packet_password = $2, tic_password = $3, areafix_password = $4 WHERE uuid = $5", [formObj.sessionpw, formObj.packetpw, formObj.ticpw, formObj.areafixpw, uuid])
		console.log(dbres)	
		returnObj.status = true
	}catch(error){
		console.log("Error writing to DB", error)
		returnObj.errormessages.push("Error updating DB entry")
	}

	return returnObj
}

async function updateConnection(uuid, formObj){
	var returnObj = {
		status: false,
		errormessages: []
	}


	return returnObj
}


export{
	newNode,
	getAllNodes,
	getNodeByAddress,
	getNodeByUUID,
	getNodeById,
	updateAllowedAreas,
	updateEnabledAreas,
	getActiveNodes,
	updateAddress,
	updateConnection,
	updatePasswords,
}