// tests/menus.test.js — Unit tests for pure functions in src/models/menus.js
//
// Only the pure exported functions are tested here:
//   getAvailableCommands(), getValidDisplayFileTypes(),
//   getValidMenuTypes(), getAnsiColors()
//
// menus.js imports postgres — the pg Pool constructor is lazy (no network call
// at import time), so the module loads safely without a running database.
//
// Run: npx mocha tests/menus.test.js

import assert from 'assert';
import * as fs from 'fs';
import {
	getAvailableCommands,
	getValidDisplayFileTypes,
	getValidMenuTypes,
	getAnsiColors,
} from '../src/models/menus.js';

// ---------------------------------------------------------------------------
// getAvailableCommands
// ---------------------------------------------------------------------------

describe('getAvailableCommands', function () {

	// #82: fireEvent worked as a command but the editor could not offer it,
	// because this list is kept by hand. Every command the menu handler runs
	// must be here, apart from display-file types (another switch in the same
	// file) and aliases kept for old menus.
	it('offers every command the menu handler runs', function () {
		var src = fs.readFileSync(new URL('../src/handlers/menuhandler.js', import.meta.url), 'utf8');
		var cases = new Set(Array.from(src.matchAll(/case "([A-Za-z]+)":/g)).map(function (m) { return m[1]; }));
		var skip = new Set(getValidDisplayFileTypes().concat(['fileList']));
		var offered = new Set(getAvailableCommands().map(function (c) { return c.name; }));
		var missing = Array.from(cases).filter(function (c) { return !skip.has(c) && !offered.has(c); });
		assert.deepStrictEqual(missing, []);
	});

	it('should return an array', function () {
		var cmds = getAvailableCommands();
		assert.ok(Array.isArray(cmds));
	});

	it('should return a non-empty array', function () {
		var cmds = getAvailableCommands();
		assert.ok(cmds.length > 0);
	});

	it('every entry should have a string name field', function () {
		var cmds = getAvailableCommands();
		for (var cmd of cmds) {
			assert.ok(typeof cmd.name === 'string' && cmd.name.length > 0,
				'missing name on entry: ' + JSON.stringify(cmd));
		}
	});

	it('every entry should have a string label field', function () {
		var cmds = getAvailableCommands();
		for (var cmd of cmds) {
			assert.ok(typeof cmd.label === 'string' && cmd.label.length > 0,
				'missing label on entry: ' + JSON.stringify(cmd));
		}
	});

	it('every entry should have a boolean needsArg field', function () {
		var cmds = getAvailableCommands();
		for (var cmd of cmds) {
			assert.ok(typeof cmd.needsArg === 'boolean',
				'needsArg should be boolean on entry: ' + cmd.name);
		}
	});

	it('every entry with needsArg:true should also have a string argLabel', function () {
		var cmds = getAvailableCommands();
		for (var cmd of cmds) {
			if (cmd.needsArg) {
				assert.ok(typeof cmd.argLabel === 'string' && cmd.argLabel.length > 0,
					'needsArg:true entry missing argLabel: ' + cmd.name);
			}
		}
	});

	it('should include loadMenu command with needsArg:true', function () {
		var cmds = getAvailableCommands();
		var entry = cmds.find(function(c) { return c.name === 'loadMenu'; });
		assert.ok(entry, 'loadMenu command not found');
		assert.strictEqual(entry.needsArg, true);
		assert.ok(typeof entry.argLabel === 'string');
	});

	it('should include runXtrn (door game) command with needsArg:true', function () {
		var cmds = getAvailableCommands();
		var entry = cmds.find(function(c) { return c.name === 'runXtrn'; });
		assert.ok(entry, 'runXtrn command not found');
		assert.strictEqual(entry.needsArg, true);
	});

	it('should include previousMenu command with needsArg:false', function () {
		var cmds = getAvailableCommands();
		var entry = cmds.find(function(c) { return c.name === 'previousMenu'; });
		assert.ok(entry, 'previousMenu command not found');
		assert.strictEqual(entry.needsArg, false);
	});

	it('should include logOff command', function () {
		var cmds = getAvailableCommands();
		assert.ok(cmds.some(function(c) { return c.name === 'logOff'; }));
	});

	it('should include file area commands', function () {
		var cmds = getAvailableCommands();
		var names = cmds.map(function(c) { return c.name; });
		assert.ok(names.includes('fileAreaChange'),  'missing fileAreaChange');
		assert.ok(names.includes('fileGroupChange'), 'missing fileGroupChange');
		assert.ok(names.includes('fileBrowser'),     'missing fileBrowser');
		assert.ok(names.includes('downloadBatch'),   'missing downloadBatch');
		assert.ok(names.includes('fileUpload'),      'missing fileUpload');
		assert.ok(names.includes('fileSearch'),      'missing fileSearch');
	});

	it('should include message area commands', function () {
		var cmds = getAvailableCommands();
		var names = cmds.map(function(c) { return c.name; });
		assert.ok(names.includes('msgAreaChange'),  'missing msgAreaChange');
		assert.ok(names.includes('msgGroupChange'), 'missing msgGroupChange');
		assert.ok(names.includes('listMessages'),   'missing listMessages');
		assert.ok(names.includes('readMessages'),   'missing readMessages');
		assert.ok(names.includes('postMessage'),    'missing postMessage');
		assert.ok(names.includes('newScan'),        'missing newScan');
		assert.ok(names.includes('newScanGroup'),   'missing newScanGroup');
	});

	it('should include user/system commands', function () {
		var cmds = getAvailableCommands();
		var names = cmds.map(function(c) { return c.name; });
		assert.ok(names.includes('userList'),    'missing userList');
		assert.ok(names.includes('lastCallers'), 'missing lastCallers');
		assert.ok(names.includes('whosOnline'),  'missing whosOnline');
		assert.ok(names.includes('email'),       'missing email');
		assert.ok(names.includes('checkEmail'),  'missing checkEmail');
	});

	it('should have no duplicate command names', function () {
		var cmds = getAvailableCommands();
		var seen = {};
		for (var cmd of cmds) {
			assert.ok(!seen[cmd.name], 'Duplicate command name: ' + cmd.name);
			seen[cmd.name] = true;
		}
	});

	it('should return the same array contents on repeated calls', function () {
		var first  = getAvailableCommands();
		var second = getAvailableCommands();
		assert.deepStrictEqual(
			first.map(function(c) { return c.name; }),
			second.map(function(c) { return c.name; })
		);
	});
});

// ---------------------------------------------------------------------------
// getValidDisplayFileTypes
// ---------------------------------------------------------------------------

describe('getValidDisplayFileTypes', function () {

	it('should return an array', function () {
		assert.ok(Array.isArray(getValidDisplayFileTypes()));
	});

	it('should include empty string (default/misc)', function () {
		assert.ok(getValidDisplayFileTypes().includes(''));
	});

	it('should include "Screen"', function () {
		assert.ok(getValidDisplayFileTypes().includes('Screen'));
	});

	it('should include "Header"', function () {
		assert.ok(getValidDisplayFileTypes().includes('Header'));
	});
});

// ---------------------------------------------------------------------------
// getValidMenuTypes
// ---------------------------------------------------------------------------

describe('getValidMenuTypes', function () {

	it('should return an array', function () {
		assert.ok(Array.isArray(getValidMenuTypes()));
	});

	it('should include "Hotkey"', function () {
		assert.ok(getValidMenuTypes().includes('Hotkey'));
	});

	it('should include "Lightbar"', function () {
		assert.ok(getValidMenuTypes().includes('Lightbar'));
	});
});

// ---------------------------------------------------------------------------
// getAnsiColors
// ---------------------------------------------------------------------------

describe('getAnsiColors', function () {

	it('should return an array', function () {
		assert.ok(Array.isArray(getAnsiColors()));
	});

	it('should have 16 entries (ANSI color codes 0-15)', function () {
		assert.strictEqual(getAnsiColors().length, 16);
	});

	it('every entry should have value, label, hex, and css fields', function () {
		var colors = getAnsiColors();
		for (var c of colors) {
			assert.ok(typeof c.value === 'number',  'value should be number: ' + JSON.stringify(c));
			assert.ok(typeof c.label === 'string',  'label should be string: ' + JSON.stringify(c));
			assert.ok(typeof c.hex   === 'string',  'hex should be string: ' + JSON.stringify(c));
			assert.ok(typeof c.css   === 'string',  'css should be string: ' + JSON.stringify(c));
		}
	});

	it('should have values 0 through 15 in order', function () {
		var colors = getAnsiColors();
		for (var i = 0; i < colors.length; i++) {
			assert.strictEqual(colors[i].value, i, 'Color at index ' + i + ' should have value ' + i);
		}
	});

	it('should have hex values matching expected hex format', function () {
		var colors = getAnsiColors();
		var hexPattern = /^#[0-9a-fA-F]{6}$/;
		for (var c of colors) {
			assert.ok(hexPattern.test(c.hex), 'Invalid hex format for color ' + c.label + ': ' + c.hex);
		}
	});

	it('should have Black at index 0 and Bright White at index 15', function () {
		var colors = getAnsiColors();
		assert.strictEqual(colors[0].label,  'Black');
		assert.strictEqual(colors[15].label, 'Bright White');
	});
});
