import * as alogger from "../../utils/alogger.js";
import { getClient, hSet, hGetAll, del, exists, expire, keys } from "./redis.js";
import appConfig from "../../config/appConfig.js";

const SESSION_PREFIX = "session:";
const SESSION_INDEX_PREFIX = "session_index:";

// --- Session CRUD ---

async function sessionStore(sessionId, data, ttl) {
	var sessionKey = SESSION_PREFIX + sessionId;
	var ok = await hSet(sessionKey, data);
	if (ok) {
		await expire(sessionKey, ttl || appConfig.getNumber('session_ttl', 60) * 60);
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
	return await expire(SESSION_PREFIX + sessionId, ttl || appConfig.getNumber('session_ttl', 60) * 60);
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

export {
	sessionStore,
	sessionGet,
	sessionDestroy,
	sessionExists,
	sessionRenew,
	sessionList,
	sessionUpdateUser
};