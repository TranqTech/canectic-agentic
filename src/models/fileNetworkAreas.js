// fileNetworkAreas.js — Maps file areas to networks with file echo areatags
// Analogous to networkAreas.js for the message system.
// Used by the TIC tosser to resolve inbound areatags to local file areas,
// and to look up the areatag when building outbound TIC descriptors.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Resolve a file echo areatag to a file_area on a given network.
 * Returns the file_area row joined with the network mapping, or null.
 */
async function getAreaByTag(networkId, areatag) {
	var row = await postgres.queryOne(
		`SELECT fna.*, fa.name AS area_name, fa.shortcode, fa.description,
		        fa.group_id, fa.group_shortcode, fa.sub_dir,
		        fa.file_count, fa.active AS area_active
		 FROM file_network_areas fna
		 JOIN file_areas fa ON fa.id = fna.area_id
		 WHERE fna.network_id = $1 AND UPPER(fna.areatag) = UPPER($2)
		   AND fna.active = true`,
		[parseInt(networkId), areatag.toUpperCase().trim()]
	);
	return row || null;
}

/**
 * Get all network mappings for a given file area.
 */
async function getNetworksByFileArea(areaId) {
	var rows = await postgres.query(
		`SELECT fna.*, mn.name AS network_name, mn.domain, mn.network_type
		 FROM file_network_areas fna
		 JOIN message_networks mn ON mn.id = fna.network_id
		 WHERE fna.area_id = $1
		 ORDER BY mn.name ASC`,
		[parseInt(areaId)]
	);
	return rows || [];
}

/**
 * Get all file area mappings for a given network.
 */
async function getMappingsForNetwork(networkId) {
	var rows = await postgres.query(
		`SELECT fna.*, fa.name AS area_name, fa.shortcode, fa.description, fa.active AS area_active
		 FROM file_network_areas fna
		 JOIN file_areas fa ON fa.id = fna.area_id
		 WHERE fna.network_id = $1
		 ORDER BY fna.areatag ASC`,
		[parseInt(networkId)]
	);
	return rows || [];
}

/**
 * Get a single mapping by network + area (for checking existence).
 */
async function getMapping(networkId, areaId) {
	var row = await postgres.queryOne(
		'SELECT * FROM file_network_areas WHERE network_id = $1 AND area_id = $2',
		[parseInt(networkId), parseInt(areaId)]
	);
	return row || null;
}

/**
 * Get a single mapping by its primary key id.
 */
async function getMappingById(id) {
	var row = await postgres.queryOne(
		`SELECT fna.*, fa.name AS area_name, fa.shortcode
		 FROM file_network_areas fna
		 JOIN file_areas fa ON fa.id = fna.area_id
		 WHERE fna.id = $1`,
		[parseInt(id)]
	);
	return row || null;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Create a new file network area mapping.
 */
async function addMapping(networkId, areaId, areatag, formObj) {
	var returnObj = { status: false, errormessages: [] };

	if (!networkId) returnObj.errormessages.push('network_id is required');
	if (!areaId) returnObj.errormessages.push('area_id is required');
	if (!areatag) returnObj.errormessages.push('areatag is required');
	if (returnObj.errormessages.length > 0) return returnObj;

	var netId = parseInt(networkId);
	var aid = parseInt(areaId);
	var tag = areatag.toUpperCase().trim();
	var now = new Date();

	// Check for duplicate mapping
	var existing = await getMapping(netId, aid);
	if (existing) {
		returnObj.errormessages.push('Mapping already exists for this network and file area');
		return returnObj;
	}

	// Check for duplicate areatag on the same network
	var tagCheck = await getAreaByTag(netId, tag);
	if (tagCheck) {
		returnObj.errormessages.push('Areatag ' + tag + ' is already mapped on this network');
		return returnObj;
	}

	var pgObj = {
		network_id: netId,
		area_id: aid,
		areatag: tag,
		active: true,
		created_at: now,
		updated_at: now,
		created_by_uuid: (formObj && formObj.createdByUUID) || '1',
		created_by_name: (formObj && formObj.createdByName) || '1',
		updated_by_uuid: (formObj && formObj.updatedByUUID) || '1',
		updated_by_name: (formObj && formObj.updatedByName) || '1'
	};

	var dbres = await postgres.insertObject(pgObj, 'file_network_areas');
	if (dbres.status === true) {
		returnObj.status = true;
		returnObj.insertId = dbres.insertId;
		alogger.writeAlog(5, 'fileNetworkAreas: mapped ' + tag + ' to area ' + aid + ' on network ' + netId, 'greenbright');
		// Sync filebone local_area_id
		try {
			var fileEcholist = await import('./fileEcholist.js');
			await fileEcholist.syncLocalAreaId(netId, aid, tag, 'add');
		} catch (e) { /* filebone sync is non-critical */ }
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

/**
 * Remove a file network area mapping.
 */
async function removeMapping(networkId, areaId) {
	var netId = parseInt(networkId);
	var aid = parseInt(areaId);

	// Look up areatag before deleting (needed for filebone sync)
	var existing = await getMapping(netId, aid);
	var areatag = existing ? existing.areatag : null;

	var err = await postgres.write(
		'DELETE FROM file_network_areas WHERE network_id = $1 AND area_id = $2',
		[netId, aid]
	);

	if (err) {
		alogger.writeAlog(3, 'fileNetworkAreas: removeMapping failed: ' + err.message, 'redbright');
		return false;
	}

	alogger.writeAlog(5, 'fileNetworkAreas: removed mapping for area ' + aid + ' on network ' + netId, 'greenbright');
	// Sync filebone local_area_id
	if (areatag) {
		try {
			var fileEcholist = await import('./fileEcholist.js');
			await fileEcholist.syncLocalAreaId(netId, null, areatag, 'remove');
		} catch (e) { /* filebone sync is non-critical */ }
	}
	return true;
}

/**
 * Update areatag or active status on an existing mapping.
 */
async function updateMapping(id, updateObj) {
	var now = new Date();
	updateObj.updated_at = now;

	var count = await postgres.updateById(parseInt(id), updateObj, 'file_network_areas');
	return count > 0;
}

// File areas mapped to this network that don't appear in any active filebone
async function getOrphanedNetworkAreas(networkId) {
	return await postgres.query(
		"SELECT fna.*, fa.name AS area_name, fa.shortcode, fa.description AS area_description " +
		"FROM file_network_areas fna " +
		"JOIN file_areas fa ON fa.id = fna.area_id " +
		"WHERE fna.network_id = $1 " +
		"AND NOT EXISTS (" +
		"  SELECT 1 FROM file_echolist_areas nea " +
		"  JOIN file_echolists nel ON nel.id = nea.echolist_id " +
		"  WHERE nel.network_id = $1 AND nea.active = true " +
		"  AND UPPER(nea.areatag) = UPPER(fna.areatag)" +
		") ORDER BY fna.areatag ASC",
		[parseInt(networkId)]
	) || [];
}

export {
	getAreaByTag,
	getNetworksByFileArea,
	getMappingsForNetwork,
	getMapping,
	getMappingById,
	addMapping,
	removeMapping,
	updateMapping,
	getOrphanedNetworkAreas
};
