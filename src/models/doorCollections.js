// src/models/doorCollections.js
// Door collection/category management.
// Collections group doors for presentation in web and terminal views.
// A door can belong to multiple collections (many-to-many).

import * as postgres from '../middleware/db/postgres.js';

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
		active: data.active !== 'false' && data.active !== false,
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

async function updateCollection(id, data) {
	var obj = {
		name: (data.name || '').trim(),
		description: (data.description || '').trim() || null,
		icon_url: (data.icon_url || '').trim() || null,
		sort_order: parseInt(data.sort_order) || 0,
		active: data.active !== 'false' && data.active !== false,
		updated_at: new Date()
	};

	await postgres.updateById(id, obj, 'door_collections');
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
		'SELECT d.*, dce.sort_order AS collection_sort, dce.id AS entry_id ' +
		'FROM doors d ' +
		'INNER JOIN door_collection_entries dce ON dce.door_id = d.id ' +
		'WHERE dce.collection_id = $1 ' +
		'ORDER BY dce.sort_order ASC, d.name ASC',
		[collectionId]
	);
	return rows || [];
}

async function addDoorToCollection(collectionId, doorId, sortOrder) {
	// Check if already in collection
	var existing = await postgres.queryOne(
		'SELECT id FROM door_collection_entries WHERE collection_id = $1 AND door_id = $2',
		[collectionId, doorId]
	);
	if (existing) return { status: true, duplicate: true };

	var obj = {
		collection_id: collectionId,
		door_id: doorId,
		sort_order: sortOrder || 0,
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
	getAllCollections,
	getActiveCollections,
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
	getCollectionsForDoor,
	getCollectionCounts
};
