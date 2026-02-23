import { createClient } from 'redis';
import * as dotenv from 'dotenv';
import * as alogger from "../../utils/alogger.js";

dotenv.config();

// --- Connection ---
const redisUrl = process.env.redis_url || 'redis://localhost:6379';
const defaultCacheTTL = parseInt(process.env.cache_ttl) || 3600;
const sessionTTL = parseInt(process.env.session_ttl) || 3600;

let client = null;
let connected = false;

async function getClient() {
	if (client && connected) return client;

	client = createClient({ url: redisUrl });

	client.on('error', (err) => {
		alogger.writeAlog(2, "Redis error: " + err.message, "redbright");
		connected = false;
	});

	client.on('end', () => {
		connected = false;
	});

	await client.connect();
	connected = true;
	return client;
}

async function shutdown() {
	if (client && connected) {
		try {
			await client.quit();
		} catch (_) {}
		connected = false;
		client = null;
	}
}

// --- Core key/value helpers ---

async function get(key) {
	try {
		var rc = await getClient();
		var val = await rc.get(key);
		return val;
	} catch (err) {
		alogger.writeAlog(2, "Redis GET error [" + key + "]: " + err.message, "redbright");
		return null;
	}
}

async function set(key, value, ttl) {
	try {
		var rc = await getClient();
		if (ttl) {
			await rc.set(key, value, { EX: ttl });
		} else {
			await rc.set(key, value);
		}
		return true;
	} catch (err) {
		alogger.writeAlog(2, "Redis SET error [" + key + "]: " + err.message, "redbright");
		return false;
	}
}

async function del(key) {
	try {
		var rc = await getClient();
		await rc.del(key);
		return true;
	} catch (err) {
		alogger.writeAlog(2, "Redis DEL error [" + key + "]: " + err.message, "redbright");
		return false;
	}
}

async function exists(key) {
	try {
		var rc = await getClient();
		var result = await rc.exists(key);
		return result === 1;
	} catch (err) {
		alogger.writeAlog(2, "Redis EXISTS error [" + key + "]: " + err.message, "redbright");
		return false;
	}
}

async function expire(key, ttl) {
	try {
		var rc = await getClient();
		await rc.expire(key, ttl);
		return true;
	} catch (err) {
		alogger.writeAlog(2, "Redis EXPIRE error [" + key + "]: " + err.message, "redbright");
		return false;
	}
}

async function keys(pattern) {
	try {
		var rc = await getClient();
		var result = await rc.keys(pattern);
		return result;
	} catch (err) {
		alogger.writeAlog(2, "Redis KEYS error [" + pattern + "]: " + err.message, "redbright");
		return [];
	}
}

// --- Hash helpers (for structured objects like sessions) ---

async function hSet(key, fieldOrObj, value) {
	try {
		var rc = await getClient();
		if (typeof fieldOrObj === "object") {
			// Set multiple fields from an object
			for (var field of Object.keys(fieldOrObj)) {
				var val = fieldOrObj[field];
				if (val === null || val === undefined) val = "";
				if (typeof val === "object") val = JSON.stringify(val);
				else val = String(val);
				await rc.hSet(key, field, val);
			}
		} else {
			if (value === null || value === undefined) value = "";
			await rc.hSet(key, fieldOrObj, String(value));
		}
		return true;
	} catch (err) {
		alogger.writeAlog(2, "Redis HSET error [" + key + "]: " + err.message, "redbright");
		return false;
	}
}

async function hGet(key, field) {
	try {
		var rc = await getClient();
		var val = await rc.hGet(key, field);
		return val;
	} catch (err) {
		alogger.writeAlog(2, "Redis HGET error [" + key + "." + field + "]: " + err.message, "redbright");
		return null;
	}
}

async function hGetAll(key) {
	try {
		var rc = await getClient();
		var val = await rc.hGetAll(key);
		// redis returns {} for non-existent keys
		if (val && Object.keys(val).length > 0) return val;
		return null;
	} catch (err) {
		alogger.writeAlog(2, "Redis HGETALL error [" + key + "]: " + err.message, "redbright");
		return null;
	}
}

// --- JSON cache helpers ---
// For caching configs, themes, menus, etc. as JSON with a namespace prefix

const CACHE_PREFIX = "cache:";

// Store an object in cache with optional TTL (defaults to defaultCacheTTL)
async function cacheSet(namespace, key, obj, ttl) {
	var cacheKey = CACHE_PREFIX + namespace + ":" + key;
	var cacheTTL = ttl || defaultCacheTTL;
	try {
		var json = JSON.stringify(obj);
		return await set(cacheKey, json, cacheTTL);
	} catch (err) {
		alogger.writeAlog(2, "Redis cacheSet error [" + cacheKey + "]: " + err.message, "redbright");
		return false;
	}
}

// Retrieve a cached object (returns parsed object or null)
async function cacheGet(namespace, key) {
	var cacheKey = CACHE_PREFIX + namespace + ":" + key;
	try {
		var json = await get(cacheKey);
		if (json) return JSON.parse(json);
		return null;
	} catch (err) {
		alogger.writeAlog(2, "Redis cacheGet error [" + cacheKey + "]: " + err.message, "redbright");
		return null;
	}
}

// Invalidate a specific cached item
async function cacheInvalidate(namespace, key) {
	var cacheKey = CACHE_PREFIX + namespace + ":" + key;
	return await del(cacheKey);
}

// Invalidate all items in a namespace (e.g. all menus, all themes)
async function cacheInvalidateAll(namespace) {
	var pattern = CACHE_PREFIX + namespace + ":*";
	try {
		var matchingKeys = await keys(pattern);
		if (matchingKeys.length > 0) {
			var rc = await getClient();
			await rc.del(matchingKeys);
			alogger.writeAlog(5, "Cache invalidated: " + namespace + " (" + matchingKeys.length + " keys)", "cyan");
		}
		return true;
	} catch (err) {
		alogger.writeAlog(2, "Redis cacheInvalidateAll error [" + namespace + "]: " + err.message, "redbright");
		return false;
	}
}

// Cache-through helper: returns cached value if available, otherwise calls
// the loader function, caches the result, and returns it.
// Usage: var config = await cacheThrough("config", "system", () => loadConfigFromDB())
async function cacheThrough(namespace, key, loaderFn, ttl) {
	var cached = await cacheGet(namespace, key);
	if (cached) return cached;

	try {
		var fresh = await loaderFn();
		if (fresh) {
			await cacheSet(namespace, key, fresh, ttl);
		}
		return fresh;
	} catch (err) {
		alogger.writeAlog(2, "Redis cacheThrough loader error [" + namespace + ":" + key + "]: " + err.message, "redbright");
		return null;
	}
}

export {
	// Connection
	getClient,
	shutdown,
	// Core
	get,
	set,
	del,
	exists,
	expire,
	keys,
	// Hash
	hSet,
	hGet,
	hGetAll,
	// Cache
	cacheSet,
	cacheGet,
	cacheInvalidate,
	cacheInvalidateAll,
	cacheThrough
};