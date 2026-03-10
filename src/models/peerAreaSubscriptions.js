// imports
import * as dotenv from 'dotenv';

// internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

dotenv.config();

// peerConnections is imported lazily where needed to avoid the circular
// dependency: peerConnections -> peerAreaSubscriptions -> peerConnections
async function getPeerConnections() {
	var mod = await import('./peerConnections.js');
	return mod;
}

// --- Read operations ---

async function getSubscriptionsByConnection(peerConnectionId) {
	var dblist = await postgres.query(
		`SELECT pas.*, ma.name AS area_name, ma.shortcode, ma.description
		 FROM peer_area_subscriptions pas
		 JOIN message_areas ma ON ma.id = pas.area_id
		 WHERE pas.peer_connection_id = $1
		 ORDER BY ma.shortcode ASC`,
		[parseInt(peerConnectionId)]
	);
	return dblist || [];
}

async function getEnabledByConnection(peerConnectionId) {
	var dblist = await postgres.query(
		`SELECT pas.*, ma.name AS area_name, ma.shortcode, ma.description
		 FROM peer_area_subscriptions pas
		 JOIN message_areas ma ON ma.id = pas.area_id
		 WHERE pas.peer_connection_id = $1 AND pas.enabled = true
		 ORDER BY ma.shortcode ASC`,
		[parseInt(peerConnectionId)]
	);
	return dblist || [];
}

async function getAllowedByConnection(peerConnectionId) {
	var dblist = await postgres.query(
		`SELECT pas.*, ma.name AS area_name, ma.shortcode, ma.description
		 FROM peer_area_subscriptions pas
		 JOIN message_areas ma ON ma.id = pas.area_id
		 WHERE pas.peer_connection_id = $1 AND pas.allowed = true
		 ORDER BY ma.shortcode ASC`,
		[parseInt(peerConnectionId)]
	);
	return dblist || [];
}

// --- Write operations ---

// field must be 'enabled' or 'allowed'
// Listed areaIds are set true, all other rows for this connection are set false.
// Rows that don't exist yet are unexpected (should have been created by
// newConnection/syncConnectionToNetwork) — log the anomaly and upsert anyway.
// formObj is optional — pass { updatedByUUID, updatedByName } for audit trail.
async function setSubscriptions(peerConnectionId, areaIds, field, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (field !== 'enabled' && field !== 'allowed') {
		returnObj.errormessages.push('Invalid subscription field: must be "enabled" or "allowed"');
		return returnObj;
	}

	var connId = parseInt(peerConnectionId);
	var ids = Array.isArray(areaIds) ? areaIds.map(id => parseInt(id)) : [];
	var currtime = new Date();
	var updatedByUUID = formObj && formObj.updatedByUUID ? formObj.updatedByUUID : '';
	var updatedByName = formObj && formObj.updatedByName ? formObj.updatedByName : '';

	// Set all existing rows for this connection to false first
	var clearErr = await postgres.write(
		`UPDATE peer_area_subscriptions SET ${field} = false, updated_at = $1,
		 updated_by_uuid = $2, updated_by_name = $3
		 WHERE peer_connection_id = $4`,
		[currtime, updatedByUUID, updatedByName, connId]
	);
	if (clearErr) {
		alogger.writeAlog(3, 'setSubscriptions: failed to clear ' + field + ' for connection ' + connId + ': ' + clearErr.message, 'redbright');
		returnObj.errormessages.push('Failed to clear existing subscriptions: ' + clearErr.message);
		return returnObj;
	}

	if (ids.length === 0) {
		returnObj.status = true;
		return returnObj;
	}

	// Check which of the requested areaIds already have rows
	var existingRows = await postgres.query(
		`SELECT area_id FROM peer_area_subscriptions
		 WHERE peer_connection_id = $1 AND area_id = ANY($2)`,
		[connId, ids]
	);
	var existingAreaIds = new Set(existingRows.map(r => r.area_id));

	// Any areaId not already present is an anomaly — log it then upsert
	for (var id of ids) {
		if (!existingAreaIds.has(id)) {
			alogger.writeAlog(3,
				'setSubscriptions: subscription row missing for connection ' + connId +
				' / area ' + id + ' — expected to exist from newConnection or ' +
				'syncConnectionToNetwork; upserting now',
				'redbright'
			);

			var insertObj = {
				peer_connection_id: connId,
				area_id: id,
				allowed: field === 'allowed' ? true : false,
				enabled: field === 'enabled' ? true : false,
				created_at: currtime,
				updated_at: currtime,
				created_by_uuid: '1',
				created_by_name: '1',
				updated_by_uuid: updatedByUUID || '1',
				updated_by_name: updatedByName || '1'
			};

			var dbres = await postgres.insertObject(insertObj, 'peer_area_subscriptions');
			if (!dbres.status) {
				alogger.writeAlog(3,
					'setSubscriptions: upsert failed for connection ' + connId +
					' / area ' + id + ': ' + (dbres.errormessages.join(', ')),
					'redbright'
				);
				returnObj.errormessages.push('Failed to upsert subscription for area ' + id);
			}
		}
	}

	// Set the field to true for all rows that do exist
	var existingToSet = ids.filter(id => existingAreaIds.has(id));
	if (existingToSet.length > 0) {
		var setErr = await postgres.write(
			`UPDATE peer_area_subscriptions SET ${field} = true, updated_at = $1,
			 updated_by_uuid = $2, updated_by_name = $3
			 WHERE peer_connection_id = $4 AND area_id = ANY($5)`,
			[currtime, updatedByUUID, updatedByName, connId, existingToSet]
		);
		if (setErr) {
			alogger.writeAlog(3, 'setSubscriptions: failed to set ' + field + ' = true for connection ' + connId + ': ' + setErr.message, 'redbright');
			returnObj.errormessages.push('Failed to set subscriptions: ' + setErr.message);
			return returnObj;
		}
	}

	if (returnObj.errormessages.length === 0) {
		returnObj.status = true;
	}
	return returnObj;
}

// Creates subscription rows for any network_areas entries that don't yet have
// a row in peer_area_subscriptions for this connection. Called when a new area
// is added to a network that already has connections, and on newConnection to
// bootstrap all rows.
async function syncConnectionToNetwork(peerConnectionId) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var connId = parseInt(peerConnectionId);

	// Resolve the connection to get its network_id
	var peerConnections = await getPeerConnections();
	var dbconn = await peerConnections.getConnectionById(connId);
	if (!dbconn) {
		returnObj.errormessages.push('Connection not found: ' + connId);
		return returnObj;
	}

	// Find all network_areas rows for this network that don't yet have a
	// subscription row for this connection
	var missing = await postgres.query(
		`SELECT na.area_id
		 FROM network_areas na
		 WHERE na.network_id = $1
		   AND NOT EXISTS (
		     SELECT 1 FROM peer_area_subscriptions pas
		     WHERE pas.peer_connection_id = $2
		       AND pas.area_id = na.area_id
		   )`,
		[dbconn.network_id, connId]
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
			area_id: row.area_id,
			allowed: false,
			enabled: false,
			created_at: currtime,
			updated_at: currtime,
			created_by_uuid: '1',
			created_by_name: '1',
			updated_by_uuid: '1',
			updated_by_name: '1'
		};

		var dbres = await postgres.insertObject(insertObj, 'peer_area_subscriptions');
		if (!dbres.status) {
			alogger.writeAlog(3,
				'syncConnectionToNetwork: failed to create subscription for connection ' +
				connId + ' / area ' + row.area_id + ': ' + dbres.errormessages.join(', '),
				'redbright'
			);
			errors.push('area ' + row.area_id);
		}
	}

	if (errors.length > 0) {
		returnObj.errormessages.push('Failed to create subscriptions for: ' + errors.join(', '));
		return returnObj;
	}

	alogger.writeAlog(5,
		'syncConnectionToNetwork: created ' + missing.length + ' subscription row(s) for connection ' + connId,
		'greenbright'
	);
	returnObj.status = true;
	return returnObj;
}

export {
	getSubscriptionsByConnection,
	getEnabledByConnection,
	getAllowedByConnection,
	setSubscriptions,
	syncConnectionToNetwork
};
