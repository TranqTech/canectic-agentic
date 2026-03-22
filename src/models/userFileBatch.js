// userFileBatch.js — Persisted file download batch per user
//
// Stores tagged files so they survive session disconnects.
// Loaded into call.file_batch on login, synced on tag/untag,
// cleared on successful batch download.

import * as postgres from '../middleware/db/postgres.js';

var TABLE = 'user_file_batch';

/**
 * Load a user's persisted batch. Returns array matching call.file_batch format.
 */
async function loadBatch(userId) {
	var rows = await postgres.query(
		"SELECT file_entry_uuid AS uuid, file_entry_id AS id, filename, file_size, area_shortcode, disk_path FROM " + TABLE + " WHERE user_id = $1 ORDER BY added_at ASC",
		[userId]
	);
	return (rows || []).map(function(r) {
		return {
			uuid: r.uuid,
			id: parseInt(r.id) || 0,
			filename: r.filename,
			file_size: parseInt(r.file_size) || 0,
			area_shortcode: r.area_shortcode,
			disk_path: r.disk_path || r.filename
		};
	});
}

/**
 * Add a file to a user's batch. No-op if already tagged.
 */
async function addToBatch(userId, item) {
	var existing = await postgres.queryOne(
		"SELECT id FROM " + TABLE + " WHERE user_id = $1 AND file_entry_uuid = $2",
		[userId, item.uuid]
	);
	if (existing) return false;

	await postgres.write(
		"INSERT INTO " + TABLE + " (user_id, file_entry_uuid, file_entry_id, filename, file_size, area_shortcode, disk_path) VALUES ($1, $2, $3, $4, $5, $6, $7)",
		[userId, item.uuid, item.id, item.filename, item.file_size || 0, item.area_shortcode, item.disk_path || item.filename]
	);
	return true;
}

/**
 * Remove a file from a user's batch.
 */
async function removeFromBatch(userId, fileUuid) {
	await postgres.write(
		"DELETE FROM " + TABLE + " WHERE user_id = $1 AND file_entry_uuid = $2",
		[userId, fileUuid]
	);
}

/**
 * Clear a user's entire batch (after successful download).
 */
async function clearBatch(userId) {
	await postgres.write(
		"DELETE FROM " + TABLE + " WHERE user_id = $1",
		[userId]
	);
}

/**
 * Sync the full in-memory batch array to DB (replace all).
 * Used when the batch changes in ways other than single add/remove.
 */
async function syncBatch(userId, batchArray) {
	await postgres.write("DELETE FROM " + TABLE + " WHERE user_id = $1", [userId]);
	if (!batchArray || batchArray.length === 0) return;
	for (var item of batchArray) {
		await postgres.write(
			"INSERT INTO " + TABLE + " (user_id, file_entry_uuid, file_entry_id, filename, file_size, area_shortcode, disk_path) VALUES ($1, $2, $3, $4, $5, $6, $7)",
			[userId, item.uuid, item.id, item.filename, item.file_size || 0, item.area_shortcode, item.disk_path || item.filename]
		);
	}
}

/**
 * Get batch count for a user (for display without loading full batch).
 */
async function getBatchCount(userId) {
	var result = await postgres.queryOne(
		"SELECT COUNT(*) AS cnt FROM " + TABLE + " WHERE user_id = $1",
		[userId]
	);
	return result ? parseInt(result.cnt) : 0;
}

export {
	loadBatch,
	addToBatch,
	removeFromBatch,
	clearBatch,
	syncBatch,
	getBatchCount
};
