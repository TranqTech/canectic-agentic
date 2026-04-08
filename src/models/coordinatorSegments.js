// coordinatorSegments.js — Network coordinator segment definitions.
//
// A segment defines a portion of a network that this system coordinates.
// Examples: Net 134 (role=NC), Hub 120 within Net 134 (role=Hub),
// Region 12 (role=RC), Zone 1 (role=ZC).
//
// Managed nodes belong to a segment. Stub generation is per-segment.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

var VALID_ROLES = ['Hub', 'NC', 'RC', 'ZC'];

var ROLE_LABELS = {
	'Hub': 'Hub',
	'NC':  'Network Coordinator',
	'RC':  'Region Coordinator',
	'ZC':  'Zone Coordinator'
};

var DISTRIBUTION_METHODS = ['manual', 'filebox', 'tic', 'netmail_attach'];

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getAll() {
	return await postgres.query(
		`SELECT cs.*, mn.name AS network_name
		 FROM coordinator_segments cs
		 JOIN message_networks mn ON mn.id = cs.network_id
		 ORDER BY mn.name ASC, cs.zone, cs.net`
	) || [];
}

async function getByNetwork(networkId) {
	return await postgres.query(
		'SELECT * FROM coordinator_segments WHERE network_id = $1 ORDER BY zone, net',
		[parseInt(networkId)]
	) || [];
}

async function getById(id) {
	return await postgres.queryOne(
		`SELECT cs.*, mn.name AS network_name
		 FROM coordinator_segments cs
		 JOIN message_networks mn ON mn.id = cs.network_id
		 WHERE cs.id = $1`,
		[parseInt(id)]
	);
}

async function create(formObj) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!formObj.network_id) returnObj.errormessages.push('Network is required');
	if (!formObj.name || !formObj.name.trim()) returnObj.errormessages.push('Name is required');
	var role = (formObj.role || 'NC').trim();
	if (!VALID_ROLES.includes(role)) returnObj.errormessages.push('Invalid role');
	if (returnObj.errormessages.length > 0) return returnObj;

	var dbObj = {
		network_id:            parseInt(formObj.network_id),
		name:                  formObj.name.trim(),
		role:                  role,
		zone:                  parseInt(formObj.zone) || 1,
		region:                parseInt(formObj.region) || 0,
		net:                   parseInt(formObj.net) || 0,
		hub_node:              parseInt(formObj.hub_node) || 0,
		upstream_address:      (formObj.upstream_address || '').trim() || null,
		upstream_connection_id: formObj.upstream_connection_id ? parseInt(formObj.upstream_connection_id) : null,
		stub_filename:         (formObj.stub_filename || '').trim() || null,
		distribution_method:   DISTRIBUTION_METHODS.includes(formObj.distribution_method) ? formObj.distribution_method : 'manual',
		schedule:              (formObj.schedule || '').trim() || 'manual',
		description:           (formObj.description || '').trim() || null,
		active:                formObj.active !== 'false' && formObj.active !== false,
		created_at:            new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'coordinator_segments');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	returnObj.status = true;
	returnObj.insertId = dbres.insertId;
	alogger.writeAlog(5, 'Coordinator segment created: ' + dbObj.name + ' (' + role + ')', 'greenbright');
	return returnObj;
}

async function update(id, formObj) {
	var returnObj = { status: false, errormessages: [] };
	var existing = await getById(id);
	if (!existing) { returnObj.errormessages.push('Segment not found'); return returnObj; }

	var updateObj = { updated_at: new Date() };

	if (formObj.name !== undefined) updateObj.name = formObj.name.trim();
	if (formObj.role !== undefined && VALID_ROLES.includes(formObj.role)) updateObj.role = formObj.role;
	if (formObj.zone !== undefined) updateObj.zone = parseInt(formObj.zone);
	if (formObj.region !== undefined) updateObj.region = parseInt(formObj.region) || 0;
	if (formObj.net !== undefined) updateObj.net = parseInt(formObj.net) || 0;
	if (formObj.hub_node !== undefined) updateObj.hub_node = parseInt(formObj.hub_node) || 0;
	if (formObj.upstream_address !== undefined) updateObj.upstream_address = formObj.upstream_address.trim() || null;
	if (formObj.upstream_connection_id !== undefined) updateObj.upstream_connection_id = formObj.upstream_connection_id ? parseInt(formObj.upstream_connection_id) : null;
	if (formObj.stub_filename !== undefined) updateObj.stub_filename = formObj.stub_filename.trim() || null;
	if (formObj.distribution_method !== undefined && DISTRIBUTION_METHODS.includes(formObj.distribution_method)) updateObj.distribution_method = formObj.distribution_method;
	if (formObj.schedule !== undefined) updateObj.schedule = (formObj.schedule || '').trim() || 'manual';
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim() || null;
	if (formObj.active !== undefined) updateObj.active = formObj.active !== 'false' && formObj.active !== false;

	var count = await postgres.updateById(parseInt(id), updateObj, 'coordinator_segments');
	if (count === 0) { returnObj.errormessages.push('No rows updated'); return returnObj; }

	returnObj.status = true;
	return returnObj;
}

async function remove(id) {
	var returnObj = { status: false, errormessages: [] };
	// Clear segment_id on managed nodes first
	await postgres.write('UPDATE managed_nodes SET segment_id = NULL WHERE segment_id = $1', [parseInt(id)]);
	var err = await postgres.write('DELETE FROM coordinator_segments WHERE id = $1', [parseInt(id)]);
	if (err) { returnObj.errormessages.push('Delete failed: ' + err.message); return returnObj; }
	returnObj.status = true;
	return returnObj;
}

export {
	VALID_ROLES,
	ROLE_LABELS,
	DISTRIBUTION_METHODS,
	getAll,
	getByNetwork,
	getById,
	create,
	update,
	remove
};
