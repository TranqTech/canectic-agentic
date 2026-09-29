// src/models/doorCollections.js
// Door collection/category management.
// Collections group doors for presentation in web and terminal views.
// A door can belong to multiple collections (many-to-many).
//
// A collection's audience says who sees it (#89): 'local' (this board's
// callers), 'doorserver' (BBSes connecting to our door server) or 'both'.
// Within a collection the door server sees, each entry's `doorserver` flag
// says whether that door is offered. That is the ONLY way a door becomes
// launchable by a door-server session (doors.doorserver_available, the
// per-door setting 0.9.13a shipped, is no longer read; migration 0011
// carried it over). A door-server-only collection is hidden from local
// callers, but a door in it still shows locally through any local collection.

import * as postgres from '../middleware/db/postgres.js';

var AUDIENCES = ['local', 'doorserver', 'both'];
var AUDIENCE_LABELS = { local: 'This board', doorserver: 'Door server', both: 'Both' };

// Launch types that may never be offered through our door server: a door on
// another system would be passed on under our credentials, and could loop.
var NEVER_OFFERED_TYPES = ['Remote'];

function normaliseAudience(value, fallback) {
	var v = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
	return AUDIENCES.indexOf(v) !== -1 ? v : (fallback === undefined ? 'local' : fallback);
}

function isAudience(value) {
	return AUDIENCES.indexOf(String(value === undefined || value === null ? '' : value).trim().toLowerCase()) !== -1;
}

function offersToDoorserver(audience) {
	return audience === 'doorserver' || audience === 'both';
}

function showsLocally(audience) {
	return audience !== 'doorserver';
}

// An HTML checkbox that is unticked sends nothing, so absence means false.
function checkboxValue(v) {
	return v === true || v === 'true' || v === 'on' || v === '1';
}

// --- Collection CRUD ---

async function getAllCollections() {
	var rows = await postgres.query(
		'SELECT * FROM door_collections ORDER BY sort_order ASC, name ASC'
	);
	return rows || [];
}

async function getActiveCollections() {
	var rows = await postgres.query(
		'SELECT * FROM door_collections WHERE active = true ORDER BY sort_order ASC, name ASC'
	);
	return rows || [];
}

/** Active collections this board's own callers see (web and terminal). */
async function getLocalCollections() {
	var rows = await postgres.query(
		"SELECT * FROM door_collections WHERE active = true AND COALESCE(audience, 'local') <> 'doorserver' " +
		'ORDER BY sort_order ASC, name ASC'
	);
	return rows || [];
}

/**
 * Door ids hidden from local callers: in at least one collection, and in no
 * collection local callers see. Used where doors are listed without
 * collections (the flat fallback on a board with no local collections).
 */
async function doorIdsHiddenLocally() {
	var rows = await postgres.query(
		'SELECT dce.door_id FROM door_collection_entries dce ' +
		'JOIN door_collections dc ON dc.id = dce.collection_id ' +
		'GROUP BY dce.door_id ' +
		"HAVING bool_and(COALESCE(dc.audience, 'local') = 'doorserver')"
	);
	return new Set((rows || []).map(function (r) { return r.door_id; }));
}

/**
 * What the door server offers, by collection: active collections whose
 * audience includes the door server, each with its offered, active doors.
 * Collections with nothing offered are left out.
 * returns [{ slug, name, description, doors: [{ slug, name, description }] }]
 */
async function offeredCollections() {
	var rows = await postgres.query(
		'SELECT dc.id AS collection_id, dc.slug AS collection_slug, dc.name AS collection_name, ' +
		'dc.description AS collection_description, d.slug, d.name, d.description ' +
		'FROM door_collections dc ' +
		'JOIN door_collection_entries dce ON dce.collection_id = dc.id AND dce.doorserver = true ' +
		'JOIN doors d ON d.id = dce.door_id AND d.active = true ' +
		"WHERE dc.active = true AND dc.audience IN ('doorserver', 'both') AND NOT (d.launch_type = ANY($1)) " +
		'ORDER BY dc.sort_order ASC, dc.name ASC, dce.sort_order ASC, d.name ASC',
		[NEVER_OFFERED_TYPES]
	);
	var out = [], byId = {};
	for (var r of rows || []) {
		var c = byId[r.collection_id];
		if (!c) {
			c = byId[r.collection_id] = { slug: r.collection_slug, name: r.collection_name, description: r.collection_description || '', doors: [] };
			out.push(c);
		}
		c.doors.push({ slug: r.slug, name: r.name, description: r.description || '' });
	}
	return out;
}

/** The offered doors as one list, each door once, in collection order. */
function flattenOffered(collections) {
	var seen = new Set(), doors = [];
	for (var c of collections || []) {
		for (var d of c.doors) {
			if (seen.has(d.slug)) continue;
			seen.add(d.slug);
			doors.push(d);
		}
	}
	return doors;
}

/** Whether a door-server session may launch this door (by door id). */
async function isDoorOffered(doorId) {
	var row = await postgres.queryOne(
		'SELECT 1 AS ok FROM door_collection_entries dce ' +
		'JOIN door_collections dc ON dc.id = dce.collection_id ' +
		'JOIN doors d ON d.id = dce.door_id ' +
		"WHERE dce.door_id = $1 AND dce.doorserver = true AND dc.active = true AND dc.audience IN ('doorserver', 'both') " +
		'AND NOT (d.launch_type = ANY($2)) LIMIT 1',
		[doorId, NEVER_OFFERED_TYPES]
	);
	return !!row;
}

async function getCollectionBySlug(slug) {
	return await postgres.queryOne(
		'SELECT * FROM door_collections WHERE slug = $1',
		[slug]
	);
}

async function getCollectionById(id) {
	return await postgres.queryOne(
		'SELECT * FROM door_collections WHERE id = $1',
		[id]
	);
}

async function createCollection(data) {
	var result = { status: false, errormessages: [], collectionId: null };

	var name = (data.name || '').trim();
	var slug = (data.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
	if (!name) {
		result.errormessages.push('Name is required');
		return result;
	}
	if (!slug) {
		result.errormessages.push('Slug is required');
		return result;
	}

	var existing = await postgres.queryOne('SELECT id FROM door_collections WHERE slug = $1', [slug]);
	if (existing) {
		result.errormessages.push('A collection with that slug already exists');
		return result;
	}

	var obj = {
		slug: slug,
		name: name,
		description: (data.description || '').trim() || null,
		icon_url: (data.icon_url || '').trim() || null,
		sort_order: parseInt(data.sort_order) || 0,
		active: checkboxValue(data.active),
		audience: normaliseAudience(data.audience),
		created_at: new Date(),
		updated_at: new Date()
	};

	var insertResult = await postgres.insertObject(obj, 'door_collections');
	if (insertResult.status) {
		result.status = true;
		result.collectionId = insertResult.insertId;
	} else {
		result.errormessages.push('Database insert failed');
	}
	return result;
}

/**
 * Update a collection. The audience is NOT changed here when the change
 * would start offering doors to the door server: that goes through
 * setAudience, after the sysop has seen which doors it offers. The result
 * says so (pendingAudience) so the route can show that step.
 */
async function updateCollection(id, data) {
	var obj = {
		name: (data.name || '').trim(),
		description: (data.description || '').trim() || null,
		icon_url: (data.icon_url || '').trim() || null,
		sort_order: parseInt(data.sort_order) || 0,
		// Unticked sends nothing; this used to read absence as active, so a
		// collection could not be switched off from the edit form.
		active: checkboxValue(data.active),
		updated_at: new Date()
	};
	var result = { status: true, pendingAudience: null };
	if (isAudience(data.audience)) {
		var current = await getCollectionById(id);
		var wanted = normaliseAudience(data.audience);
		var was = normaliseAudience(current && current.audience);
		if (wanted !== was) {
			if (offersToDoorserver(wanted) && !offersToDoorserver(was)) result.pendingAudience = wanted;
			else obj.audience = wanted;
		}
	}

	await postgres.updateById(id, obj, 'door_collections');
	return result;
}

/**
 * Set a collection's audience and, when it includes the door server, which of
 * its doors are offered (an array of door ids; the rest are not offered).
 */
async function setAudience(id, audience, offeredDoorIds) {
	var a = normaliseAudience(audience, null);
	if (!a) return { status: false, errormessages: ['Unknown audience'] };
	await postgres.write('UPDATE door_collections SET audience = $1, updated_at = NOW() WHERE id = $2', [a, id]);
	if (offersToDoorserver(a) && Array.isArray(offeredDoorIds)) {
		var ids = offeredDoorIds.map(function (x) { return parseInt(x); }).filter(function (x) { return x > 0; });
		await postgres.write('UPDATE door_collection_entries SET doorserver = (door_id = ANY($2::int[])) WHERE collection_id = $1', [id, ids]);
	}
	return { status: true };
}

/** Offer (or stop offering) one door of a collection to the door server. */
async function setEntryOffered(collectionId, doorId, offered) {
	await postgres.write(
		'UPDATE door_collection_entries SET doorserver = $3 WHERE collection_id = $1 AND door_id = $2',
		[collectionId, doorId, !!offered]
	);
	return { status: true };
}

async function deleteCollection(id) {
	await postgres.write('DELETE FROM door_collection_entries WHERE collection_id = $1', [id]);
	await postgres.write('DELETE FROM door_collections WHERE id = $1', [id]);
	return { status: true };
}

// --- Collection entries (many-to-many) ---

async function getDoorsInCollection(collectionId) {
	var rows = await postgres.query(
		'SELECT d.*, dce.sort_order AS collection_sort ' +
		'FROM doors d ' +
		'INNER JOIN door_collection_entries dce ON dce.door_id = d.id ' +
		'WHERE dce.collection_id = $1 AND d.active = true ' +
		'ORDER BY dce.sort_order ASC, d.name ASC',
		[collectionId]
	);
	return rows || [];
}

async function getAllDoorsInCollection(collectionId) {
	// Includes inactive doors (for admin view)
	var rows = await postgres.query(
		'SELECT d.*, dce.sort_order AS collection_sort, dce.id AS entry_id, dce.doorserver AS offered ' +
		'FROM doors d ' +
		'INNER JOIN door_collection_entries dce ON dce.door_id = d.id ' +
		'WHERE dce.collection_id = $1 ' +
		'ORDER BY dce.sort_order ASC, d.name ASC',
		[collectionId]
	);
	return rows || [];
}

/**
 * opts.offered: override whether the door is offered to the door server
 * (a duplicated door is not, until the sysop says so).
 */
async function addDoorToCollection(collectionId, doorId, sortOrder, opts) {
	// Check if already in collection
	var existing = await postgres.queryOne(
		'SELECT id FROM door_collection_entries WHERE collection_id = $1 AND door_id = $2',
		[collectionId, doorId]
	);
	if (existing) return { status: true, duplicate: true };

	// A door added to a collection the door server sees is offered at once;
	// the sysop chose that audience for the collection.
	var coll = await getCollectionById(collectionId);
	var door = await postgres.queryOne('SELECT launch_type FROM doors WHERE id = $1', [doorId]);
	var obj = {
		collection_id: collectionId,
		door_id: doorId,
		sort_order: sortOrder || 0,
		doorserver: !!(coll && offersToDoorserver(coll.audience) && door && NEVER_OFFERED_TYPES.indexOf(door.launch_type) === -1) &&
			!(opts && opts.offered === false),
		created_at: new Date()
	};

	var result = await postgres.insertObject(obj, 'door_collection_entries');
	return { status: result.status };
}

async function removeDoorFromCollection(collectionId, doorId) {
	await postgres.write(
		'DELETE FROM door_collection_entries WHERE collection_id = $1 AND door_id = $2',
		[collectionId, doorId]
	);
	return { status: true };
}

async function updateEntrySortOrder(collectionId, orderedDoorIds) {
	if (!orderedDoorIds || orderedDoorIds.length === 0) return;
	for (var i = 0; i < orderedDoorIds.length; i++) {
		await postgres.write(
			'UPDATE door_collection_entries SET sort_order = $1 WHERE collection_id = $2 AND door_id = $3',
			[i, collectionId, parseInt(orderedDoorIds[i])]
		);
	}
}

// Reorder the collections themselves. Writes sort_order on the
// door_collections rows in the supplied sequence so /doors and the
// admin list respect the drag-to-reorder ordering.
async function updateCollectionSortOrder(orderedCollectionIds) {
	if (!orderedCollectionIds || orderedCollectionIds.length === 0) return;
	for (var i = 0; i < orderedCollectionIds.length; i++) {
		await postgres.write(
			'UPDATE door_collections SET sort_order = $1, updated_at = NOW() WHERE id = $2',
			[i, parseInt(orderedCollectionIds[i])]
		);
	}
}

// --- Utility ---

// Get collections a specific door belongs to
async function getCollectionsForDoor(doorId) {
	var rows = await postgres.query(
		'SELECT dc.* FROM door_collections dc ' +
		'INNER JOIN door_collection_entries dce ON dce.collection_id = dc.id ' +
		'WHERE dce.door_id = $1 ORDER BY dc.sort_order ASC',
		[doorId]
	);
	return rows || [];
}

// Get count of active doors per collection (for display)
async function getCollectionCounts() {
	var rows = await postgres.query(
		'SELECT dce.collection_id, COUNT(*) as door_count ' +
		'FROM door_collection_entries dce ' +
		'INNER JOIN doors d ON d.id = dce.door_id AND d.active = true ' +
		'GROUP BY dce.collection_id'
	);
	var counts = {};
	for (var row of (rows || [])) {
		counts[row.collection_id] = parseInt(row.door_count);
	}
	return counts;
}

export {
	AUDIENCES,
	AUDIENCE_LABELS,
	NEVER_OFFERED_TYPES,
	normaliseAudience,
	isAudience,
	offersToDoorserver,
	showsLocally,
	checkboxValue,
	getAllCollections,
	getActiveCollections,
	getLocalCollections,
	doorIdsHiddenLocally,
	offeredCollections,
	flattenOffered,
	isDoorOffered,
	setAudience,
	setEntryOffered,
	getCollectionBySlug,
	getCollectionById,
	createCollection,
	updateCollection,
	deleteCollection,
	getDoorsInCollection,
	getAllDoorsInCollection,
	addDoorToCollection,
	removeDoorFromCollection,
	updateEntrySortOrder,
	updateCollectionSortOrder,
	getCollectionsForDoor,
	getCollectionCounts
};
