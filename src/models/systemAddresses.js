//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as msgNetworks from './msgNetworks.js';
import * as msgZones from './msgZones.js';
import * as alogger from "../utils/alogger.js";

dotenv.config();

async function newAddress(formObj) {
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0
	};

	if (!formObj.address) {
		returnObj.errormessages.push("Address cannot be empty!");
	}
	if (!formObj.network_id && !formObj.domain) {
		returnObj.errormessages.push("Network cannot be empty!");
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

	// Parse and validate FidoNet-style address (zone:net/node.point)
	var validaddress = true;
	var zsplit  = formObj.address.split(":");
	var nnsplit = zsplit[1] ? zsplit[1].split("/") : [];
	var npsplit = nnsplit[1] ? nnsplit[1].split(".") : [];

	var zone  = parseInt(zsplit[0]);
	var net   = parseInt(nnsplit[0]);
	var node  = parseInt(npsplit[0]);
	var point = npsplit.length > 1 ? parseInt(npsplit[1]) : null;

	if (!zone || !Number.isInteger(zone)) {
		returnObj.errormessages.push("Invalid Zone");
		validaddress = false;
	}
	if (!net || !Number.isInteger(net)) {
		returnObj.errormessages.push("Invalid Net");
		validaddress = false;
	}
	if (!node || !Number.isInteger(node)) {
		returnObj.errormessages.push("Invalid Node");
		validaddress = false;
	}
	if (point !== null && !Number.isInteger(point)) {
		returnObj.errormessages.push("Invalid Point Address Component");
		validaddress = false;
	}

	if (!validaddress) {
		returnObj.errormessages.push("Invalid Address!");
		return returnObj;
	}

	// Validate zone belongs to this network.
	// getCachedZonesByNetwork returns null if both Redis and DB are unavailable —
	// reject the address in that case rather than allowing an unvalidated entry.
	var zoneList = await msgZones.getCachedZonesByNetwork(dbnetwork.id);
	if (!zoneList) {
		alogger.writeAlog(3, "newAddress: zone validation unavailable for network_id " + dbnetwork.id, "redbright");
		returnObj.errormessages.push("Zone validation is currently unavailable. Please try again or contact the system administrator.");
		return returnObj;
	}
	if (zoneList.length > 0) {
		var validZone = zoneList.some(z => z.zone_number === zone);
		if (!validZone) {
			returnObj.errormessages.push("Zone " + zone + " does not belong to network " + dbnetwork.name);
			return returnObj;
		}
	}

	var currtime = new Date();
	var uuid = uuidv4();

	var dbObj = {
		uuid: uuid,
		network_id: dbnetwork.id,
		address: formObj.address,
		address_zone: zone,
		address_net: net,
		address_node: node,
		address_point: point,
		domain: dbnetwork.domain,
		active: true,
		created_at: currtime,
		created_by_name: formObj.createdByName || "",
		created_by_uuid: formObj.createdByUUID || ""
	};

	var dbres = await postgres.insertObject(dbObj, "system_addresses");
	if (dbres.status === true && dbres.insertId) {
		returnObj.insertId = dbres.insertId;
		returnObj.status = true;
		alogger.writeAlog(5, "System address created: " + formObj.address + " on " + dbnetwork.domain, "greenbright");
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function getActiveAddresses() {
	var dblist = await postgres.query(
		"SELECT * FROM system_addresses WHERE active ORDER BY address ASC"
	);
	return dblist || [];
}

async function getAllAddresses() {
	var dblist = await postgres.query(
		"SELECT * FROM system_addresses ORDER BY address ASC"
	);
	return dblist || [];
}

async function getInactiveAddresses() {
	var dblist = await postgres.query(
		"SELECT * FROM system_addresses WHERE NOT active ORDER BY address ASC"
	);
	return dblist || [];
}

async function getAddressesByNetwork(networkId) {
	var dblist = await postgres.query(
		"SELECT * FROM system_addresses WHERE network_id = $1 AND active ORDER BY address ASC",
		[networkId]
	);
	return dblist || [];
}

async function getAddressesForZone(zone, domain) {
	var dblist;
	if (domain) {
		dblist = await postgres.query(
			"SELECT * FROM system_addresses WHERE address_zone = $1 AND UPPER(domain) LIKE UPPER($2) AND active",
			[zone, domain]
		);
	} else {
		dblist = await postgres.query(
			"SELECT * FROM system_addresses WHERE address_zone = $1 AND active",
			[zone]
		);
	}
	return dblist || [];
}

async function getAddressesForDomain(domain) {
	var dblist = await postgres.query(
		"SELECT * FROM system_addresses WHERE UPPER(domain) LIKE UPPER($1) AND active",
		[domain]
	);
	return dblist || [];
}

async function getAddressById(id) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM system_addresses WHERE id = $1",
		[id]
	);
	return dbres;
}

async function getAddressByUUID(uuid) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM system_addresses WHERE uuid = $1",
		[uuid]
	);
	return dbres;
}

export {
	newAddress,
	getActiveAddresses,
	getAllAddresses,
	getInactiveAddresses,
	getAddressesByNetwork,
	getAddressesForZone,
	getAddressesForDomain,
	getAddressById,
	getAddressByUUID
};