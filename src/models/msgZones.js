//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as redis from '../middleware/db/redis.js';
import * as alogger from "../utils/alogger.js";

dotenv.config();

const ZONES_CACHE_NS = "zones";
const ZONES_CACHE_TTL = parseInt(process.env.zones_cache_ttl) || 3600;

// Invalidates the Redis zone cache for a network so the next lookup
// repopulates from the DB via cacheThrough.
async function invalidateZoneCache(networkId) {
	var ok = await redis.cacheInvalidate(ZONES_CACHE_NS, networkId.toString());
	if (!ok) {
		alogger.writeAlog(4, "invalidateZoneCache: failed to invalidate for network_id " + networkId, "yellow");
	}
	return ok;
}

// Returns active zones for a network, served from Redis cache when available.
async function getCachedZonesByNetwork(networkId) {
	return await redis.cacheThrough(
		ZONES_CACHE_NS,
		networkId.toString(),
		() => getActiveZonesByNetwork(networkId),
		ZONES_CACHE_TTL
	);
}

async function newZone(formObj) {
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0
	};

	if (!formObj.network_id) {
		returnObj.errormessages.push("Network ID cannot be empty!");
	}
	if (!formObj.zone_number) {
		returnObj.errormessages.push("Zone number cannot be empty!");
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	var networkId  = parseInt(formObj.network_id);
	var zoneNumber = parseInt(formObj.zone_number);

	if (isNaN(networkId) || isNaN(zoneNumber)) {
		returnObj.errormessages.push("Network ID and zone number must be valid integers");
		return returnObj;
	}

	// Check zone number is unique within this network
	var existing = await postgres.queryOne(
		"SELECT id FROM network_zones WHERE network_id = $1 AND zone_number = $2",
		[networkId, zoneNumber]
	);
	if (existing) {
		returnObj.errormessages.push("Zone " + zoneNumber + " already exists on this network");
		return returnObj;
	}

	var currtime = new Date();
	var uuid = uuidv4();

	var dbObj = {
		uuid: uuid,
		network_id: networkId,
		zone_number: zoneNumber,
		name: formObj.name ? formObj.name.trim() : "",
		description: formObj.description ? formObj.description.trim() : "",
		coordinator_address: formObj.coordinator_address ? formObj.coordinator_address.trim() : "",
		active: true,
		created_at: currtime,
		updated_at: null,
		created_by_name: formObj.createdByName || "",
		created_by_uuid: formObj.createdByUUID || ""
	};

	var dbres = await postgres.insertObject(dbObj, "network_zones");
	if (dbres.status !== true) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	returnObj.insertId = dbres.insertId;

	await invalidateZoneCache(networkId);

	alogger.writeAlog(5, "Zone " + zoneNumber + " created for network_id " + networkId, "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function updateZone(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbzone = await getZoneByUUID(uuid);
	if (!dbzone) {
		returnObj.errormessages.push("Zone not found");
		return returnObj;
	}

	var updateObj = {};
	if (formObj.name                !== undefined) updateObj.name                = formObj.name.trim();
	if (formObj.description         !== undefined) updateObj.description         = formObj.description.trim();
	if (formObj.coordinator_address !== undefined) updateObj.coordinator_address = formObj.coordinator_address.trim();
	if (formObj.active              !== undefined) updateObj.active              = (formObj.active === "true" || formObj.active === true);

	// Zone number changes are intentionally not supported via update —
	// remove and re-add if a zone number needs to change.
	if (Object.keys(updateObj).length === 0) {
		returnObj.errormessages.push("No updatable fields provided");
		return returnObj;
	}

	updateObj.updated_at = new Date();
	if (formObj.updatedByName) updateObj.updated_by_name = formObj.updatedByName;
	if (formObj.updatedByUUID) updateObj.updated_by_uuid = formObj.updatedByUUID;

	var count = await postgres.updateById(dbzone.id, updateObj, "network_zones");
	if (count === 0) {
		returnObj.errormessages.push("No rows updated");
		return returnObj;
	}

	// Invalidate cache if active status changed — zone may have entered or left the active set
	if (formObj.active !== undefined) {
		await invalidateZoneCache(dbzone.network_id);
	}

	alogger.writeAlog(5, "Zone " + dbzone.zone_number + " updated for network_id " + dbzone.network_id, "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function removeZone(uuid) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbzone = await getZoneByUUID(uuid);
	if (!dbzone) {
		returnObj.errormessages.push("Zone not found");
		return returnObj;
	}

	var err = await postgres.write(
		"DELETE FROM network_zones WHERE id = $1",
		[dbzone.id]
	);
	if (err) {
		returnObj.errormessages.push("Failed to remove zone: " + err.message);
		return returnObj;
	}

	await invalidateZoneCache(dbzone.network_id);

	alogger.writeAlog(5, "Zone " + dbzone.zone_number + " removed from network_id " + dbzone.network_id, "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function getZonesByNetwork(networkId) {
	var dblist = await postgres.query(
		"SELECT * FROM network_zones WHERE network_id = $1 ORDER BY zone_number ASC",
		[networkId]
	);
	return dblist || [];
}

async function getActiveZonesByNetwork(networkId) {
	var dblist = await postgres.query(
		"SELECT * FROM network_zones WHERE network_id = $1 AND active ORDER BY zone_number ASC",
		[networkId]
	);
	return dblist || [];
}

async function getZoneByNumber(networkId, zoneNumber) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM network_zones WHERE network_id = $1 AND zone_number = $2",
		[networkId, zoneNumber]
	);
	return dbres;
}

async function getZoneByUUID(uuid) {
	var dbres = await postgres.queryOne(
		"SELECT * FROM network_zones WHERE uuid = $1",
		[uuid]
	);
	return dbres;
}

export {
	newZone,
	updateZone,
	removeZone,
	getZonesByNetwork,
	getActiveZonesByNetwork,
	getCachedZonesByNetwork,
	getZoneByNumber,
	getZoneByUUID,
	invalidateZoneCache
};