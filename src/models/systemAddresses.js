//imports
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as msgNetworks from './msgNetworks.js';
import * as msgZones from './msgZones.js';
import * as alogger from "../utils/alogger.js";


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

		if (zone == null || !Number.isInteger(zone) || zone < 0) {
			returnObj.errormessages.push("Invalid Zone");
			validaddress = false;
		}
		if (net == null || !Number.isInteger(net) || net < 0) {
			returnObj.errormessages.push("Invalid Net");
			validaddress = false;
		}
		if (node == null || !Number.isInteger(node) || node < 0) {
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

			if (zone == null || !Number.isInteger(zone) || zone < 0) returnObj.errormessages.push("Invalid Zone");
			if (net == null  || !Number.isInteger(net)  || net < 0)  returnObj.errormessages.push("Invalid Net");
			if (node == null || !Number.isInteger(node) || node < 0) returnObj.errormessages.push("Invalid Node");
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

// Check if an address string exists as an active system address
// on a network of the given type (e.g. 'FTN', 'QWK', 'NNTP').
// Returns the system_addresses row if found, null otherwise.
// Used by ftnNetmailAdapter to determine if a destination is local.
async function getActiveAddressByNetworkType(addressString, networkType) {
	var row = await postgres.queryOne(
		"SELECT sa.* FROM system_addresses sa " +
		"JOIN message_networks mn ON sa.network_id = mn.id " +
		"WHERE sa.address = $1 AND UPPER(mn.network_type) = UPPER($2) AND sa.active = true",
		[addressString, networkType]
	);
	return row || null;
}

// Get the default system address for a network type (e.g. 'FTN', 'QWK').
// Joins with message_networks to find networks of the given type, then
// returns the first default address found. Returns null if none.
// Note: for FTN, prefer resolveSourceForDestinationZone() which matches
// the correct network based on destination zone.
async function getDefaultAddressByNetworkType(networkType) {
	var row = await postgres.queryOne(
		"SELECT sa.* FROM system_addresses sa " +
		"JOIN message_networks mn ON sa.network_id = mn.id " +
		"WHERE UPPER(mn.network_type) = UPPER($1) AND sa.is_default = true AND sa.active = true " +
		"ORDER BY sa.id ASC LIMIT 1",
		[networkType]
	);
	return row || null;
}

// Resolve the correct local system address to use as the source for an
// outbound FTN message based on the destination zone number.
//
// Cascade:
//   1. Get all FTN-type networks
//   2. For each, check if destinationZone is in that network's zone list
//   3. Return the default system address for the matching network
//   4. If no zone match on any network, return { address: null, reason: '...' }
//
// Returns { address: <system_addresses row>, networkId: <int> } on success
// or { address: null, reason: <string> } on failure.
async function resolveSourceForDestinationZone(destinationZone) {
	if (!destinationZone) {
		return { address: null, reason: 'no_destination_zone' };
	}

	var zone = parseInt(destinationZone);
	if (isNaN(zone)) {
		return { address: null, reason: 'invalid_destination_zone' };
	}

	// Get all FTN-type networks
	var ftnNetworks = await msgNetworks.getNetworksByType('FTN');
	if (!ftnNetworks || ftnNetworks.length === 0) {
		return { address: null, reason: 'no_ftn_networks_configured' };
	}

	// Check each network's zone list for a match
	for (var network of ftnNetworks) {
		if (!network.active) continue;

		var zoneList = await msgZones.getCachedZonesByNetwork(network.id);
		if (!zoneList || zoneList.length === 0) continue;

		var zoneMatch = zoneList.some(function(z) { return z.zone_number === zone; });
		if (zoneMatch) {
			// Found the network that owns this zone — get its default address
			var defaultAddr = await getDefaultAddress(network.id);
			if (defaultAddr) {
				return { address: defaultAddr, networkId: network.id };
			}
			// Network owns the zone but has no default address
			return { address: null, reason: 'no_default_address_for_network_' + network.domain };
		}
	}

	return { address: null, reason: 'zone_' + zone + '_not_found_on_any_ftn_network' };
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
	getAddressByUUID,
	getActiveAddressByNetworkType,
	getDefaultAddressByNetworkType,
	resolveSourceForDestinationZone
};