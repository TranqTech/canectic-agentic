// areaAccess.js — Shared access check functions for message areas.
//
// Extracted from routes/index.js so qwkUser.js and other modules can
// check read/write access without importing route code.

// Parse flag column — may be a JSON array string, an actual array, or empty.
function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === 'string') {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

// Check if a user has sufficient access to read an area.
// user must have: security, permissionflags, restrictionflags
// area must have: read_security, read_perm_flags, read_rest_flags
function checkAreaReadAccess(user, area) {
	if (!area) return false;
	var userSecurity = parseInt(user.security) || 0;
	if (area.read_security && userSecurity < area.read_security) return false;

	var userPerms  = parseFlags(user.permissionflags);
	var userRestrs = parseFlags(user.restrictionflags);
	var reqFlags   = parseFlags(area.read_perm_flags);
	var restFlags  = parseFlags(area.read_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

// Check if a user has sufficient access to post in an area.
function checkAreaPostAccess(user, area) {
	if (!area) return false;
	var userSecurity = parseInt(user.security) || 0;
	if (area.post_security && userSecurity < area.post_security) return false;

	var userPerms  = parseFlags(user.permissionflags);
	var userRestrs = parseFlags(user.restrictionflags);
	var reqFlags   = parseFlags(area.post_perm_flags);
	var restFlags  = parseFlags(area.post_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}


// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

/**
 * Can this user moderate this area: delete or move other people's threads and
 * messages?
 *
 * Today this is the Sysop flag and nothing else. It exists as its own function
 * rather than an inline permissionflags check because per-area and per-group
 * moderators are wanted next, and when they arrive every caller should start
 * honouring them without being revisited. Adding the check inline at each call
 * site would guarantee one gets missed.
 *
 * The shape that is coming, sketched here so the seam is not accidentally
 * designed shut:
 *
 *   - a moderators table keyed by user plus either group or area
 *   - group-level moderation implying every area in that group
 *   - Sysop continuing to imply moderation everywhere, as a superset rather
 *     than a special case
 *
 * `area` is accepted and currently unused for exactly that reason: callers
 * should already be passing the area they are moderating, so the per-area
 * lookup can be added here alone. Callers that cannot name an area should pass
 * null and get the board-wide answer.
 *
 * @param {object} user  needs permissionflags
 * @param {object} [area] the area being moderated, for future per-area rules
 * @returns {boolean}
 */
function canModerateArea(user, area) {   // eslint-disable-line no-unused-vars
	if (!user) return false;
	return parseFlags(user.permissionflags).includes('Sysop');
}

export { parseFlags, checkAreaReadAccess, checkAreaPostAccess, canModerateArea };
