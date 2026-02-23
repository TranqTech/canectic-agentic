//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';

//internal modules
import * as mongoquick from "../middleware/db/mongoquick.js"
import * as postgres from '../middleware/db/postgres.js'
import * as msgAreas from "./msgAreas.js"

async function newGroup(formObj){
	console.log("Creating Group")
	var returnObj = {
		status: false,
		errormessages: []
	}
	//validate
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
	var shorty = formObj.shortcode.toUpperCase().trim()
	var uniqueShortcode = await postgres.checkValueUnique("shortcode", shorty, "message_groups")
	if (!uniqueShortcode){
		returnObj.errormessages.push("Shortcode must be unique!")
		console.log("shortcode must be unique!")
		return returnObj
	}
	returnObj.shortcode = shorty
	var currtime = await new Date()
	var uuid = await uuidv4()
	var pgObj = {
		uuid: uuid,
		name: formObj.name,
		description: formObj.description,
		shortcode: shorty,
		security: parseInt(formObj.security),
		created_at: currtime,
		updated_at: null,
		area_count: 0,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		active: true
	}
	var dbres = await postgres.insertObject(pgObj, "message_groups")
	if (dbres.status == true){
		returnObj.status = true
	}else{
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages)
	}
	console.log("Returning")
	return returnObj
}

async function isShortcodeUnique(shortcode){
	var isUnique = true
	console.log("Checking DB")
	var dblist = await mongoquick.getCollectionByFilter({shortcode: shortcode}, "MessageGroups")
	console.log("Checking results")
	if (dblist && dblist.length > 0){
		isUnique = false
	}
	return isUnique
}

async function getGroupByShortcode(shortcode){
	var shorty = shortcode.toUpperCase().trim()
	console.log("Finding group for shortcode", shortcode)
	var dbgroup = await postgres.singlereadquery('SELECT * FROM message_groups WHERE UPPER(shortcode) LIKE UPPER($1)', [shorty])
	return dbgroup
}

async function getAllGroups(){
	var grouplist = []
	//var dblist = await mongoquick.getCollectionByFilter({}, "MessageGroups")
	var dblist = await postgres.readquery('SELECT * FROM message_groups ORDER BY name ASC')
	if ((dblist)&&(dblist.length > 0)){
		grouplist = dblist
	}

	return grouplist
}

async function getActiveGroups(){
	var grouplist = []
	//var dblist = await mongoquick.getCollectionByFilter({active: true}, "MessageGroups")
	var dblist = await postgres.readquery('SELECT * FROM message_groups WHERE active ORDER BY name ASC')
	if ((dblist)&&(dblist.length > 0)){
		grouplist = dblist
	}

	return grouplist
}

async function getInactiveGroups(){
	var grouplist = []
	//var dblist = await mongoquick.getCollectionByFilter({active: false}, "MessageGroups")
	var dblist = await postgres.readquery('SELECT * FROM message_groups WHERE NOT active ORDER BY name ASC')
	if ((dblist)&&(dblist.length > 0)){
		grouplist = dblist
	}

	return grouplist
}

async function getAllGroupsWithAreas(){
	var querytext = "SELECT id, name, description, shortcode FROM message_groups WHERE active ORDER BY name ASC"
	var grouplist = await postgres.query(querytext, [])
	if ((grouplist)&&(grouplist.length > 0)){
		for await (var group of grouplist){
			group.areas = []
			group.areacount = 0
			var dbareas = await postgres.query("SELECT id, name, description, areatag, shortcode FROM message_areas WHERE active AND networked AND group_id = $1 ORDER BY name ASC", [group.id])
			if ((dbareas)&&(dbareas.length > 0)){
				group.areas = dbareas
				group.areacount = dbareas.length
			}
		}
	}
	//console.log(grouplist)
	return grouplist
}

export{
	newGroup,
	getGroupByShortcode,
	getAllGroups,
	getActiveGroups,
	getInactiveGroups,
	getAllGroupsWithAreas
}