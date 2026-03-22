// tests/configDefaults.test.js — Unit tests for configDefaults.js
//
// Tests getDefaults(), getDefinition(), getCategories(), CONFIG_DEFINITIONS.
// Pure logic — no DB, no Redis.
// Run: npx mocha tests/configDefaults.test.js

import assert from 'assert';
import { CONFIG_DEFINITIONS, getDefaults, getDefinition, getCategories } from '../src/config/configDefaults.js';

// ---------------------------------------------------------------------------
// CONFIG_DEFINITIONS structure
// ---------------------------------------------------------------------------

describe('CONFIG_DEFINITIONS', function () {

	it('should be a non-empty array', function () {
		assert.ok(Array.isArray(CONFIG_DEFINITIONS));
		assert.ok(CONFIG_DEFINITIONS.length > 0);
	});

	it('should have required fields on every entry', function () {
		for (var def of CONFIG_DEFINITIONS) {
			assert.ok(typeof def.key === 'string' && def.key.length > 0,
				'key should be a non-empty string: ' + JSON.stringify(def));
			assert.ok(def.defaultValue !== undefined,
				'defaultValue should be defined for key: ' + def.key);
			assert.ok(typeof def.type === 'string' && def.type.length > 0,
				'type should be a non-empty string for key: ' + def.key);
			assert.ok(typeof def.category === 'string' && def.category.length > 0,
				'category should be a non-empty string for key: ' + def.key);
			assert.ok(typeof def.description === 'string',
				'description should be a string for key: ' + def.key);
		}
	});

	it('should have only valid type values', function () {
		var VALID_TYPES = ['string', 'number', 'boolean'];
		for (var def of CONFIG_DEFINITIONS) {
			assert.ok(VALID_TYPES.includes(def.type),
				'Invalid type "' + def.type + '" for key: ' + def.key);
		}
	});

	it('should have no duplicate keys', function () {
		var seen = {};
		for (var def of CONFIG_DEFINITIONS) {
			assert.ok(!seen[def.key], 'Duplicate key: ' + def.key);
			seen[def.key] = true;
		}
	});

	it('should include expected system keys', function () {
		var keys = CONFIG_DEFINITIONS.map(function(d) { return d.key; });
		assert.ok(keys.includes('boardname'));
		assert.ok(keys.includes('webport'));
		assert.ok(keys.includes('adminsecurity'));
		assert.ok(keys.includes('loglevel'));
		assert.ok(keys.includes('MAILER_BINKP_PORT'));
	});
});

// ---------------------------------------------------------------------------
// getDefaults
// ---------------------------------------------------------------------------

describe('getDefaults', function () {

	it('should return a plain object', function () {
		var d = getDefaults();
		assert.ok(d !== null && typeof d === 'object' && !Array.isArray(d));
	});

	it('should contain a key for every CONFIG_DEFINITIONS entry', function () {
		var d = getDefaults();
		for (var def of CONFIG_DEFINITIONS) {
			assert.ok(def.key in d,
				'getDefaults() missing key: ' + def.key);
		}
	});

	it('should set each key to the definition defaultValue', function () {
		var d = getDefaults();
		for (var def of CONFIG_DEFINITIONS) {
			assert.strictEqual(d[def.key], def.defaultValue,
				'Wrong default for key: ' + def.key);
		}
	});

	it('should have boardname default "Canectic BBS"', function () {
		var d = getDefaults();
		assert.strictEqual(d.boardname, 'Canectic BBS');
	});

	it('should have adminsecurity default "200"', function () {
		var d = getDefaults();
		assert.strictEqual(d.adminsecurity, '200');
	});

	it('should have MAILER_BINKP_PORT default "24554"', function () {
		var d = getDefaults();
		assert.strictEqual(d.MAILER_BINKP_PORT, '24554');
	});

	it('should have webport default "8080"', function () {
		var d = getDefaults();
		assert.strictEqual(d.webport, '8080');
	});

	it('should not share object reference across calls', function () {
		var d1 = getDefaults();
		var d2 = getDefaults();
		d1.boardname = 'mutated';
		assert.notStrictEqual(d2.boardname, 'mutated');
	});
});

// ---------------------------------------------------------------------------
// getDefinition
// ---------------------------------------------------------------------------

describe('getDefinition', function () {

	it('should return the definition object for a known key', function () {
		var def = getDefinition('boardname');
		assert.notStrictEqual(def, null);
		assert.strictEqual(def.key, 'boardname');
		assert.strictEqual(def.type, 'string');
		assert.strictEqual(def.category, 'system');
	});

	it('should return null for an unknown key', function () {
		assert.strictEqual(getDefinition('no_such_key_xyz'), null);
	});

	it('should return null for null', function () {
		assert.strictEqual(getDefinition(null), null);
	});

	it('should find MAILER_BINKP_PORT', function () {
		var def = getDefinition('MAILER_BINKP_PORT');
		assert.notStrictEqual(def, null);
		assert.strictEqual(def.type, 'number');
		assert.strictEqual(def.category, 'mailer');
	});

	it('should find loglevel with correct type', function () {
		var def = getDefinition('loglevel');
		assert.notStrictEqual(def, null);
		assert.strictEqual(def.type, 'number');
	});

	it('should find a boolean key', function () {
		var def = getDefinition('allow_netmail_relay');
		assert.notStrictEqual(def, null);
		assert.strictEqual(def.type, 'boolean');
	});
});

// ---------------------------------------------------------------------------
// getCategories
// ---------------------------------------------------------------------------

describe('getCategories', function () {

	it('should return an array', function () {
		var cats = getCategories();
		assert.ok(Array.isArray(cats));
	});

	it('should contain no duplicates', function () {
		var cats = getCategories();
		var seen = {};
		for (var cat of cats) {
			assert.ok(!seen[cat], 'Duplicate category: ' + cat);
			seen[cat] = true;
		}
	});

	it('should include expected categories', function () {
		var cats = getCategories();
		assert.ok(cats.includes('system'));
		assert.ok(cats.includes('network'));
		assert.ok(cats.includes('security'));
		assert.ok(cats.includes('logging'));
		assert.ok(cats.includes('mailer'));
		assert.ok(cats.includes('terminal'));
		assert.ok(cats.includes('doors'));
	});

	it('should preserve order of first appearance', function () {
		// system is defined first, so it should come first
		var cats = getCategories();
		assert.strictEqual(cats[0], 'system');
	});

	it('should cover all categories referenced by CONFIG_DEFINITIONS', function () {
		var cats = getCategories();
		var catSet = new Set(cats);
		for (var def of CONFIG_DEFINITIONS) {
			assert.ok(catSet.has(def.category),
				'Category "' + def.category + '" from key "' + def.key + '" not in getCategories()');
		}
	});
});
