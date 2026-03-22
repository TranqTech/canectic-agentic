// tests/accessControl.test.js — Unit tests for access control helpers
//
// The functions under test (parseFlags, checkAreaReadAccess, checkAreaPostAccess,
// checkFileAreaBrowseAccess, checkFileAreaReadAccess, checkFileAreaUploadAccess)
// are not exported from their route files.  They are recreated here verbatim,
// mirroring the logic in src/routes/index.js and src/routes/files.js so that
// the pattern/algorithm is tested independently of the Express router.
//
// Run: npx mocha tests/accessControl.test.js

import assert from 'assert';

// ---------------------------------------------------------------------------
// Inlined helpers — mirrors src/routes/index.js and src/routes/files.js
// ---------------------------------------------------------------------------

function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === 'string') {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

function checkAreaReadAccess(sessionUser, msgArea) {
	if (!msgArea) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	if (msgArea.read_security && userSecurity < msgArea.read_security) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(msgArea.read_perm_flags);
	var restFlags  = parseFlags(msgArea.read_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

function checkAreaPostAccess(sessionUser, msgArea) {
	if (!msgArea) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	if (msgArea.post_security && userSecurity < msgArea.post_security) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(msgArea.post_perm_flags);
	var restFlags  = parseFlags(msgArea.post_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

function checkFileAreaBrowseAccess(sessionUser, areaOrGroup) {
	if (!areaOrGroup) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	var browseSec = areaOrGroup.browse_security !== null && areaOrGroup.browse_security !== undefined
		? parseInt(areaOrGroup.browse_security)
		: (areaOrGroup.read_security ? parseInt(areaOrGroup.read_security) : 0);
	if (userSecurity < browseSec) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(areaOrGroup.browse_perm_flags || areaOrGroup.read_perm_flags);
	var restFlags  = parseFlags(areaOrGroup.browse_rest_flags || areaOrGroup.read_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

function checkFileAreaReadAccess(sessionUser, areaOrGroup) {
	if (!areaOrGroup) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	if (areaOrGroup.read_security && userSecurity < areaOrGroup.read_security) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(areaOrGroup.read_perm_flags);
	var restFlags  = parseFlags(areaOrGroup.read_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

function checkFileAreaUploadAccess(sessionUser, areaOrGroup) {
	if (!areaOrGroup) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	if (areaOrGroup.post_security && userSecurity < areaOrGroup.post_security) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(areaOrGroup.post_perm_flags);
	var restFlags  = parseFlags(areaOrGroup.post_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeUser(overrides) {
	return Object.assign({
		security:         100,
		permissionflags:  [],
		restrictionflags: []
	}, overrides);
}

function makeMsgArea(overrides) {
	return Object.assign({
		read_security:  0,
		post_security:  0,
		read_perm_flags:  null,
		read_rest_flags:  null,
		post_perm_flags:  null,
		post_rest_flags:  null
	}, overrides);
}

function makeFileArea(overrides) {
	return Object.assign({
		browse_security:  null,
		read_security:    0,
		post_security:    0,
		browse_perm_flags: null,
		browse_rest_flags: null,
		read_perm_flags:  null,
		read_rest_flags:  null,
		post_perm_flags:  null,
		post_rest_flags:  null
	}, overrides);
}

// ---------------------------------------------------------------------------
// checkAreaReadAccess (message areas — src/routes/index.js)
// ---------------------------------------------------------------------------

describe('checkAreaReadAccess', function () {

	it('should allow user with sufficient security and no flags', function () {
		var user = makeUser({ security: 100 });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should deny user with insufficient security', function () {
		var user = makeUser({ security: 30 });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should allow when user security exactly equals required', function () {
		var user = makeUser({ security: 50 });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should return false for null area', function () {
		var user = makeUser();
		assert.strictEqual(checkAreaReadAccess(user, null), false);
	});

	it('should allow when read_security is 0 or absent', function () {
		var user = makeUser({ security: 0 });
		var area = makeMsgArea({ read_security: 0 });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should deny user missing a required permission flag', function () {
		var user = makeUser({ permissionflags: ['Member'] });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Sysop']) });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should deny user missing one of multiple required permission flags', function () {
		var user = makeUser({ permissionflags: ['Member'] });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Member', 'Verified']) });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should allow user with ALL required permission flags', function () {
		var user = makeUser({ permissionflags: ['Member', 'Verified', 'Sysop'] });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Member', 'Verified']) });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should deny user who has a restriction flag', function () {
		var user = makeUser({ restrictionflags: ['NoPost'] });
		var area = makeMsgArea({ read_rest_flags: JSON.stringify(['NoPost']) });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should allow user who has none of the restriction flags', function () {
		var user = makeUser({ restrictionflags: ['SomeOtherFlag'] });
		var area = makeMsgArea({ read_rest_flags: JSON.stringify(['Banned']) });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should allow when flag arrays are null (no constraints)', function () {
		var user = makeUser({ permissionflags: null, restrictionflags: null });
		var area = makeMsgArea({ read_perm_flags: null, read_rest_flags: null });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should accept permissionflags as a JSON string from DB', function () {
		var user = makeUser({ permissionflags: '["Sysop","Member"]' });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Sysop']) });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should deny when user security string parses to insufficient level', function () {
		// Redis stores all session values as strings
		var user = makeUser({ security: '30' });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});
});

// ---------------------------------------------------------------------------
// checkAreaPostAccess (message areas — src/routes/index.js)
// ---------------------------------------------------------------------------

describe('checkAreaPostAccess', function () {

	it('should allow user with sufficient security and no flags', function () {
		var user = makeUser({ security: 100 });
		var area = makeMsgArea({ post_security: 50 });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should deny user with insufficient security', function () {
		var user = makeUser({ security: 20 });
		var area = makeMsgArea({ post_security: 100 });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should return false for null area', function () {
		assert.strictEqual(checkAreaPostAccess(makeUser(), null), false);
	});

	it('should deny user missing required post permission flag', function () {
		var user = makeUser({ permissionflags: [] });
		var area = makeMsgArea({ post_perm_flags: JSON.stringify(['Poster']) });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should allow user with all required post permission flags', function () {
		var user = makeUser({ permissionflags: ['Poster', 'Member'] });
		var area = makeMsgArea({ post_perm_flags: JSON.stringify(['Poster']) });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should deny user who carries a post restriction flag', function () {
		var user = makeUser({ restrictionflags: ['NoPost'] });
		var area = makeMsgArea({ post_rest_flags: JSON.stringify(['NoPost']) });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should allow user with no restriction flags when restrictions are set', function () {
		var user = makeUser({ restrictionflags: [] });
		var area = makeMsgArea({ post_rest_flags: JSON.stringify(['Banned']) });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});
});

// ---------------------------------------------------------------------------
// checkFileAreaBrowseAccess (src/routes/files.js)
// ---------------------------------------------------------------------------

describe('checkFileAreaBrowseAccess', function () {

	it('should allow user who meets browse_security', function () {
		var user = makeUser({ security: 100 });
		var area = makeFileArea({ browse_security: 50 });
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), true);
	});

	it('should deny user below browse_security', function () {
		var user = makeUser({ security: 40 });
		var area = makeFileArea({ browse_security: 50 });
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), false);
	});

	it('should return false for null area', function () {
		assert.strictEqual(checkFileAreaBrowseAccess(makeUser(), null), false);
	});

	it('should fall back to read_security when browse_security is null', function () {
		var user = makeUser({ security: 40 });
		var area = makeFileArea({ browse_security: null, read_security: 50 });
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), false);
	});

	it('should allow when browse_security is null and user meets read_security', function () {
		var user = makeUser({ security: 100 });
		var area = makeFileArea({ browse_security: null, read_security: 50 });
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), true);
	});

	it('should use browse_security=0 (not fall back) when explicitly set to 0', function () {
		// browse_security = 0 means no security requirement — everyone passes
		var user = makeUser({ security: 0 });
		var area = makeFileArea({ browse_security: 0, read_security: 100 });
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), true);
	});

	it('should fall back to read_perm_flags when browse_perm_flags not set', function () {
		var user = makeUser({ permissionflags: [] });
		var area = makeFileArea({
			browse_perm_flags: null,
			read_perm_flags:   JSON.stringify(['Member'])
		});
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), false);
	});

	it('should use browse_perm_flags when set, ignoring read_perm_flags', function () {
		var user = makeUser({ permissionflags: ['BrowseOnly'] });
		var area = makeFileArea({
			browse_perm_flags: JSON.stringify(['BrowseOnly']),
			read_perm_flags:   JSON.stringify(['Downloader'])
		});
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), true);
	});

	it('should fall back to read_rest_flags when browse_rest_flags not set', function () {
		var user = makeUser({ restrictionflags: ['Banned'] });
		var area = makeFileArea({
			browse_rest_flags: null,
			read_rest_flags:   JSON.stringify(['Banned'])
		});
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), false);
	});

	it('should deny user who has a browse restriction flag', function () {
		var user = makeUser({ restrictionflags: ['NoBrowse'] });
		var area = makeFileArea({ browse_rest_flags: JSON.stringify(['NoBrowse']) });
		assert.strictEqual(checkFileAreaBrowseAccess(user, area), false);
	});
});

// ---------------------------------------------------------------------------
// checkFileAreaReadAccess (download — src/routes/files.js)
// ---------------------------------------------------------------------------

describe('checkFileAreaReadAccess', function () {

	it('should allow user who meets read_security', function () {
		var user = makeUser({ security: 100 });
		var area = makeFileArea({ read_security: 50 });
		assert.strictEqual(checkFileAreaReadAccess(user, area), true);
	});

	it('should deny user below read_security', function () {
		var user = makeUser({ security: 30 });
		var area = makeFileArea({ read_security: 50 });
		assert.strictEqual(checkFileAreaReadAccess(user, area), false);
	});

	it('should return false for null area', function () {
		assert.strictEqual(checkFileAreaReadAccess(makeUser(), null), false);
	});

	it('should deny user missing required read perm flag', function () {
		var user = makeUser({ permissionflags: [] });
		var area = makeFileArea({ read_perm_flags: JSON.stringify(['Downloader']) });
		assert.strictEqual(checkFileAreaReadAccess(user, area), false);
	});

	it('should allow user with all required read perm flags', function () {
		var user = makeUser({ permissionflags: ['Downloader', 'Member'] });
		var area = makeFileArea({ read_perm_flags: JSON.stringify(['Downloader']) });
		assert.strictEqual(checkFileAreaReadAccess(user, area), true);
	});

	it('should deny user carrying a read restriction flag', function () {
		var user = makeUser({ restrictionflags: ['NoDownload'] });
		var area = makeFileArea({ read_rest_flags: JSON.stringify(['NoDownload']) });
		assert.strictEqual(checkFileAreaReadAccess(user, area), false);
	});

	it('should allow with empty flag arrays on both sides', function () {
		var user = makeUser({ permissionflags: [], restrictionflags: [] });
		var area = makeFileArea({ read_perm_flags: '[]', read_rest_flags: '[]' });
		assert.strictEqual(checkFileAreaReadAccess(user, area), true);
	});
});

// ---------------------------------------------------------------------------
// checkFileAreaUploadAccess (src/routes/files.js)
// ---------------------------------------------------------------------------

describe('checkFileAreaUploadAccess', function () {

	it('should allow user who meets post_security', function () {
		var user = makeUser({ security: 150 });
		var area = makeFileArea({ post_security: 100 });
		assert.strictEqual(checkFileAreaUploadAccess(user, area), true);
	});

	it('should deny user below post_security', function () {
		var user = makeUser({ security: 50 });
		var area = makeFileArea({ post_security: 100 });
		assert.strictEqual(checkFileAreaUploadAccess(user, area), false);
	});

	it('should return false for null area', function () {
		assert.strictEqual(checkFileAreaUploadAccess(makeUser(), null), false);
	});

	it('should deny user missing required post perm flag', function () {
		var user = makeUser({ permissionflags: [] });
		var area = makeFileArea({ post_perm_flags: JSON.stringify(['Uploader']) });
		assert.strictEqual(checkFileAreaUploadAccess(user, area), false);
	});

	it('should allow user with all required post perm flags', function () {
		var user = makeUser({ permissionflags: ['Uploader'] });
		var area = makeFileArea({ post_perm_flags: JSON.stringify(['Uploader']) });
		assert.strictEqual(checkFileAreaUploadAccess(user, area), true);
	});

	it('should deny user carrying an upload restriction flag', function () {
		var user = makeUser({ restrictionflags: ['NoUpload'] });
		var area = makeFileArea({ post_rest_flags: JSON.stringify(['NoUpload']) });
		assert.strictEqual(checkFileAreaUploadAccess(user, area), false);
	});

	it('should allow when post_security is 0 and user security is 0', function () {
		var user = makeUser({ security: 0 });
		var area = makeFileArea({ post_security: 0 });
		assert.strictEqual(checkFileAreaUploadAccess(user, area), true);
	});
});
