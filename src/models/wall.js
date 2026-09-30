// src/models/wall.js
// Wall / Oneliners -- short public messages displayed during login and on the web.

import * as postgres from '../middleware/db/postgres.js';
import appConfig from '../config/appConfig.js';

async function getRecentMessages(limit) {
	var rows = await postgres.query(
		'SELECT * FROM wall_messages ORDER BY created_at DESC LIMIT $1',
		[limit || 15]
	);
	// Reverse so newest is last (chronological display order)
	return rows ? rows.reverse() : [];
}

/** Whether anyone other than username has posted since the given time. */
async function hasMessagesSince(since, username) {
	var row = await postgres.queryOne(
		'SELECT 1 AS found FROM wall_messages WHERE created_at > $1 AND LOWER(username) <> LOWER($2) LIMIT 1',
		[since, username || '']
	);
	return !!row;
}

async function addMessage(userId, username, message) {
	var obj = {
		user_id: userId || null,
		username: username,
		message: message.substring(0, 160)
	};
	return await postgres.insertObject(obj, 'wall_messages');
}

async function deleteMessage(uuid) {
	return await postgres.write(
		'DELETE FROM wall_messages WHERE uuid = $1',
		[uuid]
	);
}

async function getCount() {
	var row = await postgres.queryOne(
		'SELECT COUNT(*) AS count FROM wall_messages'
	);
	return row ? parseInt(row.count) : 0;
}

async function purgeOldMessages() {
	var maxMessages = appConfig.getNumber('wall_max_messages', 60);
	if (maxMessages <= 0) return 0;

	var result = await postgres.write(
		'DELETE FROM wall_messages WHERE id NOT IN (SELECT id FROM wall_messages ORDER BY created_at DESC LIMIT $1)',
		[maxMessages]
	);
	return result?.rowCount || 0;
}

async function getAllMessages() {
	var rows = await postgres.query(
		'SELECT * FROM wall_messages ORDER BY created_at DESC'
	);
	return rows || [];
}

// Check if a user is allowed to post on the wall.
// user: { security, permissionflags, restrictionflags } or similar
function canPost(user) {
	if (!user) return false;

	var minSecurity = appConfig.getNumber('wall_post_security', 10);
	var userSecurity = parseInt(user.security) || 0;
	if (userSecurity < minSecurity) return false;

	var requiredRaw = appConfig.get('wall_post_required_flags', '');
	if (requiredRaw) {
		var required = requiredRaw.split(',').map(f => f.trim()).filter(Boolean);
		var userPerms = Array.isArray(user.permissionflags) ? user.permissionflags : [];
		for (var i = 0; i < required.length; i++) {
			if (!userPerms.includes(required[i])) return false;
		}
	}

	var restrictedRaw = appConfig.get('wall_post_restricted_flags', '');
	if (restrictedRaw) {
		var restricted = restrictedRaw.split(',').map(f => f.trim()).filter(Boolean);
		var userRestrictions = Array.isArray(user.restrictionflags) ? user.restrictionflags : [];
		for (var j = 0; j < restricted.length; j++) {
			if (userRestrictions.includes(restricted[j])) return false;
		}
	}

	return true;
}

export {
	getRecentMessages,
	hasMessagesSince,
	getAllMessages,
	addMessage,
	deleteMessage,
	purgeOldMessages,
	getCount,
	canPost
};
