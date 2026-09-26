// imports
import { v4 as uuidv4 } from 'uuid';

// internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as msgNetworks from './msgNetworks.js';
import * as networkAreas from './networkAreas.js';
import * as peerAreaSubscriptions from './peerAreaSubscriptions.js';
import * as systemAddresses from './systemAddresses.js';
import { checkQwkId, longIdsAllowed, remoteRole, findIdClash } from '../utils/qwkId.js';

// peers is imported lazily to avoid any future circular risk as the
// peer/connection graph grows
async function getPeers() {
	var mod = await import('./peers.js');
	return mod;
}


const VALID_FTN_STATUS = ['NORMAL', 'CRASH', 'HOLD'];

// A checkbox's value. The forms send a hidden 'false' before each checkbox,
// because an unticked box sends nothing and updateConnection merges the form
// over the stored row, so without it a box could be ticked but never
// unticked. Ticked, the body holds both values: ['false', 'true'].
function checkboxValue(v) {
	if (Array.isArray(v)) return v.some(checkboxValue);
	return v === true || v === 'true' || v === 'on';
}

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
			var rawPollInterval = formObj.poll_interval_minutes || formObj.poll_interval || null;
			var rawMailerTransport = formObj.ftn_mailer_transport || formObj.mailer_transport || 'tcp';
			var rawMailerProtocol  = formObj.ftn_mailer_protocol  || formObj.mailer_protocol  || 'binkp';
			var rawMailerWsUrl     = formObj.ftn_mailer_ws_url    || formObj.mailer_ws_url    || '';
			var rawOutboxDir       = formObj.ftn_outbox_dir !== undefined ? formObj.ftn_outbox_dir : (formObj.outbox_dir || '');
			var rawForcePlain      = formObj.ftn_force_plain_password !== undefined ? formObj.ftn_force_plain_password : formObj.force_plain_password;
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
				areafix_password: rawAreafix  ? rawAreafix.trim()        : '',
				poll_interval:    rawPollInterval ? parseInt(rawPollInterval) : 60,
				mailer_transport: rawMailerTransport ? rawMailerTransport.trim().toLowerCase() : 'tcp',
				mailer_protocol:  rawMailerProtocol  ? rawMailerProtocol.trim().toLowerCase()  : 'binkp',
				mailer_ws_url:    rawMailerWsUrl     ? rawMailerWsUrl.trim()                   : '',
				outbox_dir:       rawOutboxDir        ? rawOutboxDir.trim()                     : '',
				force_plain_password: checkboxValue(rawForcePlain)
			};
		}
		case 'NNTP': {
			var nHost     = formObj.nntp_host                  || formObj.host                  || '';
			var nPort     = formObj.nntp_port                  || formObj.port                  || 119;
			var nTls      = formObj.nntp_use_tls               !== undefined ? formObj.nntp_use_tls : formObj.use_tls;
			var nUser     = formObj.nntp_username              || formObj.username              || '';
			var nPass     = formObj.nntp_password              || formObj.password              || '';
			var nInterval = formObj.nntp_pull_interval_minutes || formObj.poll_interval_minutes || formObj.pull_interval_minutes || 60;
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
			// Use explicit undefined checks so that empty strings from the form
			// are preserved — an empty inbox/outbox means "use server default cwd".
			var pick = function(/* ...candidates */) {
				for (var i = 0; i < arguments.length; i++) {
					if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
				}
				return arguments[arguments.length - 1];
			};
			var qHost      = pick(formObj.qwk_host,           formObj.host,           '');
			var qPort      = pick(formObj.qwk_port,           formObj.port,           21);
			var qUser      = pick(formObj.qwk_username,       formObj.username,       '');
			var qPass      = pick(formObj.qwk_password,       formObj.password,       '');
			var qTransport = pick(formObj.qwk_transport,      formObj.transport,      'ftp');
			var qInbox     = pick(formObj.qwk_remote_inbox,   formObj.remote_inbox,   '/');
			var qOutbox    = pick(formObj.qwk_remote_outbox,  formObj.remote_outbox,  '/');
			var qRemoteId  = pick(formObj.qwk_remote_qwk_id, formObj.remote_qwk_id,  '');
			var qPollInterval = formObj.poll_interval_minutes || formObj.pull_interval_minutes || formObj.pull_interval || null;
			var qHubDir    = pick(formObj.qwk_hub_directory, formObj.hub_directory, false);
			var qUtf8      = pick(formObj.qwk_utf8, formObj.utf8, true);
			return {
				transport:             qTransport ? qTransport.toString().trim().toLowerCase() : 'ftp',
				host:                  qHost ? qHost.toString().trim() : '',
				port:                  qPort ? parseInt(qPort) : 21,
				username:              qUser ? qUser.toString().trim() : '',
				password:              typeof qPass === 'string' ? qPass.trim() : '',
				remote_inbox:          typeof qInbox === 'string'  ? qInbox.trim()  : '',
				remote_outbox:         typeof qOutbox === 'string' ? qOutbox.trim() : '',
				remote_qwk_id:         qRemoteId ? qRemoteId.toString().trim().toUpperCase() : '',
				pull_interval_minutes: qPollInterval ? parseInt(qPollInterval) : 120,
				// Hub transport only: the node collects its packet from
				// qnet/<ID>/out/ rather than over HTTP, so the hub builds it
				// ahead of time (qwkTosser.serviceHubNodes).
				hub_directory:         checkboxValue(qHubDir),
				// Send a message as UTF-8 when it does not fit CP437 (#71). On by
				// default: Synchronet honours HEADERS.DAT Utf8 whatever its own
				// settings, and only messages that would lose characters change.
				utf8:                  checkboxValue(qUtf8)
			};
		}
		case 'LOCAL':
		default:
			return {};
	}
}

// The FTN fields that decide what the mailer dials. Nodelist lookups key on
// `address` when there is no remote_host, so it counts too.
const FTN_DIAL_KEYS = ['address', 'remote_host', 'remote_port', 'mailer_transport', 'mailer_protocol', 'mailer_ws_url'];

// connection_data for a form save over a stored row (#66). buildConnectionData
// returns only the keys a form edits, so rebuilding from it alone threw away
// everything the system writes for itself: NNTP/QWK high_water_marks (the next
// NNTP pull restarted every group from its first article) and the FTN connect
// backoff. Keys the builder does not produce are carried through unchanged.
// The one exception is backoff when the dial target changes: those failures
// were against the old target, and a sysop correcting a wrong host expects the
// next poll to try it. last_success_at and last_failure_at stay as history.
function mergeConnectionData(networkType, existing, formObj) {
	var stored = existing || {};
	var built  = buildConnectionData(networkType, Object.assign({}, stored, formObj));
	var merged = Object.assign({}, stored, built);

	if (networkType === 'FTN') {
		// Compare against the stored row rebuilt the same way, so a key an old
		// row never had (mailer_transport before it existed) reads as its
		// default rather than as a change.
		var before = buildConnectionData(networkType, stored);
		var redialled = FTN_DIAL_KEYS.some(k => before[k] !== built[k]);
		if (redialled && (parseInt(stored.consecutive_failures) || 0) > 0) {
			merged.consecutive_failures = 0;
			merged.next_allowed_poll_at = null;
			merged.last_failure_reason  = null;
		}
	}
	return merged;
}

// A QWK hub connection whose node collects its packet from qnet/<ID>/out/ and
// leaves REPs in qnet/<ID>/in/ (qnet-directory.js), rather than calling over
// HTTP. Such a node never asks for a packet, so the hub builds it ahead of time.
function isDirectoryHubNode(conn) {
	var cd = (conn && conn.connection_data) || {};
	return !!(conn && conn.active !== false) && cd.transport === 'hub' && cd.hub_directory === true;
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
			if (data.transport !== 'directory' && data.transport !== 'hub' && !data.host) {
				errors.push('QWK host cannot be empty (not required for directory or hub transport)');
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

// Every QWK connection, inactive included, for the per-role uniqueness check.
async function getQwkConnectionsForIdCheck() {
	return (await postgres.query(
		`SELECT pc.id, pc.uuid, pc.network_id, pc.active, pc.connection_data,
		        p.name AS peer_name, mn.name AS network_name
		 FROM peer_connections pc
		 JOIN message_networks mn ON mn.id = pc.network_id
		 JOIN peers p ON p.id = pc.peer_id
		 WHERE mn.network_type = 'QWK'
		 ORDER BY pc.id ASC`, [])) || [];
}

// The QWK ID rules (src/utils/qwkId.js) for a connection about to be saved:
// its Remote QWK ID must be valid for the network, and no other connection may
// use the same ID in the same role. Normalises connectionData.remote_qwk_id.
async function checkQwkConnection(dbnetwork, connectionData, selfUuid) {
	var check = checkQwkId(connectionData.remote_qwk_id, { allowLong: longIdsAllowed(dbnetwork) });
	connectionData.remote_qwk_id = check.id;
	var out = { errors: check.errors.slice(), warnings: check.warnings.slice() };
	if (out.errors.length > 0) return out;

	var role = remoteRole(connectionData);
	var clash = findIdClash({ uuid: selfUuid, id: check.id, role: role }, await getQwkConnectionsForIdCheck());
	if (clash) {
		out.errors.push('QWK ID ' + check.id + ' is already used by the connection to ' + clash.peer_name +
			' on ' + clash.network_name + (clash.active ? '' : ' (inactive)') + ', where it is ' +
			(role === 'hub' ? 'our hub' : 'our node') + '. A QWK ID can be used once as a hub and once as a node.');
	}
	return out;
}


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
	if (dbnetwork.network_type === 'QWK') {
		var qwkCheck = await checkQwkConnection(dbnetwork, connectionData, null);
		returnObj.warnings = qwkCheck.warnings;
		if (qwkCheck.errors.length > 0) {
			returnObj.errormessages = returnObj.errormessages.concat(qwkCheck.errors);
			return returnObj;
		}
	}

	// Resolve system_address_id — optional, must belong to the same network
	var systemAddressId = null;
	if (formObj.system_address_id) {
		var saId = parseInt(formObj.system_address_id);
		if (!isNaN(saId)) {
			var saCheck = await systemAddresses.getAddressById(saId);
			if (saCheck && parseInt(saCheck.network_id) === parseInt(dbnetwork.id)) {
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
		poll_enabled:      formObj.poll_enabled !== undefined
			? (formObj.poll_enabled === 'true' || formObj.poll_enabled === true)
			: (formObj.connection_type === 'NNTP' || (formObj.connection_type === 'QWK' && connectionData.transport !== 'hub')),
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
		alogger.writeAlog(3,
			'newConnection: subscription sync failed for new connection ' + uuid +
			': ' + syncResult.errormessages.join(', '),
			'redbright'
		);
	}

	// Allow all areas that are currently on this network for the new connection.
	// The admin can then selectively revoke areas they don't want this peer to have.
	await peerAreaSubscriptions.allowAllNetworkAreas(dbres.insertId, dbnetwork.id);

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
			if (!saCheck || parseInt(saCheck.network_id) !== parseInt(dbconn.network_id)) {
				returnObj.errormessages.push('Selected system address does not belong to this network');
				return returnObj;
			}
		}
		updateObj.system_address_id = newSaId;
	}

	// If any connection_data fields are present, rebuild the full data object
	// from the existing stored data merged with the incoming form fields.
	// Includes both bare names (for programmatic callers) and prefixed names
	// (ftn_, nntp_, qwk_) as submitted by the admin edit forms.
	var dataKeys = [
		// Bare names (programmatic callers / backward compat)
		'address', 'direct', 'route_to', 'status', 'remote_host', 'remote_port',
		'session_password', 'packet_password', 'tic_password', 'areafix_password',
		'routing_rules', 'host', 'port', 'use_tls', 'username', 'password',
		'poll_interval_minutes', 'pull_interval_minutes', 'transport', 'remote_inbox', 'remote_outbox',
		'remote_qwk_id', 'outbox_dir',
		// FTN form fields
		'ftn_address', 'ftn_direct', 'ftn_route_to', 'ftn_status',
		'ftn_remote_host', 'ftn_remote_port', 'ftn_session_password',
		'ftn_packet_password', 'ftn_tic_password', 'ftn_areafix_password',
		'ftn_routing_rules', 'ftn_outbox_dir',
		// NNTP form fields
		'nntp_host', 'nntp_port', 'nntp_use_tls', 'nntp_username',
		'nntp_password', 'nntp_pull_interval_minutes',
		// QWK form fields
		'qwk_host', 'qwk_port', 'qwk_transport', 'qwk_username',
		'qwk_password', 'qwk_remote_inbox', 'qwk_remote_outbox',
		'qwk_remote_qwk_id', 'qwk_hub_directory', 'hub_directory', 'qwk_utf8', 'utf8',
		'ftn_force_plain_password', 'force_plain_password'
	];
	var hasDataField = dataKeys.some(k => formObj[k] !== undefined);

	if (hasDataField) {
		var connectionData = mergeConnectionData(dbnetwork.network_type, dbconn.connection_data, formObj);
		var dataErrors     = validateConnectionData(dbnetwork.network_type, connectionData);
		if (dataErrors.length > 0) {
			returnObj.errormessages = returnObj.errormessages.concat(dataErrors);
			return returnObj;
		}
		if (dbnetwork.network_type === 'QWK') {
			var qwkCheck = await checkQwkConnection(dbnetwork, connectionData, dbconn.uuid);
			returnObj.warnings = qwkCheck.warnings;
			if (qwkCheck.errors.length > 0) {
				returnObj.errormessages = returnObj.errormessages.concat(qwkCheck.errors);
				return returnObj;
			}
		}
		updateObj.connection_data = JSON.stringify(connectionData);
	}

	if (formObj.poll_enabled !== undefined) {
		updateObj.poll_enabled = (formObj.poll_enabled === 'true' || formObj.poll_enabled === true);
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

// ---------------------------------------------------------------------------
// Backoff state tracking for outbound mailer polls
// ---------------------------------------------------------------------------
//
// When a peer's mailer connect fails (TCP error, auth failure, unexpected
// disconnect), we bump a consecutive-failure counter and stamp a
// `next_allowed_poll_at` window so the scheduler skips the peer until the
// backoff expires. A successful session (state === 'done') clears the
// counter and resets the window.
//
// Fields live under connection_data JSONB to avoid a schema change and
// to surface in existing admin views. Writes use jsonb_set so they
// don't collide with sysop config edits on the same row.

/**
 * Compute the next backoff delay in milliseconds.
 *
 * delay = min(baseIntervalMin * 2^(failures-1), capHours * 60)  minutes
 * Jitter: +/- 10% to avoid thundering herd on service recovery.
 *
 * failures <= 1 returns a one-base-interval wait (so a single failure
 * doesn't retry instantly, just delays by one cycle).
 */
function computeBackoffDelayMs(failures, baseIntervalMin, capHours) {
	var base = parseInt(baseIntervalMin) || 60;
	var cap = (parseInt(capHours) || 24) * 60;
	var f = Math.max(0, parseInt(failures) - 1);
	var minutes = base * Math.pow(2, f);
	if (minutes > cap) minutes = cap;
	var jitter = 1 + (Math.random() * 0.2 - 0.1);
	return Math.round(minutes * 60 * 1000 * jitter);
}

/**
 * Is this connection currently in a backoff window?
 * Pure check on the passed-in row, no DB read.
 */
function isInBackoff(conn) {
	if (!conn || !conn.connection_data) return false;
	var until = conn.connection_data.next_allowed_poll_at;
	if (!until) return false;
	var untilDate = new Date(until);
	if (isNaN(untilDate.getTime())) return false;
	return untilDate > new Date();
}

/**
 * Record a connect/session failure: bump counter, set next_allowed_poll_at.
 * baseIntervalMin defaults to the peer's configured poll_interval.
 * capHours defaults to the mailer_backoff_max_hours config (24).
 */
async function recordConnectFailure(uuid, reason, opts) {
	var options = opts || {};
	var conn = await getConnectionByUUID(uuid);
	if (!conn) return null;

	var cd = conn.connection_data || {};
	var failures = (parseInt(cd.consecutive_failures) || 0) + 1;
	var base = options.baseIntervalMin || parseInt(cd.poll_interval) || 60;
	var cap  = options.capHours || 24;
	var delayMs = computeBackoffDelayMs(failures, base, cap);
	var nextAt  = new Date(Date.now() + delayMs);

	var patch = {
		consecutive_failures: failures,
		last_failure_at:      new Date().toISOString(),
		last_failure_reason:  (reason || 'unknown').substring(0, 200),
		next_allowed_poll_at: nextAt.toISOString(),
	};

	await _patchConnectionData(conn.id, patch);
	alogger.writeAlog(4,
		'[peer backoff] ' + (cd.address || uuid) + ' failure #' + failures +
		' -- next poll allowed at ' + nextAt.toISOString() +
		' (' + Math.round(delayMs / 60000) + ' min delay)',
		'yellow');
	return { failures: failures, nextAt: nextAt };
}

/**
 * Record a successful session: clear counter and backoff window.
 */
async function recordConnectSuccess(uuid) {
	var conn = await getConnectionByUUID(uuid);
	if (!conn) return;
	var cd = conn.connection_data || {};
	// Only log if there was actually a failure streak to clear
	var hadFailures = (parseInt(cd.consecutive_failures) || 0) > 0;

	var patch = {
		consecutive_failures: 0,
		next_allowed_poll_at: null,
		last_failure_reason:  null,
		last_success_at:      new Date().toISOString(),
	};
	await _patchConnectionData(conn.id, patch);
	if (hadFailures) {
		alogger.writeAlog(3,
			'[peer backoff] ' + (cd.address || uuid) + ' recovered -- backoff cleared',
			'greenbright');
	}
}

/**
 * Manually reset backoff (admin override).
 */
async function resetBackoff(uuid) {
	return recordConnectSuccess(uuid);
}

// Atomic jsonb_set patch: merges the given keys into connection_data
// without reading-then-writing the whole object. Null values in `patch`
// are written as JSON null (effectively clearing a key while preserving
// the rest). Multiple keys are applied in one UPDATE via chained
// jsonb_set calls.
async function _patchConnectionData(id, patch) {
	var keys = Object.keys(patch);
	if (keys.length === 0) return;

	// Build a chain of jsonb_set() calls. Values are supplied as
	// separate parameters to keep things parameterised.
	var expr = 'connection_data';
	var params = [];
	for (var i = 0; i < keys.length; i++) {
		var keyParam = '$' + (params.length + 2); // +2 because $1 is id
		var valParam = '$' + (params.length + 3);
		expr = "jsonb_set(" + expr + ", ARRAY[" + keyParam + "]::text[], " + valParam + "::jsonb, true)";
		params.push(keys[i], JSON.stringify(patch[keys[i]]));
	}

	var sql = 'UPDATE peer_connections SET connection_data = ' + expr +
		', updated_at = NOW() WHERE id = $1';
	await postgres.write(sql, [id].concat(params));
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

/**
 * Every connection with its peer and network names attached, for views that
 * list the whole board rather than one peer. Inactive connections are included
 * so the mailer dashboard can show a link that was turned off rather than
 * quietly dropping it from the list.
 */
async function getAllConnectionsWithPeer() {
	var dblist = await postgres.query(
		`SELECT pc.*, mn.name AS network_name, mn.network_type, mn.domain,
		        p.name AS peer_name, p.uuid AS peer_uuid, p.sysop_name
		 FROM peer_connections pc
		 JOIN message_networks mn ON mn.id = pc.network_id
		 JOIN peers p ON p.id = pc.peer_id
		 ORDER BY p.name ASC, mn.name ASC`
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

// Like getConnectionByUUID but joins message_networks so network fields
// (domain, network_type, network_name) are available on the returned row.
async function getConnectionByUUIDWithNetwork(uuid) {
	var dbres = await postgres.queryOne(
		`SELECT pc.*, mn.name AS network_name, mn.network_type, mn.domain, mn.config AS network_config
		 FROM peer_connections pc
		 JOIN message_networks mn ON mn.id = pc.network_id
		 WHERE pc.uuid = $1`,
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

// Same as clearNntpHwmForArea but for QWK connections on a network.
// Removes the areatag (= conference number) key from high_water_marks in
// connection_data for all connections on the given network.
async function clearQwkHwmForArea(networkId, areatag) {
	if (!areatag) return;
	try {
		await postgres.write(
			`UPDATE peer_connections
			 SET connection_data = connection_data #- ARRAY['high_water_marks', $1]
			 WHERE network_id = $2`,
			[areatag, parseInt(networkId)]
		);
		alogger.writeAlog(5,
			'clearQwkHwmForArea: removed HWM for ' + areatag +
			' on network_id ' + networkId,
			'greenbright'
		);
	} catch (err) {
		alogger.writeAlog(3,
			'clearQwkHwmForArea: failed for ' + areatag + ': ' + err.message,
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
	getAllConnectionsWithPeer,
	getConnectionsByNetwork,
	getConnectionByUUID,
	getConnectionByUUIDWithNetwork,
	getConnectionById,
	getActiveConnectionsByNetworkType,
	buildConnectionData,
	mergeConnectionData,
	isDirectoryHubNode,
	getQwkConnectionsForIdCheck,
	validateConnectionData,
	clearNntpHwmForArea,
	clearQwkHwmForArea,
	// Backoff
	computeBackoffDelayMs,
	isInBackoff,
	recordConnectFailure,
	recordConnectSuccess,
	resetBackoff
};
