// webActivity.js - Web session activity tracking and presence.
//
// Middleware: tracks last web activity per session. Logs a new call record
// when activity resumes after an idle period (configurable threshold).
//
// Presence: Redis-backed online user tracking. Updated by the WebSocket
// heartbeat. Provides getOnlineUsers() for "who's online" views.

import * as redis from './db/redis.js';
import * as sessionStore from './db/sessionstore.js';
import * as callers from '../models/callers.js';
import * as userAccounts from '../models/useraccounts.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

var PRESENCE_PREFIX = 'presence:web:';
var PRESENCE_SET = 'presence:web:online';
var PRESENCE_TTL = 120; // seconds before presence expires (heartbeat interval should be < this)

// ==========================================================================
// Activity Middleware
// ==========================================================================

// Express middleware: attach to the app after cookie/session middleware.
// Checks last_web_activity on the session, logs a new call if idle threshold exceeded.
function activityMiddleware(req, res, next) {
	// Skip non-authenticated requests and static assets
	if (!req.cookies || !req.cookies.sessionid) return next();
	if (req.path.startsWith('/health') || req.path.startsWith('/js/') ||
		req.path.startsWith('/css/') || req.path.startsWith('/images/')) return next();

	// Fire and forget - don't block the request
	_trackActivity(req).catch(function() {});
	next();
}

async function _trackActivity(req) {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return;

	var session = await sessionStore.sessionGet(sessionid);
	if (!session || !session.id) return;

	// Renew session TTL on every page view
	await sessionStore.sessionRenew(sessionid);

	var now = Date.now();
	var thresholdMs = appConfig.getNumber('web_idle_threshold', 30) * 60 * 1000;

	// Check last activity timestamp
	var rc = await redis.getClient();
	var activityKey = 'web_activity:' + sessionid;
	var lastActivity = await rc.get(activityKey);

	if (!lastActivity || (now - parseInt(lastActivity)) > thresholdMs) {
		// New engagement session - log a call
		try {
			var user = await userAccounts.getUserRecord(session.username);
			if (user) {
				var clientIp = req.ip || (req.connection && req.connection.remoteAddress) || '';
				await callers.logCall(user, 'Web', clientIp, user.location || '');
				userAccounts.updateUserCalls(user);
				alogger.writeAlog(5, 'Web activity resumed for ' + session.username + ' (new call logged)', 'cyan');
			}
		} catch (err) {
			alogger.writeAlog(4, 'Web activity tracking error: ' + err.message, 'yellow');
		}
	}

	// Update last activity timestamp (expires with session)
	await rc.set(activityKey, String(now), { EX: appConfig.getNumber('session_ttl', 60) * 60 });
}

// ==========================================================================
// Presence (Redis-backed online tracking)
// ==========================================================================

// Called by WebSocket heartbeat to mark a user as online.
// Preserves any existing activity string set by setActivity().
async function markOnline(userId, username) {
	try {
		var rc = await redis.getClient();
		var userKey = PRESENCE_PREFIX + userId;

		// Read existing entry to preserve activity field
		var existing = null;
		var raw = await rc.get(userKey);
		if (raw) {
			try { existing = JSON.parse(raw); } catch (_) {}
		}

		var data = JSON.stringify({
			userId: userId,
			username: username,
			lastSeen: Date.now(),
			source: 'web',
			activity: (existing && existing.activity) || null
		});
		await rc.set(userKey, data, { EX: PRESENCE_TTL });
		await rc.sAdd(PRESENCE_SET, String(userId));
	} catch (err) {
		alogger.writeAlog(4, 'Presence markOnline error: ' + err.message, 'yellow');
	}
}

// Set a specific activity string for a web user (e.g. "Reading Mail", "Browsing Files").
// Activity clears automatically when the presence entry expires.
async function setActivity(userId, activity) {
	try {
		var rc = await redis.getClient();
		var userKey = PRESENCE_PREFIX + userId;
		var raw = await rc.get(userKey);
		if (!raw) return;
		var entry = JSON.parse(raw);
		entry.activity = activity || null;
		entry.lastSeen = Date.now();
		var ttl = await rc.ttl(userKey);
		await rc.set(userKey, JSON.stringify(entry), { EX: ttl > 0 ? ttl : PRESENCE_TTL });
	} catch (err) {
		alogger.writeAlog(4, 'Presence setActivity error: ' + err.message, 'yellow');
	}
}

// Called on disconnect or session end.
async function markOffline(userId) {
	try {
		var rc = await redis.getClient();
		await rc.del(PRESENCE_PREFIX + userId);
		await rc.sRem(PRESENCE_SET, String(userId));
	} catch (err) {
		alogger.writeAlog(4, 'Presence markOffline error: ' + err.message, 'yellow');
	}
}

// Get list of online web users. Prunes expired entries.
async function getOnlineUsers() {
	try {
		var rc = await redis.getClient();
		var memberIds = await rc.sMembers(PRESENCE_SET);
		var users = [];

		for (var uid of (memberIds || [])) {
			var data = await rc.get(PRESENCE_PREFIX + uid);
			if (data) {
				try {
					users.push(JSON.parse(data));
				} catch (_) {}
			} else {
				// Expired - prune from set
				await rc.sRem(PRESENCE_SET, uid);
			}
		}

		return users;
	} catch (err) {
		alogger.writeAlog(4, 'Presence getOnlineUsers error: ' + err.message, 'yellow');
		return [];
	}
}

export {
	activityMiddleware,
	markOnline,
	markOffline,
	setActivity,
	getOnlineUsers
};
