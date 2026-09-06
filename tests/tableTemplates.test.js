// tests/tableTemplates.test.js: guards the per-area table templates and the
// parser that turns them into CREATE TABLE column lists.
//
// This file exists because of a real outage. Appending a column to
// src/templates/msgTable.conf left the file with a trailing newline. Every
// other template is written without one, and getColumnsFromFile split on
// newline with no filtering, so the empty entry landed in the column list and
// CREATE TABLE emitted ", )":
//
//     DB write error: syntax error at or near ")"
//
// Every new message area creation failed until it was found by accident. No
// test touched it, because nothing asserted on the template format or on the
// parser's handling of blank lines. Both are asserted here now.
//
// Pure: no database needed.
// Run: npx mocha tests/tableTemplates.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var here = path.dirname(fileURLToPath(import.meta.url));
var templateDir = path.join(here, '..', 'src', 'templates');

var tableTools = null;
try {
	tableTools = await import('../src/middleware/db/tableTools.js');
} catch (_) { tableTools = null; }

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

describe('tableTools.getColumnsFromFile', function () {
	before(function () {
		if (!tableTools) this.skip();
	});

	var tmpFiles = [];

	function writeTemp(name, contents) {
		var p = path.join(here, name);
		fs.writeFileSync(p, contents, 'utf8');
		tmpFiles.push(p);
		return p;
	}

	after(function () {
		for (var p of tmpFiles) {
			try { fs.unlinkSync(p); } catch (_) {}
		}
	});

	it('drops the empty entry produced by a trailing newline', async function () {
		var p = writeTemp('zz_tmpl_trailing.conf', 'id BIGSERIAL PRIMARY KEY\nname VARCHAR(64)\n');
		var cols = await tableTools.getColumnsFromFile(p);
		assert.deepStrictEqual(cols, ['id BIGSERIAL PRIMARY KEY', 'name VARCHAR(64)']);
	});

	it('parses a file with no trailing newline identically', async function () {
		var p = writeTemp('zz_tmpl_notrailing.conf', 'id BIGSERIAL PRIMARY KEY\nname VARCHAR(64)');
		var cols = await tableTools.getColumnsFromFile(p);
		assert.deepStrictEqual(cols, ['id BIGSERIAL PRIMARY KEY', 'name VARCHAR(64)']);
	});

	it('drops blank and whitespace-only lines anywhere in the file', async function () {
		var p = writeTemp('zz_tmpl_blanks.conf',
			'id BIGSERIAL PRIMARY KEY\n\nname VARCHAR(64)\n   \nflag BOOLEAN DEFAULT false\n\n');
		var cols = await tableTools.getColumnsFromFile(p);
		assert.deepStrictEqual(cols, [
			'id BIGSERIAL PRIMARY KEY',
			'name VARCHAR(64)',
			'flag BOOLEAN DEFAULT false'
		]);
	});

	it('never returns an entry that would produce ", )" in a column list', async function () {
		var p = writeTemp('zz_tmpl_join.conf', 'id BIGSERIAL PRIMARY KEY\nname VARCHAR(64)\n');
		var cols = await tableTools.getColumnsFromFile(p);
		var sql = 'CREATE TABLE x (' + cols.join(', ') + ')';
		assert.ok(!/,\s*\)/.test(sql), 'column list ends with a dangling comma: ' + sql);
	});

	it('returns an empty array for a missing file rather than throwing', async function () {
		var cols = await tableTools.getColumnsFromFile(path.join(here, 'zz_does_not_exist.conf'));
		assert.ok(Array.isArray(cols));
		assert.strictEqual(cols.length, 0);
	});
});

// ---------------------------------------------------------------------------
// The shipped templates
// ---------------------------------------------------------------------------

describe('shipped table templates', function () {
	before(function () {
		if (!tableTools) this.skip();
	});

	var templates = fs.existsSync(templateDir)
		? fs.readdirSync(templateDir).filter(function (f) { return f.endsWith('.conf'); })
		: [];

	it('finds the template directory', function () {
		assert.ok(templates.length > 0, 'no .conf templates found in ' + templateDir);
	});

	templates.forEach(function (name) {
		describe(name, function () {
			var full = path.join(templateDir, name);

			it('parses to a column list with no empty entries', async function () {
				var cols = await tableTools.getColumnsFromFile(full);
				for (var i = 0; i < cols.length; i++) {
					assert.ok(cols[i] && cols[i].trim().length > 0,
						'empty column entry at index ' + i);
				}
			});

			it('produces a column list with no dangling comma', async function () {
				var cols = await tableTools.getColumnsFromFile(full);
				if (cols.length === 0) return;   // *Removed.conf files may be empty
				var sql = 'CREATE TABLE x (' + cols.join(', ') + ')';
				assert.ok(!/,\s*\)/.test(sql), name + ' would emit ", )"');
				assert.ok(!/\(\s*,/.test(sql), name + ' would emit "(,"');
			});
		});
	});

	// The msgs template is the one that broke. Assert the column that was being
	// added when it happened, so a revert is visible rather than silent.
	it('msgTable.conf declares the imported flag used to suppress imported history outbound', async function () {
		var cols = await tableTools.getColumnsFromFile(path.join(templateDir, 'msgTable.conf'));
		var names = cols.map(function (c) { return c.trim().split(/\s+/)[0]; });
		assert.ok(names.includes('imported'),
			'msgTable.conf is missing the "imported" column; getOutboundForConnection ' +
			'relies on it to keep an SMB/JAM migration from echoing out to peers');
	});
});
