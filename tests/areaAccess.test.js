// tests/areaAccess.test.js — Unit tests for src/utils/areaAccess.js
//
// Tests the three exported pure functions: parseFlags, checkAreaReadAccess,
// and checkAreaPostAccess. No DB or Redis dependency — these are pure logic.
//
// Run: npx mocha tests/areaAccess.test.js

import assert from 'assert';
import { parseFlags, checkAreaReadAccess, checkAreaPostAccess } from '../src/utils/areaAccess.js';

// ---------------------------------------------------------------------------
// Factory helpers
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
		read_security:   0,
		post_security:   0,
		read_perm_flags: null,
		read_rest_flags: null,
		post_perm_flags: null,
		post_rest_flags: null
	}, overrides);
}

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe('parseFlags', function () {

	it('should return empty array for null', function () {
		assert.deepStrictEqual(parseFlags(null), []);
	});

	it('should return empty array for undefined', function () {
		assert.deepStrictEqual(parseFlags(undefined), []);
	});

	it('should return empty array for empty string', function () {
		assert.deepStrictEqual(parseFlags(''), []);
	});

	it('should return empty array for 0 (falsy number)', function () {
		assert.deepStrictEqual(parseFlags(0), []);
	});

	it('should return empty array for false', function () {
		assert.deepStrictEqual(parseFlags(false), []);
	});

	it('should return the array as-is when input is already an array', function () {
		var flags = ['Sysop', 'Member'];
		assert.deepStrictEqual(parseFlags(flags), flags);
	});

	it('should return an empty array as-is when input is an empty array', function () {
		assert.deepStrictEqual(parseFlags([]), []);
	});

	it('should parse a valid JSON array string', function () {
		assert.deepStrictEqual(parseFlags('["Sysop","Member"]'), ['Sysop', 'Member']);
	});

	it('should parse a JSON array string with a single element', function () {
		assert.deepStrictEqual(parseFlags('["Verified"]'), ['Verified']);
	});

	it('should parse an empty JSON array string to empty array', function () {
		assert.deepStrictEqual(parseFlags('[]'), []);
	});

	it('should return empty array for invalid JSON string', function () {
		assert.deepStrictEqual(parseFlags('not-json'), []);
	});

	it('should return empty array for truncated JSON string', function () {
		assert.deepStrictEqual(parseFlags('["Sysop"'), []);
	});

	it('should return empty array for JSON object (not an array)', function () {
		// A non-array JSON value is rejected
		assert.deepStrictEqual(parseFlags('{"flag":"Sysop"}'), []);
	});

	it('should return empty array for JSON string scalar', function () {
		assert.deepStrictEqual(parseFlags('"Sysop"'), []);
	});

	it('should return empty array for JSON number scalar', function () {
		assert.deepStrictEqual(parseFlags('42'), []);
	});

	it('should return empty array for JSON boolean scalar', function () {
		assert.deepStrictEqual(parseFlags('true'), []);
	});
});

// ---------------------------------------------------------------------------
// checkAreaReadAccess
// ---------------------------------------------------------------------------

describe('checkAreaReadAccess', function () {

	it('should return false when area is null', function () {
		assert.strictEqual(checkAreaReadAccess(makeUser(), null), false);
	});

	it('should return false when area is undefined', function () {
		assert.strictEqual(checkAreaReadAccess(makeUser(), undefined), false);
	});

	it('should allow user whose security exceeds read_security', function () {
		var user = makeUser({ security: 100 });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should allow user whose security exactly equals read_security', function () {
		var user = makeUser({ security: 50 });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should deny user whose security is below read_security', function () {
		var user = makeUser({ security: 30 });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should allow when read_security is 0 and user security is 0', function () {
		var user = makeUser({ security: 0 });
		var area = makeMsgArea({ read_security: 0 });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should allow when read_security is absent (null) regardless of user security', function () {
		// null read_security — no security gate
		var user = makeUser({ security: 0 });
		var area = makeMsgArea({ read_security: null });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should treat string security from Redis session as a number', function () {
		// Redis stores session values as strings
		var user = makeUser({ security: '30' });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should treat a passing string security from Redis session correctly', function () {
		var user = makeUser({ security: '100' });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should treat non-numeric security string as 0', function () {
		var user = makeUser({ security: 'admin' });
		var area = makeMsgArea({ read_security: 50 });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should allow when all flag arrays are null (no constraints)', function () {
		var user = makeUser({ permissionflags: null, restrictionflags: null });
		var area = makeMsgArea({ read_perm_flags: null, read_rest_flags: null });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should allow when flag arrays are empty JSON strings', function () {
		var user = makeUser({ permissionflags: [], restrictionflags: [] });
		var area = makeMsgArea({ read_perm_flags: '[]', read_rest_flags: '[]' });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should deny user who is missing a required permission flag', function () {
		var user = makeUser({ permissionflags: ['Member'] });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Sysop']) });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should deny user who is missing one of multiple required permission flags', function () {
		var user = makeUser({ permissionflags: ['Member'] });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Member', 'Verified']) });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should deny user who has none of the required permission flags', function () {
		var user = makeUser({ permissionflags: [] });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Sysop']) });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should allow user who has all required permission flags', function () {
		var user = makeUser({ permissionflags: ['Member', 'Verified', 'Sysop'] });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Member', 'Verified']) });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should allow user who has exactly the required permission flags', function () {
		var user = makeUser({ permissionflags: ['Verified'] });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Verified']) });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should accept user permissionflags as a JSON string from DB', function () {
		var user = makeUser({ permissionflags: '["Sysop","Member"]' });
		var area = makeMsgArea({ read_perm_flags: JSON.stringify(['Sysop']) });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should deny user who has a restriction flag that the area blocks', function () {
		var user = makeUser({ restrictionflags: ['NoRead'] });
		var area = makeMsgArea({ read_rest_flags: JSON.stringify(['NoRead']) });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should deny user who has one matching restriction flag out of several area restrictions', function () {
		var user = makeUser({ restrictionflags: ['Banned'] });
		var area = makeMsgArea({ read_rest_flags: JSON.stringify(['NoRead', 'Banned']) });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should allow user who has restriction flags that do not overlap with area restrictions', function () {
		var user = makeUser({ restrictionflags: ['NoPost'] });
		var area = makeMsgArea({ read_rest_flags: JSON.stringify(['Banned']) });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should allow user with no restriction flags when area has restrictions', function () {
		var user = makeUser({ restrictionflags: [] });
		var area = makeMsgArea({ read_rest_flags: JSON.stringify(['Banned']) });
		assert.strictEqual(checkAreaReadAccess(user, area), true);
	});

	it('should accept area restriction flags as a JSON string from DB', function () {
		var user = makeUser({ restrictionflags: ['Banned'] });
		var area = makeMsgArea({ read_rest_flags: '["Banned"]' });
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should require all checks to pass: security + perm flags + rest flags', function () {
		// User passes security and has no restriction, but is missing perm flag
		var user = makeUser({ security: 200, permissionflags: [], restrictionflags: [] });
		var area = makeMsgArea({
			read_security:   100,
			read_perm_flags: JSON.stringify(['Verified']),
			read_rest_flags: null
		});
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});

	it('should deny at security stage even if flags would pass', function () {
		var user = makeUser({ security: 10, permissionflags: ['Sysop'], restrictionflags: [] });
		var area = makeMsgArea({
			read_security:   50,
			read_perm_flags: JSON.stringify(['Sysop']),
			read_rest_flags: null
		});
		assert.strictEqual(checkAreaReadAccess(user, area), false);
	});
});

// ---------------------------------------------------------------------------
// checkAreaPostAccess
// ---------------------------------------------------------------------------

describe('checkAreaPostAccess', function () {

	it('should return false when area is null', function () {
		assert.strictEqual(checkAreaPostAccess(makeUser(), null), false);
	});

	it('should return false when area is undefined', function () {
		assert.strictEqual(checkAreaPostAccess(makeUser(), undefined), false);
	});

	it('should allow user whose security exceeds post_security', function () {
		var user = makeUser({ security: 100 });
		var area = makeMsgArea({ post_security: 50 });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should allow user whose security exactly equals post_security', function () {
		var user = makeUser({ security: 50 });
		var area = makeMsgArea({ post_security: 50 });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should deny user whose security is below post_security', function () {
		var user = makeUser({ security: 20 });
		var area = makeMsgArea({ post_security: 100 });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should allow when post_security is 0 and user security is 0', function () {
		var user = makeUser({ security: 0 });
		var area = makeMsgArea({ post_security: 0 });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should allow when post_security is absent (null)', function () {
		var user = makeUser({ security: 0 });
		var area = makeMsgArea({ post_security: null });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should treat string security from Redis session as a number', function () {
		var user = makeUser({ security: '20' });
		var area = makeMsgArea({ post_security: 100 });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should treat non-numeric security string as 0', function () {
		var user = makeUser({ security: 'admin' });
		var area = makeMsgArea({ post_security: 50 });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should allow when all flag arrays are null (no constraints)', function () {
		var user = makeUser({ permissionflags: null, restrictionflags: null });
		var area = makeMsgArea({ post_perm_flags: null, post_rest_flags: null });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should allow when flag arrays are empty JSON strings', function () {
		var user = makeUser({ permissionflags: [], restrictionflags: [] });
		var area = makeMsgArea({ post_perm_flags: '[]', post_rest_flags: '[]' });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should deny user who is missing a required post permission flag', function () {
		var user = makeUser({ permissionflags: [] });
		var area = makeMsgArea({ post_perm_flags: JSON.stringify(['Poster']) });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should deny user who is missing one of multiple required post permission flags', function () {
		var user = makeUser({ permissionflags: ['Poster'] });
		var area = makeMsgArea({ post_perm_flags: JSON.stringify(['Poster', 'Verified']) });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should allow user who has all required post permission flags', function () {
		var user = makeUser({ permissionflags: ['Poster', 'Member'] });
		var area = makeMsgArea({ post_perm_flags: JSON.stringify(['Poster']) });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should allow user who has exactly the required post permission flags', function () {
		var user = makeUser({ permissionflags: ['Poster'] });
		var area = makeMsgArea({ post_perm_flags: JSON.stringify(['Poster']) });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should accept user permissionflags as a JSON string from DB', function () {
		var user = makeUser({ permissionflags: '["Poster","Member"]' });
		var area = makeMsgArea({ post_perm_flags: JSON.stringify(['Poster']) });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should deny user who has a restriction flag that the area blocks for posting', function () {
		var user = makeUser({ restrictionflags: ['NoPost'] });
		var area = makeMsgArea({ post_rest_flags: JSON.stringify(['NoPost']) });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should deny user who has one matching post restriction flag out of several', function () {
		var user = makeUser({ restrictionflags: ['Banned'] });
		var area = makeMsgArea({ post_rest_flags: JSON.stringify(['NoPost', 'Banned']) });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should allow user whose restriction flags do not overlap with post restrictions', function () {
		var user = makeUser({ restrictionflags: ['NoRead'] });
		var area = makeMsgArea({ post_rest_flags: JSON.stringify(['NoPost']) });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should allow user with no restriction flags when area has post restrictions', function () {
		var user = makeUser({ restrictionflags: [] });
		var area = makeMsgArea({ post_rest_flags: JSON.stringify(['Banned']) });
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});

	it('should accept area post restriction flags as a JSON string from DB', function () {
		var user = makeUser({ restrictionflags: ['NoPost'] });
		var area = makeMsgArea({ post_rest_flags: '["NoPost"]' });
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should require all checks to pass: security + perm flags + rest flags', function () {
		// User passes security and has no restriction, but is missing perm flag
		var user = makeUser({ security: 200, permissionflags: [], restrictionflags: [] });
		var area = makeMsgArea({
			post_security:   100,
			post_perm_flags: JSON.stringify(['Poster']),
			post_rest_flags: null
		});
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should deny at security stage even if flags would pass', function () {
		var user = makeUser({ security: 10, permissionflags: ['Poster'], restrictionflags: [] });
		var area = makeMsgArea({
			post_security:   50,
			post_perm_flags: JSON.stringify(['Poster']),
			post_rest_flags: null
		});
		assert.strictEqual(checkAreaPostAccess(user, area), false);
	});

	it('should be independent from read access fields — read fields do not affect post check', function () {
		// Area has a harsh read requirement but no post requirement; user passes post
		var user = makeUser({ security: 10, permissionflags: [], restrictionflags: [] });
		var area = makeMsgArea({
			read_security:   200,
			read_perm_flags: JSON.stringify(['Sysop']),
			post_security:   0,
			post_perm_flags: null,
			post_rest_flags: null
		});
		assert.strictEqual(checkAreaPostAccess(user, area), true);
	});
});
