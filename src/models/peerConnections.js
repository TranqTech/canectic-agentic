// imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

// internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as msgNetworks from './msgNetworks.js';
import * as networkAreas from './networkAreas.js';
import * as peerAreaSubscriptions from './peerAreaSubscriptions.js';
import * as systemAddresses from './systemAddresses.js';

// peers is imported lazily to avoid any future circular risk as the
// peer/connection graph grows
async function getPeers() {
	var mod = await import('./peers.js');
	return mod;
}

dotenv.config();

const VALID_FTN_STATUS = ['NORMAL', 'CRASH', 'HOLD'];

// --- connection_data builders ---
// Assemble a clean, fully-defaulted connection_data object from raw form input
// based on the network's type. Unknown types get an empty object.

function buildConnectionData(networkType, formObj) {
	switch (networkType) {
		case 'FTN': {
			// Form fields use ftn_ prefix; also accept bare names for programmatic callers
			var rawAddress  = formObj.ftn_address          || formObj.address          || '';
			var rawStatus   = formObj.ftn_status           || formObj.status           || '';
			var rawRouteTo  = formObj.ftn_route_to         || formObj.route_to         || '';
			var rawHost     = formObj.ftn_remote_host      || formObj.remote_host      || '';
			var rawPort     = formObj.ftn_remote_port      || formObj.remote_port      || null;
			var rawDirect   = formObj.ftn_direct           !== undefined ? formObj.ftn_direct   : formObj.direct;
			var rawSessPw   = formObj.ftn_session_password || formObj.session_password || '';
			var rawPktPw    = formObj.ftn_packet_password  || formObj.packet_password  || '';
			var rawTicPw    = formObj.ftn_tic_password     || formObj.tic_password     || '';
			var rawAreafix  = formObj.ftn_areafix_password || formObj.areafix_password || '';
			// routing_rules: comma-separated string from form, or pre-built array from code
			var rawRules    = formObj.ftn_routing_rules !== undefined
				? formObj.ftn_routing_rules
				: formObj.routing_rules;
			var routingRules = [];
			if (Array.isArray(rawRules)) {
				routingRules = rawRules.map(r => r.trim()).filter(Boolean);
			} else if (typeof rawRules === 'string' && rawRules.trim()) {
				routingRules = rawRules.split(',').map(r => r.trim()).filter(Boolean);
			}
			var status = 'NORMAL';
			if (rawStatus && VALID_FTN_STATUS.includes(rawStatus.toUpperCase().trim())) {
				status = rawStatus.toUpperCase().trim();
			}
			return {
				address:          rawAddress  ? rawAddress.trim()        : '',
				direct:           rawDirect !== 'No' && rawDirect !== false ? true : false,
				route_to:         rawRouteTo  ? rawRouteTo.trim()        : '',
				routing_rules:    routingRules,
				status:           status,
				remote_host:      rawHost     ? rawHost.trim()           : '',
				remote_port:      rawPort     ? parseInt(rawPort)        : null,
				session_password: rawSessPw   ? rawSessPw.trim()         : '',
				packet_password:  rawPktPw    ? rawPktPw.trim()          : '',
				tic_password:     rawTicPw    ? rawTicPw.trim()          : '',
				areafix_password: rawAreafix  ? rawAreafix.trim()        : ''
			};
		}
		case 'NNTP': {
			var nHost     = formObj.nntp_host                  || formObj.host                  || '';
			var nPort     = formObj.nntp_port                  || formObj.port                  || 119;
			var nTls      = formObj.nntp_use_tls               !== undefined ? formObj.nntp_use_tls : formObj.use_tls;
			var nUser     = formObj.nntp_username              || formObj.username              || '';
			var nPass     = formObj.nntp_password              || formObj.password              || '';
			var nInterval = formObj.nntp_pull_interval_minutes || formObj.pull_interval_minutes || 60;
			return {
				host:                  nHost     ? nHost.trim()        : '',
				port:                  nPort     ? parseInt(nPort)     : 119,
				use_tls:               nTls === 'true' || nTls === true ? true : false,
				username:              nUser     ? nUser.trim()        : '',
				password:              nPass     ? nPass.trim()        : '',
				pull_interval_minutes: nInterval ? parseInt(nInterval) : 60
			};
		}
		case 'QWK': {
			var qHost = formObj.qwk_host        || formObj.host        || '';
			var qPort = formObj.qwk_port        || formObj.port        || 21;
			var qUser = formObj.qwk_username    || formObj.username    || '';
			var qPass = formObj.qwk_password    || formObj.password    || '';
			var qPkt  = formObj.qwk_packet_name || formObj.packet_name || '';
			return {
				host:        qHost ? qHost.trim() : '',
				port:        qPort ? parseInt(qPort) : 21,
				username:    qUser ? qUser.trim() : '',
				password:    qPass ? qPass.trim() : '',
				packet_name: qPkt  ? qPkt.trim()  : ''
			};
		}
		case 'LOCAL':
		default:
			return {};
	}
}

// Safety-check connection_data against the network type.
// Returns an array of error strings (empty = valid).
function validateConnectionData(networkType, data) {
	var errors = [];
	switch (networkType) {
		case 'FTN':
			if (!data.address) {
				errors.push('FTN address cannot be empty');
			}
			if (data.status && !VALID_FTN_STATUS.includes(data.status)) {
				errors.push('Invalid FTN status: must be NORMAL, CRASH, or HOLD');
			}
			if (data.remote_port && isNaN(data.remote_port)) {
				errors.push('FTN remote_port must be a number');
			}
			break;
		case 'NNTP':
			if (!data.host) {
				errors.push('NNTP host cannot be empty');
			}
			if (data.port && isNaN(data.port)) {
				errors.push('NNTP port must be a number');
			}
			break;
		case 'QWK':
			if (!data.host) {
				errors.push('QWK host cannot be empty');
			}
			if (data.port && isNaN(data.port)) {
				errors.push('QWK port must be a number');
			}
			break;
		case 'LOCAL':
			break;
		default:
			errors.push('Unknown network type: ' + networkType);
	}
	return errors;
}

// --- Write operations ---

async function newConnection(formObj) {
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0,
		insertUUID: ''
	};

	if (!formObj.peer_id) {
		returnObj.errormessages.push('Peer ID cannot be empty');
	}
	if (!formObj.network_id) {
		returnObj.errormessages.push('Network ID cannot be empty');
	}
	if (!formObj.connection_type) {
		returnObj.errormessages.push('Connection type cannot be empty');
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	// Validate peer exists
	var peers = await getPeers();
	var dbpeer = await peers.getPeerById(parseInt(formObj.peer_id));
	if (!dbpeer) {
		returnObj.errormessages.push('Peer not found');
		return returnObj;
	}

	// Validate network exists and is active
	var dbnetwork = await msgNetworks.getNetworkById(parseInt(formObj.network_id));
	if (!dbnetwork) {
		returnObj.errormessages.push('Network not found');
		return returnObj;
	}
	if (!dbnetwork.active) {
		returnObj.errormessages.push('Network is not active');
		return returnObj;
	}

	// Build and validate connection_data for this network type
	var connectionData = buildConnectionData(dbnetwork.network_type, formObj);
	var dataErrors = validateConnectionData(dbnetwork.network_type, connectionData);
	if (dataErrors.length > 0) {
		returnObj.errormessages = returnObj.errormessages.concat(dataErrors);
		return returnObj;
	}

	// Resolve system_address_id — optional, must belong to the same network
	var systemAddressId = null;
	if (formObj.system_address_id) {
		var saId = parseInt(formObj.system_address_id);
		if (!isNaN(saId)) {
			var saCheck = await systemAddresses.getAddressById(saId);
			if (saCheck && saCheck.network_id === dbnetwork.id) {
				systemAddressId = saId;
			} else {
				returnObj.errormessages.push('Selected system address does not belong to this network');
				return returnObj;
			}
		}
	}

	var uuid = uuidv4();
	var currtime = new Date();

	var dbObj = {
		uuid:              uuid,
		peer_id:           dbpeer.id,
		network_id:        dbnetwork.id,
		connection_type:   formObj.connection_type.trim(),
		connection_data:   JSON.stringify(connectionData),
		system_address_id: systemAddressId,
		active:            true,
		created_at:        currtime,
		updated_at:        null,
		created_by_uuid:   formObj.createdByUUID || '',
		created_by_name:   formObj.createdByName || '',
		updated_by_uuid:   '',
		updated_by_name:   ''
	};

	var dbres = await postgres.insertObject(dbObj, 'peer_connections');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	returnObj.insertId   = dbres.insertId;
	returnObj.insertUUID = uuid;

	// Bootstrap subscription rows for all areas already on this network
	var syncResult = await peerAreaSubscriptions.syncConnectionToNetwork(dbres.insertId);
	if (!syncResult.status) {
		// Connection was created successfully — log the sync failure but don't
		// roll back. Subscriptions can be repaired via syncConnectionToNetwork.
		alogger.writeAlog(3,
			'newConnection: subscription sync failed for new connection ' + uuid +
			': ' + syncResult.errormessages.join(', '),
			'redbright'
		);
	}

	alogger.writeAlog(5,
		'Peer connection created: ' + formObj.connection_type +
		' for peer ' + dbpeer.id + ' on network ' + dbnetwork.name +
		' (' + uuid + ')',
		'greenbright'
	);
	returnObj.status = true;
	return returnObj;
}

async function updateConnection(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbconn = await getConnectionByUUID(uuid);
	if (!dbconn) {
		returnObj.errormessages.push('Connection not found');
		return returnObj;
	}

	// network_id changes are not supported — remove and re-add
	if (formObj.network_id !== undefined &&
	    parseInt(formObj.network_id) !== dbconn.network_id) {
		returnObj.errormessages.push('Network cannot be changed on an existing connection — remove and re-add');
		return returnObj;
	}

	var dbnetwork = await msgNetworks.getNetworkById(dbconn.network_id);
	if (!dbnetwork) {
		returnObj.errormessages.push('Network not found for this connection');
		return returnObj;
	}

	var updateObj = {};

	if (formObj.connection_type !== undefined) {
		updateObj.connection_type = formObj.connection_type.trim();
	}
	if (formObj.active !== undefined) {
		updateObj.active = (formObj.active === 'true' || formObj.active === true);
	}
	if (formObj.system_address_id !== undefined) {
		var newSaId = formObj.system_address_id === '' || formObj.system_address_id === null
			? null
			: parseInt(formObj.system_address_id);
		if (newSaId !== null) {
			var saCheck = await systemAddresses.getAddressById(newSaId);
			if (!saCheck || saCheck.network_id !== dbconn.network_id) {
				returnObj.errormessages.push('Selected system address does not belong to this network');
				return returnObj;
			}
		}
		updateObj.system_address_id = newSaId;
	}

	// If any connection_data fields are present, rebuild the full data object
	// from the existing stored data merged with the incoming form fields
	var dataKeys = [
		'address', 'direct', 'route_to', 'status', 'remote_host', 'remote_port',
		'session_password', 'packet_password', 'tic_password', 'areafix_password',
		'host', 'port', 'use_tls', 'username', 'password', 'pull_interval_minutes',
		'packet_name'
	];
	var hasDataField = dataKeys.some(k => formObj[k] !== undefined);

	if (hasDataField) {
		// Merge: spread existing stored data, overlay with incoming form fields
		var existingData = dbconn.connection_data || {};
		var mergedForm   = Object.assign({}, existingData, formObj);
		var connectionData = buildConnectionData(dbnetwork.network_type, mergedForm);
		var dataErrors     = validateConnectionData(dbnetwork.network_type, connectionData);
		if (dataErrors.length > 0) {
			returnObj.errormessages = returnObj.errormessages.concat(dataErrors);
			return returnObj;
		}
		updateObj.connection_data = JSON.stringify(connectionData);
	}

	if (Object.keys(updateObj).length === 0) {
		returnObj.errormessages.push('No updatable fields provided');
		return returnObj;
	}

	updateObj.updated_at = new Date();
	if (formObj.updatedByUUID) updateObj.updated_by_uuid = formObj.updatedByUUID;
	if (formObj.updatedByName) updateObj.updated_by_name = formObj.updatedByName;

	var count = await postgres.updateById(dbconn.id, updateObj, 'peer_connections');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	alogger.writeAlog(5, 'Peer connection updated: ' + uuid, 'greenbright');
	returnObj.status = true;
	return returnObj;
}

// Partial JSONB merge update — merges dataObj fields into existing
// connection_data without requiring a full form submission. Validates result.
async function updateConnectionData(uuid, dataObj, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbconn = await getConnectionByUUID(uuid);
	if (!dbconn) {
		returnObj.errormessages.push('Connection not found');
		return returnObj;
	}

	var dbnetwork = await msgNetworks.getNetworkById(dbconn.network_id);
	if (!dbnetwork) {
		returnObj.errormessages.push('Network not found for this connection');
		return returnObj;
	}

	var existingData   = dbconn.connection_data || {};
	var mergedData     = Object.assign({}, existingData, dataObj);
	var dataErrors     = validateConnectionData(dbnetwork.network_type, mergedData);
	if (dataErrors.length > 0) {
		returnObj.errormessages = returnObj.errormessages.concat(dataErrors);
		return returnObj;
	}

	var updateObj = {
		connection_data: JSON.stringify(mergedData),
		updated_at:      new Date()
	};
	if (formObj && formObj.updatedByUUID) updateObj.updated_by_uuid = formObj.updatedByUUID;
	if (formObj && formObj.updatedByName) updateObj.updated_by_name = formObj.updatedByName;

	var count = await postgres.updateById(dbconn.id, updateObj, 'peer_connections');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	alogger.writeAlog(5, 'Peer connection data updated: ' + uuid, 'greenbright');
	returnObj.status = true;
	return returnObj;
}

async function removeConnection(uuid) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbconn = await getConnectionByUUID(uuid);
	if (!dbconn) {
		returnObj.errormessages.push('Connection not found');
		return returnObj;
	}

	// Remove subscriptions first to avoid FK constraint violations
	var subErr = await postgres.write(
		'DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1',
		[dbconn.id]
	);
	if (subErr) {
		alogger.writeAlog(3,
			'removeConnection: failed to remove subscriptions for connection ' +
			uuid + ': ' + subErr.message,
			'redbright'
		);
		returnObj.errormessages.push('Failed to remove subscriptions: ' + subErr.message);
		return returnObj;
	}

	var connErr = await postgres.write(
		'DELETE FROM peer_connections WHERE id = $1',
		[dbconn.id]
	);
	if (connErr) {
		alogger.writeAlog(3,
			'removeConnection: failed to remove connection ' +
			uuid + ': ' + connErr.message,
			'redbright'
		);
		returnObj.errormessages.push('Failed to remove connection: ' + connErr.message);
		return returnObj;
	}

	alogger.writeAlog(5, 'Peer connection removed: ' + uuid, 'greenbright');
	returnObj.status = true;
	return returnObj;
}

// --- Read operations ---

async function getConnectionsByPeer(peerId) {
	var dblist = await postgres.query(
		`SELECT pc.*, mn.name AS network_name, mn.network_type, mn.domain, mn.uuid AS network_uuid
		 FROM peer_connections pc
		 JOIN message_networks mn ON mn.id = pc.network_id
		 WHERE pc.peer_id = $1
		 ORDER BY mn.name ASC`,
		[parseInt(peerId)]
	);
	return dblist || [];
}

async function getConnectionsByNetwork(networkId) {
	var dblist = await postgres.query(
		`SELECT pc.*, p.name AS peer_name, p.sysop_name, p.uuid AS peer_uuid
		 FROM peer_connections pc
		 JOIN peers p ON p.id = pc.peer_id
		 WHERE pc.network_id = $1
		 ORDER BY p.name ASC`,
		[parseInt(networkId)]
	);
	return dblist || [];
}

async function getConnectionByUUID(uuid) {
	var dbres = await postgres.queryOne(
		'SELECT * FROM peer_connections WHERE uuid = $1',
		[uuid]
	);
	return dbres;
}

async function getConnectionById(id) {
	var dbres = await postgres.queryOne(
		'SELECT * FROM peer_connections WHERE id = $1',
		[parseInt(id)]
	);
	return dbres;
}

// Returns all active NNTP connections joined with their network.
// Used by nntpTosser to discover what to pull.
async function getActiveConnectionsByNetworkType(networkType) {
	var dblist = await postgres.query(
		`SELECT pc.*, mn.name AS network_name, mn.domain, mn.config AS network_config,
		        p.name AS peer_name, p.sysop_name
		 FROM peer_connections pc
		 JOIN message_networks mn ON mn.id = pc.network_id
		 JOIN peers p ON p.id = pc.peer_id
		 WHERE mn.network_type = $1 AND pc.active = true AND mn.active = true
		 ORDER BY p.name ASC`,
		[networkType]
	);
	return dblist || [];
}

// Remove a specific newsgroup's high-water mark from all NNTP connections on a
// network. Called when a network_area mapping is removed so a re-add triggers
// a fresh pull. Uses the Postgres JSONB #- operator to surgically delete the
// key without touching the rest of connection_data. #- is a no-op if the key
// does not exist, so no existence check is needed (and avoids pg's ? conflict).
async function clearNntpHwmForArea(networkId, areatag) {
	if (!areatag) return;
	try {
		await postgres.write(
			`UPDATE peer_connections
			 SET connection_data = connection_data #- ARRAY['high_water_marks', $1]
			 WHERE network_id = $2`,
			[areatag, parseInt(networkId)]
		);
		alogger.writeAlog(5,
			'clearNntpHwmForArea: removed HWM for ' + areatag +
			' on network_id ' + networkId,
			'greenbright'
		);
	} catch (err) {
		alogger.writeAlog(3,
			'clearNntpHwmForArea: failed for ' + areatag + ': ' + err.message,
			'redbright'
		);
	}
}

export {
	newConnection,
	updateConnection,
	updateConnectionData,
	removeConnection,
	getConnectionsByPeer,
	getConnectionsByNetwork,
	getConnectionByUUID,
	getConnectionById,
	getActiveConnectionsByNetworkType,
	buildConnectionData,
	validateConnectionData,
	clearNntpHwmForArea
};
