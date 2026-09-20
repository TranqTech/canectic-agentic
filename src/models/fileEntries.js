// fileEntries.js — File entry CRUD, search, stats, dupe checking
// Individual file records within file areas.

import { v4 as uuidv4 } from 'uuid';
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from "../utils/alogger.js";

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function addFileEntry(formObj) {
	var returnObj = { status: false, errormessages: [], entryId: null };

	if (!formObj.area_id) returnObj.errormessages.push("area_id is required");
	if (!formObj.filename) returnObj.errormessages.push("filename is required");
	if (returnObj.errormessages.length > 0) return returnObj;

	var uuid = uuidv4();
	var now = new Date();

	var pgObj = {
		uuid: uuid,
		area_id: formObj.area_id,
		area_shortcode: formObj.area_shortcode || null,
		filename: formObj.filename,
		disk_path: formObj.disk_path || formObj.filename,
		file_size: formObj.file_size || 0,
		file_date: formObj.file_date || now,
		file_hash_crc32: formObj.file_hash_crc32 || null,
		file_hash_sha256: formObj.file_hash_sha256 || null,
		short_desc: formObj.short_desc || null,
		long_desc: formObj.long_desc || null,
		long_desc_html: formObj.long_desc_html || null,
		full_text: formObj.full_text || null,
		upload_date: formObj.upload_date || now,
		uploader_uuid: formObj.uploader_uuid || null,
		uploader_name: formObj.uploader_name || null,
		download_count: 0,
		source_type: formObj.source_type || 'local',
		source_network_id: formObj.source_network_id || null,
		source_peer_id: formObj.source_peer_id || null,
		source_data: formObj.source_data ? JSON.stringify(formObj.source_data) : null,
		active: true,
		flagged: false,
		created_at: now,
		updated_at: null
	};

	var dbres = await postgres.insertObject(pgObj, "file_entries");
	if (dbres.status === true) {
		returnObj.status = true;
		returnObj.entryId = dbres.insertId;
		returnObj.uuid = uuid;
		alogger.writeAlog(5, "File entry added: " + formObj.filename + " in area " + (formObj.area_shortcode || formObj.area_id), "greenbright");
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function getEntryByUUID(uuid) {
	return await postgres.queryOne("SELECT * FROM file_entries WHERE uuid = $1", [uuid]);
}

async function getEntryById(id) {
	return await postgres.queryOne("SELECT * FROM file_entries WHERE id = $1", [id]);
}

async function getEntriesForArea(areaId, opts) {
	var limit = (opts && opts.limit) || 50;
	var offset = (opts && opts.offset) || 0;
	var orderBy = (opts && opts.orderBy) || 'upload_date DESC';

	var rows = await postgres.query(
		"SELECT * FROM file_entries WHERE area_id = $1 AND active = true ORDER BY " + orderBy + " LIMIT $2 OFFSET $3",
		[areaId, limit, offset]
	);
	return rows || [];
}

async function getEntryCount(areaId) {
	var result = await postgres.queryOne(
		"SELECT COUNT(*) AS cnt FROM file_entries WHERE area_id = $1 AND active = true",
		[areaId]
	);
	return result ? parseInt(result.cnt) : 0;
}

async function searchEntries(searchTerm, opts) {
	var limit = (opts && opts.limit) || 50;
	var offset = (opts && opts.offset) || 0;
	var areaId = opts && opts.areaId;
	var pattern = '%' + searchTerm + '%';

	var sql, params;
	if (areaId) {
		sql = "SELECT * FROM file_entries WHERE area_id = $1 AND active = true AND (filename ILIKE $2 OR short_desc ILIKE $2 OR long_desc ILIKE $2 OR full_text ILIKE $2) ORDER BY upload_date DESC LIMIT $3 OFFSET $4";
		params = [areaId, pattern, limit, offset];
	} else {
		sql = "SELECT * FROM file_entries WHERE active = true AND (filename ILIKE $1 OR short_desc ILIKE $1 OR long_desc ILIKE $1 OR full_text ILIKE $1) ORDER BY upload_date DESC LIMIT $2 OFFSET $3";
		params = [pattern, limit, offset];
	}

	var rows = await postgres.query(sql, params);
	return rows || [];
}

// ---------------------------------------------------------------------------
// Dupe checking
// ---------------------------------------------------------------------------

async function checkDupe(areaId, filename, crc32) {
	if (crc32) {
		var row = await postgres.queryOne(
			"SELECT id FROM file_entries WHERE area_id = $1 AND file_hash_crc32 = $2 AND filename = $3",
			[areaId, crc32, filename]
		);
		return !!row;
	}
	var row = await postgres.queryOne(
		"SELECT id FROM file_entries WHERE area_id = $1 AND filename = $2",
		[areaId, filename]
	);
	return !!row;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

async function updateEntry(id, updateObj) {
	updateObj.updated_at = new Date();
	var count = await postgres.updateById(id, updateObj, "file_entries");
	return count > 0;
}

async function incrementDownloadCount(id) {
	await postgres.write(
		"UPDATE file_entries SET download_count = download_count + 1 WHERE id = $1",
		[id]
	);
}

async function deactivateEntry(id) {
	return await updateEntry(id, { active: false });
}

async function flagEntry(id, flagged) {
	return await updateEntry(id, { flagged: flagged !== false });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function deleteEntry(uuid) {
	var entry = await getEntryByUUID(uuid);
	if (!entry) return false;

	// Remove distribution rows
	await postgres.write("DELETE FROM file_distribution WHERE file_entry_id = $1", [entry.id]);

	// Remove the entry
	await postgres.write("DELETE FROM file_entries WHERE id = $1", [entry.id]);

	alogger.writeAlog(5, "File entry deleted: " + entry.filename + " (uuid: " + uuid + ")", "yellow");
	return true;
}

// ---------------------------------------------------------------------------
// New file count (for scan pointers)
// ---------------------------------------------------------------------------

async function getNewFileCount(areaId, sinceId) {
	var result = await postgres.queryOne(
		"SELECT COUNT(*) AS cnt FROM file_entries WHERE area_id = $1 AND id > $2 AND active = true",
		[areaId, sinceId || 0]
	);
	return result ? parseInt(result.cnt) : 0;
}

/**
 * The new file entries themselves, rather than just how many there are.
 *
 * getNewFileCount has always been able to say "3 new" without anything being
 * able to say WHICH three, which is why the web could badge an area and then
 * offer no way to look at what the badge was counting.
 *
 * Defaults to newest first, matching getEntriesForArea so the two listings read
 * the same way round.  `oldestFirst` is for a catch-up view that advances the
 * scan pointer as it goes: there the page has to start at the OLDEST unseen
 * file, because advancing past the newest of a capped page would mark the
 * backlog underneath it as read without ever showing it.
 */
function newEntriesOrderBy(opts) {
	return (opts && opts.oldestFirst) ? 'upload_date ASC, id ASC' : 'upload_date DESC, id DESC';
}

async function getNewEntriesForArea(areaId, sinceId, opts) {
	var limit = (opts && opts.limit) || 50;
	var offset = (opts && opts.offset) || 0;

	var rows = await postgres.query(
		"SELECT * FROM file_entries WHERE area_id = $1 AND id > $2 AND active = true " +
		"ORDER BY " + newEntriesOrderBy(opts) + " LIMIT $3 OFFSET $4",
		[areaId, sinceId || 0, limit, offset]
	);
	return rows || [];
}

async function getMaxIdForArea(areaId) {
	var result = await postgres.queryOne(
		"SELECT COALESCE(MAX(id), 0) AS max_id FROM file_entries WHERE area_id = $1",
		[areaId]
	);
	return result ? parseInt(result.max_id) : 0;
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Regenerate long_desc_html for all file entries that have a long_desc.
 * Uses the formatBodyHtml pipeline (same as messages).
 */
async function regenerateDescHtml(opts) {
	var batchSize = (opts && opts.batchSize) || 100;
	var { formatBodyHtml } = await import('../utils/terminalText.js');

	var total = 0;
	var updated = 0;
	var lastId = 0;

	while (true) {
		var rows = await postgres.query(
			"SELECT id, long_desc FROM file_entries WHERE long_desc IS NOT NULL AND id > $1 ORDER BY id ASC LIMIT $2",
			[lastId, batchSize]
		);

		if (!rows || rows.length === 0) break;

		for (var row of rows) {
			total++;
			lastId = row.id;

			var html = null;
			try {
				html = formatBodyHtml(row.long_desc);
			} catch (_) {}

			// Guard against non-string returns (formatBodyHtml returns {} for some plain text)
			if (!html || typeof html !== 'string' || html.length === 0) {
				html = row.long_desc
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/\n/g, '<br>');
			}

			await postgres.write(
				"UPDATE file_entries SET long_desc_html = $1 WHERE id = $2",
				[html, row.id]
			);
			updated++;
		}

		alogger.writeAlog(4, "[fileEntries] Regen desc HTML: processed " + total + " entries so far", "cyan");
	}

	alogger.writeAlog(3, "[fileEntries] Regen desc HTML complete: " + updated + "/" + total + " updated", "greenbright");
	return { total: total, updated: updated };
}

/**
 * Scan a file area directory and import untracked files.
 * Same logic as the admin scan route but callable from the worker.
 */
async function scanAreaDirectory(areaShortcode) {
	var { getAreaByShortcode, resolveAreaPath, updateStatsForArea } = await import('./fileAreas.js');
	var { getGroupByShortcode } = await import('./fileGroups.js');
	var { applyDescriptions } = await import('../utils/fileDescExtractor.js');
	var fs = await import('fs');
	var path = await import('path');

	var area = await getAreaByShortcode(areaShortcode);
	if (!area) return { found: 0, added: 0, skipped: 0, errors: 0, error: 'Area not found' };

	var group = area.group_shortcode ? await getGroupByShortcode(area.group_shortcode) : null;
	var areaPath = resolveAreaPath(group, area);

	var found = 0, added = 0, skipped = 0, errors = 0;

	try {
		if (!fs.existsSync(areaPath) || !fs.statSync(areaPath).isDirectory()) {
			return { found: 0, added: 0, skipped: 0, errors: 0, error: 'Directory not found: ' + areaPath };
		}

		var dirEntries = fs.readdirSync(areaPath);
		for (var fname of dirEntries) {
			var fullPath = path.join(areaPath, fname);
			var stat;
			try { stat = fs.statSync(fullPath); } catch (_) { errors++; continue; }
			if (!stat.isFile()) continue;

			found++;

			var existing = await postgres.queryOne(
				"SELECT id FROM file_entries WHERE area_id = $1 AND filename = $2",
				[area.id, fname]
			);
			if (existing) { skipped++; continue; }

			var entryObj = {
				area_id: area.id,
				area_shortcode: areaShortcode,
				filename: fname,
				disk_path: fname,
				file_size: stat.size,
				file_date: stat.mtime,
				source_type: 'local',
				source_data: { import_method: 'directory_scan' }
			};
			applyDescriptions(entryObj, fullPath);

			var result = await addFileEntry(entryObj);
			if (result.status) { added++; } else { errors++; }
		}
	} catch (err) {
		errors++;
		alogger.writeAlog(3, "[fileEntries] scanAreaDirectory error: " + err.message, "redbright");
	}

	await updateStatsForArea(areaShortcode);

	alogger.writeAlog(3, "[fileEntries] Scan " + areaShortcode + ": found=" + found + " added=" + added + " skipped=" + skipped + " errors=" + errors, "cyan");
	return { found: found, added: added, skipped: skipped, errors: errors };
}

// --- File area maintenance ---

// Remove duplicate file entries (same filename + area_id).
// Keeps the entry with the lowest id (oldest), deletes the rest.
async function cleanDuplicates() {
	var dupes = await postgres.query(
		"SELECT area_id, filename, COUNT(*) as cnt, MIN(id) as keep_id " +
		"FROM file_entries GROUP BY area_id, filename HAVING COUNT(*) > 1"
	);

	var removed = 0;
	for (var dupe of (dupes || [])) {
		var extras = await postgres.query(
			"SELECT id, uuid FROM file_entries WHERE area_id = $1 AND filename = $2 AND id != $3",
			[dupe.area_id, dupe.filename, dupe.keep_id]
		);
		for (var extra of (extras || [])) {
			await postgres.write("DELETE FROM file_distribution WHERE file_entry_id = $1", [extra.id]);
			await postgres.write("DELETE FROM file_entries WHERE id = $1", [extra.id]);
			removed++;
		}
	}

	if (removed > 0) {
		alogger.writeAlog(2, '[fileEntries] cleanDuplicates: removed ' + removed + ' duplicate(s)', 'cyan');
	}
	return { removed: removed };
}

// Remove entries where the physical file no longer exists on disk.
// Checks all active entries across all areas.
async function cleanMissingFiles() {
	var { getAllAreas, resolveAreaPath } = await import('./fileAreas.js');
	var { getGroupByShortcode } = await import('./fileGroups.js');
	var fs = await import('fs');
	var path = await import('path');

	var areas = await getAllAreas();
	var removed = 0;
	var checked = 0;

	// Cache group lookups
	var groupCache = {};

	for (var area of (areas || [])) {
		var group = null;
		if (area.group_shortcode) {
			if (!groupCache[area.group_shortcode]) {
				groupCache[area.group_shortcode] = await getGroupByShortcode(area.group_shortcode);
			}
			group = groupCache[area.group_shortcode];
		}

		var areaPath = resolveAreaPath(group, area);
		if (!fs.existsSync(areaPath)) continue;

		var entries = await postgres.query(
			"SELECT id, uuid, filename, disk_path FROM file_entries WHERE area_id = $1 AND active = true",
			[area.id]
		);

		for (var entry of (entries || [])) {
			checked++;
			var filePath = path.join(areaPath, entry.disk_path || entry.filename);
			if (!fs.existsSync(filePath)) {
				await postgres.write("DELETE FROM file_distribution WHERE file_entry_id = $1", [entry.id]);
				await postgres.write("DELETE FROM file_entries WHERE id = $1", [entry.id]);
				alogger.writeAlog(4, '[fileEntries] Removed missing file entry: ' + entry.filename + ' (area ' + area.shortcode + ')', 'yellow');
				removed++;
			}
		}
	}

	if (removed > 0) {
		alogger.writeAlog(2, '[fileEntries] cleanMissingFiles: removed ' + removed + ' orphan(s) of ' + checked + ' checked', 'cyan');
		// Update stats for affected areas
		var { recalculateFileCounts } = await import('./fileAreas.js');
		await recalculateFileCounts();
	}
	return { checked: checked, removed: removed };
}

// ---------------------------------------------------------------------------
// Area retention maintenance
// ---------------------------------------------------------------------------

/**
 * Enforce max_age_days and max_files limits on file areas.
 * Deletes file entries (and disk files) that exceed the configured limits.
 * Called by the daily file-maintenance job.
 *
 * @returns {object} { areasChecked, filesRemoved }
 */
async function enforceRetentionLimits() {
	var fs = await import('fs');
	var path = await import('path');
	var fileAreasModel = await import('./fileAreas.js');
	var fileGroupsModel = await import('./fileGroups.js');

	var areas = await postgres.query(
		"SELECT * FROM file_areas WHERE active = true AND (max_age_days IS NOT NULL OR max_files IS NOT NULL)"
	);
	if (!areas || areas.length === 0) return { areasChecked: 0, filesRemoved: 0 };

	var areasChecked = 0;
	var filesRemoved = 0;

	for (var area of areas) {
		areasChecked++;
		var group = area.group_shortcode ? await fileGroupsModel.getGroupByShortcode(area.group_shortcode) : null;
		var areaPath = fileAreasModel.resolveAreaPath(group, area);

		// Collect entries to remove
		var toRemove = new Set();

		// max_age_days: remove files older than N days
		if (area.max_age_days && area.max_age_days > 0) {
			var cutoff = new Date();
			cutoff.setDate(cutoff.getDate() - area.max_age_days);

			var oldEntries = await postgres.query(
				"SELECT id, uuid, filename, disk_path FROM file_entries WHERE area_id = $1 AND active = true AND upload_date < $2 ORDER BY upload_date ASC",
				[area.id, cutoff]
			);
			for (var entry of (oldEntries || [])) {
				toRemove.add(entry);
			}
		}

		// max_files: keep only the N newest, remove the rest
		if (area.max_files && area.max_files > 0) {
			var allEntries = await postgres.query(
				"SELECT id, uuid, filename, disk_path FROM file_entries WHERE area_id = $1 AND active = true ORDER BY upload_date DESC, id DESC",
				[area.id]
			);
			if (allEntries && allEntries.length > area.max_files) {
				var excess = allEntries.slice(area.max_files);
				for (var entry of excess) {
					toRemove.add(entry);
				}
			}
		}

		if (toRemove.size === 0) continue;

		// Delete entries and disk files
		for (var entry of toRemove) {
			// Remove from disk
			if (entry.disk_path) {
				try {
					var filePath = path.join(areaPath, entry.disk_path);
					if (fs.existsSync(filePath)) {
						fs.unlinkSync(filePath);
					}
				} catch (err) {
					alogger.writeAlog(3, 'enforceRetentionLimits: disk delete failed for ' + entry.filename + ': ' + err.message, 'yellow');
				}
			}

			// Remove from DB (handles distribution rows)
			await deleteEntry(entry.uuid);
			filesRemoved++;
		}

		// Update area stats
		await fileAreasModel.updateStatsForArea(area.shortcode);

		alogger.writeAlog(5,
			'enforceRetentionLimits: ' + area.shortcode + ': removed ' + toRemove.size + ' file(s)' +
			(area.max_age_days ? ' (max_age=' + area.max_age_days + 'd)' : '') +
			(area.max_files ? ' (max_files=' + area.max_files + ')' : ''),
			'cyan'
		);
	}

	if (filesRemoved > 0) {
		alogger.writeAlog(3, 'enforceRetentionLimits: checked ' + areasChecked + ' area(s), removed ' + filesRemoved + ' file(s)', 'greenbright');
	}

	return { areasChecked, filesRemoved };
}

export {
	addFileEntry,
	getEntryByUUID,
	getEntryById,
	getEntriesForArea,
	getEntryCount,
	searchEntries,
	checkDupe,
	updateEntry,
	incrementDownloadCount,
	deactivateEntry,
	flagEntry,
	deleteEntry,
	getNewFileCount,
	getNewEntriesForArea,
	newEntriesOrderBy,
	getMaxIdForArea,
	regenerateDescHtml,
	scanAreaDirectory,
	cleanDuplicates,
	cleanMissingFiles,
	enforceRetentionLimits
};
