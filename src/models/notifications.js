// notifications.js -- Centralised notification system.
//
// Sysop alerts (user_id = NULL): operational events visible to all sysops.
// User notifications (user_id = N): activity events for a specific user.
//
// Delivered in real-time via PresenceSocket. Persisted in PostgreSQL.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

// Reference to PresenceServer instance for push delivery.
// Set by gateway startup via setPresenceServer().
var _presenceServer = null;

function setPresenceServer(server) {
	_presenceServer = server;
}

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

async function ensureTable() {
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS notifications (
			id SERIAL PRIMARY KEY,
			user_id INTEGER,
			type VARCHAR(32) NOT NULL,
			title VARCHAR(256) NOT NULL,
			body TEXT,
			link VARCHAR(512),
			icon VARCHAR(32) DEFAULT 'info',
			severity VARCHAR(16) DEFAULT 'info',
			read BOOLEAN DEFAULT false,
			read_at TIMESTAMP,
			created_at TIMESTAMP DEFAULT NOW()
		)
	`);

	await postgres.write(
		"CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications(user_id, read, created_at DESC)"
	);
	await postgres.write(
		"CREATE INDEX IF NOT EXISTS idx_notif_sysop ON notifications(created_at DESC) WHERE user_id IS NULL"
	);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// Create a notification for a specific user.
async function create(userId, type, title, body, opts) {
	if (!appConfig.getBoolean('notifications_enabled', true)) return null;

	opts = opts || {};
	var dbObj = {
		user_id: userId,
		type: type,
		title: (title || '').substring(0, 256),
		body: body || null,
		link: opts.link || null,
		icon: opts.icon || 'info',
		severity: opts.severity || 'info',
		read: false,
		created_at: new Date()
	};

	var result = await postgres.insertObject(dbObj, 'notifications');
	if (!result.status) return null;

	var notifId = result.insertId;

	// Push via PresenceSocket
	if (_presenceServer && userId) {
		_presenceServer._sendToUser(userId, {
			type: 'notification',
			id: notifId,
			notifType: type,
			title: dbObj.title,
			body: dbObj.body,
			link: dbObj.link,
			icon: dbObj.icon,
			severity: dbObj.severity
		});
	}

	return notifId;
}

// Create a sysop broadcast notification (user_id = NULL).
async function createSysop(type, title, body, opts) {
	if (!appConfig.getBoolean('notifications_enabled', true)) return null;

	opts = opts || {};
	var dbObj = {
		user_id: null,
		type: type,
		title: (title || '').substring(0, 256),
		body: body || null,
		link: opts.link || null,
		icon: opts.icon || 'exclamation-triangle',
		severity: opts.severity || 'warning',
		read: false,
		created_at: new Date()
	};

	var result = await postgres.insertObject(dbObj, 'notifications');
	if (!result.status) return null;

	var notifId = result.insertId;

	// Push to all connected sysop users
	if (_presenceServer) {
		_pushToSysops({
			type: 'notification',
			id: notifId,
			notifType: type,
			title: dbObj.title,
			body: dbObj.body,
			link: dbObj.link,
			icon: dbObj.icon,
			severity: dbObj.severity
		});
	}

	return notifId;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// Get unread notifications for a user (including sysop broadcasts if sysop).
async function getUnread(userId, isSysop, limit) {
	var max = limit || 20;
	if (isSysop) {
		return await postgres.query(
			'SELECT * FROM notifications WHERE (user_id = $1 OR user_id IS NULL) AND read = false ORDER BY created_at DESC LIMIT $2',
			[userId, max]
		) || [];
	}
	return await postgres.query(
		'SELECT * FROM notifications WHERE user_id = $1 AND read = false ORDER BY created_at DESC LIMIT $2',
		[userId, max]
	) || [];
}

// Get all notifications with pagination.
async function getAll(userId, isSysop, limit, offset) {
	var max = limit || 50;
	var off = offset || 0;
	if (isSysop) {
		return await postgres.query(
			'SELECT * FROM notifications WHERE (user_id = $1 OR user_id IS NULL) ORDER BY created_at DESC LIMIT $2 OFFSET $3',
			[userId, max, off]
		) || [];
	}
	return await postgres.query(
		'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
		[userId, max, off]
	) || [];
}

// Get unread count.
async function getUnreadCount(userId, isSysop) {
	var row;
	if (isSysop) {
		row = await postgres.queryOne(
			'SELECT COUNT(*) AS cnt FROM notifications WHERE (user_id = $1 OR user_id IS NULL) AND read = false',
			[userId]
		);
	} else {
		row = await postgres.queryOne(
			'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = $1 AND read = false',
			[userId]
		);
	}
	return row ? parseInt(row.cnt) : 0;
}

// Mark a single notification as read.
async function markRead(id, userId) {
	await postgres.write(
		'UPDATE notifications SET read = true, read_at = NOW() WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
		[id, userId]
	);
}

// Mark all as read for a user.
async function markAllRead(userId, isSysop) {
	if (isSysop) {
		await postgres.write(
			'UPDATE notifications SET read = true, read_at = NOW() WHERE (user_id = $1 OR user_id IS NULL) AND read = false',
			[userId]
		);
	} else {
		await postgres.write(
			'UPDATE notifications SET read = true, read_at = NOW() WHERE user_id = $1 AND read = false',
			[userId]
		);
	}
}

// Get a single notification by ID.
async function getById(id) {
	return await postgres.queryOne('SELECT * FROM notifications WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

// Purge read notifications older than retention period.
async function purgeOld(days) {
	var retention = days || appConfig.getNumber('notifications_retention_days', 30);
	if (retention <= 0) return 0;

	var result = await postgres.query(
		"DELETE FROM notifications WHERE read = true AND read_at < NOW() - ($1 || ' days')::interval RETURNING id",
		[retention.toString()]
	);
	var count = result ? result.length : 0;
	if (count > 0) {
		alogger.writeAlog(3, 'Notifications: purged ' + count + ' old read notification(s)', 'cyan');
	}
	return count;
}

// ---------------------------------------------------------------------------
// Push helpers
// ---------------------------------------------------------------------------

// Push a message to all connected users with Sysop permission.
function _pushToSysops(msg) {
	if (!_presenceServer) return;

	var json = JSON.stringify(msg);
	for (var [ws, client] of _presenceServer.clients) {
		// We need to check if this client is a sysop.
		// The session data includes permissionflags.
		// Rather than re-querying, we check a cached flag set during connect.
		if (client._isSysop && ws.readyState === 1) {
			ws.send(json);
		}
	}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	ensureTable,
	setPresenceServer,
	create,
	createSysop,
	getUnread,
	getAll,
	getUnreadCount,
	markRead,
	markAllRead,
	getById,
	purgeOld
};
