// tests/flagHelpers.test.js — Unit tests for parseFlags and normalizeFlags
//
// parseFlags appears in src/routes/index.js and src/routes/files.js (not exported).
// normalizeFlags is exported from src/models/fileGroups.js and src/models/fileAreas.js
// (identical implementations in both).
//
// Both are inlined here as they are pure functions and this validates their
// algorithm independent of the modules that import postgres/appConfig.
//
// Run: npx mocha tests/flagHelpers.test.js

import assert from 'assert';

// ---------------------------------------------------------------------------
// parseFlags — mirrors src/routes/index.js and src/routes/files.js
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

// ---------------------------------------------------------------------------
// normalizeFlags — mirrors src/models/fileGroups.js and src/models/fileAreas.js
// ---------------------------------------------------------------------------

function normalizeFlags(input) {
	if (!input) return JSON.stringify([]);
	if (typeof input === 'string') {
		try {
			var parsed = JSON.parse(input);
			if (Array.isArray(parsed)) return JSON.stringify(parsed);
		} catch (_) {}
		return JSON.stringify([input]);
	}
	if (Array.isArray(input)) return JSON.stringify(input);
	return JSON.stringify([]);
}

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe('parseFlags', function () {

	describe('falsy inputs', function () {
		it('should return [] for null', function () {
			assert.deepStrictEqual(parseFlags(null), []);
		});

		it('should return [] for undefined', function () {
			assert.deepStrictEqual(parseFlags(undefined), []);
		});

		it('should return [] for empty string', function () {
			assert.deepStrictEqual(parseFlags(''), []);
		});

		it('should return [] for 0', function () {
			assert.deepStrictEqual(parseFlags(0), []);
		});

		it('should return [] for false', function () {
			assert.deepStrictEqual(parseFlags(false), []);
		});
	});

	describe('array inputs (pass-through)', function () {
		it('should return the array unchanged when already an array', function () {
			var arr = ['Sysop', 'Member'];
			assert.strictEqual(parseFlags(arr), arr);
		});

		it('should return empty array unchanged', function () {
			var arr = [];
			assert.strictEqual(parseFlags(arr), arr);
		});
	});

	describe('JSON string inputs', function () {
		it('should parse a JSON array string', function () {
			assert.deepStrictEqual(parseFlags('["Sysop","Mod"]'), ['Sysop', 'Mod']);
		});

		it('should parse a JSON array with one element', function () {
			assert.deepStrictEqual(parseFlags('["Sysop"]'), ['Sysop']);
		});

		it('should return [] for a JSON array string that is empty', function () {
			assert.deepStrictEqual(parseFlags('[]'), []);
		});

		it('should return [] for a JSON non-array (object)', function () {
			assert.deepStrictEqual(parseFlags('{"key":"val"}'), []);
		});

		it('should return [] for a JSON non-array (string literal)', function () {
			// JSON.parse('"Sysop"') returns the string "Sysop", not an array
			assert.deepStrictEqual(parseFlags('"Sysop"'), []);
		});

		it('should return [] for malformed JSON', function () {
			assert.deepStrictEqual(parseFlags('[broken json'), []);
		});
	});

	describe('non-string, non-array inputs', function () {
		it('should return [] for a plain object', function () {
			assert.deepStrictEqual(parseFlags({ Sysop: true }), []);
		});

		it('should return [] for a number', function () {
			assert.deepStrictEqual(parseFlags(42), []);
		});
	});
});

// ---------------------------------------------------------------------------
// normalizeFlags
// ---------------------------------------------------------------------------

describe('normalizeFlags', function () {

	describe('falsy inputs', function () {
		it('should return "[]" for null', function () {
			assert.strictEqual(normalizeFlags(null), '[]');
		});

		it('should return "[]" for undefined', function () {
			assert.strictEqual(normalizeFlags(undefined), '[]');
		});

		it('should return "[]" for empty string', function () {
			assert.strictEqual(normalizeFlags(''), '[]');
		});

		it('should return "[]" for 0', function () {
			assert.strictEqual(normalizeFlags(0), '[]');
		});

		it('should return "[]" for false', function () {
			assert.strictEqual(normalizeFlags(false), '[]');
		});
	});

	describe('string inputs', function () {
		it('should wrap a plain string as a single-element JSON array', function () {
			assert.strictEqual(normalizeFlags('Sysop'), '["Sysop"]');
		});

		it('should pass through an already-valid JSON array string', function () {
			assert.strictEqual(normalizeFlags('["Sysop","Mod"]'), '["Sysop","Mod"]');
		});

		it('should pass through an empty JSON array string', function () {
			assert.strictEqual(normalizeFlags('[]'), '[]');
		});

		it('should wrap a non-JSON string as a single-element array', function () {
			// The string is not valid JSON, so it becomes ["Member"]
			assert.strictEqual(normalizeFlags('Member'), '["Member"]');
		});

		it('should wrap a JSON non-array string as a single-element array', function () {
			// JSON.parse('{"k":"v"}') succeeds but is not an array.
			// Falls through to JSON.stringify([input]) where input is the original string.
			assert.strictEqual(normalizeFlags('{"k":"v"}'), JSON.stringify(['{"k":"v"}']));
		});
	});

	describe('array inputs', function () {
		it('should serialise an array to JSON', function () {
			assert.strictEqual(normalizeFlags(['Sysop', 'Mod']), '["Sysop","Mod"]');
		});

		it('should serialise a single-element array', function () {
			assert.strictEqual(normalizeFlags(['Sysop']), '["Sysop"]');
		});

		it('should serialise an empty array to "[]"', function () {
			assert.strictEqual(normalizeFlags([]), '[]');
		});
	});

	describe('other types', function () {
		it('should return "[]" for a plain object', function () {
			assert.strictEqual(normalizeFlags({ Sysop: true }), '[]');
		});

		it('should return "[]" for a number', function () {
			assert.strictEqual(normalizeFlags(42), '[]');
		});
	});

	describe('round-trip with parseFlags', function () {
		it('should produce a value that parseFlags can parse back', function () {
			var input = ['Sysop', 'Member'];
			var normalized = normalizeFlags(input);
			assert.deepStrictEqual(parseFlags(normalized), input);
		});

		it('should round-trip an empty array', function () {
			assert.deepStrictEqual(parseFlags(normalizeFlags([])), []);
		});

		it('should round-trip null as empty array', function () {
			assert.deepStrictEqual(parseFlags(normalizeFlags(null)), []);
		});
	});
});
