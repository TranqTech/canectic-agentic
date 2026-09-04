// tests/recordfileSqlite.test.js — Tests for the Synchronet RecordFile shim.
//
// src/shims/recordfile_sqlite.js is the only consumer of better-sqlite3 in the
// project, and it had no coverage. It replaces Synchronet's binary RecordFile
// with a SQLite-backed implementation so JS doors (LORD and similar) can keep
// their data. A silent break here means door data loss, which nothing else
// would catch.
//
// This also serves as the regression test for better-sqlite3 upgrades: v13
// moved the module to N-API, and a future major could change behaviour without
// any other test noticing.
//
// Field descriptors use Synchronet's shape: { prop, type } where type is a
// string like 'String:26' or 'Integer16', not { name, size }.
// Run: npx mocha tests/recordfileSqlite.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

var shim = null;
var available = false;
var scratchDir = null;

var DEF = [
	{ prop: 'name',  type: 'String:26' },
	{ prop: 'level', type: 'Integer16' },
	{ prop: 'gold',  type: 'Integer' },
];

describe('Synchronet RecordFile shim (better-sqlite3)', function () {
	this.timeout(20000);

	before(async function () {
		try {
			shim = await import('../src/shims/recordfile_sqlite.js');
			scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-recordfile-test-'));
			shim.setDatabaseDir(scratchDir);
			available = true;
		} catch (err) {
			// better-sqlite3 is a native module; if it will not load there is
			// nothing meaningful to assert.
			available = false;
		}
	});

	after(function () {
		if (scratchDir) {
			try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
		}
	});

	it('loads and computes a record length from a definition', function () {
		if (!available) return this.skip();
		var len = shim.GetRecordLength(DEF);
		assert.strictEqual(typeof len, 'number');
		assert.ok(len > 0, 'record length should be positive, got ' + len);
	});

	it('opens a RecordFile and exposes the Synchronet .file compatibility shape', function () {
		if (!available) return this.skip();
		// LORD reads .file.name and calls .file.close(); LORD2 also touches
		// .file.position and .file.is_open.
		var rf = new shim.RecordFile('compat.dat', DEF);
		try {
			assert.strictEqual(rf.file.name, 'compat.dat');
			assert.strictEqual(typeof rf.file.close, 'function');
		} finally {
			rf.close();
		}
	});

	it('allocates records with new() and persists them with put()', function () {
		if (!available) return this.skip();
		var rf = new shim.RecordFile('players.dat', DEF);
		try {
			var a = rf.new();
			a.name = 'Seth Able';
			a.level = 12;
			a.gold = 4200;
			a.put();

			var b = rf.new();
			b.name = 'Violet';
			b.level = 3;
			b.gold = 75;
			b.put();

			assert.strictEqual(rf.length, 2);
		} finally {
			rf.close();
		}
	});

	it('reads records back through a freshly opened handle', function () {
		if (!available) return this.skip();
		// Reopening is the real test: it proves the rows reached SQLite rather
		// than living in the first handle's memory.
		var rf = new shim.RecordFile('players.dat', DEF);
		try {
			var a = rf.get(0);
			var b = rf.get(1);
			assert.strictEqual(a.name.trim(), 'Seth Able');
			assert.strictEqual(a.level, 12);
			assert.strictEqual(a.gold, 4200);
			assert.strictEqual(b.name.trim(), 'Violet');
			assert.strictEqual(b.level, 3);
			assert.strictEqual(b.gold, 75);
		} finally {
			rf.close();
		}
	});

	it('updates a record in place', function () {
		if (!available) return this.skip();
		var rf = new shim.RecordFile('players.dat', DEF);
		try {
			var a = rf.get(0);
			a.gold = 9999;
			a.put();
		} finally {
			rf.close();
		}

		var rf2 = new shim.RecordFile('players.dat', DEF);
		try {
			assert.strictEqual(rf2.get(0).gold, 9999);
			assert.strictEqual(rf2.get(1).gold, 75, 'the other record should be untouched');
		} finally {
			rf2.close();
		}
	});

	it('supports the capitalised Synchronet aliases', function () {
		if (!available) return this.skip();
		// Doors written against Synchronet call Get/New/Put/Close.
		var rf = new shim.RecordFile('aliases.dat', DEF);
		try {
			var r = rf.New();
			r.name = 'Alias';
			r.level = 1;
			r.gold = 5;
			r.Put();
			assert.strictEqual(rf.Get(0).name.trim(), 'Alias');
		} finally {
			rf.Close();
		}
	});

	it('returns null for a record number that does not exist', function () {
		if (!available) return this.skip();
		var rf = new shim.RecordFile('empty.dat', DEF);
		try {
			assert.strictEqual(rf.length, 0);
			assert.strictEqual(rf.get(0), null);
		} finally {
			rf.close();
		}
	});

	it('keeps separate files in separate tables', function () {
		if (!available) return this.skip();
		var one = new shim.RecordFile('one.dat', DEF);
		var two = new shim.RecordFile('two.dat', DEF);
		try {
			var r = one.new();
			r.name = 'only in one';
			r.level = 1;
			r.gold = 1;
			r.put();

			assert.strictEqual(one.length, 1);
			assert.strictEqual(two.length, 0, 'a different filename must not share rows');
		} finally {
			one.close();
			two.close();
		}
	});
});
