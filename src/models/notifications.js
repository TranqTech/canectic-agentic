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

	// Clean up legacy broadcast rows if any (now using per-user rows instead)
	// notification_reads table no longer needed -- all notifications are per-user
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

// Create a sysop notification -- one row per sysop user.
async function createSysop(type, title, body, opts) {
	if (!appConfig.getBoolean('notifications_enabled', true)) return null;

	opts = opts || {};
	var truncTitle = (title || '').substring(0, 256);
	var icon = opts.icon || 'exclamation-triangle';
	var severity = opts.severity || 'warning';
	var link = opts.link || null;
	var now = new Date();

	// Find all sysop users
	var sysops = await postgres.query(
		"SELECT id FROM users WHERE active = true AND permissionflags @> '[\"Sysop\"]'::jsonb",
		[]
	);
	if (!sysops || sysops.length === 0) return null;

	var ids = [];
	for (var sysop of sysops) {
		var dbObj = {
			user_id: sysop.id,
			type: type,
			title: truncTitle,
			body: body || null,
			link: link,
			icon: icon,
			severity: severity,
			read: false,
			created_at: now
		};

		var result = await postgres.insertObject(dbObj, 'notifications');
		if (result.status && result.insertId) {
			ids.push(result.insertId);

			// Push via PresenceSocket
			if (_presenceServer) {
				_presenceServer._sendToUser(sysop.id, {
					type: 'notification',
					id: result.insertId,
					notifType: type,
					title: truncTitle,
					body: body || null,
					link: link,
					icon: icon,
					severity: severity
				});
			}
		}
	}

	return ids.length > 0 ? ids[0] : null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// Get unread notifications for a user.
// All notifications are per-user (sysop broadcasts create one row per sysop).
async function getUnread(userId, isSysop, limit) {
	var max = limit || 20;
	return await postgres.query(
		'SELECT * FROM notifications WHERE user_id = $1 AND read = false ORDER BY created_at DESC LIMIT $2',
		[userId, max]
	) || [];
}

// Get all notifications with pagination.
async function getAll(userId, isSysop, limit, offset) {
	var max = limit || 50;
	var off = offset || 0;
	return await postgres.query(
		'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
		[userId, max, off]
	) || [];
}

// Get unread count.
async function getUnreadCount(userId, isSysop) {
	var row = await postgres.queryOne(
		'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = $1 AND read = false',
		[userId]
	);
	return row ? parseInt(row.cnt) : 0;
}

// Mark a single notification as read.
async function markRead(id, userId) {
	await postgres.write(
		'UPDATE notifications SET read = true, read_at = NOW() WHERE id = $1 AND user_id = $2',
		[id, userId]
	);
}

// Mark all as read for a user.
async function markAllRead(userId) {
	await postgres.write(
		'UPDATE notifications SET read = true, read_at = NOW() WHERE user_id = $1 AND read = false',
		[userId]
	);
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
