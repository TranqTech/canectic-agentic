// freq.js -- FREQ (File Request) handler.
//
// Resolves requested filenames through three layers:
//   1. Magic aliases (admin-configured, highest priority)
//   2. Filebox directory (sysop-curated, open to any session)
//   3. File entries database (broadest, scoped to peer's subscribed areas)
//
// Also handles filelist auto-generation for the magic 'filelist' type.

import * as fs from 'fs';
import * as path from 'path';
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';
import { reqFilePath } from '../utils/bsoPaths.js';

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

async function ensureTable() {
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS freq_magic (
			id SERIAL PRIMARY KEY,
			name VARCHAR(64) NOT NULL UNIQUE,
			file_path VARCHAR(512),
			magic_type VARCHAR(16) DEFAULT 'file',
			description VARCHAR(256) DEFAULT '',
			active BOOLEAN DEFAULT true,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP
		)
	`);

	// Seed defaults if empty
	var count = await postgres.queryOne('SELECT COUNT(*) AS cnt FROM freq_magic');
	if (count && parseInt(count.cnt) === 0) {
		await postgres.insertObject({
			name: 'FILES',
			magic_type: 'filelist',
			description: 'Auto-generated file listing',
			active: true,
			created_at: new Date()
		}, 'freq_magic');
		alogger.writeAlog(5, 'Seeded default FREQ magic alias: FILES', 'greenbright');
	}
}

// ---------------------------------------------------------------------------
// Magic CRUD
// ---------------------------------------------------------------------------

async function getAllMagic() {
	return await postgres.query('SELECT * FROM freq_magic ORDER BY name ASC') || [];
}

async function getMagicById(id) {
	return await postgres.queryOne('SELECT * FROM freq_magic WHERE id = $1', [id]);
}

async function getMagicByName(name) {
	return await postgres.queryOne(
		'SELECT * FROM freq_magic WHERE UPPER(name) = UPPER($1) AND active = true',
		[name]
	);
}

async function createMagic(data) {
	var result = { status: false, errormessages: [] };
	var name = (data.name || '').trim().toUpperCase();
	if (!name) { result.errormessages.push('Name is required'); return result; }

	var dbObj = {
		name: name,
		file_path: (data.file_path || '').trim(),
		magic_type: ['file', 'filelist', 'nodelist'].includes(data.magic_type) ? data.magic_type : 'file',
		description: (data.description || '').trim(),
		active: data.active !== 'false' && data.active !== false,
		created_at: new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'freq_magic');
	if (dbres.status) {
		result.status = true;
		result.insertId = dbres.insertId;
	} else {
		result.errormessages = dbres.errormessages;
	}
	return result;
}

async function updateMagic(id, data) {
	var updates = {};
	if (data.name !== undefined) updates.name = (data.name || '').trim().toUpperCase();
	if (data.file_path !== undefined) updates.file_path = (data.file_path || '').trim();
	if (data.magic_type !== undefined) updates.magic_type = ['file', 'filelist', 'nodelist'].includes(data.magic_type) ? data.magic_type : 'file';
	if (data.description !== undefined) updates.description = (data.description || '').trim();
	if (data.active !== undefined) updates.active = data.active === 'true' || data.active === true || data.active === 'on';
	updates.updated_at = new Date();
	return await postgres.updateById(id, updates, 'freq_magic');
}

async function deleteMagic(id) {
	return await postgres.write('DELETE FROM freq_magic WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// FREQ Resolver
// ---------------------------------------------------------------------------

// Resolve a single filename through all three layers.
// Returns { found: boolean, filePath: string, source: string } or { found: false }
async function resolveFile(filename, connectionId) {
	if (!filename) return { found: false };
	var name = filename.trim();
	if (!name) return { found: false };

	// Layer 1: Magic aliases
	var magic = await getMagicByName(name);
	if (magic) {
		if (magic.magic_type === 'filelist') {
			var listPath = await _generateFilelist();
			if (listPath) return { found: true, filePath: listPath, source: 'magic:filelist' };
		} else if (magic.magic_type === 'nodelist') {
			var nlPath = await _findLatestNodelist();
			if (nlPath) return { found: true, filePath: nlPath, source: 'magic:nodelist' };
		} else if (magic.file_path && fs.existsSync(magic.file_path)) {
			return { found: true, filePath: magic.file_path, source: 'magic:file' };
		}
	}

	// Layer 2: Filebox
	var fileboxDir = appConfig.get('freq_filebox_dir', 'ftn/freq');
	if (fs.existsSync(fileboxDir)) {
		// Case-insensitive search
		try {
			var boxFiles = fs.readdirSync(fileboxDir);
			var match = boxFiles.find(function(f) {
				return f.toLowerCase() === name.toLowerCase();
			});
			if (match) {
				var boxPath = path.join(fileboxDir, match);
				if (fs.statSync(boxPath).isFile()) {
					return { found: true, filePath: boxPath, source: 'filebox' };
				}
			}
		} catch (_) {}
	}

	// Layer 3: File entries (scoped to peer's subscribed areas)
	if (connectionId) {
		var entry = await postgres.queryOne(
			`SELECT fe.*, fa.id AS area_id
			 FROM file_entries fe
			 JOIN file_areas fa ON fa.id = fe.area_id
			 JOIN file_peer_subscriptions fps ON fps.file_area_id = fa.id
			 WHERE fps.peer_connection_id = $1
			   AND fps.allowed = true AND fps.enabled = true
			   AND LOWER(fe.filename) = LOWER($2)
			 LIMIT 1`,
			[connectionId, name]
		);
		if (entry && entry.disk_path && fs.existsSync(entry.disk_path)) {
			return { found: true, filePath: entry.disk_path, source: 'fileentry' };
		}
	}

	return { found: false };
}

// Resolve all filenames from a .req file.
// Returns array of { filename, found, filePath, source }
async function resolveRequest(reqFilePath, connectionId) {
	var results = [];
	var maxFiles = appConfig.getNumber('freq_max_files', 10);

	var text;
	try {
		text = fs.readFileSync(reqFilePath, 'utf8');
	} catch (err) {
		alogger.writeAlog(3, 'FREQ: cannot read .req file: ' + err.message, 'yellow');
		return results;
	}

	var lines = text.split(/\r?\n/);
	var foundCount = 0;

	for (var line of lines) {
		var trimmed = line.trim();
		if (!trimmed || trimmed.startsWith(';')) continue;

		// Strip password/flags after filename
		var filename = trimmed.split(/\s+/)[0];
		if (!filename) continue;

		if (foundCount >= maxFiles) {
			results.push({ filename: filename, found: false, reason: 'max files reached' });
			continue;
		}

		var resolved = await resolveFile(filename, connectionId);
		if (resolved.found) {
			results.push({
				filename: filename,
				found: true,
				filePath: resolved.filePath,
				source: resolved.source
			});
			foundCount++;
		} else {
			results.push({ filename: filename, found: false });
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Filelist generation
// ---------------------------------------------------------------------------

async function _generateFilelist() {
	try {
		var bbsName = appConfig.get('boardname', 'Canectic BBS');
		var areas = await postgres.query(
			`SELECT fa.*, fg.name AS group_name
			 FROM file_areas fa
			 JOIN file_groups fg ON fg.id = fa.group_id
			 WHERE fa.active = true
			 ORDER BY fg.name ASC, fa.name ASC`
		);

		var lines = [];
		lines.push('; File listing for ' + bbsName);
		lines.push('; Generated ' + new Date().toISOString().split('T')[0]);
		lines.push(';');

		if (areas && areas.length > 0) {
			for (var area of areas) {
				lines.push('');
				lines.push('; --- ' + (area.group_name || '') + ' / ' + area.name + ' ---');

				var files = await postgres.query(
					'SELECT filename, file_size, short_desc, upload_date FROM file_entries WHERE area_id = $1 ORDER BY filename ASC',
					[area.id]
				);

				if (files && files.length > 0) {
					for (var f of files) {
						var size = f.file_size ? Math.round(f.file_size / 1024) + 'K' : '?K';
						var desc = f.short_desc || '';
						lines.push(f.filename.padEnd(14) + ' ' + size.padStart(8) + '  ' + desc);
					}
				} else {
					lines.push('; (empty)');
				}
			}
		}

		// Write to temp file
		var tmpPath = path.join(appConfig.get('freq_filebox_dir', 'ftn/freq'), '_FILES.LST');
		var dir = path.dirname(tmpPath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tmpPath, lines.join('\r\n') + '\r\n');

		return tmpPath;
	} catch (err) {
		alogger.writeAlog(3, 'FREQ: filelist generation error: ' + err.message, 'yellow');
		return null;
	}
}

// ---------------------------------------------------------------------------
// Nodelist lookup
// ---------------------------------------------------------------------------

async function _findLatestNodelist() {
	// Look in the inbound directory for nodelist files
	var inDir = appConfig.get('ftninbound', 'ftn/in');
	try {
		var files = fs.readdirSync(inDir);
		var nodelists = files.filter(function(f) {
			return /^nodelist\.\d{3}$/i.test(f) || /^nodediff\.\d{3}$/i.test(f);
		});
		if (nodelists.length === 0) return null;

		// Sort by modification time, newest first
		nodelists.sort(function(a, b) {
			var sa = fs.statSync(path.join(inDir, a));
			var sb = fs.statSync(path.join(inDir, b));
			return sb.mtimeMs - sa.mtimeMs;
		});

		return path.join(inDir, nodelists[0]);
	} catch (_) {
		return null;
	}
}

// ---------------------------------------------------------------------------
// .req file creation (outbound FREQ)
// ---------------------------------------------------------------------------

// Written to the zone outbound the mailer reads for that address (see
// bsoPaths.js). It used to go to `ftnoutbound` whatever the zone, so a request
// to a peer outside zone 1, or on a board with MAILER_OUTBOUND_DIR set, was
// never picked up by any session.
//
// opts.zone    -- destination zone (default 1)
// opts.baseDir -- outbound base directory (default: the mailer's)
function createReqFile(destNet, destNode, filenames, opts) {
	var o = opts || {};
	var reqPath = reqFilePath(o.zone || 1, destNet, destNode, o.baseDir);
	var outDir = path.dirname(reqPath);
	if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

	var content = filenames.join('\r\n') + '\r\n';
	fs.writeFileSync(reqPath, content);

	alogger.writeAlog(3, 'FREQ: created ' + reqPath + ' with ' + filenames.length + ' request(s)', 'cyan');
	return reqPath;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	ensureTable,
	getAllMagic,
	getMagicById,
	getMagicByName,
	createMagic,
	updateMagic,
	deleteMagic,
	resolveFile,
	resolveRequest,
	createReqFile
};
