// fileAreas.js — File area CRUD
// Mirrors msgAreas.js pattern but without per-area backing tables.
// Files live in the single file_entries table with area_id FK.

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import * as postgres from '../middleware/db/postgres.js';
import * as fileGroups from "./fileGroups.js";
import * as alogger from "../utils/alogger.js";
import { substitute } from '../utils/configvars.js';

function expandHome(dir) {
	if (!dir) return dir;
	if (dir.startsWith('~/') || dir === '~') return path.join(os.homedir(), dir.substring(1));
	return dir;
}
import appConfig from "../config/appConfig.js";

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
// Directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the filesystem path for a file area.
 * Three-level hierarchy: global file_base_dir → group base_dir → area sub_dir
 */
function resolveAreaPath(group, area) {
	var globalBase = expandHome(substitute(appConfig.get('file_base_dir', 'files')));
	var root;
	if (group && group.base_dir) {
		var groupDir = expandHome(substitute(group.base_dir));
		// Relative group base_dir is treated as a subdirectory of the global file_base_dir
		root = path.isAbsolute(groupDir) ? groupDir : path.join(globalBase, groupDir);
	} else {
		root = globalBase;
	}
	var sub = (area && area.sub_dir) ? substitute(area.sub_dir) : (area ? area.shortcode.toLowerCase() : '');
	return path.join(root, sub);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function newArea(formObj) {
	var returnObj = { status: false, errormessages: [] };

	if (!formObj.groupshortcode) returnObj.errormessages.push("Could not determine group!");
	if (!formObj.name) returnObj.errormessages.push("Name cannot be empty!");
	if (!formObj.description) returnObj.errormessages.push("Description cannot be empty!");
	if (!formObj.shortcode) returnObj.errormessages.push("Must have a shortcode!");
	if (returnObj.errormessages.length > 0) return returnObj;

	var groupshort = formObj.groupshortcode.toUpperCase().trim();
	var shorty = formObj.shortcode.toUpperCase().trim();

	var uniqueShortcode = await postgres.checkValueUnique("shortcode", shorty, "file_areas");
	if (!uniqueShortcode) {
		returnObj.errormessages.push("Shortcode must be unique!");
	}

	var dbgroup = await fileGroups.getGroupByShortcode(groupshort);
	if (!dbgroup) {
		returnObj.errormessages.push("Could not find parent group!");
	}

	if (returnObj.errormessages.length > 0) return returnObj;

	returnObj.shortcode = shorty;
	var uuid = uuidv4();

	var pgObj = {
		uuid: uuid,
		group_shortcode: groupshort,
		group_id: dbgroup.id,
		group_uuid: dbgroup.uuid,
		name: formObj.name.trim(),
		description: formObj.description.trim(),
		shortcode: shorty,
		sub_dir: formObj.sub_dir ? formObj.sub_dir.trim() : shorty.toLowerCase(),
		browse_security: parseInt(formObj.browsesecurity) || 0,
		browse_perm_flags: normalizeFlags(formObj.browse_perm_flags),
		browse_rest_flags: normalizeFlags(formObj.browse_rest_flags),
		read_security: parseInt(formObj.readsecurity) || 0,
		post_security: parseInt(formObj.postsecurity) || 0,
		created_at: new Date(),
		updated_at: null,
		active: true,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		file_count: 0,
		total_bytes: 0,
		newscan_default: formObj.newscan_default !== 'false',
		read_perm_flags: normalizeFlags(formObj.read_perm_flags),
		read_rest_flags: normalizeFlags(formObj.read_rest_flags),
		post_perm_flags: normalizeFlags(formObj.post_perm_flags),
		post_rest_flags: normalizeFlags(formObj.post_rest_flags)
	};

	var dbres = await postgres.insertObject(pgObj, "file_areas");
	if (dbres.status !== true) {
		returnObj.errormessages.push("Could not write to DB");
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	// Create the area directory on disk
	try {
		var areaPath = resolveAreaPath(dbgroup, pgObj);
		if (!fs.existsSync(areaPath)) {
			fs.mkdirSync(areaPath, { recursive: true });
			alogger.writeAlog(5, "Created file area directory: " + areaPath, "cyan");
		}
	} catch (dirErr) {
		alogger.writeAlog(3, "Could not create file area directory: " + dirErr.message, "yellow");
	}

	// Pre-populate file scan pointers for the new area (all active users)
	try {
		var pointerMod = await import('./userFilePointers.js');
		await pointerMod.initPointersForArea(shorty);
	} catch (e) {
		alogger.writeAlog(3, "newFileArea: pointer init failed for area " + shorty + ": " + (e.message || e), "yellow");
	}

	// Recalculate group area counts
	await fileGroups.recalculateAreaCounts();

	alogger.writeAlog(5, "File area created: " + formObj.name + " (" + shorty + ") in group " + groupshort, "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function getAreaByShortcode(shortcode) {
	var shorty = shortcode.toUpperCase().trim();
	var dbarea = await postgres.queryOne(
		'SELECT * FROM file_areas WHERE UPPER(shortcode) LIKE UPPER($1)',
		[shorty]
	);
	return dbarea;
}

async function getAreasInGroup(groupShortcode) {
	var shorty = groupShortcode.toUpperCase().trim();
	var dbgroup = await fileGroups.getGroupByShortcode(shorty);
	if (!dbgroup) return [];
	var dblist = await postgres.query(
		'SELECT * FROM file_areas WHERE group_id = $1 ORDER BY sort_order ASC, name ASC',
		[dbgroup.id]
	);
	return dblist || [];
}

async function getAllAreas() {
	var dblist = await postgres.query(
		'SELECT fa.*, fg.name AS group_name FROM file_areas fa LEFT JOIN file_groups fg ON fg.id = fa.group_id ORDER BY fg.sort_order ASC, fg.name ASC, fa.sort_order ASC, fa.name ASC'
	);
	return dblist || [];
}

async function getActiveAreas() {
	var dblist = await postgres.query(
		'SELECT fa.*, fg.name AS group_name FROM file_areas fa LEFT JOIN file_groups fg ON fg.id = fa.group_id WHERE fa.active ORDER BY fg.sort_order ASC, fg.name ASC, fa.sort_order ASC, fa.name ASC'
	);
	return dblist || [];
}

async function updateArea(shortcode, formObj) {
	var returnObj = { status: false, errormessages: [] };

	var shorty = shortcode.toUpperCase().trim();
	var dbarea = await getAreaByShortcode(shorty);
	if (!dbarea) {
		returnObj.errormessages.push("Area not found for shortcode " + shorty);
		return returnObj;
	}

	var updateObj = {};
	if (formObj.name         !== undefined) updateObj.name         = formObj.name.trim();
	if (formObj.description  !== undefined) updateObj.description  = formObj.description.trim();
	if (formObj.sub_dir      !== undefined) updateObj.sub_dir      = formObj.sub_dir.trim() || shorty.toLowerCase();
	if (formObj.browsesecurity !== undefined) updateObj.browse_security = parseInt(formObj.browsesecurity);
	if (formObj.readsecurity !== undefined) updateObj.read_security = parseInt(formObj.readsecurity);
	if (formObj.postsecurity !== undefined) updateObj.post_security = parseInt(formObj.postsecurity);
	if (formObj.active       !== undefined) updateObj.active       = (formObj.active === "true" || formObj.active === true);
	if (formObj.newscan_default !== undefined) updateObj.newscan_default = (formObj.newscan_default === "true" || formObj.newscan_default === true);
	if (formObj.browse_perm_flags !== undefined) updateObj.browse_perm_flags = normalizeFlags(formObj.browse_perm_flags);
	if (formObj.browse_rest_flags !== undefined) updateObj.browse_rest_flags = normalizeFlags(formObj.browse_rest_flags);
	if (formObj.read_perm_flags !== undefined) updateObj.read_perm_flags = normalizeFlags(formObj.read_perm_flags);
	if (formObj.read_rest_flags !== undefined) updateObj.read_rest_flags = normalizeFlags(formObj.read_rest_flags);
	if (formObj.post_perm_flags !== undefined) updateObj.post_perm_flags = normalizeFlags(formObj.post_perm_flags);
	if (formObj.post_rest_flags !== undefined) updateObj.post_rest_flags = normalizeFlags(formObj.post_rest_flags);

	if (Object.keys(updateObj).length === 0) {
		returnObj.errormessages.push("No updatable fields provided");
		return returnObj;
	}

	updateObj.updated_at = new Date();

	var count = await postgres.updateById(dbarea.id, updateObj, "file_areas");
	if (count > 0) {
		alogger.writeAlog(5, "File area updated: " + shorty, "greenbright");
		returnObj.status = true;
	} else {
		returnObj.errormessages.push("No rows updated for area " + shorty);
	}

	return returnObj;
}

async function removeArea(shortcode, deleteFiles) {
	var returnObj = { status: false, errormessages: [] };

	var shorty = shortcode.toUpperCase().trim();
	var dbarea = await getAreaByShortcode(shorty);
	if (!dbarea) {
		returnObj.errormessages.push("Area not found for shortcode " + shorty);
		return returnObj;
	}

	// Remove file entries for this area
	try {
		await postgres.write("DELETE FROM file_entries WHERE area_id = $1", [dbarea.id]);
	} catch (error) {
		returnObj.errormessages.push("Failed to remove file entries: " + error.message);
		return returnObj;
	}

	// Remove distribution rows for files that were in this area
	// (already cascaded by file_entries deletion if FK was set, but clean up any orphans)

	// Remove file network area mappings
	try {
		await postgres.write("DELETE FROM file_network_areas WHERE area_id = $1", [dbarea.id]);
	} catch (error) {
		alogger.writeAlog(3, "removeFileArea: failed to clean file_network_areas for " + shorty + ": " + error.message, "yellow");
	}

	// Remove file peer subscriptions
	try {
		await postgres.write("DELETE FROM file_peer_subscriptions WHERE file_area_id = $1", [dbarea.id]);
	} catch (error) {
		alogger.writeAlog(3, "removeFileArea: failed to clean file_peer_subscriptions for " + shorty + ": " + error.message, "yellow");
	}

	// Remove user file pointers for this area
	try {
		await postgres.write("DELETE FROM user_file_pointers WHERE area_shortcode = $1", [shorty]);
	} catch (error) {
		alogger.writeAlog(3, "removeFileArea: failed to clean user_file_pointers for " + shorty + ": " + error.message, "yellow");
	}

	// Remove user file subscriptions for this area
	try {
		await postgres.write("DELETE FROM user_file_subscriptions WHERE area_shortcode = $1", [shorty]);
	} catch (error) {
		alogger.writeAlog(3, "removeFileArea: failed to clean user_file_subscriptions for " + shorty + ": " + error.message, "yellow");
	}

	// Remove the area record
	try {
		await postgres.write("DELETE FROM file_areas WHERE id = $1", [dbarea.id]);
	} catch (error) {
		returnObj.errormessages.push("Failed to remove area record: " + error.message);
		return returnObj;
	}

	// Recalculate group area counts
	await fileGroups.recalculateAreaCounts();

	// Optionally remove the area directory from disk
	if (deleteFiles) {
		try {
			var dbgroup = await fileGroups.getGroupByShortcode(dbarea.group_shortcode);
			var areaPath = resolveAreaPath(dbgroup, dbarea);
			if (fs.existsSync(areaPath)) {
				fs.rmSync(areaPath, { recursive: true, force: true });
				alogger.writeAlog(5, "removeFileArea: deleted directory " + areaPath, "cyan");
			}
		} catch (dirErr) {
			alogger.writeAlog(3, "removeFileArea: could not delete directory: " + dirErr.message, "yellow");
		}
	}

	alogger.writeAlog(5, "removeFileArea: area " + shorty + " removed", "greenbright");
	returnObj.status = true;
	return returnObj;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function updateStatsForArea(shortcode) {
	var dbarea = await getAreaByShortcode(shortcode);
	if (!dbarea) return;

	var countResult = await postgres.queryOne(
		"SELECT COUNT(*) AS cnt, COALESCE(SUM(file_size), 0) AS total FROM file_entries WHERE area_id = $1 AND active = true",
		[dbarea.id]
	);

	var fileCount = countResult ? parseInt(countResult.cnt) : 0;
	var totalBytes = countResult ? parseInt(countResult.total) : 0;

	var lastResult = await postgres.queryOne(
		"SELECT upload_date, filename, uploader_name FROM file_entries WHERE area_id = $1 AND active = true ORDER BY upload_date DESC LIMIT 1",
		[dbarea.id]
	);

	await postgres.write(
		"UPDATE file_areas SET file_count = $1, total_bytes = $2, last_upload = $3, last_filename = $4, last_uploader = $5 WHERE id = $6",
		[
			fileCount,
			totalBytes,
			lastResult ? lastResult.upload_date : null,
			lastResult ? lastResult.filename : null,
			lastResult ? lastResult.uploader_name : null,
			dbarea.id
		]
	);
}

async function recalculateFileCounts() {
	var arealist = await postgres.query("SELECT shortcode FROM file_areas WHERE active");
	if (arealist && arealist.length > 0) {
		for (var area of arealist) {
			await updateStatsForArea(area.shortcode);
		}
	}
}

export {
	normalizeFlags,
	resolveAreaPath,
	newArea,
	updateArea,
	removeArea,
	getAreaByShortcode,
	getAreasInGroup,
	getAllAreas,
	getActiveAreas,
	updateStatsForArea,
	recalculateFileCounts
};
