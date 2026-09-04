// imports

// internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';


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

			// Start at the area head, not 0. A new link gets traffic from now
			// on, not the entire backlog. resetOutboundIdx is the explicit way
			// to rewind and resend history.
			var startIdx = await headIdForAreaId(id);

			var insertObj = {
				peer_connection_id: connId,
				area_id: id,
				allowed: field === 'allowed' ? true : false,
				enabled: field === 'enabled' ? true : false,
				msg_idx: startIdx,
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
		`SELECT na.area_id, ma.shortcode
		 FROM network_areas na
		 JOIN message_areas ma ON ma.id = na.area_id
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
		// Start at the area head so a newly linked connection does not inherit
		// the whole backlog. See the note in setSubscriptions.
		var startIdx = row.shortcode
			? await headIdForShortcode(row.shortcode).catch(function () { return 0; })
			: await headIdForAreaId(row.area_id);

		var insertObj = {
			peer_connection_id: connId,
			area_id: row.area_id,
			allowed: false,
			enabled: false,
			msg_idx: startIdx,
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

// Sets allowed = true for all areas currently on a network for a given connection.
// Called when a new connection is created so it starts with all network areas allowed.
async function allowAllNetworkAreas(connectionId, networkId) {
	var connId = parseInt(connectionId);
	var netId  = parseInt(networkId);
	var currtime = new Date();

	try {
		var result = await postgres.write(
			`UPDATE peer_area_subscriptions pas
			 SET allowed = true, updated_at = $1
			 FROM network_areas na
			 WHERE pas.peer_connection_id = $2
			   AND pas.area_id = na.area_id
			   AND na.network_id = $3
			   AND na.active = true`,
			[currtime, connId, netId]
		);
		alogger.writeAlog(5,
			'allowAllNetworkAreas: set allowed on all network areas for connection ' + connId,
			'greenbright'
		);
	} catch (err) {
		alogger.writeAlog(3,
			'allowAllNetworkAreas: failed for connection ' + connId + ': ' + err.message,
			'redbright'
		);
	}
}

// Syncs all connections on a network so they have a subscription row for a
// newly added area, then optionally sets allowed/enabled on that area for
// all connections.
//
// options:
//   allowAll  — if true, set allowed = true for this area on all connections
//   enableAll — if true, set enabled = true for this area on all connections
async function syncNetworkAreaToConnections(networkId, areaId, options) {
	var netId   = parseInt(networkId);
	var aid     = parseInt(areaId);
	var opts    = options || {};
	var currtime = new Date();

	var peerConnections = await getPeerConnections();

	// Get all connections on this network
	var connRows = await postgres.query(
		'SELECT id FROM peer_connections WHERE network_id = $1 AND active = true',
		[netId]
	);
	if (!connRows || connRows.length === 0) return;

	for (var row of connRows) {
		// Ensure subscription row exists
		await syncConnectionToNetwork(row.id);

		// Set allowed/enabled if requested
		if (opts.allowAll || opts.enableAll) {
			var setClauses = ['updated_at = $1'];
			if (opts.allowAll)  setClauses.push('allowed = true');
			if (opts.enableAll) setClauses.push('enabled = true');

			try {
				await postgres.write(
					'UPDATE peer_area_subscriptions SET ' + setClauses.join(', ') +
					' WHERE peer_connection_id = $2 AND area_id = $3',
					[currtime, row.id, aid]
				);
			} catch (err) {
				alogger.writeAlog(3,
					'syncNetworkAreaToConnections: failed to update connection ' +
					row.id + ' area ' + aid + ': ' + err.message,
					'redbright'
				);
			}
		}
	}

	alogger.writeAlog(5,
		'syncNetworkAreaToConnections: synced area ' + aid + ' to ' +
		connRows.length + ' connection(s) on network ' + netId +
		(opts.allowAll ? ' [allowed]' : '') + (opts.enableAll ? ' [enabled]' : ''),
		'greenbright'
	);
}

// Removes subscription rows for a specific area from all connections on a network.
// Called when an area is removed from a network so that orphaned allowed/enabled
// rows don't linger.
async function removeSubscriptionsForNetworkArea(networkId, areaId) {
	var netId = parseInt(networkId);
	var aid   = parseInt(areaId);

	try {
		await postgres.write(
			`DELETE FROM peer_area_subscriptions
			 WHERE area_id = $1
			   AND peer_connection_id IN (
			     SELECT id FROM peer_connections WHERE network_id = $2
			   )`,
			[aid, netId]
		);
		alogger.writeAlog(5,
			'removeSubscriptionsForNetworkArea: cleaned up subscriptions for area ' +
			aid + ' on network ' + netId,
			'greenbright'
		);
	} catch (err) {
		alogger.writeAlog(3,
			'removeSubscriptionsForNetworkArea: failed for area ' + aid +
			' on network ' + netId + ': ' + err.message,
			'redbright'
		);
	}
}

// Reset outbound msg_idx for a peer connection so the next toss cycle
// rescans from the beginning.  Protocol-agnostic — works for FTN, QWK, NNTP.
// Optionally targets a single area; defaults to all areas on the connection.
async function resetOutboundIdx(peerConnectionUUID, areaId) {
	var peerConnections = await getPeerConnections();
	var dbconn = await peerConnections.getConnectionByUUID(peerConnectionUUID);
	if (!dbconn) return { status: false, errormessages: ['Connection not found'] };

	var sql    = 'UPDATE peer_area_subscriptions SET msg_idx = 0 WHERE peer_connection_id = $1';
	var params = [dbconn.id];

	if (areaId) {
		sql    += ' AND area_id = $2';
		params.push(parseInt(areaId));
	}

	var err = await postgres.write(sql, params);
	if (err) {
		alogger.writeAlog(3,
			'resetOutboundIdx: failed for ' + peerConnectionUUID + ': ' + err.message,
			'redbright'
		);
		return { status: false, errormessages: [err.message] };
	}

	alogger.writeAlog(5,
		'resetOutboundIdx: reset msg_idx for connection ' + peerConnectionUUID +
		(areaId ? ' area ' + areaId : ' all areas'),
		'greenbright'
	);
	return { status: true, errormessages: [] };
}

// --- Outbound high water mark helpers ---

// Backing message table for an area shortcode. Shortcodes are admin-controlled,
// but this name is interpolated into SQL, so validate it the same way
// postgres.js validates identifiers.
var validShortcodeRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function msgTableForShortcode(shortcode) {
	var shorty = String(shortcode || '').toLowerCase().trim();
	if (!validShortcodeRegex.test(shorty)) {
		throw new Error('Invalid area shortcode: ' + shortcode);
	}
	return 'mb_' + shorty + '_msgs';
}

// Highest message id currently in an area, or 0 when the area is empty.
async function headIdForShortcode(shortcode) {
	var row = await postgres.queryOne(
		'SELECT COALESCE(MAX(id), 0) AS head FROM ' + msgTableForShortcode(shortcode)
	);
	return row ? parseInt(row.head) : 0;
}

async function headIdForAreaId(areaId) {
	var row = await postgres.queryOne(
		'SELECT shortcode FROM message_areas WHERE id = $1',
		[parseInt(areaId)]
	);
	if (!row || !row.shortcode) return 0;
	try {
		return await headIdForShortcode(row.shortcode);
	} catch (err) {
		alogger.writeAlog(3, 'headIdForAreaId: ' + err.message, 'yellow');
		return 0;
	}
}

// Advance the outbound high water mark for every subscription on an area so
// downstream peers treat everything currently in it as already sent. This is
// the mirror of resetOutboundIdx, which rewinds to 0 to force a resend.
//
// Only subscriptions at or past minIdx are moved. A peer that was already
// behind before an import keeps its position, because a single high water mark
// cannot express "send the old backlog but skip the middle". Suppression for
// those peers relies on source_network_id instead, which
// getOutboundForConnection checks per message.
//
// Passing minIdx as the area head recorded before an import therefore moves
// exactly the peers that were caught up at that moment.
async function advanceOutboundIdxForArea(areaId, shortcode, minIdx) {
	var aid = parseInt(areaId);
	var head;

	try {
		head = await headIdForShortcode(shortcode);
	} catch (err) {
		return { status: false, updated: 0, head: 0, errormessages: [err.message] };
	}

	if (!head) {
		return { status: true, updated: 0, head: 0, errormessages: [] };
	}

	var floor = (minIdx === undefined || minIdx === null) ? 0 : parseInt(minIdx);

	var rows = await postgres.query(
		`UPDATE peer_area_subscriptions
		 SET msg_idx = $1, updated_at = NOW()
		 WHERE area_id = $2 AND msg_idx >= $3 AND msg_idx < $1
		 RETURNING id`,
		[head, aid, floor]
	);

	var updated = rows ? rows.length : 0;
	alogger.writeAlog(4,
		'advanceOutboundIdxForArea: area ' + aid + ' head ' + head +
		', advanced ' + updated + ' subscription(s) from >= ' + floor,
		'cyan'
	);

	return { status: true, updated: updated, head: head, errormessages: [] };
}

export {
	getSubscriptionsByConnection,
	getEnabledByConnection,
	getAllowedByConnection,
	setSubscriptions,
	syncConnectionToNetwork,
	allowAllNetworkAreas,
	syncNetworkAreaToConnections,
	removeSubscriptionsForNetworkArea,
	resetOutboundIdx,
	advanceOutboundIdxForArea,
	headIdForShortcode,
	headIdForAreaId
};
