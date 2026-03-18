// flash.js — Session-scoped flash messages via Redis
// Flash messages persist for one page load, then are cleared.
// Stored as a JSON array under a Redis key tied to the session ID.
//
// Usage in routes:
//   await flash.set(req, [{ type: 'danger', text: 'User not found' }]);
//   res.redirect('/pm/inbox');
//
// Usage in middleware (auto-load into res.locals):
//   var messages = await flash.get(req);  // returns array and clears
//   res.locals.flash = messages;
//
// Usage in views:
//   include ../partials/flash

import * as redis from './redis.js';

const FLASH_PREFIX = "flash:";
const FLASH_TTL = 30; // seconds — only needs to survive one redirect

// Store flash messages for the current session.
// messages is an array of { type: 'danger'|'warning'|'success'|'info', text: '...' }
async function set(req, messages) {
	var sessionId = req.cookies && req.cookies.sessionid;
	if (!sessionId) return false;
	if (!messages || !Array.isArray(messages) || messages.length === 0) return false;

	var key = FLASH_PREFIX + sessionId;
	// Append to any existing flash messages (multiple redirects in sequence)
	var existing = await getMessages(key);
	var combined = existing.concat(messages);

	return await redis.set(key, JSON.stringify(combined), FLASH_TTL);
}

// Convenience: set a single flash message
async function setOne(req, type, text) {
	return await set(req, [{ type: type, text: text }]);
}

// Retrieve and clear flash messages for the current session.
// Returns an array (empty if none).
async function get(req) {
	var sessionId = req.cookies && req.cookies.sessionid;
	if (!sessionId) return [];

	var key = FLASH_PREFIX + sessionId;
	var messages = await getMessages(key);

	// Clear after reading (one-shot)
	if (messages.length > 0) {
		await redis.del(key);
	}

	return messages;
}

// Internal: read messages from a flash key
async function getMessages(key) {
	try {
		var raw = await redis.get(key);
		if (!raw) return [];
		var parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch (err) {
		return [];
	}
}

export {
	set,
	setOne,
	get
};
