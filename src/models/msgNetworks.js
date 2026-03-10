//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from "../utils/alogger.js";

dotenv.config();

async function newNetwork(formObj) {
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0,
		insertUUID: ""
	};

	if (!formObj.name) {
		returnObj.errormessages.push("Name cannot be empty!");
	}
	if (!formObj.domain) {
		returnObj.errormessages.push("Domain cannot be empty!");
	}
	if (!formObj.description) {
		returnObj.errormessages.push("Description cannot be empty!");
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	var domain = formObj.domain.toLowerCase().trim();

	var uniqueDomain = await postgres.checkValueUnique("domain", domain, "message_networks");
	if (!uniqueDomain) {
		returnObj.errormessages.push("A network with that domain already exists!");
		return returnObj;
	}

	var currtime = new Date();
	var uuid = uuidv4();

	var dbObj = {
		uuid: uuid,
		name: formObj.name.trim(),
		domain: domain,
		description: formObj.description.trim(),
		network_type: formObj.network_type ? formObj.network_type.trim() : "FTN",
		active: true,
		config: formObj.config ? JSON.stringify(formObj.config) : null,
		created_at: currtime,
		updated_at: null,
		created_by_name: formObj.createdByName || "",
		created_by_uuid: formObj.createdByUUID || ""
	};

	var dbres = await postgres.insertObject(dbObj, "message_networks");
	if (dbres.status === true && dbres.insertId) {
		returnObj.insertId   = dbres.insertId;
		returnObj.insertUUID = uuid;
		returnObj.status = true;
		alogger.writeAlog(5, "Message network created: " + formObj.name + " (" + domain + ")", "greenbright");
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function getAllNetworks() {
	var dblist = await postgres.query(
		"SELECT * FROM message_networks ORDER BY name ASC"
	);
	return dblist || [];
}

async function getActiveNetworks() {
	var dblist = await postgres.query(
		"SELECT * FROM message_networks WHERE active ORDER BY name ASC"
	);
	return dblist || [];
}

async function getNetworkById(id) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM message_networks WHERE id = $1",
		[id]
	);
	return dbres;
}

async function getNetworkByUUID(uuid) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM message_networks WHERE uuid = $1",
		[uuid]
	);
	return dbres;
}

async function getNetworkByDomain(domain) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM message_networks WHERE LOWER(domain) = LOWER($1)",
		[domain.toLowerCase().trim()]
	);
	return dbres;
}

async function getNetworksWithZoneCount() {
	var dblist = await postgres.query(
		`SELECT n.*, COUNT(z.id)::int AS zone_count
		 FROM message_networks n
		 LEFT JOIN network_zones z ON z.network_id = n.id AND z.active
		 GROUP BY n.id
		 ORDER BY n.name ASC`
	);
	return dblist || [];
}


async function updateNetwork(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbnetwork = await getNetworkByUUID(uuid);
	if (!dbnetwork) {
		returnObj.errormessages.push("Network not found");
		return returnObj;
	}

	// If domain is changing, validate uniqueness and cascade to children
	var domainChanging = false;
	var newDomain;
	if (formObj.domain !== undefined) {
		newDomain = formObj.domain.toLowerCase().trim();
		if (newDomain !== dbnetwork.domain) {
			var uniqueDomain = await postgres.checkValueUnique("domain", newDomain, "message_networks");
			if (!uniqueDomain) {
				returnObj.errormessages.push("A network with that domain already exists!");
				return returnObj;
			}
			domainChanging = true;
		}
	}

	var updateObj = {};
	if (formObj.name        !== undefined) updateObj.name        = formObj.name.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim();
	if (formObj.active      !== undefined) updateObj.active      = (formObj.active === "true" || formObj.active === true);
	if (formObj.domain      !== undefined) updateObj.domain      = newDomain;

	if (formObj.network_type !== undefined) updateObj.network_type = formObj.network_type.trim();
	if (formObj.config       !== undefined) {
		// Accept a raw object, a JSON string, or null to clear
		if (formObj.config === null) {
			updateObj.config = null;
		} else if (typeof formObj.config === 'object') {
			updateObj.config = JSON.stringify(formObj.config);
		} else {
			updateObj.config = formObj.config; // assume pre-serialised string
		}
	}

	// zones is a managed cache owned by msgZones — never updated directly here

	if (Object.keys(updateObj).length === 0) {
		returnObj.errormessages.push("No updatable fields provided");
		return returnObj;
	}

	updateObj.updated_at = new Date();
	if (formObj.updatedByName) updateObj.updated_by_name = formObj.updatedByName;
	if (formObj.updatedByUUID) updateObj.updated_by_uuid = formObj.updatedByUUID;

	var count = await postgres.updateById(dbnetwork.id, updateObj, "message_networks");
	if (count === 0) {
		returnObj.errormessages.push("No rows updated");
		return returnObj;
	}

	// Cascade domain change to system_addresses
	// (linked_nodes retired — peer_connections.connection_data is transport-specific
	// and does not store a redundant domain field)
	if (domainChanging) {
		var addrErr = await postgres.write(
			"UPDATE system_addresses SET domain = $1 WHERE network_id = $2",
			[newDomain, dbnetwork.id]
		);
		if (addrErr) {
			alogger.writeAlog(3, "updateNetwork: failed to cascade domain to system_addresses for network_id " + dbnetwork.id + ": " + addrErr.message, "redbright");
			returnObj.errormessages.push("Network updated but domain cascade to system addresses failed: " + addrErr.message);
			return returnObj;
		}

		alogger.writeAlog(5, "updateNetwork: domain cascaded from " + dbnetwork.domain + " to " + newDomain + " for network_id " + dbnetwork.id, "cyan");
	}

	alogger.writeAlog(5, "Message network updated: " + dbnetwork.name, "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function getNetworksByType(networkType) {
	var dblist = await postgres.query(
		"SELECT * FROM message_networks WHERE network_type = $1 ORDER BY name ASC",
		[networkType]
	);
	return dblist || [];
}

export {
	newNetwork,
	getAllNetworks,
	getActiveNetworks,
	getNetworksWithZoneCount,
	getNetworkById,
	getNetworkByUUID,
	getNetworkByDomain,
	getNetworksByType,
	updateNetwork
};