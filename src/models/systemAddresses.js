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

	var networkType = (dbnetwork.network_type || 'FTN').toUpperCase();
	var zone = null, net = null, node = null, point = null;

	if (networkType === 'FTN') {
		// Parse and validate FidoNet-style address (zone:net/node.point)
		var validaddress = true;
		var zsplit  = formObj.address.split(":");
		var nnsplit = zsplit[1] ? zsplit[1].split("/") : [];
		var npsplit = nnsplit[1] ? nnsplit[1].split(".") : [];

		zone  = parseInt(zsplit[0]);
		net   = parseInt(nnsplit[0]);
		node  = parseInt(npsplit[0]);
		point = npsplit.length > 1 ? parseInt(npsplit[1]) : null;

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
			returnObj.errormessages.push("Invalid FTN Address!");
			return returnObj;
		}

		// Validate zone belongs to this network
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
	} else {
		// QWK, NNTP, LOCAL — store address as-is, no numeric parsing
		if (!formObj.address.trim()) {
			returnObj.errormessages.push("Address cannot be empty");
			return returnObj;
		}
	}

	// Check if this will be the first address on this network — auto-default it
	var existingAddresses = await getAddressesByNetwork(dbnetwork.id);
	var shouldBeDefault   = existingAddresses.length === 0;

	var currtime = new Date();
	var uuid = uuidv4();

	var dbObj = {
		uuid:            uuid,
		network_id:      dbnetwork.id,
		address:         formObj.address.trim(),
		address_zone:    zone,
		address_net:     net,
		address_node:    node,
		address_point:   point,
		domain:          dbnetwork.domain,
		origin_line:     formObj.origin_line ? formObj.origin_line.trim() : '',
		is_default:      shouldBeDefault,
		active:          true,
		created_at:      currtime,
		created_by_name: formObj.createdByName || "",
		created_by_uuid: formObj.createdByUUID || ""
	};

	var dbres = await postgres.insertObject(dbObj, "system_addresses");
	if (dbres.status === true && dbres.insertId) {
		returnObj.insertId = dbres.insertId;
		returnObj.status = true;
		alogger.writeAlog(5,
			"System address created: " + formObj.address + " on " + dbnetwork.domain +
			(shouldBeDefault ? " (set as default)" : ""),
			"greenbright"
		);
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
		"SELECT * FROM system_addresses WHERE network_id = $1 ORDER BY address ASC",
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

async function getDefaultAddress(networkId) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM system_addresses WHERE network_id = $1 AND is_default = true AND active ORDER BY id ASC LIMIT 1",
		[parseInt(networkId)]
	);
	return dbres || null;
}

async function setDefaultAddress(networkId, addressUUID) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbaddress = await getAddressByUUID(addressUUID);
	if (!dbaddress) {
		returnObj.errormessages.push("Address not found");
		return returnObj;
	}
	if (dbaddress.network_id !== parseInt(networkId)) {
		returnObj.errormessages.push("Address does not belong to this network");
		return returnObj;
	}

	// Clear existing default on this network then set the new one
	try {
		await postgres.write(
			"UPDATE system_addresses SET is_default = false WHERE network_id = $1 AND is_default = true",
			[parseInt(networkId)]
		);
		await postgres.write(
			"UPDATE system_addresses SET is_default = true WHERE id = $1",
			[dbaddress.id]
		);
		alogger.writeAlog(5, "Default address set to " + dbaddress.address + " for network_id " + networkId, "greenbright");
		returnObj.status = true;
	} catch (err) {
		returnObj.errormessages.push("Failed to set default address: " + err.message);
		alogger.writeAlog(3, "setDefaultAddress failed: " + err.message, "redbright");
	}
	return returnObj;
}

async function updateAddress(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbaddress = await getAddressByUUID(uuid);
	if (!dbaddress) {
		returnObj.errormessages.push("Address not found");
		return returnObj;
	}

	var dbnetwork = await msgNetworks.getNetworkById(dbaddress.network_id);
	var networkType = dbnetwork ? (dbnetwork.network_type || 'FTN').toUpperCase() : 'FTN';

	var updateObj = {
		active:          formObj.active === 'true' || formObj.active === true,
		updated_at:      new Date(),
		updated_by_name: formObj.updatedByName || "",
		updated_by_uuid: formObj.updatedByUUID || ""
	};

	if (formObj.origin_line !== undefined) {
		updateObj.origin_line = formObj.origin_line ? formObj.origin_line.trim() : '';
	}

	// If a new address string is provided and it changed, re-parse/validate
	if (formObj.address && formObj.address.trim() !== dbaddress.address) {
		var raw = formObj.address.trim();

		if (networkType === 'FTN') {
			var zsplit  = raw.split(":");
			var nnsplit = zsplit[1] ? zsplit[1].split("/") : [];
			var npsplit = nnsplit[1] ? nnsplit[1].split(".") : [];

			var zone  = parseInt(zsplit[0]);
			var net   = parseInt(nnsplit[0]);
			var node  = parseInt(npsplit[0]);
			var point = npsplit.length > 1 ? parseInt(npsplit[1]) : null;

			if (!zone  || !Number.isInteger(zone))  returnObj.errormessages.push("Invalid Zone");
			if (!net   || !Number.isInteger(net))   returnObj.errormessages.push("Invalid Net");
			if (!node  || !Number.isInteger(node))  returnObj.errormessages.push("Invalid Node");
			if (point !== null && !Number.isInteger(point)) returnObj.errormessages.push("Invalid Point");
			if (returnObj.errormessages.length > 0) return returnObj;

			// Validate zone belongs to this network
			var zoneList = await msgZones.getCachedZonesByNetwork(dbaddress.network_id);
			if (zoneList && zoneList.length > 0) {
				if (!zoneList.some(z => z.zone_number === zone)) {
					returnObj.errormessages.push("Zone " + zone + " does not belong to this network");
					return returnObj;
				}
			}

			updateObj.address       = raw;
			updateObj.address_zone  = zone;
			updateObj.address_net   = net;
			updateObj.address_node  = node;
			updateObj.address_point = point;
		} else {
			// QWK, NNTP, LOCAL — store as-is
			updateObj.address = raw;
		}
	}

	var dbres = await postgres.updateById(dbaddress.id, updateObj, "system_addresses");
	if (dbres > 0) {
		returnObj.status = true;
		alogger.writeAlog(5, "System address updated: " + (updateObj.address || dbaddress.address), "greenbright");
	} else {
		returnObj.errormessages.push("Database update returned no rows");
		alogger.writeAlog(3, "updateAddress: no rows updated for uuid " + uuid, "redbright");
	}
	return returnObj;
}

async function removeAddress(uuid) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbaddress = await getAddressByUUID(uuid);
	if (!dbaddress) {
		returnObj.errormessages.push("Address not found");
		return returnObj;
	}

	var dbres = await postgres.write(
		"DELETE FROM system_addresses WHERE id = $1",
		[dbaddress.id]
	);
	if (dbres.status === true) {
		returnObj.status = true;
		alogger.writeAlog(5, "System address removed: " + dbaddress.address, "greenbright");
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages || []);
	}
	return returnObj;
}

export {
	newAddress,
	updateAddress,
	removeAddress,
	setDefaultAddress,
	getDefaultAddress,
	getActiveAddresses,
	getAllAddresses,
	getInactiveAddresses,
	getAddressesByNetwork,
	getAddressesForZone,
	getAddressesForDomain,
	getAddressById,
	getAddressByUUID
};