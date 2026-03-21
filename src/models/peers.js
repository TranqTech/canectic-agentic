// imports
import { v4 as uuidv4 } from 'uuid';

// internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';


async function newPeer(formObj) {
	var returnObj = {
		status: false,
		errormessages: [],
		insertId: 0,
		insertUUID: ''
	};

	if (!formObj.name) {
		returnObj.errormessages.push('Name cannot be empty');
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	var uuid = uuidv4();
	var currtime = new Date();

	var dbObj = {
		uuid: uuid,
		name: formObj.name.trim(),
		sysop_name: formObj.sysop_name ? formObj.sysop_name.trim() : '',
		contact: formObj.contact ? formObj.contact.trim() : '',
		notes: formObj.notes ? formObj.notes.trim() : '',
		active: true,
		created_at: currtime,
		updated_at: null,
		created_by_uuid: formObj.createdByUUID || '',
		created_by_name: formObj.createdByName || '',
		updated_by_uuid: '',
		updated_by_name: ''
	};

	var dbres = await postgres.insertObject(dbObj, 'peers');
	if (dbres.status === true && dbres.insertId) {
		returnObj.insertId = dbres.insertId;
		returnObj.insertUUID = uuid;
		returnObj.status = true;
		alogger.writeAlog(5, 'Peer created: ' + formObj.name, 'greenbright');
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function getAllPeers() {
	var dblist = await postgres.query(
		'SELECT * FROM peers ORDER BY name ASC'
	);
	return dblist || [];
}

async function getActivePeers() {
	var dblist = await postgres.query(
		'SELECT * FROM peers WHERE active ORDER BY name ASC'
	);
	return dblist || [];
}

async function getPeerById(id) {
	var dbres = await postgres.queryOne(
		'SELECT * FROM peers WHERE id = $1',
		[id]
	);
	return dbres;
}

async function getPeerByUUID(uuid) {
	var dbres = await postgres.queryOne(
		'SELECT * FROM peers WHERE uuid = $1',
		[uuid]
	);
	return dbres;
}

async function updatePeer(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbpeer = await getPeerByUUID(uuid);
	if (!dbpeer) {
		returnObj.errormessages.push('Peer not found');
		return returnObj;
	}

	var updateObj = {};
	if (formObj.name        !== undefined) updateObj.name        = formObj.name.trim();
	if (formObj.sysop_name  !== undefined) updateObj.sysop_name  = formObj.sysop_name.trim();
	if (formObj.contact     !== undefined) updateObj.contact     = formObj.contact.trim();
	if (formObj.notes       !== undefined) updateObj.notes       = formObj.notes.trim();
	if (formObj.active      !== undefined) updateObj.active      = (formObj.active === 'true' || formObj.active === true);

	if (Object.keys(updateObj).length === 0) {
		returnObj.errormessages.push('No updatable fields provided');
		return returnObj;
	}

	updateObj.updated_at = new Date();
	if (formObj.updatedByUUID) updateObj.updated_by_uuid = formObj.updatedByUUID;
	if (formObj.updatedByName) updateObj.updated_by_name = formObj.updatedByName;

	var count = await postgres.updateById(dbpeer.id, updateObj, 'peers');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	alogger.writeAlog(5, 'Peer updated: ' + dbpeer.name, 'greenbright');
	returnObj.status = true;
	return returnObj;
}

async function removePeer(uuid) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var dbpeer = await getPeerByUUID(uuid);
	if (!dbpeer) {
		returnObj.errormessages.push('Peer not found');
		return returnObj;
	}

	// peer_connections (and their peer_area_subscriptions via cascade) are
	// removed first to avoid FK constraint violations
	var connErr = await postgres.write(
		`DELETE FROM peer_area_subscriptions
		 WHERE peer_connection_id IN (
		   SELECT id FROM peer_connections WHERE peer_id = $1
		 )`,
		[dbpeer.id]
	);
	if (connErr) {
		alogger.writeAlog(3, 'removePeer: failed to remove subscriptions for peer ' + uuid + ': ' + connErr.message, 'redbright');
		returnObj.errormessages.push('Failed to remove peer subscriptions: ' + connErr.message);
		return returnObj;
	}

	var pcErr = await postgres.write(
		'DELETE FROM peer_connections WHERE peer_id = $1',
		[dbpeer.id]
	);
	if (pcErr) {
		alogger.writeAlog(3, 'removePeer: failed to remove connections for peer ' + uuid + ': ' + pcErr.message, 'redbright');
		returnObj.errormessages.push('Failed to remove peer connections: ' + pcErr.message);
		return returnObj;
	}

	var peerErr = await postgres.write(
		'DELETE FROM peers WHERE id = $1',
		[dbpeer.id]
	);
	if (peerErr) {
		alogger.writeAlog(3, 'removePeer: failed to remove peer ' + uuid + ': ' + peerErr.message, 'redbright');
		returnObj.errormessages.push('Failed to remove peer: ' + peerErr.message);
		return returnObj;
	}

	alogger.writeAlog(5, 'Peer removed: ' + dbpeer.name + ' (' + uuid + ')', 'greenbright');
	returnObj.status = true;
	return returnObj;
}

export {
	newPeer,
	getAllPeers,
	getActivePeers,
	getPeerById,
	getPeerByUUID,
	updatePeer,
	removePeer
};
