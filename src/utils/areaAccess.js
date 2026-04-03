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

export { parseFlags, checkAreaReadAccess, checkAreaPostAccess };
