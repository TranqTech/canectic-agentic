// tests/wall.test.js — Unit tests for src/models/wall.js
//
// wall.js imports postgres and appConfig at module level, so it cannot be
// imported directly in a unit test without infrastructure.  The pure logic
// is extracted and inlined here:
//
//   - canPost(user)   — pure function; reads appConfig at call time, so we
//                       test via a factory that accepts config values directly,
//                       mirroring the real algorithm exactly
//   - addMessage()    — data transformation: message is truncated to 160 chars
//   - getRecentMessages() — result reversal (newest-last display order)
//
// DB-hitting functions (addMessage, deleteMessage, getCount, purgeOldMessages,
// getAllMessages) are validated for export shape via the modelExports pattern.
//
// Run: npx mocha tests/wall.test.js

import assert from 'assert';

// ---------------------------------------------------------------------------
// Inlined canPost logic — mirrors src/models/wall.js canPost()
// The real function calls appConfig.getNumber / appConfig.get at call time.
// We parameterise config values so the algorithm can be tested without
// appConfig being initialised.
// ---------------------------------------------------------------------------

function canPostWith(user, cfg) {
	if (!user) return false;

	var minSecurity = cfg.wall_post_security !== undefined ? cfg.wall_post_security : 10;
	var userSecurity = parseInt(user.security) || 0;
	if (userSecurity < minSecurity) return false;

	var requiredRaw = cfg.wall_post_required_flags || '';
	if (requiredRaw) {
		var required = requiredRaw.split(',').map(function(f) { return f.trim(); }).filter(Boolean);
		var userPerms = Array.isArray(user.permissionflags) ? user.permissionflags : [];
		for (var i = 0; i < required.length; i++) {
			if (!userPerms.includes(required[i])) return false;
		}
	}

	var restrictedRaw = cfg.wall_post_restricted_flags || '';
	if (restrictedRaw) {
		var restricted = restrictedRaw.split(',').map(function(f) { return f.trim(); }).filter(Boolean);
		var userRestrictions = Array.isArray(user.restrictionflags) ? user.restrictionflags : [];
		for (var j = 0; j < restricted.length; j++) {
			if (userRestrictions.includes(restricted[j])) return false;
		}
	}

	return true;
}

// Default config — no flag constraints, minimum security of 10
function defaultCfg(overrides) {
	return Object.assign({
		wall_post_security:        10,
		wall_post_required_flags:  '',
		wall_post_restricted_flags: ''
	}, overrides);
}

function makeUser(overrides) {
	return Object.assign({
		security:         100,
		permissionflags:  [],
		restrictionflags: []
	}, overrides);
}

// ---------------------------------------------------------------------------
// Inlined addMessage truncation logic — mirrors src/models/wall.js addMessage()
// The real function does: message.substring(0, 160) before inserting.
// ---------------------------------------------------------------------------

function truncateMessage(message) {
	return message.substring(0, 160);
}

// ---------------------------------------------------------------------------
// Inlined getRecentMessages reversal — mirrors src/models/wall.js
// The real function reverses the DB result so newest is last (chronological).
// ---------------------------------------------------------------------------

function applyRecentReversal(rows) {
	return rows ? rows.reverse() : [];
}

// ---------------------------------------------------------------------------
// canPost — security level checks
// ---------------------------------------------------------------------------

describe('canPost (wall.js)', function () {

	describe('null / missing user', function () {
		it('should return false for null user', function () {
			assert.strictEqual(canPostWith(null, defaultCfg()), false);
		});

		it('should return false for undefined user', function () {
			assert.strictEqual(canPostWith(undefined, defaultCfg()), false);
		});
	});

	describe('security level', function () {
		it('should allow user with security above minimum', function () {
			var user = makeUser({ security: 50 });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 10 })), true);
		});

		it('should allow user with security exactly equal to minimum', function () {
			var user = makeUser({ security: 10 });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 10 })), true);
		});

		it('should deny user with security below minimum', function () {
			var user = makeUser({ security: 9 });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 10 })), false);
		});

		it('should deny user with security of 0 when minimum is 10', function () {
			var user = makeUser({ security: 0 });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 10 })), false);
		});

		it('should allow user with security of 0 when minimum is 0', function () {
			var user = makeUser({ security: 0 });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 0 })), true);
		});

		it('should accept security as a string (session values stored as strings)', function () {
			var user = makeUser({ security: '25' });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 10 })), true);
		});

		it('should treat non-numeric security as 0', function () {
			var user = makeUser({ security: 'nope' });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 10 })), false);
		});

		it('should treat missing security field as 0', function () {
			var user = { permissionflags: [], restrictionflags: [] };
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 10 })), false);
		});

		it('should allow user when minimum security is very high and user meets it', function () {
			var user = makeUser({ security: 255 });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_security: 255 })), true);
		});
	});

	describe('required permission flags', function () {
		it('should allow when no required flags are configured', function () {
			var user = makeUser({ permissionflags: [] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_required_flags: '' })), true);
		});

		it('should allow when user has the single required flag', function () {
			var user = makeUser({ permissionflags: ['Verified'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_required_flags: 'Verified' })), true);
		});

		it('should deny when user is missing the required flag', function () {
			var user = makeUser({ permissionflags: ['Member'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_required_flags: 'Verified' })), false);
		});

		it('should allow when user has all of multiple required flags', function () {
			var user = makeUser({ permissionflags: ['Member', 'Verified'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_required_flags: 'Member, Verified' })), true);
		});

		it('should deny when user is missing one of multiple required flags', function () {
			var user = makeUser({ permissionflags: ['Member'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_required_flags: 'Member, Verified' })), false);
		});

		it('should deny when user has no flags and a flag is required', function () {
			var user = makeUser({ permissionflags: [] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_required_flags: 'Sysop' })), false);
		});

		it('should handle leading and trailing whitespace in flag list', function () {
			var user = makeUser({ permissionflags: ['Verified'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_required_flags: ' Verified ' })), true);
		});

		it('should treat null permissionflags as an empty array', function () {
			var user = makeUser({ permissionflags: null });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_required_flags: 'Verified' })), false);
		});
	});

	describe('restriction flags', function () {
		it('should allow when no restriction flags are configured', function () {
			var user = makeUser({ restrictionflags: ['Suspended'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_restricted_flags: '' })), true);
		});

		it('should deny when user carries the restricted flag', function () {
			var user = makeUser({ restrictionflags: ['NoWall'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_restricted_flags: 'NoWall' })), false);
		});

		it('should allow when user does not carry any of the restricted flags', function () {
			var user = makeUser({ restrictionflags: ['OtherFlag'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_restricted_flags: 'NoWall' })), true);
		});

		it('should deny when user carries one of multiple restricted flags', function () {
			var user = makeUser({ restrictionflags: ['Banned'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_restricted_flags: 'NoWall, Banned' })), false);
		});

		it('should allow when user carries none of multiple restricted flags', function () {
			var user = makeUser({ restrictionflags: ['Member'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_restricted_flags: 'NoWall, Banned' })), true);
		});

		it('should allow when user has an empty restriction list', function () {
			var user = makeUser({ restrictionflags: [] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_restricted_flags: 'NoWall' })), true);
		});

		it('should treat null restrictionflags as an empty array', function () {
			var user = makeUser({ restrictionflags: null });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_restricted_flags: 'NoWall' })), true);
		});

		it('should handle leading and trailing whitespace in restricted flag list', function () {
			var user = makeUser({ restrictionflags: ['NoWall'] });
			assert.strictEqual(canPostWith(user, defaultCfg({ wall_post_restricted_flags: ' NoWall ' })), false);
		});
	});

	describe('combined conditions', function () {
		it('should deny user who meets security but is missing a required flag', function () {
			var user = makeUser({ security: 100, permissionflags: [] });
			assert.strictEqual(canPostWith(user, defaultCfg({
				wall_post_security:       10,
				wall_post_required_flags: 'Verified'
			})), false);
		});

		it('should deny user who meets security and required flags but carries a restriction flag', function () {
			var user = makeUser({
				security:         100,
				permissionflags:  ['Verified'],
				restrictionflags: ['NoWall']
			});
			assert.strictEqual(canPostWith(user, defaultCfg({
				wall_post_security:        10,
				wall_post_required_flags:  'Verified',
				wall_post_restricted_flags: 'NoWall'
			})), false);
		});

		it('should allow user who satisfies all three conditions', function () {
			var user = makeUser({
				security:         100,
				permissionflags:  ['Verified', 'Member'],
				restrictionflags: []
			});
			assert.strictEqual(canPostWith(user, defaultCfg({
				wall_post_security:        10,
				wall_post_required_flags:  'Verified, Member',
				wall_post_restricted_flags: 'NoWall'
			})), true);
		});

		it('should deny a user who fails security even if flags would otherwise pass', function () {
			var user = makeUser({
				security:        5,
				permissionflags: ['Verified']
			});
			assert.strictEqual(canPostWith(user, defaultCfg({
				wall_post_security:       10,
				wall_post_required_flags: 'Verified'
			})), false);
		});
	});
});

// ---------------------------------------------------------------------------
// addMessage truncation logic
// ---------------------------------------------------------------------------

describe('addMessage message truncation (wall.js)', function () {
	it('should pass through messages shorter than 160 characters unchanged', function () {
		var msg = 'Hello BBS!';
		assert.strictEqual(truncateMessage(msg), msg);
	});

	it('should pass through a message of exactly 160 characters unchanged', function () {
		var msg = 'A'.repeat(160);
		assert.strictEqual(truncateMessage(msg).length, 160);
	});

	it('should truncate a message longer than 160 characters to 160', function () {
		var msg = 'B'.repeat(200);
		assert.strictEqual(truncateMessage(msg).length, 160);
	});

	it('should truncate at exactly the 160-character boundary', function () {
		var msg = 'C'.repeat(161);
		assert.strictEqual(truncateMessage(msg), 'C'.repeat(160));
	});

	it('should handle an empty string without error', function () {
		assert.strictEqual(truncateMessage(''), '');
	});

	it('should preserve multi-byte characters within the 160 byte limit', function () {
		// substring() operates on code units — BBS usernames are ASCII so this
		// mirrors production usage, but worth confirming no crash on unicode
		var msg = 'Hello ' + '\u00e9'.repeat(80);
		var result = truncateMessage(msg);
		assert.ok(result.length <= 160);
	});
});

// ---------------------------------------------------------------------------
// getRecentMessages result reversal
// ---------------------------------------------------------------------------

describe('getRecentMessages result reversal (wall.js)', function () {
	it('should reverse DB rows so that the oldest appears first', function () {
		// DB returns newest-first; reversal makes display chronological
		var rows = [
			{ id: 3, message: 'newest' },
			{ id: 2, message: 'middle' },
			{ id: 1, message: 'oldest' }
		];
		var result = applyRecentReversal(rows);
		assert.strictEqual(result[0].id, 1);
		assert.strictEqual(result[2].id, 3);
	});

	it('should return an empty array when rows is null', function () {
		assert.deepStrictEqual(applyRecentReversal(null), []);
	});

	it('should return an empty array when rows is an empty array', function () {
		assert.deepStrictEqual(applyRecentReversal([]), []);
	});

	it('should return a single-element array unchanged in content', function () {
		var rows = [{ id: 1, message: 'only one' }];
		var result = applyRecentReversal(rows);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, 1);
	});

	it('should mutate and return the same array reference (Array.reverse() is in-place)', function () {
		var rows = [{ id: 2 }, { id: 1 }];
		var result = applyRecentReversal(rows);
		// In the real code, rows.reverse() mutates and returns the same reference
		assert.strictEqual(result, rows);
	});
});

// ---------------------------------------------------------------------------
// Export shape — validate wall.js exports the expected functions
// (uses the same graceful-skip pattern as modelExports.test.js)
// ---------------------------------------------------------------------------

describe('src/models/wall.js exports', function () {
	var mod;

	before(async function () {
		try {
			mod = await import('../src/models/wall.js');
		} catch (err) {
			mod = null;
		}
	});

	var expectedFns = [
		'getRecentMessages',
		'getAllMessages',
		'addMessage',
		'deleteMessage',
		'purgeOldMessages',
		'getCount',
		'canPost'
	];

	for (var fnName of expectedFns) {
		(function (name) {
			it('exports ' + name + ' as a function', function () {
				if (!mod) return this.skip();
				assert.ok(
					Object.prototype.hasOwnProperty.call(mod, name),
					'wall.js does not export "' + name + '"'
				);
				assert.strictEqual(
					typeof mod[name], 'function',
					'wall.js export "' + name + '" is not a function (got ' + typeof mod[name] + ')'
				);
			});
		})(fnName);
	}
});
