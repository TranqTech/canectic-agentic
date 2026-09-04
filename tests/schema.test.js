// tests/schema.test.js
// Schema consistency tests — reads .conf files from db/schema/ on disk and
// validates their structure without connecting to any database.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var SCHEMA_ROOT = path.join(__dirname, '..', 'db', 'schema');
var TABLECOLUMNS_DIR = path.join(SCHEMA_ROOT, 'tablecolumns');
var TABLENAMES_FILE  = path.join(SCHEMA_ROOT, 'tables', 'tablenames.conf');

// ---------------------------------------------------------------------------
// Helper: parse a .conf file into an array of column definitions.
// Each non-empty, non-comment line represents one column. The first token is
// the column name; the rest is the type expression. Lines starting with //
// are comments and are ignored.
// ---------------------------------------------------------------------------
function parseConf(filepath) {
	var content = fs.readFileSync(filepath, 'utf8');
	var lines = content.split('\n');
	var columns = [];
	for (var line of lines) {
		var trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
		var tokens = trimmed.split(/\s+/);
		if (tokens.length < 1) continue;
		columns.push({
			name: tokens[0].toLowerCase(),
			type: tokens.slice(1).join(' ')
		});
	}
	return columns;
}

// ---------------------------------------------------------------------------
// Helper: read table names from tablenames.conf
// ---------------------------------------------------------------------------
function readTableNames() {
	var content = fs.readFileSync(TABLENAMES_FILE, 'utf8');
	return content.split('\n')
		.map(function(l) { return l.trim(); })
		.filter(function(l) { return l && !l.startsWith('//') && !l.startsWith('#'); });
}

// ---------------------------------------------------------------------------
// Describe blocks
// ---------------------------------------------------------------------------

describe('db/schema: tablenames vs conf files', function() {
	var tableNames;
	var confFiles;

	before(function() {
		tableNames = readTableNames();
		confFiles = fs.readdirSync(TABLECOLUMNS_DIR)
			.filter(function(f) { return f.endsWith('.conf') && !f.includes('-remove'); })
			.map(function(f) { return path.basename(f, '.conf'); });
	});

	it('tablenames.conf should not be empty', function() {
		assert.ok(tableNames.length > 0, 'tablenames.conf has no entries');
	});

	it('every table name has a corresponding .conf file in tablecolumns/', function() {
		var missing = tableNames.filter(function(t) { return confFiles.indexOf(t) === -1; });
		assert.deepStrictEqual(missing, [], 'Tables in tablenames.conf with no .conf file: ' + missing.join(', '));
	});

	it('every .conf file in tablecolumns/ is referenced in tablenames.conf', function() {
		var orphaned = confFiles.filter(function(f) { return tableNames.indexOf(f) === -1; });
		assert.deepStrictEqual(orphaned, [], 'Orphaned .conf files (not in tablenames.conf): ' + orphaned.join(', '));
	});
});

describe('db/schema: individual .conf file structure', function() {
	var confFiles;

	before(function() {
		confFiles = fs.readdirSync(TABLECOLUMNS_DIR)
			.filter(function(f) { return f.endsWith('.conf') && !f.includes('-remove'); });
	});

	it('every .conf file defines at least one column', function() {
		// No empty placeholders. A table listed in tablenames.conf with an
		// empty .conf is never created or maintained, and dbmigrations reports
		// "no column definitions" on every run. netmail_bad sat that way until
		// pm_undeliverable superseded it.
		for (var filename of confFiles) {
			var filepath = path.join(TABLECOLUMNS_DIR, filename);
			var raw = fs.readFileSync(filepath, 'utf8').trim();
			assert.ok(raw.length > 0, filename + ' is empty; remove it and its tablenames.conf entry, or define its columns');
			var columns = parseConf(filepath);
			assert.ok(columns.length > 0, filename + ' defines no columns');
		}
	});

	it('every non-empty .conf file defines an id column', function() {
		for (var filename of confFiles) {
			var filepath = path.join(TABLECOLUMNS_DIR, filename);
			// Skip empty placeholder files.
			var raw = fs.readFileSync(filepath, 'utf8').trim();
			if (!raw) continue;
			var columns = parseConf(filepath);
			var hasId = columns.some(function(c) { return c.name === 'id'; });
			assert.ok(hasId, filename + ' does not define an id column');
		}
	});

	it('no .conf file has duplicate column names', function() {
		for (var filename of confFiles) {
			var filepath = path.join(TABLECOLUMNS_DIR, filename);
			var columns = parseConf(filepath);
			var names = columns.map(function(c) { return c.name; });
			var seen = {};
			var dupes = [];
			for (var n of names) {
				if (seen[n]) { dupes.push(n); } else { seen[n] = true; }
			}
			assert.deepStrictEqual(dupes, [], filename + ' has duplicate columns: ' + dupes.join(', '));
		}
	});

	it('every column definition has a non-empty name and type', function() {
		for (var filename of confFiles) {
			var filepath = path.join(TABLECOLUMNS_DIR, filename);
			var columns = parseConf(filepath);
			for (var col of columns) {
				assert.ok(col.name, filename + ': column with empty name found');
				assert.ok(col.type, filename + ': column "' + col.name + '" has no type expression');
			}
		}
	});
});

describe('db/schema: file_entries columns', function() {
	var columns;

	before(function() {
		columns = parseConf(path.join(TABLECOLUMNS_DIR, 'file_entries.conf'));
	});

	function hasColumn(name) {
		return columns.some(function(c) { return c.name === name; });
	}

	it('has uuid column', function() {
		assert.ok(hasColumn('uuid'), 'Missing uuid');
	});

	it('has area_id column', function() {
		assert.ok(hasColumn('area_id'), 'Missing area_id');
	});

	it('has filename column', function() {
		assert.ok(hasColumn('filename'), 'Missing filename');
	});

	it('has file_size column', function() {
		assert.ok(hasColumn('file_size'), 'Missing file_size');
	});

	it('has short_desc column', function() {
		assert.ok(hasColumn('short_desc'), 'Missing short_desc');
	});

	it('has long_desc column', function() {
		assert.ok(hasColumn('long_desc'), 'Missing long_desc');
	});

	it('has source_type column', function() {
		assert.ok(hasColumn('source_type'), 'Missing source_type');
	});

	it('does NOT have connection_types column (belongs on ftn_nodelist)', function() {
		assert.ok(!hasColumn('connection_types'), 'file_entries should not have connection_types');
	});
});

describe('db/schema: file_groups columns', function() {
	var columns;

	before(function() {
		columns = parseConf(path.join(TABLECOLUMNS_DIR, 'file_groups.conf'));
	});

	function hasColumn(name) {
		return columns.some(function(c) { return c.name === name; });
	}

	it('has browse_security column', function() {
		assert.ok(hasColumn('browse_security'), 'Missing browse_security');
	});

	it('has read_security column', function() {
		assert.ok(hasColumn('read_security'), 'Missing read_security');
	});

	it('has post_security column', function() {
		assert.ok(hasColumn('post_security'), 'Missing post_security');
	});

	it('has browse_perm_flags column', function() {
		assert.ok(hasColumn('browse_perm_flags'), 'Missing browse_perm_flags');
	});
});

describe('db/schema: file_areas columns', function() {
	var columns;

	before(function() {
		columns = parseConf(path.join(TABLECOLUMNS_DIR, 'file_areas.conf'));
	});

	function hasColumn(name) {
		return columns.some(function(c) { return c.name === name; });
	}

	it('has browse_security column', function() {
		assert.ok(hasColumn('browse_security'), 'Missing browse_security');
	});

	it('has read_security column', function() {
		assert.ok(hasColumn('read_security'), 'Missing read_security');
	});

	it('has post_security column', function() {
		assert.ok(hasColumn('post_security'), 'Missing post_security');
	});

	it('has newscan_default column', function() {
		assert.ok(hasColumn('newscan_default'), 'Missing newscan_default');
	});

	it('has sub_dir column', function() {
		assert.ok(hasColumn('sub_dir'), 'Missing sub_dir');
	});
});

describe('db/schema: ftn_nodelist columns', function() {
	var columns;

	before(function() {
		columns = parseConf(path.join(TABLECOLUMNS_DIR, 'ftn_nodelist.conf'));
	});

	function hasColumn(name) {
		return columns.some(function(c) { return c.name === name; });
	}

	it('has network_id column', function() {
		assert.ok(hasColumn('network_id'), 'Missing network_id');
	});

	it('has zone column', function() {
		assert.ok(hasColumn('zone'), 'Missing zone');
	});

	it('has net column', function() {
		assert.ok(hasColumn('net'), 'Missing net');
	});

	it('has node column', function() {
		assert.ok(hasColumn('node'), 'Missing node');
	});

	it('has hostname column', function() {
		assert.ok(hasColumn('hostname'), 'Missing hostname');
	});

	it('has connection_types column', function() {
		assert.ok(hasColumn('connection_types'), 'Missing connection_types');
	});

	it('has first_seen column', function() {
		assert.ok(hasColumn('first_seen'), 'Missing first_seen');
	});

	it('has last_seen column', function() {
		assert.ok(hasColumn('last_seen'), 'Missing last_seen');
	});

	it('has removed_at column', function() {
		assert.ok(hasColumn('removed_at'), 'Missing removed_at');
	});

	it('has active column', function() {
		assert.ok(hasColumn('active'), 'Missing active');
	});
});

describe('db/schema: peer_connections columns', function() {
	var columns;

	before(function() {
		columns = parseConf(path.join(TABLECOLUMNS_DIR, 'peer_connections.conf'));
	});

	function hasColumn(name) {
		return columns.some(function(c) { return c.name === name; });
	}

	it('has poll_enabled column', function() {
		assert.ok(hasColumn('poll_enabled'), 'Missing poll_enabled');
	});

	it('has connection_data column', function() {
		assert.ok(hasColumn('connection_data'), 'Missing connection_data');
	});
});

describe('db/schema: settings columns', function() {
	var columns;

	before(function() {
		columns = parseConf(path.join(TABLECOLUMNS_DIR, 'settings.conf'));
	});

	function hasColumn(name) {
		return columns.some(function(c) { return c.name === name; });
	}

	it('has key column', function() {
		assert.ok(hasColumn('key'), 'Missing key');
	});

	it('has value column', function() {
		assert.ok(hasColumn('value'), 'Missing value');
	});

	it('has type column', function() {
		assert.ok(hasColumn('type'), 'Missing type');
	});

	it('has category column', function() {
		assert.ok(hasColumn('category'), 'Missing category');
	});
});

describe('db/schema: file_distribution columns', function() {
	var columns;

	before(function() {
		columns = parseConf(path.join(TABLECOLUMNS_DIR, 'file_distribution.conf'));
	});

	function hasColumn(name) {
		return columns.some(function(c) { return c.name === name; });
	}

	it('has file_entry_id column', function() {
		assert.ok(hasColumn('file_entry_id'), 'Missing file_entry_id');
	});

	it('has peer_connection_id column', function() {
		assert.ok(hasColumn('peer_connection_id'), 'Missing peer_connection_id');
	});

	it('has status column', function() {
		assert.ok(hasColumn('status'), 'Missing status');
	});

	it('has protocol column', function() {
		assert.ok(hasColumn('protocol'), 'Missing protocol');
	});
});
