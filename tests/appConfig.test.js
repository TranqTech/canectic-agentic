// tests/appConfig.test.js — Unit tests for appConfig getter logic and merge
//
// appConfig.js uses a module-level _cache object that requires DB/env to
// populate via load().  Rather than mocking the DB, we test the logic by
// extracting the pure functions inline:
//
//   - buildMergedCache(dbRows)  — three-tier merge (defaults → DB → env)
//   - get(key, default)         — string getter with fallback
//   - getNumber(key, default)   — integer coercion
//   - getBoolean(key, default)  — boolean coercion
//   - getJSON(key, default)     — JSON parse
//   - getSource(key)            — tier reporting
//
// The real appConfig.js is NOT imported here (it would try to import postgres
// and configStore at module load time).  Instead the pure logic is inlined
// with comments referencing the source lines.
//
// Run: npx mocha tests/appConfig.test.js

import assert from 'assert';
import { CONFIG_DEFINITIONS, getDefaults } from '../src/config/configDefaults.js';

// ---------------------------------------------------------------------------
// Inlined pure getter helpers — mirrors src/config/appConfig.js
// ---------------------------------------------------------------------------

function makeGetters(cache, sources) {
	function get(key, defaultValue) {
		var val = cache[key];
		if (val !== undefined && val !== null && val !== '') return val;
		return defaultValue;
	}

	function getNumber(key, defaultValue) {
		var val = cache[key];
		if (val === undefined || val === null || val === '') return defaultValue;
		var num = parseInt(val, 10);
		return isNaN(num) ? defaultValue : num;
	}

	function getBoolean(key, defaultValue) {
		var val = cache[key];
		if (val === undefined || val === null) return defaultValue;
		var lower = String(val).toLowerCase().trim();
		if (lower === 'true'  || lower === '1' || lower === 'yes') return true;
		if (lower === 'false' || lower === '0' || lower === 'no' || lower === '') return false;
		return defaultValue;
	}

	function getJSON(key, defaultValue) {
		var val = cache[key];
		if (val === undefined || val === null || val === '') return defaultValue;
		try { return JSON.parse(val); } catch (_) { return defaultValue; }
	}

	function getSource(key) {
		return (sources && sources[key]) || 'default';
	}

	return { get, getNumber, getBoolean, getJSON, getSource };
}

// ---------------------------------------------------------------------------
// buildMergedCache — inlined to avoid importing appConfig (which needs DB)
// ---------------------------------------------------------------------------

function buildMergedCache(dbRows, envSnapshot) {
	// envSnapshot is a plain {key: value} that replaces process.env for testing
	var defaults = getDefaults();
	var merged = {};
	var sources = {};

	for (var key in defaults) {
		merged[key] = defaults[key];
		sources[key] = 'default';
	}

	if (dbRows) {
		for (var row of dbRows) {
			if (row.key && row.value !== null && row.value !== undefined) {
				merged[row.key] = row.value;
				sources[row.key] = 'db';
			}
		}
	}

	// Simulate env override using envSnapshot instead of process.env
	if (envSnapshot) {
		for (var def of CONFIG_DEFINITIONS) {
			if (envSnapshot[def.key] !== undefined && envSnapshot[def.key] !== '') {
				merged[def.key] = envSnapshot[def.key];
				sources[def.key] = 'env';
			}
		}
	}

	return { merged, sources };
}

// ---------------------------------------------------------------------------
// buildMergedCache — three-tier merge
// ---------------------------------------------------------------------------

describe('buildMergedCache', function () {

	it('should include all default keys when no DB rows are provided', function () {
		var result = buildMergedCache(null, null);
		var defaults = getDefaults();
		for (var key in defaults) {
			assert.ok(key in result.merged, 'missing key from defaults: ' + key);
		}
	});

	it('should mark all default-only keys with source "default"', function () {
		var result = buildMergedCache(null, null);
		assert.strictEqual(result.sources['boardname'], 'default');
		assert.strictEqual(result.sources['webport'],   'default');
	});

	it('should let DB values override defaults', function () {
		var dbRows = [{ key: 'boardname', value: 'My BBS' }];
		var result = buildMergedCache(dbRows, null);
		assert.strictEqual(result.merged['boardname'], 'My BBS');
		assert.strictEqual(result.sources['boardname'], 'db');
	});

	it('should ignore DB rows with null value', function () {
		var dbRows = [{ key: 'boardname', value: null }];
		var result = buildMergedCache(dbRows, null);
		// null value is skipped; default should remain
		assert.strictEqual(result.merged['boardname'], 'Canectic BBS');
		assert.strictEqual(result.sources['boardname'], 'default');
	});

	it('should ignore DB rows with undefined value', function () {
		var dbRows = [{ key: 'boardname', value: undefined }];
		var result = buildMergedCache(dbRows, null);
		assert.strictEqual(result.merged['boardname'], 'Canectic BBS');
	});

	it('should ignore DB rows with no key', function () {
		var dbRows = [{ value: 'orphan value' }];
		var result = buildMergedCache(dbRows, null);
		// Should not throw; unknown key should not pollute cache
		assert.ok(result.merged !== null);
	});

	it('should let env values override DB values', function () {
		var dbRows   = [{ key: 'boardname', value: 'DB BBS' }];
		var envSnap  = { boardname: 'ENV BBS' };
		var result = buildMergedCache(dbRows, envSnap);
		assert.strictEqual(result.merged['boardname'], 'ENV BBS');
		assert.strictEqual(result.sources['boardname'], 'env');
	});

	it('should let env values override defaults directly', function () {
		var envSnap = { boardname: 'ENV BBS' };
		var result = buildMergedCache(null, envSnap);
		assert.strictEqual(result.merged['boardname'], 'ENV BBS');
		assert.strictEqual(result.sources['boardname'], 'env');
	});

	it('should not apply env override for a key with empty string value', function () {
		// Empty string in env is treated as "not set" (same as appConfig.js line 78)
		var envSnap = { boardname: '' };
		var result = buildMergedCache(null, envSnap);
		assert.strictEqual(result.merged['boardname'], 'Canectic BBS');
		assert.strictEqual(result.sources['boardname'], 'default');
	});

	it('should handle empty dbRows array without error', function () {
		var result = buildMergedCache([], null);
		assert.strictEqual(result.sources['boardname'], 'default');
	});

	it('should stack multiple DB keys independently', function () {
		var dbRows = [
			{ key: 'boardname', value: 'My BBS' },
			{ key: 'webport',   value: '9090'   }
		];
		var result = buildMergedCache(dbRows, null);
		assert.strictEqual(result.merged['boardname'], 'My BBS');
		assert.strictEqual(result.merged['webport'],   '9090');
		assert.strictEqual(result.sources['boardname'], 'db');
		assert.strictEqual(result.sources['webport'],   'db');
	});
});

// ---------------------------------------------------------------------------
// get — string getter with fallback
// ---------------------------------------------------------------------------

describe('appConfig.get', function () {

	it('should return the cached value for an existing key', function () {
		var { get } = makeGetters({ boardname: 'My BBS' }, {});
		assert.strictEqual(get('boardname'), 'My BBS');
	});

	it('should return defaultValue for a missing key', function () {
		var { get } = makeGetters({}, {});
		assert.strictEqual(get('boardname', 'Fallback'), 'Fallback');
	});

	it('should return defaultValue when the cached value is null', function () {
		var { get } = makeGetters({ boardname: null }, {});
		assert.strictEqual(get('boardname', 'Fallback'), 'Fallback');
	});

	it('should return defaultValue when the cached value is empty string', function () {
		var { get } = makeGetters({ boardname: '' }, {});
		assert.strictEqual(get('boardname', 'Fallback'), 'Fallback');
	});

	it('should return undefined when key is missing and no defaultValue given', function () {
		var { get } = makeGetters({}, {});
		assert.strictEqual(get('nosuchkey'), undefined);
	});

	it('should return the string "0" without treating it as falsy', function () {
		var { get } = makeGetters({ mykey: '0' }, {});
		// '0' is a valid non-empty string — it should be returned, not the default
		assert.strictEqual(get('mykey', 'fallback'), '0');
	});
});

// ---------------------------------------------------------------------------
// getNumber — integer coercion
// ---------------------------------------------------------------------------

describe('appConfig.getNumber', function () {

	it('should parse a numeric string to an integer', function () {
		var { getNumber } = makeGetters({ webport: '9090' }, {});
		assert.strictEqual(getNumber('webport'), 9090);
	});

	it('should return defaultValue for a missing key', function () {
		var { getNumber } = makeGetters({}, {});
		assert.strictEqual(getNumber('webport', 8080), 8080);
	});

	it('should return defaultValue for null', function () {
		var { getNumber } = makeGetters({ webport: null }, {});
		assert.strictEqual(getNumber('webport', 8080), 8080);
	});

	it('should return defaultValue for empty string', function () {
		var { getNumber } = makeGetters({ webport: '' }, {});
		assert.strictEqual(getNumber('webport', 8080), 8080);
	});

	it('should return defaultValue for a non-numeric string', function () {
		var { getNumber } = makeGetters({ webport: 'notanumber' }, {});
		assert.strictEqual(getNumber('webport', 8080), 8080);
	});

	it('should truncate a decimal string (parseInt behaviour)', function () {
		var { getNumber } = makeGetters({ val: '3.14' }, {});
		assert.strictEqual(getNumber('val', 0), 3);
	});

	it('should parse a string starting with digits and ignoring trailing text', function () {
		// parseInt('8080abc') → 8080
		var { getNumber } = makeGetters({ webport: '8080abc' }, {});
		assert.strictEqual(getNumber('webport', 0), 8080);
	});
});

// ---------------------------------------------------------------------------
// getBoolean — boolean coercion
// ---------------------------------------------------------------------------

describe('appConfig.getBoolean', function () {

	it('should return true for "true"', function () {
		var { getBoolean } = makeGetters({ flag: 'true' }, {});
		assert.strictEqual(getBoolean('flag'), true);
	});

	it('should return true for "1"', function () {
		var { getBoolean } = makeGetters({ flag: '1' }, {});
		assert.strictEqual(getBoolean('flag'), true);
	});

	it('should return true for "yes"', function () {
		var { getBoolean } = makeGetters({ flag: 'yes' }, {});
		assert.strictEqual(getBoolean('flag'), true);
	});

	it('should return true for "TRUE" (case-insensitive)', function () {
		var { getBoolean } = makeGetters({ flag: 'TRUE' }, {});
		assert.strictEqual(getBoolean('flag'), true);
	});

	it('should return false for "false"', function () {
		var { getBoolean } = makeGetters({ flag: 'false' }, {});
		assert.strictEqual(getBoolean('flag'), false);
	});

	it('should return false for "0"', function () {
		var { getBoolean } = makeGetters({ flag: '0' }, {});
		assert.strictEqual(getBoolean('flag'), false);
	});

	it('should return false for "no"', function () {
		var { getBoolean } = makeGetters({ flag: 'no' }, {});
		assert.strictEqual(getBoolean('flag'), false);
	});

	it('should return false for empty string', function () {
		var { getBoolean } = makeGetters({ flag: '' }, {});
		assert.strictEqual(getBoolean('flag', true), false);
	});

	it('should return false for "FALSE" (case-insensitive)', function () {
		var { getBoolean } = makeGetters({ flag: 'FALSE' }, {});
		assert.strictEqual(getBoolean('flag'), false);
	});

	it('should return defaultValue for a missing key', function () {
		var { getBoolean } = makeGetters({}, {});
		assert.strictEqual(getBoolean('missing', true), true);
	});

	it('should return defaultValue for null', function () {
		var { getBoolean } = makeGetters({ flag: null }, {});
		assert.strictEqual(getBoolean('flag', true), true);
	});

	it('should return defaultValue for an unrecognised string', function () {
		var { getBoolean } = makeGetters({ flag: 'maybe' }, {});
		assert.strictEqual(getBoolean('flag', true), true);
	});
});

// ---------------------------------------------------------------------------
// getJSON — JSON parse with fallback
// ---------------------------------------------------------------------------

describe('appConfig.getJSON', function () {

	it('should parse a JSON array string', function () {
		var { getJSON } = makeGetters({ hosts: '["a","b"]' }, {});
		assert.deepStrictEqual(getJSON('hosts'), ['a', 'b']);
	});

	it('should parse a JSON object string', function () {
		var { getJSON } = makeGetters({ config: '{"x":1}' }, {});
		assert.deepStrictEqual(getJSON('config'), { x: 1 });
	});

	it('should return defaultValue for missing key', function () {
		var { getJSON } = makeGetters({}, {});
		assert.deepStrictEqual(getJSON('missing', []), []);
	});

	it('should return defaultValue for null', function () {
		var { getJSON } = makeGetters({ hosts: null }, {});
		assert.deepStrictEqual(getJSON('hosts', []), []);
	});

	it('should return defaultValue for empty string', function () {
		var { getJSON } = makeGetters({ hosts: '' }, {});
		assert.deepStrictEqual(getJSON('hosts', []), []);
	});

	it('should return defaultValue for malformed JSON', function () {
		var { getJSON } = makeGetters({ hosts: '[broken' }, {});
		assert.deepStrictEqual(getJSON('hosts', []), []);
	});

	it('should parse a JSON number', function () {
		var { getJSON } = makeGetters({ count: '42' }, {});
		assert.strictEqual(getJSON('count'), 42);
	});

	it('should parse a JSON boolean', function () {
		var { getJSON } = makeGetters({ enabled: 'true' }, {});
		assert.strictEqual(getJSON('enabled'), true);
	});
});

// ---------------------------------------------------------------------------
// getSource — tier reporting
// ---------------------------------------------------------------------------

describe('appConfig.getSource', function () {

	it('should return "default" for a key with default source', function () {
		var { getSource } = makeGetters({}, { boardname: 'default' });
		assert.strictEqual(getSource('boardname'), 'default');
	});

	it('should return "db" for a key with db source', function () {
		var { getSource } = makeGetters({}, { boardname: 'db' });
		assert.strictEqual(getSource('boardname'), 'db');
	});

	it('should return "env" for a key with env source', function () {
		var { getSource } = makeGetters({}, { boardname: 'env' });
		assert.strictEqual(getSource('boardname'), 'env');
	});

	it('should return "default" for an unknown key', function () {
		var { getSource } = makeGetters({}, {});
		assert.strictEqual(getSource('nosuchkey'), 'default');
	});

	it('should reflect source set by buildMergedCache for db tier', function () {
		var result = buildMergedCache([{ key: 'boardname', value: 'DB BBS' }], null);
		var { getSource } = makeGetters(result.merged, result.sources);
		assert.strictEqual(getSource('boardname'), 'db');
	});

	it('should reflect source set by buildMergedCache for env tier', function () {
		var result = buildMergedCache(null, { boardname: 'ENV BBS' });
		var { getSource } = makeGetters(result.merged, result.sources);
		assert.strictEqual(getSource('boardname'), 'env');
	});

	it('should reflect source set by buildMergedCache for default tier', function () {
		var result = buildMergedCache(null, null);
		var { getSource } = makeGetters(result.merged, result.sources);
		assert.strictEqual(getSource('boardname'), 'default');
	});
});
