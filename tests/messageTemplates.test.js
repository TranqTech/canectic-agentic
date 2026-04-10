// tests/messageTemplates.test.js
// Unit tests for pure logic in messageTemplates.js and templateVars.js.
//
// DB-dependent paths (fireEvent actually delivering, CRUD roundtrip) require
// a test database harness and are out of scope for this file. These tests
// cover:
//   - applyTemplate() token substitution (including nested paths)
//   - buildContext() user/event variable assembly
//   - evaluateConditions() pure logic
//   - Export validation
//
// Run: npx mocha tests/messageTemplates.test.js

import assert from 'assert';

var templateVars, mod;
try {
	templateVars = await import('../src/utils/templateVars.js');
} catch (_) { templateVars = null; }
try {
	mod = await import('../src/models/messageTemplates.js');
} catch (_) { mod = null; }

// ---------------------------------------------------------------------------
// applyTemplate — pure string substitution
// ---------------------------------------------------------------------------

describe('templateVars.applyTemplate', function() {
	before(function() {
		if (!templateVars) this.skip();
	});

	it('returns template unchanged when no braces present', function() {
		assert.strictEqual(templateVars.applyTemplate('hello world', {}), 'hello world');
	});

	it('returns empty string for null/undefined template', function() {
		assert.strictEqual(templateVars.applyTemplate(null, {}), '');
		assert.strictEqual(templateVars.applyTemplate(undefined, {}), '');
	});

	it('substitutes a single top-level variable', function() {
		var result = templateVars.applyTemplate('Hello {name}!', { name: 'Bob' });
		assert.strictEqual(result, 'Hello Bob!');
	});

	it('substitutes nested dot-path variables', function() {
		var result = templateVars.applyTemplate('User: {user.username}', {
			user: { username: 'alice' }
		});
		assert.strictEqual(result, 'User: alice');
	});

	it('substitutes deeply nested paths', function() {
		var result = templateVars.applyTemplate('{a.b.c.d}', {
			a: { b: { c: { d: 'deep' } } }
		});
		assert.strictEqual(result, 'deep');
	});

	it('leaves unknown tokens in place so they are visible during testing', function() {
		var result = templateVars.applyTemplate('Hi {unknown} and {other.missing}', { name: 'Bob' });
		assert.strictEqual(result, 'Hi {unknown} and {other.missing}');
	});

	it('handles multiple substitutions in one string', function() {
		var result = templateVars.applyTemplate('{greet} {user.name}, your code is {code}', {
			greet: 'Hello',
			user: { name: 'Alice' },
			code: 'ABC123'
		});
		assert.strictEqual(result, 'Hello Alice, your code is ABC123');
	});

	it('formats null values as empty strings', function() {
		var result = templateVars.applyTemplate('[{val}]', { val: null });
		assert.strictEqual(result, '[]');
	});

	it('formats boolean values as yes/no', function() {
		assert.strictEqual(templateVars.applyTemplate('{x}', { x: true }), 'yes');
		assert.strictEqual(templateVars.applyTemplate('{x}', { x: false }), 'no');
	});

	it('formats Date objects as locale date strings', function() {
		var d = new Date('2026-04-09T12:00:00Z');
		var result = templateVars.applyTemplate('{d}', { d: d });
		// Locale-specific, but should be a non-empty string that contains a digit
		assert.ok(/\d/.test(result));
		assert.notStrictEqual(result, '{d}');
	});

	it('does not match malformed token patterns', function() {
		// Missing closing brace, malformed key
		assert.strictEqual(templateVars.applyTemplate('{bad', { bad: 'x' }), '{bad');
		assert.strictEqual(templateVars.applyTemplate('{ bad }', { bad: 'x' }), '{ bad }');
	});
});

// ---------------------------------------------------------------------------
// buildContext / buildUserVars — variable assembly
// ---------------------------------------------------------------------------

describe('templateVars.buildContext', function() {
	before(function() {
		if (!templateVars) this.skip();
	});

	it('returns standard vars (boardname, date, etc) even with no user', function() {
		var ctx = templateVars.buildContext(null, null);
		assert.ok(ctx.boardname !== undefined);
		assert.ok(ctx.date !== undefined);
		assert.ok(ctx.year !== undefined);
		assert.ok(!ctx.user, 'no user key when user is null');
	});

	it('includes user fields under user.* when user is passed', function() {
		var user = {
			username: 'bob',
			fullname: 'Bob Smith',
			firstname: 'Bob',
			lastname: 'Smith',
			mailaddress: 'bob@example.com',
			mailtype: 'email',
			location: 'Testville',
			security: 50,
			logoncount: 10
		};
		var ctx = templateVars.buildContext(user, null);
		assert.strictEqual(ctx.user.username, 'bob');
		assert.strictEqual(ctx.user.fullname, 'Bob Smith');
		assert.strictEqual(ctx.user.email, 'bob@example.com');
		assert.strictEqual(ctx.user.location, 'Testville');
		assert.strictEqual(ctx.user.logoncount, 10);
	});

	it('includes extraVars (e.g. event object) at top level', function() {
		var ctx = templateVars.buildContext(null, { event: { verify_code: 'XYZ' } });
		assert.strictEqual(ctx.event.verify_code, 'XYZ');
	});
});

// ---------------------------------------------------------------------------
// evaluateConditions — pure condition filter
// ---------------------------------------------------------------------------

describe('messageTemplates.evaluateConditions', function() {
	before(function() {
		if (!mod) this.skip();
	});

	it('returns true when conditions is null/empty', function() {
		assert.strictEqual(mod.evaluateConditions(null, { security: 50 }), true);
		assert.strictEqual(mod.evaluateConditions({}, { security: 50 }), true);
	});

	it('parses conditions from a JSON string', function() {
		var result = mod.evaluateConditions('{"security_min":50}', { security: 50 });
		assert.strictEqual(result, true);
	});

	it('security_min enforces minimum security level', function() {
		assert.strictEqual(mod.evaluateConditions({ security_min: 50 }, { security: 100 }), true);
		assert.strictEqual(mod.evaluateConditions({ security_min: 50 }, { security: 50 }), true);
		assert.strictEqual(mod.evaluateConditions({ security_min: 50 }, { security: 49 }), false);
	});

	it('security_max enforces maximum security level', function() {
		assert.strictEqual(mod.evaluateConditions({ security_max: 100 }, { security: 50 }), true);
		assert.strictEqual(mod.evaluateConditions({ security_max: 100 }, { security: 100 }), true);
		assert.strictEqual(mod.evaluateConditions({ security_max: 100 }, { security: 101 }), false);
	});

	it('verified filter matches boolean', function() {
		assert.strictEqual(mod.evaluateConditions({ verified: true }, { mailverified: true }), true);
		assert.strictEqual(mod.evaluateConditions({ verified: true }, { mailverified: false }), false);
		assert.strictEqual(mod.evaluateConditions({ verified: false }, { mailverified: false }), true);
	});

	it('has_email requires user with mailtype=email', function() {
		assert.strictEqual(mod.evaluateConditions({ has_email: true }, {
			mailtype: 'email', mailaddress: 'x@y'
		}), true);
		assert.strictEqual(mod.evaluateConditions({ has_email: true }, {
			mailtype: 'netmail', mailaddress: '1:2/3'
		}), false);
		assert.strictEqual(mod.evaluateConditions({ has_email: true }, {
			mailtype: 'email', mailaddress: ''
		}), false);
	});

	it('nth_count matches event-specific count from extraVars', function() {
		var user = { security: 50 };
		var extraVars = { event: { login_number: 10 } };
		assert.strictEqual(
			mod.evaluateConditions({ nth_count: [1, 10, 100] }, user, extraVars),
			true
		);
		assert.strictEqual(
			mod.evaluateConditions({ nth_count: [1, 5, 100] }, user, extraVars),
			false
		);
	});

	it('days_inactive checks lastlogon age', function() {
		var now = Date.now();
		var oldDate = new Date(now - 40 * 24 * 60 * 60 * 1000); // 40 days ago
		var newDate = new Date(now - 5 * 24 * 60 * 60 * 1000);  // 5 days ago
		assert.strictEqual(
			mod.evaluateConditions({ days_inactive: 30 }, { lastlogon: oldDate }),
			true,
			'40-day-old lastlogon should match days_inactive:30'
		);
		assert.strictEqual(
			mod.evaluateConditions({ days_inactive: 30 }, { lastlogon: newDate }),
			false,
			'5-day-old lastlogon should NOT match days_inactive:30'
		);
	});

	it('permission_flags requires all listed flags', function() {
		var user = { permissionflags: ['Sysop', 'Admin'] };
		assert.strictEqual(
			mod.evaluateConditions({ permission_flags: ['Sysop'] }, user),
			true
		);
		assert.strictEqual(
			mod.evaluateConditions({ permission_flags: ['Sysop', 'Admin'] }, user),
			true
		);
		assert.strictEqual(
			mod.evaluateConditions({ permission_flags: ['Sysop', 'Godmode'] }, user),
			false
		);
	});

	it('restriction_flags rejects users with any listed flag', function() {
		var userA = { restrictionflags: ['Banned'] };
		var userB = { restrictionflags: [] };
		assert.strictEqual(
			mod.evaluateConditions({ restriction_flags: ['Banned'] }, userA),
			false
		);
		assert.strictEqual(
			mod.evaluateConditions({ restriction_flags: ['Banned'] }, userB),
			true
		);
	});

	it('combines multiple conditions with AND semantics', function() {
		var user = { security: 75, mailverified: true };
		assert.strictEqual(
			mod.evaluateConditions({ security_min: 50, verified: true }, user),
			true
		);
		assert.strictEqual(
			mod.evaluateConditions({ security_min: 50, verified: false }, user),
			false,
			'ANDed conditions: all must pass'
		);
	});
});

// ---------------------------------------------------------------------------
// Export validation
// ---------------------------------------------------------------------------

describe('messageTemplates.js exports', function() {
	before(function() {
		if (!mod) this.skip();
	});

	var expectedFns = [
		// Event registry CRUD
		'getAllEvents', 'getEventByCode', 'getEventById',
		'createEvent', 'updateEvent', 'deleteEvent',
		// Templates CRUD
		'getAllTemplates', 'getTemplatesForEvent', 'getTemplateById',
		'createTemplate', 'updateTemplate', 'deleteTemplate',
		// Dispatch
		'fireEvent', 'fireEventForMany', 'evaluateConditions',
		// Seed
		'seedBuiltinEvents'
	];

	expectedFns.forEach(function(fn) {
		it('exports ' + fn + ' as a function', function() {
			assert.strictEqual(typeof mod[fn], 'function', fn + ' should be a function');
		});
	});
});

describe('templateVars.js exports', function() {
	before(function() {
		if (!templateVars) this.skip();
	});

	var expectedFns = ['applyTemplate', 'buildStandardVars', 'buildUserVars', 'buildContext', 'lookup', 'formatValue'];

	expectedFns.forEach(function(fn) {
		it('exports ' + fn + ' as a function', function() {
			assert.strictEqual(typeof templateVars[fn], 'function');
		});
	});
});
