import * as alogger from "../../utils/alogger.js";
import { getClient, hSet, hGetAll, del, exists, expire, keys } from "./redis.js";
import appConfig from "../../config/appConfig.js";

const SESSION_PREFIX = "session:";
const SESSION_INDEX_PREFIX = "session_index:";

// --- Session CRUD ---

async function sessionStore(sessionId, data, ttl) {
	var sessionKey = SESSION_PREFIX + sessionId;
	var sessionTtl = ttl || appConfig.getNumber('session_ttl', 2880) * 60;
	data._session_ttl = String(sessionTtl);
	var ok = await hSet(sessionKey, data);
	if (ok) {
		await expire(sessionKey, sessionTtl);
		// Index this session by username for reverse lookup
		if (data.username) {
			await _addSessionIndex(data.username, sessionId);
		}
	}
	return ok;
}

async function sessionGet(sessionId) {
	var sessionKey = SESSION_PREFIX + sessionId;
	var data = await hGetAll(sessionKey);
	if (!data) return null;

	// Parse JSON fields back to native types
	if (data.permissionflags) {
		try { data.permissionflags = JSON.parse(data.permissionflags); } catch (_) { data.permissionflags = []; }
	}
	if (data.restrictionflags) {
		try { data.restrictionflags = JSON.parse(data.restrictionflags); } catch (_) { data.restrictionflags = []; }
	}
	if (data.isSysop) {
		data.isSysop = data.isSysop === "true";
	}
	if (data.security) {
		data.security = parseInt(data.security) || 0;
	}

	return data;
}

async function sessionDestroy(sessionId) {
	// Remove from username index before deleting
	var data = await hGetAll(SESSION_PREFIX + sessionId);
	if (data && data.username) {
		await _removeSessionIndex(data.username, sessionId);
	}
	return await del(SESSION_PREFIX + sessionId);
}

async function sessionExists(sessionId) {
	return await exists(SESSION_PREFIX + sessionId);
}

async function sessionRenew(sessionId, ttl) {
	// Read the session whether or not a ttl was passed, because the username
	// index has to be refreshed alongside it and that needs the username.
	var stored = await hGetAll(SESSION_PREFIX + sessionId);
	if (!ttl && stored && stored._session_ttl) {
		ttl = parseInt(stored._session_ttl);
	}

	// Keep the reverse index alive as long as the session it points at.
	//
	// The index was written once at login with an expiry of twice session_ttl
	// and never touched again, while the session hash itself was renewed on
	// every page view. A Remember Me session outlives its own index entry by
	// days, and once it has dropped out, every sessionUpdateUser broadcast
	// silently skips it: a config change, a security level change, or the call
	// flow marking itself complete reaches every session but that one. The
	// call flow case was a visible loop, being forced back to the same page on
	// every request with no way out. The others just went quietly stale.
	if (stored && stored.username) {
		await _addSessionIndex(stored.username, sessionId);
	}

	return await expire(SESSION_PREFIX + sessionId, ttl || appConfig.getNumber('session_ttl', 2880) * 60);
}

async function sessionList() {
	return await keys(SESSION_PREFIX + "*");
}

// --- Session-user index ---
// Maps username -> set of session IDs for reverse lookup

async function _addSessionIndex(username, sessionId) {
	try {
		var rc = await getClient();
		var indexKey = SESSION_INDEX_PREFIX + username.toLowerCase();
		await rc.sAdd(indexKey, sessionId);
		await rc.expire(indexKey, appConfig.getNumber('session_ttl', 60) * 60 * 2);
	} catch (err) {
		alogger.writeAlog(4, "Session index add error: " + err.message, "yellow");
	}
}

async function _removeSessionIndex(username, sessionId) {
	try {
		var rc = await getClient();
		var indexKey = SESSION_INDEX_PREFIX + username.toLowerCase();
		await rc.sRem(indexKey, sessionId);
	} catch (err) {
		alogger.writeAlog(4, "Session index remove error: " + err.message, "yellow");
	}
}

async function _getSessionsByUsername(username) {
	try {
		var rc = await getClient();
		var indexKey = SESSION_INDEX_PREFIX + username.toLowerCase();
		var sessionIds = await rc.sMembers(indexKey);
		// Prune expired sessions from the index
		var validIds = [];
		for (var sid of sessionIds) {
			var stillExists = await exists(SESSION_PREFIX + sid);
			if (stillExists) {
				validIds.push(sid);
			} else {
				await rc.sRem(indexKey, sid);
			}
		}
		return validIds;
	} catch (err) {
		alogger.writeAlog(2, "Session index lookup error: " + err.message, "redbright");
		return [];
	}
}

// --- Session update by username ---
// Updates specific fields on all active sessions for a given username.
// Usage: await sessionUpdateUser("someuser", { security: "255", isSysop: "true" })

async function sessionUpdateUser(username, fields) {
	var sessionIds = await _getSessionsByUsername(username);
	if (sessionIds.length === 0) return 0;

	var updated = 0;
	for (var sid of sessionIds) {
		var ok = await hSet(SESSION_PREFIX + sid, fields);
		if (ok) updated++;
	}

	alogger.writeAlog(5, "Updated " + updated + " session(s) for " + username, "cyan");
	return updated;
}

// Update specific fields on a session by session ID.
async function sessionUpdate(sessionid, fields) {
	if (!sessionid || !fields) return false;
	return await hSet(SESSION_PREFIX + sessionid, fields);
}

// Destroy all sessions for a user except optionally the current one.
async function destroyAllForUser(username, exceptSessionId) {
	var sessionIds = await _getSessionsByUsername(username);
	var destroyed = 0;
	for (var sid of sessionIds) {
		if (exceptSessionId && sid === exceptSessionId) continue;
		await del(SESSION_PREFIX + sid);
		destroyed++;
	}
	// Rebuild the index with only the kept session
	if (exceptSessionId) {
		var rc = await getClient();
		var indexKey = SESSION_INDEX_PREFIX + username.toLowerCase();
		await rc.del(indexKey);
		await rc.sAdd(indexKey, exceptSessionId);
	} else {
		var rc = await getClient();
		await rc.del(SESSION_INDEX_PREFIX + username.toLowerCase());
	}
	alogger.writeAlog(5, "Destroyed " + destroyed + " session(s) for " + username + (exceptSessionId ? " (kept current)" : ""), "cyan");
	return destroyed;
}

export {
	sessionStore,
	sessionGet,
	sessionDestroy,
	sessionExists,
	sessionRenew,
	sessionList,
	sessionUpdate,
	sessionUpdateUser,
	destroyAllForUser
};