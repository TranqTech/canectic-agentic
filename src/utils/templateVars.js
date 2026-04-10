// src/utils/templateVars.js
// Template variable substitution for message templates.
//
// Syntax: {var} or {nested.path} in the template string.
// Example: "Welcome {user.username}!" with { user: { username: "bob" } }
//          produces "Welcome bob!"
//
// Unknown variables are left in place (surrounded by the braces) so sysops
// see exactly which tokens were unresolved when testing templates.
//
// Standard vars always available (injected by buildStandardVars):
//   {boardname}, {sysopname}, {sysop_alias}, {sitedomain}
//   {date}, {time}, {year}
//
// Per-user vars (injected by buildUserVars when a user is passed):
//   {user.username}, {user.fullname}, {user.firstname}, {user.lastname}
//   {user.email}, {user.location}, {user.security}
//   {user.logoncount}, {user.firstlogon}, {user.lastlogon}
//   {user.birthdate}, {user.created_at}
//
// Event-specific vars are passed by the caller as extraVars under the
// 'event' key, e.g. { event: { verify_code: 'ABC123', days_until_purge: 3 } }

import appConfig from '../config/appConfig.js';

/**
 * Walk a dot-separated key path on an object. Returns undefined if any
 * segment is missing.
 */
function lookup(obj, keyPath) {
	if (!obj || !keyPath) return undefined;
	var parts = keyPath.split('.');
	var cur = obj;
	for (var i = 0; i < parts.length; i++) {
		if (cur === null || cur === undefined) return undefined;
		cur = cur[parts[i]];
	}
	return cur;
}

/**
 * Format a value for display in a template. Dates become locale strings;
 * null/undefined become empty strings; booleans become "yes"/"no".
 */
function formatValue(val) {
	if (val === null || val === undefined) return '';
	if (val instanceof Date) return val.toLocaleDateString();
	if (typeof val === 'boolean') return val ? 'yes' : 'no';
	return String(val);
}

/**
 * Apply template substitution to a string.
 * @param {string} template  - Template string with {var} or {nested.key} tokens
 * @param {object} vars      - Variable bundle
 * @returns {string} Substituted string
 */
function applyTemplate(template, vars) {
	if (!template || typeof template !== 'string') return template || '';
	if (template.indexOf('{') === -1) return template; // fast path

	return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g, function(match, key) {
		var val = lookup(vars, key);
		if (val === undefined) return match; // leave unresolved tokens in place
		return formatValue(val);
	});
}

/**
 * Build the standard variable bundle (boardname, date, time, etc).
 * Always safe to call -- no user context required.
 */
function buildStandardVars() {
	var now = new Date();
	return {
		boardname: appConfig.get('boardname', 'Canectic BBS'),
		sysopname: appConfig.get('sysopname', 'Sysop'),
		sysop_alias: appConfig.get('sysopalias', 'Sysop'),
		sitedomain: appConfig.get('sitedomain', ''),
		date: now.toLocaleDateString(),
		time: now.toLocaleTimeString(),
		year: String(now.getFullYear())
	};
}

/**
 * Build per-user variable bundle from a user record.
 */
function buildUserVars(user) {
	if (!user) return {};
	return {
		username: user.username || '',
		fullname: user.fullname || '',
		firstname: user.firstname || '',
		lastname: user.lastname || '',
		email: user.mailaddress || '',
		mailtype: user.mailtype || '',
		location: user.location || '',
		security: user.security !== undefined ? user.security : '',
		logoncount: user.logoncount || 0,
		firstlogon: user.firstlogon || null,
		lastlogon: user.lastlogon || null,
		birthdate: user.birthdate || null,
		created_at: user.created_at || null
	};
}

/**
 * Combine standard + user + event vars into a single bundle.
 */
function buildContext(user, extraVars) {
	var ctx = buildStandardVars();
	if (user) ctx.user = buildUserVars(user);
	if (extraVars) {
		// Merge extraVars at both top level and under 'event' key
		for (var key in extraVars) {
			if (extraVars.hasOwnProperty(key)) ctx[key] = extraVars[key];
		}
		// If caller provided event vars at top level without wrapping, also
		// expose them under 'event' for {event.key} access
		if (!ctx.event && extraVars) {
			// Only do this if extraVars looks like event data (not already containing 'event')
			// noop -- caller should pass { event: {...} } explicitly
		}
	}
	return ctx;
}

export {
	applyTemplate,
	buildStandardVars,
	buildUserVars,
	buildContext,
	lookup,
	formatValue
};
