// coordinatorSegments.js — Network coordinator segment definitions.
//
// A segment defines a portion of a network that this system coordinates.
// Segments form a tree: Zone > Region > Net > Hub, with each segment
// optionally parenting child segments of a lower role.
//
// Source: 'internal' segments have managed nodes edited by the sysop.
// 'external' segments represent downstream coordinators whose content
// arrives as received stub files (read-only).

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

var DEFAULT_ROLES = ['ZC', 'RC', 'NC', 'Hub'];

var ROLE_LABELS = {
	'Hub': 'Hub',
	'NC':  'Network Coordinator',
	'RC':  'Region Coordinator',
	'ZC':  'Zone Coordinator'
};

var VALID_SOURCES = ['internal', 'external'];

var DISTRIBUTION_METHODS = ['manual', 'filebox', 'tic', 'netmail_attach'];

// ---------------------------------------------------------------------------
// Per-network role configuration
// ---------------------------------------------------------------------------

/**
 * Get the ordered role list for a network.
 * Reads coordinator_roles from the network's config JSONB.
 * Falls back to DEFAULT_ROLES if not configured.
 */
async function getRolesForNetwork(networkId) {
	try {
		var msgNetworks = (await import('../models/msgNetworks.js'));
		var net = await msgNetworks.getNetworkById(networkId);
		if (net && net.config) {
			var config = typeof net.config === 'string' ? JSON.parse(net.config) : net.config;
			if (Array.isArray(config.coordinator_roles) && config.coordinator_roles.length > 0) {
				return config.coordinator_roles;
			}
		}
	} catch (_) {}
	return DEFAULT_ROLES;
}

/**
 * Get valid child roles for a given parent role within a network's role list.
 * Returns roles that appear after the parent in the ordered list.
 * If parentRole is null (top-level), returns the first role only.
 */
function getChildRoles(roles, parentRole) {
	if (!parentRole) return roles.length > 0 ? [roles[0]] : [];
	var idx = roles.indexOf(parentRole);
	if (idx < 0 || idx >= roles.length - 1) return [];
	return roles.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getAll() {
	return await postgres.query(
		`SELECT cs.*, mn.name AS network_name
		 FROM coordinator_segments cs
		 JOIN message_networks mn ON mn.id = cs.network_id
		 ORDER BY mn.name ASC, cs.depth, cs.zone, cs.net`
	) || [];
}

async function getByNetwork(networkId) {
	return await postgres.query(
		'SELECT * FROM coordinator_segments WHERE network_id = $1 ORDER BY depth, zone, net',
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

async function getChildren(parentId) {
	return await postgres.query(
		'SELECT * FROM coordinator_segments WHERE parent_segment_id = $1 ORDER BY zone, net',
		[parseInt(parentId)]
	) || [];
}

async function getRootSegments(networkId) {
	return await postgres.query(
		'SELECT * FROM coordinator_segments WHERE network_id = $1 AND parent_segment_id IS NULL ORDER BY zone, net',
		[parseInt(networkId)]
	) || [];
}

/**
 * Build the full segment tree for a network.
 * Returns an array of root segments, each with a `children` array (recursive).
 */
async function getTree(networkId) {
	var all = await getByNetwork(networkId);
	var byId = {};
	for (var seg of all) {
		seg.children = [];
		byId[seg.id] = seg;
	}

	var roots = [];
	for (var seg of all) {
		if (seg.parent_segment_id && byId[seg.parent_segment_id]) {
			byId[seg.parent_segment_id].children.push(seg);
		} else {
			roots.push(seg);
		}
	}
	return roots;
}

async function create(formObj) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!formObj.network_id) returnObj.errormessages.push('Network is required');
	if (!formObj.name || !formObj.name.trim()) returnObj.errormessages.push('Name is required');

	// Validate role against network's configured roles
	var role = (formObj.role || '').trim();
	var roles = await getRolesForNetwork(formObj.network_id);
	if (!role || !roles.includes(role)) returnObj.errormessages.push('Invalid role for this network');

	var source = (formObj.source || 'internal').trim();
	if (!VALID_SOURCES.includes(source)) returnObj.errormessages.push('Invalid source');

	if (returnObj.errormessages.length > 0) return returnObj;

	// Calculate depth from parent
	var depth = 0;
	var parentId = formObj.parent_segment_id ? parseInt(formObj.parent_segment_id) : null;
	if (parentId) {
		var parent = await getById(parentId);
		if (!parent) {
			returnObj.errormessages.push('Parent segment not found');
			return returnObj;
		}
		// Validate that role is a valid child of parent's role
		var childRoles = getChildRoles(roles, parent.role);
		if (!childRoles.includes(role)) {
			returnObj.errormessages.push(role + ' cannot be a child of ' + parent.role);
			return returnObj;
		}
		depth = parent.depth + 1;
	}

	var dbObj = {
		network_id:            parseInt(formObj.network_id),
		parent_segment_id:     parentId,
		source:                source,
		depth:                 depth,
		name:                  formObj.name.trim(),
		role:                  role,
		zone:                  parseInt(formObj.zone) || 1,
		region:                parseInt(formObj.region) || 0,
		net:                   parseInt(formObj.net) || 0,
		hub_node:              parseInt(formObj.hub_node) || 0,
		upstream_address:      (formObj.upstream_address || '').trim() || null,
		upstream_connection_id: formObj.upstream_connection_id ? parseInt(formObj.upstream_connection_id) : null,
		stub_filename:         (formObj.stub_filename || '').trim() || null,
		stub_file_area:        (formObj.stub_file_area || '').trim() || null,
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
	alogger.writeAlog(5, 'Coordinator segment created: ' + dbObj.name + ' (' + role + ', ' + source + ')', 'greenbright');
	return returnObj;
}

async function update(id, formObj) {
	var returnObj = { status: false, errormessages: [] };
	var existing = await getById(id);
	if (!existing) { returnObj.errormessages.push('Segment not found'); return returnObj; }

	var roles = await getRolesForNetwork(existing.network_id);
	var updateObj = { updated_at: new Date() };

	if (formObj.name !== undefined) updateObj.name = formObj.name.trim();
	if (formObj.role !== undefined) {
		if (!roles.includes(formObj.role)) {
			returnObj.errormessages.push('Invalid role for this network');
			return returnObj;
		}
		updateObj.role = formObj.role;
	}
	if (formObj.source !== undefined) {
		if (!VALID_SOURCES.includes(formObj.source)) {
			returnObj.errormessages.push('Invalid source');
			return returnObj;
		}
		updateObj.source = formObj.source;
	}
	if (formObj.parent_segment_id !== undefined) {
		var newParentId = formObj.parent_segment_id ? parseInt(formObj.parent_segment_id) : null;
		updateObj.parent_segment_id = newParentId;
		if (newParentId) {
			var parent = await getById(newParentId);
			if (!parent) { returnObj.errormessages.push('Parent segment not found'); return returnObj; }
			updateObj.depth = parent.depth + 1;
		} else {
			updateObj.depth = 0;
		}
	}
	if (formObj.zone !== undefined) updateObj.zone = parseInt(formObj.zone);
	if (formObj.region !== undefined) updateObj.region = parseInt(formObj.region) || 0;
	if (formObj.net !== undefined) updateObj.net = parseInt(formObj.net) || 0;
	if (formObj.hub_node !== undefined) updateObj.hub_node = parseInt(formObj.hub_node) || 0;
	if (formObj.upstream_address !== undefined) updateObj.upstream_address = formObj.upstream_address.trim() || null;
	if (formObj.upstream_connection_id !== undefined) updateObj.upstream_connection_id = formObj.upstream_connection_id ? parseInt(formObj.upstream_connection_id) : null;
	if (formObj.stub_filename !== undefined) updateObj.stub_filename = formObj.stub_filename.trim() || null;
	if (formObj.stub_file_area !== undefined) updateObj.stub_file_area = formObj.stub_file_area.trim() || null;
	if (formObj.distribution_method !== undefined && DISTRIBUTION_METHODS.includes(formObj.distribution_method)) updateObj.distribution_method = formObj.distribution_method;
	if (formObj.schedule !== undefined) updateObj.schedule = (formObj.schedule || '').trim() || 'manual';
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim() || null;
	if (formObj.active !== undefined) updateObj.active = formObj.active !== 'false' && formObj.active !== false;

	var count = await postgres.updateById(parseInt(id), updateObj, 'coordinator_segments');
	if (count === 0) { returnObj.errormessages.push('No rows updated'); return returnObj; }

	// If depth changed, cascade to children
	if (updateObj.depth !== undefined) {
		await cascadeDepth(parseInt(id), updateObj.depth);
	}

	returnObj.status = true;
	return returnObj;
}

/**
 * Recursively update depth on all descendants after a parent's depth changes.
 */
async function cascadeDepth(parentId, parentDepth) {
	var children = await getChildren(parentId);
	for (var child of children) {
		var newDepth = parentDepth + 1;
		if (child.depth !== newDepth) {
			await postgres.write(
				'UPDATE coordinator_segments SET depth = $1 WHERE id = $2',
				[newDepth, child.id]
			);
			await cascadeDepth(child.id, newDepth);
		}
	}
}

async function remove(id) {
	var returnObj = { status: false, errormessages: [] };

	// Prevent deleting segments that have children
	var children = await getChildren(id);
	if (children.length > 0) {
		returnObj.errormessages.push('Cannot delete segment with children. Remove child segments first.');
		return returnObj;
	}

	// Clear segment_id on managed nodes
	await postgres.write('UPDATE managed_nodes SET segment_id = NULL WHERE segment_id = $1', [parseInt(id)]);
	var err = await postgres.write('DELETE FROM coordinator_segments WHERE id = $1', [parseInt(id)]);
	if (err) { returnObj.errormessages.push('Delete failed: ' + err.message); return returnObj; }
	returnObj.status = true;
	return returnObj;
}

export {
	DEFAULT_ROLES,
	ROLE_LABELS,
	VALID_SOURCES,
	DISTRIBUTION_METHODS,
	getRolesForNetwork,
	getChildRoles,
	getAll,
	getByNetwork,
	getById,
	getChildren,
	getRootSegments,
	getTree,
	create,
	update,
	remove
};
