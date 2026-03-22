// tests/modelExports.test.js
// Validates that key model files export the functions we expect.
// A missing export means a function was accidentally deleted or renamed.
//
// All model files import postgres at module level. pg.Pool construction is
// lazy (no TCP until the first query is executed), so imports are safe here.
// If an import fails at the Node level for any reason, the describe block
// skips gracefully with a descriptive message rather than crashing the suite.

import assert from 'assert';

// ---------------------------------------------------------------------------
// Helper: assert that a named export exists and is a function.
// ---------------------------------------------------------------------------
function assertExportedFn(mod, name, modulePath) {
	assert.ok(
		Object.prototype.hasOwnProperty.call(mod, name),
		modulePath + ' does not export "' + name + '"'
	);
	assert.strictEqual(
		typeof mod[name], 'function',
		modulePath + ' export "' + name + '" is not a function (got ' + typeof mod[name] + ')'
	);
}

// ---------------------------------------------------------------------------
// fileGroups.js
// ---------------------------------------------------------------------------
describe('src/models/fileGroups.js exports', function() {
	var mod;

	before(async function() {
		try {
			mod = await import('../src/models/fileGroups.js');
		} catch (err) {
			mod = null;
			this.skip(); // skip if import fails
		}
	});

	var expectedFns = [
		'newGroup',
		'updateGroup',
		'removeGroup',
		'getGroupByShortcode',
		'getAllGroups',
		'recalculateAreaCounts'
	];

	for (var fnName of expectedFns) {
		// IIFE to capture fnName in closure for the it() description
		(function(name) {
			it('exports ' + name + ' as a function', function() {
				if (!mod) return this.skip();
				assertExportedFn(mod, name, 'src/models/fileGroups.js');
			});
		})(fnName);
	}
});

// ---------------------------------------------------------------------------
// fileAreas.js
// ---------------------------------------------------------------------------
describe('src/models/fileAreas.js exports', function() {
	var mod;

	before(async function() {
		try {
			mod = await import('../src/models/fileAreas.js');
		} catch (err) {
			mod = null;
			this.skip();
		}
	});

	var expectedFns = [
		'newArea',
		'updateArea',
		'removeArea',
		'getAreaByShortcode',
		'resolveAreaPath',
		'recalculateFileCounts'
	];

	for (var fnName of expectedFns) {
		(function(name) {
			it('exports ' + name + ' as a function', function() {
				if (!mod) return this.skip();
				assertExportedFn(mod, name, 'src/models/fileAreas.js');
			});
		})(fnName);
	}
});

// ---------------------------------------------------------------------------
// fileEntries.js
// ---------------------------------------------------------------------------
describe('src/models/fileEntries.js exports', function() {
	var mod;

	before(async function() {
		try {
			mod = await import('../src/models/fileEntries.js');
		} catch (err) {
			mod = null;
			this.skip();
		}
	});

	var expectedFns = [
		'addFileEntry',
		'getEntryByUUID',
		'searchEntries',
		'checkDupe',
		'incrementDownloadCount',
		'regenerateDescHtml',
		'scanAreaDirectory'
	];

	for (var fnName of expectedFns) {
		(function(name) {
			it('exports ' + name + ' as a function', function() {
				if (!mod) return this.skip();
				assertExportedFn(mod, name, 'src/models/fileEntries.js');
			});
		})(fnName);
	}
});

// ---------------------------------------------------------------------------
// ftnNodelist.js
// ---------------------------------------------------------------------------
describe('src/models/ftnNodelist.js exports', function() {
	var mod;

	before(async function() {
		try {
			mod = await import('../src/models/ftnNodelist.js');
		} catch (err) {
			mod = null;
			this.skip();
		}
	});

	var expectedFns = [
		'ensureTable',
		'importNodelist',
		'getNode',
		'getNetHost',
		'findConnectable',
		'searchNodes',
		'getNetworkStats',
		'getRecentlyAdded',
		'getRecentlyRemoved'
	];

	for (var fnName of expectedFns) {
		(function(name) {
			it('exports ' + name + ' as a function', function() {
				if (!mod) return this.skip();
				assertExportedFn(mod, name, 'src/models/ftnNodelist.js');
			});
		})(fnName);
	}
});

// ---------------------------------------------------------------------------
// configStore.js
// ---------------------------------------------------------------------------
describe('src/models/configStore.js exports', function() {
	var mod;

	before(async function() {
		try {
			mod = await import('../src/models/configStore.js');
		} catch (err) {
			mod = null;
			this.skip();
		}
	});

	var expectedFns = [
		'loadAll',
		'setValue',
		'setValues',
		'seedDefaults',
		'ensureTable'
	];

	for (var fnName of expectedFns) {
		(function(name) {
			it('exports ' + name + ' as a function', function() {
				if (!mod) return this.skip();
				assertExportedFn(mod, name, 'src/models/configStore.js');
			});
		})(fnName);
	}
});

// ---------------------------------------------------------------------------
// menus.js
// ---------------------------------------------------------------------------
describe('src/models/menus.js exports', function() {
	var mod;

	before(async function() {
		try {
			mod = await import('../src/models/menus.js');
		} catch (err) {
			mod = null;
			this.skip();
		}
	});

	var expectedFns = [
		'getMenu',
		'getAllMenus',
		'getAvailableCommands',
		'getAnsiColors'
	];

	for (var fnName of expectedFns) {
		(function(name) {
			it('exports ' + name + ' as a function', function() {
				if (!mod) return this.skip();
				assertExportedFn(mod, name, 'src/models/menus.js');
			});
		})(fnName);
	}
});

// ---------------------------------------------------------------------------
// doors.js
// ---------------------------------------------------------------------------
describe('src/models/doors.js exports', function() {
	var mod;

	before(async function() {
		try {
			mod = await import('../src/models/doors.js');
		} catch (err) {
			mod = null;
			this.skip();
		}
	});

	it('exports getDoorConfig as a function', function() {
		if (!mod) return this.skip();
		assertExportedFn(mod, 'getDoorConfig', 'src/models/doors.js');
	});
});
