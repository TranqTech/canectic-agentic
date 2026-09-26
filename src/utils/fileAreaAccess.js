// src/utils/fileAreaAccess.js: who may see a file area or group, and who may
// download from one. Pure.
//
// The same rules the web file pages applied through their own helpers; moved
// here so the offline-reader QWK features (#75: the new-files list and FREQ)
// apply exactly those rules rather than a fourth copy of them.
//
//   browse: browse_security (falling back to read_security) and the browse
//           flags (falling back to the read flags); decides visibility.
//   read:   read_security and the read flags; decides downloading.
// Permission flags: the user must hold ALL of them. Restriction flags: NONE.

function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === 'string') {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

function flagsAllow(user, required, restricted) {
	var perms = parseFlags(user.permissionflags);
	var rests = parseFlags(user.restrictionflags);
	var req = parseFlags(required);
	var rest = parseFlags(restricted);
	if (req.length > 0 && !req.every(function (f) { return perms.includes(f); })) return false;
	if (rest.length > 0 && rest.some(function (f) { return rests.includes(f); })) return false;
	return true;
}

function canBrowseFileArea(user, areaOrGroup) {
	if (!user || !areaOrGroup) return false;
	var security = parseInt(user.security) || 0;
	var browseSec = areaOrGroup.browse_security !== null && areaOrGroup.browse_security !== undefined
		? parseInt(areaOrGroup.browse_security)
		: (areaOrGroup.read_security ? parseInt(areaOrGroup.read_security) : 0);
	if (security < browseSec) return false;
	return flagsAllow(user,
		areaOrGroup.browse_perm_flags || areaOrGroup.read_perm_flags,
		areaOrGroup.browse_rest_flags || areaOrGroup.read_rest_flags);
}

function canDownloadFileArea(user, areaOrGroup) {
	if (!user || !areaOrGroup) return false;
	var security = parseInt(user.security) || 0;
	if (areaOrGroup.read_security && security < areaOrGroup.read_security) return false;
	return flagsAllow(user, areaOrGroup.read_perm_flags, areaOrGroup.read_rest_flags);
}

export { parseFlags, canBrowseFileArea, canDownloadFileArea };
