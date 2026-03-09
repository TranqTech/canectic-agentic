//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as msgNetworks from './msgNetworks.js';
import * as alogger from "../utils/alogger.js";

dotenv.config();

const validStatusArray = ["NORMAL", "CRASH", "HOLD"];

async function newNode(formObj) {
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0
	};

	if (!formObj.name) {
		returnObj.errormessages.push("Name cannot be empty");
	}
	if (!formObj.address) {
		returnObj.errormessages.push("Address cannot be empty");
	}
	if (!formObj.network_id && !formObj.domain) {
		returnObj.errormessages.push("Network cannot be empty");
	}
	if (!formObj.connectiontype) {
		returnObj.errormessages.push("Could not determine connection type");
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	// Resolve network
	var dbnetwork;
	if (formObj.network_id) {
		dbnetwork = await msgNetworks.getNetworkById(parseInt(formObj.network_id));
	} else {
		dbnetwork = await msgNetworks.getNetworkByDomain(formObj.domain);
	}
	if (!dbnetwork) {
		returnObj.errormessages.push("Network not found");
		return returnObj;
	}
	if (!dbnetwork.active) {
		returnObj.errormessages.push("Network is not active");
		return returnObj;
	}

	var direct = (formObj.direct !== "No");
	var enableareafix = (formObj.enableareafix === "Yes");
	var status = "NORMAL";
	if (formObj.status && validStatusArray.includes(formObj.status.toUpperCase().trim())) {
		status = formObj.status.toUpperCase().trim();
	}

	var uuid = uuidv4();
	var currtime = new Date();

	var dbObj = {
		name: formObj.name,
		uuid: uuid,
		network_id: dbnetwork.id,
		address: formObj.address.trim(),
		domain: dbnetwork.domain,
		status: status,
		session_password: formObj.sessionpw ? formObj.sessionpw.trim() : "",
		packet_password: formObj.packetpw ? formObj.packetpw.trim() : "",
		tic_password: formObj.ticpw ? formObj.ticpw.trim() : "",
		connection_type: formObj.connectiontype,
		areafix_password: formObj.areafixpw ? formObj.areafixpw.trim() : "",
		areafix_enabled: enableareafix,
		direct: direct,
		active: true,
		route_to: formObj.routeto ? formObj.routeto.trim() : "",
		remote_host: formObj.remotehost,
		remote_port: formObj.remoteport,
		created_at: currtime
	};

	var dbres = await postgres.insertObject(dbObj, "linked_nodes");
	if (dbres.status === true && dbres.insertId) {
		returnObj.insertId = dbres.insertId;
		returnObj.status = true;
		alogger.writeAlog(5, "Linked node created: " + formObj.name + " (" + formObj.address + ") on " + dbnetwork.domain, "greenbright");
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function getAllNodes() {
	var nodelist = await postgres.query("SELECT * FROM linked_nodes");
	return nodelist || [];
}

async function getActiveNodes() {
	var nodelist = await postgres.query("SELECT * FROM linked_nodes WHERE active");
	return nodelist || [];
}

async function getNodesByNetwork(networkId) {
	var nodelist = await postgres.query(
		"SELECT * FROM linked_nodes WHERE network_id = $1",
		[networkId]
	);
	return nodelist || [];
}

async function getNodeByAddress(address) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM linked_nodes WHERE address = $1",
		[address]
	);
	return dbres;
}

async function getNodeById(id) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM linked_nodes WHERE id = $1",
		[id]
	);
	return dbres;
}

async function getNodeByUUID(uuid) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM linked_nodes WHERE uuid = $1",
		[uuid]
	);
	return dbres;
}

async function updateAllowedAreas(uuid, allowedareas) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (!uuid || !allowedareas) {
		returnObj.errormessages.push("Invalid request!");
		return returnObj;
	}

	var insertArray = Array.isArray(allowedareas) ? allowedareas : [allowedareas];

	var dbnode = await getNodeByUUID(uuid);
	if (!dbnode) {
		returnObj.errormessages.push("Invalid Node");
		return returnObj;
	}

	var err = await postgres.write(
		"UPDATE linked_nodes SET areas_allowed = $1 WHERE uuid = $2",
		[insertArray, uuid]
	);
	if (err) {
		alogger.writeAlog(3, "updateAllowedAreas error for " + uuid + ": " + err.message, "redbright");
		returnObj.errormessages.push("Error updating DB entry");
		return returnObj;
	}

	returnObj.status = true;
	return returnObj;
}

async function updateEnabledAreas(uuid, enabledareas) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (!uuid || !enabledareas) {
		returnObj.errormessages.push("Invalid request!");
		return returnObj;
	}

	var insertArray = Array.isArray(enabledareas) ? enabledareas : [enabledareas];

	var dbnode = await getNodeByUUID(uuid);
	if (!dbnode) {
		returnObj.errormessages.push("Invalid Node");
		return returnObj;
	}

	var err = await postgres.write(
		"UPDATE linked_nodes SET areas_enabled = $1 WHERE uuid = $2",
		[insertArray, uuid]
	);
	if (err) {
		alogger.writeAlog(3, "updateEnabledAreas error for " + uuid + ": " + err.message, "redbright");
		returnObj.errormessages.push("Error updating DB entry");
		return returnObj;
	}

	returnObj.status = true;
	return returnObj;
}

async function updateAddress(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (!formObj.address) {
		returnObj.errormessages.push("Address cannot be empty");
	}
	if (!formObj.name) {
		returnObj.errormessages.push("Name cannot be empty");
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	// If network_id is being updated, resolve and validate the new network
	var networkFields = {};
	if (formObj.network_id !== undefined) {
		var dbnetwork = await msgNetworks.getNetworkById(parseInt(formObj.network_id));
		if (!dbnetwork) {
			returnObj.errormessages.push("Network not found");
			return returnObj;
		}
		if (!dbnetwork.active) {
			returnObj.errormessages.push("Network is not active");
			return returnObj;
		}
		networkFields.network_id = dbnetwork.id;
		networkFields.domain = dbnetwork.domain;
	}

	var direct = (formObj.direct !== "No");
	var status = "NORMAL";
	if (formObj.status && validStatusArray.includes(formObj.status.toUpperCase().trim())) {
		status = formObj.status.toUpperCase().trim();
	}

	var err = await postgres.write(
		"UPDATE linked_nodes SET address = $1, status = $2, direct = $3, route_to = $4, name = $5" +
		(networkFields.network_id ? ", network_id = $6, domain = $7 WHERE uuid = $8" : " WHERE uuid = $6"),
		networkFields.network_id
			? [formObj.address, status, direct, formObj.routeto, formObj.name, networkFields.network_id, networkFields.domain, uuid]
			: [formObj.address, status, direct, formObj.routeto, formObj.name, uuid]
	);
	if (err) {
		alogger.writeAlog(3, "updateAddress error for " + uuid + ": " + err.message, "redbright");
		returnObj.errormessages.push("Error updating DB entry");
		return returnObj;
	}

	returnObj.status = true;
	return returnObj;
}

async function updatePasswords(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var err = await postgres.write(
		"UPDATE linked_nodes SET session_password = $1, packet_password = $2, tic_password = $3, areafix_password = $4 WHERE uuid = $5",
		[formObj.sessionpw, formObj.packetpw, formObj.ticpw, formObj.areafixpw, uuid]
	);
	if (err) {
		alogger.writeAlog(3, "updatePasswords error for " + uuid + ": " + err.message, "redbright");
		returnObj.errormessages.push("Error updating DB entry");
		return returnObj;
	}

	returnObj.status = true;
	return returnObj;
}

async function updateConnection(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (!formObj.connectiontype) {
		returnObj.errormessages.push("Connection type cannot be empty");
		return returnObj;
	}

	var err = await postgres.write(
		"UPDATE linked_nodes SET connection_type = $1, remote_host = $2, remote_port = $3 WHERE uuid = $4",
		[formObj.connectiontype, formObj.remotehost || "", parseInt(formObj.remoteport) || null, uuid]
	);
	if (err) {
		alogger.writeAlog(3, "updateConnection error for " + uuid + ": " + err.message, "redbright");
		returnObj.errormessages.push("Error updating DB entry");
		return returnObj;
	}

	returnObj.status = true;
	return returnObj;
}

export {
	newNode,
	getAllNodes,
	getActiveNodes,
	getNodesByNetwork,
	getNodeByAddress,
	getNodeById,
	getNodeByUUID,
	updateAllowedAreas,
	updateEnabledAreas,
	updateAddress,
	updatePasswords,
	updateConnection
};