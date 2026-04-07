// filePeerSubscriptions.js — Per-connection subscription state for file areas
// Analogous to peerAreaSubscriptions.js for message areas.
// Controls which file areas each peer connection is allowed to send/receive.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// Lazy import to avoid circular dependency
async function getPeerConnections() {
	var mod = await import('./peerConnections.js');
	return mod;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get all subscriptions for a peer connection (joined with file area info).
 */
async function getSubscriptionsByConnection(peerConnectionId) {
	var rows = await postgres.query(
		`SELECT fps.*, fa.name AS area_name, fa.shortcode, fa.description
		 FROM file_peer_subscriptions fps
		 JOIN file_areas fa ON fa.id = fps.file_area_id
		 WHERE fps.peer_connection_id = $1
		 ORDER BY fa.shortcode ASC`,
		[parseInt(peerConnectionId)]
	);
	return rows || [];
}

/**
 * Get all peer connections subscribed (allowed AND enabled) to a file area.
 * Returns peer_connection rows joined with connection details.
 */
async function getSubscribedConnections(fileAreaId) {
	var rows = await postgres.query(
		`SELECT fps.peer_connection_id, pc.uuid AS connection_uuid,
		        pc.peer_id, pc.network_id, pc.active AS connection_active,
		        pc.connection_data,
		        p.name AS peer_name, p.sysop_name
		 FROM file_peer_subscriptions fps
		 JOIN peer_connections pc ON pc.id = fps.peer_connection_id
		 JOIN peers p ON p.id = pc.peer_id
		 WHERE fps.file_area_id = $1
		   AND fps.allowed = true AND fps.enabled = true
		   AND pc.active = true`,
		[parseInt(fileAreaId)]
	);
	return rows || [];
}

/**
 * Check if a specific connection is subscribed (allowed AND enabled) to a file area.
 */
async function isSubscribed(peerConnectionId, fileAreaId) {
	var row = await postgres.queryOne(
		`SELECT id FROM file_peer_subscriptions
		 WHERE peer_connection_id = $1 AND file_area_id = $2
		   AND allowed = true AND enabled = true`,
		[parseInt(peerConnectionId), parseInt(fileAreaId)]
	);
	return !!row;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Bulk toggle allowed/enabled for a connection's file area subscriptions.
 * Listed areaIds are set true, all other rows for this connection are set false.
 * Same pattern as peerAreaSubscriptions.setSubscriptions().
 */
async function setSubscriptions(peerConnectionId, areaIds, field, formObj) {
	var returnObj = { status: false, errormessages: [] };

	if (field !== 'enabled' && field !== 'allowed') {
		returnObj.errormessages.push('Invalid subscription field: must be "enabled" or "allowed"');
		return returnObj;
	}

	var connId = parseInt(peerConnectionId);
	var ids = Array.isArray(areaIds) ? areaIds.map(function(id) { return parseInt(id); }) : [];
	var currtime = new Date();
	var updatedByUUID = (formObj && formObj.updatedByUUID) ? formObj.updatedByUUID : '';
	var updatedByName = (formObj && formObj.updatedByName) ? formObj.updatedByName : '';

	// Clear all existing rows for this connection
	var clearErr = await postgres.write(
		`UPDATE file_peer_subscriptions SET ${field} = false, updated_at = $1,
		 updated_by_uuid = $2, updated_by_name = $3
		 WHERE peer_connection_id = $4`,
		[currtime, updatedByUUID, updatedByName, connId]
	);
	if (clearErr) {
		alogger.writeAlog(3, 'filePeerSubs.setSubscriptions: clear failed: ' + clearErr.message, 'redbright');
		returnObj.errormessages.push('Failed to clear existing subscriptions: ' + clearErr.message);
		return returnObj;
	}

	if (ids.length === 0) {
		returnObj.status = true;
		return returnObj;
	}

	// Check which requested areaIds already have rows
	var existingRows = await postgres.query(
		'SELECT file_area_id FROM file_peer_subscriptions WHERE peer_connection_id = $1 AND file_area_id = ANY($2)',
		[connId, ids]
	);
	var existingAreaIds = new Set(existingRows.map(function(r) { return r.file_area_id; }));

	// Upsert any missing rows
	for (var id of ids) {
		if (!existingAreaIds.has(id)) {
			alogger.writeAlog(3,
				'filePeerSubs.setSubscriptions: missing row for connection ' + connId +
				' / file_area ' + id + ' — upserting', 'redbright'
			);
			var insertObj = {
				peer_connection_id: connId,
				file_area_id: id,
				allowed: field === 'allowed' ? true : false,
				enabled: field === 'enabled' ? true : false,
				created_at: currtime,
				updated_at: currtime,
				created_by_uuid: '1',
				created_by_name: '1',
				updated_by_uuid: updatedByUUID || '1',
				updated_by_name: updatedByName || '1'
			};
			await postgres.insertObject(insertObj, 'file_peer_subscriptions');
		}
	}

	// Set the field to true for existing rows
	var existingToSet = ids.filter(function(id) { return existingAreaIds.has(id); });
	if (existingToSet.length > 0) {
		var setErr = await postgres.write(
			`UPDATE file_peer_subscriptions SET ${field} = true, updated_at = $1,
			 updated_by_uuid = $2, updated_by_name = $3
			 WHERE peer_connection_id = $4 AND file_area_id = ANY($5)`,
			[currtime, updatedByUUID, updatedByName, connId, existingToSet]
		);
		if (setErr) {
			returnObj.errormessages.push('Failed to set subscriptions: ' + setErr.message);
			return returnObj;
		}
	}

	if (returnObj.errormessages.length === 0) {
		returnObj.status = true;
	}
	return returnObj;
}

/**
 * Bootstrap subscription rows for a connection.
 * Creates file_peer_subscriptions rows for any file_network_areas entries
 * that don't yet have a row for this connection.
 * Same pattern as peerAreaSubscriptions.syncConnectionToNetwork().
 */
async function syncConnectionToFileAreas(peerConnectionId, networkId) {
	var returnObj = { status: false, errormessages: [] };

	var connId = parseInt(peerConnectionId);
	var netId = parseInt(networkId);

	// Find all file_network_areas on this network missing subscription rows
	var missing = await postgres.query(
		`SELECT fna.area_id AS file_area_id
		 FROM file_network_areas fna
		 WHERE fna.network_id = $1 AND fna.active = true
		   AND NOT EXISTS (
		     SELECT 1 FROM file_peer_subscriptions fps
		     WHERE fps.peer_connection_id = $2
		       AND fps.file_area_id = fna.area_id
		   )`,
		[netId, connId]
	);

	if (missing.length === 0) {
		returnObj.status = true;
		return returnObj;
	}

	var currtime = new Date();
	var errors = [];

	for (var row of missing) {
		var insertObj = {
			peer_connection_id: connId,
			file_area_id: row.file_area_id,
			allowed: false,
			enabled: false,
			created_at: currtime,
			updated_at: currtime,
			created_by_uuid: '1',
			created_by_name: '1',
			updated_by_uuid: '1',
			updated_by_name: '1'
		};

		var dbres = await postgres.insertObject(insertObj, 'file_peer_subscriptions');
		if (!dbres.status) {
			errors.push('file_area ' + row.file_area_id);
		}
	}

	if (errors.length > 0) {
		returnObj.errormessages.push('Failed to create subscriptions for: ' + errors.join(', '));
		return returnObj;
	}

	alogger.writeAlog(5,
		'filePeerSubs.syncConnectionToFileAreas: created ' + missing.length +
		' row(s) for connection ' + connId, 'greenbright'
	);
	returnObj.status = true;
	return returnObj;
}

/**
 * Allow all active file areas on a network for a given connection.
 */
async function allowAllFileAreas(peerConnectionId, networkId) {
	var connId = parseInt(peerConnectionId);
	var netId = parseInt(networkId);
	var currtime = new Date();

	try {
		await postgres.write(
			`UPDATE file_peer_subscriptions fps
			 SET allowed = true, updated_at = $1
			 FROM file_network_areas fna
			 WHERE fps.peer_connection_id = $2
			   AND fps.file_area_id = fna.area_id
			   AND fna.network_id = $3
			   AND fna.active = true`,
			[currtime, connId, netId]
		);
		alogger.writeAlog(5,
			'filePeerSubs.allowAllFileAreas: allowed all for connection ' + connId, 'greenbright'
		);
	} catch (err) {
		alogger.writeAlog(3,
			'filePeerSubs.allowAllFileAreas: failed for connection ' + connId + ': ' + err.message, 'redbright'
		);
	}
}

/**
 * Enable all allowed file areas for a given connection.
 */
async function enableAllAllowed(peerConnectionId) {
	var connId = parseInt(peerConnectionId);
	var currtime = new Date();

	var err = await postgres.write(
		'UPDATE file_peer_subscriptions SET enabled = true, updated_at = $1 WHERE peer_connection_id = $2 AND allowed = true',
		[currtime, connId]
	);
	if (err) {
		alogger.writeAlog(3, 'filePeerSubs.enableAllAllowed: failed: ' + err.message, 'redbright');
	}
}

/**
 * Sync a newly-added file area to ALL connections on a network.
 * Creates missing subscription rows and optionally sets allowed/enabled.
 * Mirrors peerAreaSubscriptions.syncNetworkAreaToConnections().
 */
async function syncFileAreaToConnections(networkId, fileAreaId, options) {
	var netId    = parseInt(networkId);
	var faId     = parseInt(fileAreaId);
	var opts     = options || {};
	var currtime = new Date();

	// Get all connections on this network
	var connRows = await postgres.query(
		'SELECT id FROM peer_connections WHERE network_id = $1 AND active = true',
		[netId]
	);
	if (!connRows || connRows.length === 0) return;

	for (var row of connRows) {
		// Ensure subscription row exists
		await syncConnectionToFileAreas(row.id, netId);

		// Set allowed/enabled if requested
		if (opts.allowAll || opts.enableAll) {
			var setClauses = ['updated_at = $1'];
			if (opts.allowAll)  setClauses.push('allowed = true');
			if (opts.enableAll) setClauses.push('enabled = true');

			var sql = 'UPDATE file_peer_subscriptions SET ' + setClauses.join(', ') +
				' WHERE peer_connection_id = $2 AND file_area_id = $3';
			alogger.writeAlog(5,
				'filePeerSubs.syncFileAreaToConnections: ' + sql +
				' [' + currtime.toISOString() + ', ' + row.id + ', ' + faId + ']' +
				' opts=' + JSON.stringify(opts),
				'cyan'
			);

			try {
				var writeResult = await postgres.pgpool.query(sql, [currtime, row.id, faId]);
				alogger.writeAlog(5,
					'filePeerSubs.syncFileAreaToConnections: UPDATE rowCount=' + writeResult.rowCount +
					' for connection ' + row.id + ' file_area ' + faId,
					writeResult.rowCount > 0 ? 'greenbright' : 'yellow'
				);
			} catch (err) {
				alogger.writeAlog(3,
					'filePeerSubs.syncFileAreaToConnections: failed to update connection ' +
					row.id + ' file_area ' + faId + ': ' + err.message,
					'redbright'
				);
			}
		}
	}

	alogger.writeAlog(5,
		'filePeerSubs.syncFileAreaToConnections: synced file_area ' + faId + ' to ' +
		connRows.length + ' connection(s) on network ' + netId +
		(opts.allowAll ? ' [allowed]' : '') + (opts.enableAll ? ' [enabled]' : ''),
		'greenbright'
	);
}

/**
 * Remove subscription rows for a specific file area from all connections on a network.
 * Called when a file area is removed from a network.
 */
async function removeSubscriptionsForFileArea(networkId, fileAreaId) {
	var netId = parseInt(networkId);
	var faId  = parseInt(fileAreaId);

	try {
		await postgres.write(
			`DELETE FROM file_peer_subscriptions
			 WHERE file_area_id = $1
			   AND peer_connection_id IN (
			     SELECT id FROM peer_connections WHERE network_id = $2
			   )`,
			[faId, netId]
		);
		alogger.writeAlog(5,
			'filePeerSubs.removeSubscriptionsForFileArea: cleaned up subscriptions for file_area ' +
			faId + ' on network ' + netId,
			'greenbright'
		);
	} catch (err) {
		alogger.writeAlog(3,
			'filePeerSubs.removeSubscriptionsForFileArea: failed for file_area ' + faId +
			' on network ' + netId + ': ' + err.message,
			'redbright'
		);
	}
}

export {
	getSubscriptionsByConnection,
	getSubscribedConnections,
	isSubscribed,
	setSubscriptions,
	syncConnectionToFileAreas,
	allowAllFileAreas,
	enableAllAllowed,
	syncFileAreaToConnections,
	removeSubscriptionsForFileArea
};
