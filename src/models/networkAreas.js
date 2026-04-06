// imports

// internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as redis from '../middleware/db/redis.js';
import * as alogger from '../utils/alogger.js';


const CACHE_NS = 'network_areas';
const CACHE_TTL = 3600;

// --- Write operations ---

async function addAreaToNetwork(networkId, areaId, areatag, formObj) {
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0
	};

	if (!networkId) {
		returnObj.errormessages.push('Network ID cannot be empty');
	}
	if (!areaId) {
		returnObj.errormessages.push('Area ID cannot be empty');
	}
	if (!areatag) {
		returnObj.errormessages.push('Areatag cannot be empty');
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	// Guard against duplicate
	var existing = await getNetworkArea(networkId, areaId);
	if (existing) {
		returnObj.errormessages.push('This area is already mapped to this network');
		return returnObj;
	}

	var currtime = new Date();

	var dbObj = {
		network_id: parseInt(networkId),
		area_id: parseInt(areaId),
		areatag: areatag.trim(),
		active: true,
		created_at: currtime,
		updated_at: null,
		created_by_uuid: formObj && formObj.createdByUUID ? formObj.createdByUUID : '',
		created_by_name: formObj && formObj.createdByName ? formObj.createdByName : '',
		updated_by_uuid: '',
		updated_by_name: ''
	};

	var dbres = await postgres.insertObject(dbObj, 'network_areas');
	if (dbres.status === true && dbres.insertId) {
		returnObj.insertId = dbres.insertId;
		returnObj.status = true;
		await invalidateNetworkAreaCache(networkId);
		alogger.writeAlog(5, 'Area ' + areaId + ' added to network ' + networkId + ' as ' + areatag, 'greenbright');
		// Sync echolist local_area_id
		try {
			var networkEcholist = await import('./networkEcholist.js');
			await networkEcholist.syncLocalAreaId(networkId, areaId, areatag, 'add');
		} catch (e) { /* echolist sync is non-critical */ }
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function removeAreaFromNetwork(networkId, areaId) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var existing = await getNetworkArea(networkId, areaId);
	if (!existing) {
		returnObj.errormessages.push('Network area mapping not found');
		return returnObj;
	}

	var err = await postgres.write(
		'DELETE FROM network_areas WHERE network_id = $1 AND area_id = $2',
		[parseInt(networkId), parseInt(areaId)]
	);
	if (err) {
		alogger.writeAlog(3, 'removeAreaFromNetwork error for network ' + networkId + ' / area ' + areaId + ': ' + err.message, 'redbright');
		returnObj.errormessages.push('Failed to remove network area mapping: ' + err.message);
		return returnObj;
	}

	await invalidateNetworkAreaCache(networkId);
	alogger.writeAlog(5, 'Area ' + areaId + ' removed from network ' + networkId, 'greenbright');
	// Sync echolist local_area_id
	try {
		var networkEcholist = await import('./networkEcholist.js');
		await networkEcholist.syncLocalAreaId(networkId, null, existing.areatag, 'remove');
	} catch (e) { /* echolist sync is non-critical */ }
	returnObj.status = true;
	return returnObj;
}

async function updateNetworkArea(networkId, areaId, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var existing = await getNetworkArea(networkId, areaId);
	if (!existing) {
		returnObj.errormessages.push('Network area mapping not found');
		return returnObj;
	}

	var updateObj = {};
	if (formObj.areatag !== undefined) updateObj.areatag = formObj.areatag.trim();
	if (formObj.active  !== undefined) updateObj.active  = (formObj.active === 'true' || formObj.active === true);

	if (Object.keys(updateObj).length === 0) {
		returnObj.errormessages.push('No updatable fields provided');
		return returnObj;
	}

	updateObj.updated_at = new Date();
	if (formObj.updatedByUUID) updateObj.updated_by_uuid = formObj.updatedByUUID;
	if (formObj.updatedByName) updateObj.updated_by_name = formObj.updatedByName;

	var count = await postgres.updateById(existing.id, updateObj, 'network_areas');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	await invalidateNetworkAreaCache(networkId);
	alogger.writeAlog(5, 'Network area updated: network ' + networkId + ' / area ' + areaId, 'greenbright');
	returnObj.status = true;
	return returnObj;
}

// --- Read operations ---

async function getAreasByNetwork(networkId) {
	var dblist = await postgres.query(
		`SELECT na.*, ma.name AS area_name, ma.shortcode, ma.description, ma.active AS area_active
		 FROM network_areas na
		 JOIN message_areas ma ON ma.id = na.area_id
		 WHERE na.network_id = $1
		 ORDER BY na.areatag ASC`,
		[parseInt(networkId)]
	);
	return dblist || [];
}

async function getNetworksByArea(areaId) {
	var dblist = await postgres.query(
		`SELECT na.*, mn.name AS network_name, mn.domain, mn.network_type, mn.active AS network_active
		 FROM network_areas na
		 JOIN message_networks mn ON mn.id = na.network_id
		 WHERE na.area_id = $1
		 ORDER BY mn.name ASC`,
		[parseInt(areaId)]
	);
	return dblist || [];
}

async function getNetworkArea(networkId, areaId) {
	var dbres = await postgres.queryOne(
		'SELECT * FROM network_areas WHERE network_id = $1 AND area_id = $2',
		[parseInt(networkId), parseInt(areaId)]
	);
	return dbres;
}

async function getNetworkAreaById(id) {
	var dbres = await postgres.queryOne(
		'SELECT * FROM network_areas WHERE id = $1',
		[parseInt(id)]
	);
	return dbres;
}

async function getCachedAreasByNetwork(networkId) {
	return await redis.cacheThrough(
		CACHE_NS,
		String(networkId),
		() => getAreasByNetwork(networkId),
		CACHE_TTL
	);
}

// --- Cache ---

async function invalidateNetworkAreaCache(networkId) {
	await redis.cacheInvalidate(CACHE_NS, String(networkId));
}

export {
	addAreaToNetwork,
	removeAreaFromNetwork,
	updateNetworkArea,
	getAreasByNetwork,
	getNetworksByArea,
	getNetworkArea,
	getNetworkAreaById,
	getCachedAreasByNetwork,
	invalidateNetworkAreaCache
};
