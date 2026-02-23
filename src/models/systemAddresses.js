//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { DateTime } from "luxon";

import * as postgres from '../middleware/db/postgres.js'
import * as tableTools from '../middleware/db/tableTools.js'

async function newAddress(formObj){
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0
	}
	if (!formObj.domain){
		returnObj.errormessages.push("Domain cannot be empty!")
	}
	if (!formObj.address){
		returnObj.errormessages.push("Address cannot be empty!")
	}
	if (returnObj.errormessages.length > 0){
		return returnObj
	}
	var validaddress = true
	var zsplit = formObj.address.split(":")
	var nnsplit = zsplit[1].split("/")
	var npsplit = nnsplit[1].split(".")
	var zone = parseInt(zsplit[0])
	var net = parseInt(nnsplit[0])
	var node = parseInt(npsplit[0])
	var point
	if (npsplit.length > 1){
		point = npsplit[1]
	}
	if ((!zone)||(!Number.isInteger(zone))){
		returnObj.errormessages.push("Invalid Zone")
		validaddress = false
	}
	if ((!net)||(!Number.isInteger(net))){
		returnObj.errormessages.push("Invalid Net")
		validaddress = false
	}
	if ((!node)||(!Number.isInteger(node))){
		returnObj.errormessages.push("Invalid Node")
		validaddress = false
	}
	if ((point)&&(!Number.isInteger(point))){
		returnObj.errormessages.push("Invalid Point Address Component")
		validaddress = false
	}
	if (!validaddress){
		returnObj.errormessages.push("Invalid Address!")
	}
	if (returnObj.errormessages.length > 0){
		return returnObj
	}
	var currtime = await new Date
	var uuid = await uuidv4()
	var dbObj = {
		uuid: uuid,
		address: formObj.address,
		address_zone:zone,
		address_net: net,
		address_node: node,
		address_point: point,
		domain: formObj.domain,
		active: true,
		created_at: currtime,
		created_by_name: "",
		created_by_uuid: "",
	}
	var dbres = await postgres.insertObject(dbObj, "system_addresses")
	if (dbres.status == true){
		if (dbres.insertId){
			returnObj.insertId = dbres.insertId
			returnObj.status = true
		}
	}
	return returnObj
}

async function getActiveAddresses(){
	var dblist = await postgres.query("SELECT * FROM system_addresses WHERE active ORDER BY address ASC")
	return dblist
}

async function getAllAddresses(){
	var dblist = await postgres.query("SELECT * FROM system_addresses ORDER BY address ASC")
	return dblist
}

async function getInactiveAddresses(){
	var dblist = await postgres.query("SELECT * FROM system_addresses WHERE NOT active ORDER BY address ASC")
	return dblist
}

async function getAddressesForZone(zone, domain){
	var querytext
	var dblist
	if (domain){
		querytext = "SELECT * FROM system_addresses WHERE address_zone = $1 AND UPPER(domain) LIKE UPPER($2) AND active"
		dblist = await postgres.query(querytext, [zone, domain])
	}else{
		querytext = "SELECT * FROM system_addresses WHERE address_zone = $1 AND active"
		dblist = await postgres.query(querytext, [zone])
	}
	return dblist
}

async function getAddressesForDomain(domain){
	var dblist = await postgres.query("SELECT * FROM system_addresses WHERE UPPER(domain) LIKE UPPER($1) AND active", [domain])
	return dblist
}

async function getAddressById(id){
	//
}

async function getAddressByUUID(uuid){
	//
}


export{
	newAddress,
	getAddressesForDomain,
	getAddressesForZone,
	getAllAddresses,
	getActiveAddresses,
	getInactiveAddresses,
	getAddressByUUID,
	getAddressById
}