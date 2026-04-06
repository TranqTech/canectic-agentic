// fileGroups.js — File group CRUD
// Mirrors msgGroups.js pattern for the file area system.

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

function expandHome(dir) {
	if (!dir) return dir;
	if (dir.startsWith('~/') || dir === '~') return path.join(os.homedir(), dir.substring(1));
	return dir;
}
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from "../utils/alogger.js";
import * as fileAreas from "./fileAreas.js";
import appConfig from "../config/appConfig.js";

async function ensureSortOrder() {
	await postgres.write("ALTER TABLE file_groups ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0");
	await postgres.write("ALTER TABLE file_areas ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0");
}

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

async function newGroup(formObj) {
	var returnObj = { status: false, errormessages: [] };

	if (!formObj.name) returnObj.errormessages.push("Name cannot be empty!");
	if (!formObj.description) returnObj.errormessages.push("Description cannot be empty!");
	if (!formObj.shortcode) returnObj.errormessages.push("Must have a shortcode!");
	if (returnObj.errormessages.length > 0) return returnObj;

	var shorty = formObj.shortcode.toUpperCase().trim();
	var uniqueShortcode = await postgres.checkValueUnique("shortcode", shorty, "file_groups");
	if (!uniqueShortcode) {
		returnObj.errormessages.push("Shortcode must be unique!");
		return returnObj;
	}

	returnObj.shortcode = shorty;
	var uuid = uuidv4();

	var pgObj = {
		uuid: uuid,
		name: formObj.name.trim(),
		description: formObj.description.trim(),
		shortcode: shorty,
		base_dir: formObj.base_dir ? formObj.base_dir.trim() : null,
		browse_security: formObj.browsesecurity != null && formObj.browsesecurity !== '' ? parseInt(formObj.browsesecurity) : appConfig.getNumber('default_file_browse_security', 50),
		browse_perm_flags: normalizeFlags(formObj.browse_perm_flags),
		browse_rest_flags: normalizeFlags(formObj.browse_rest_flags),
		read_security: formObj.readsecurity != null && formObj.readsecurity !== '' ? parseInt(formObj.readsecurity) : appConfig.getNumber('default_file_read_security', 60),
		post_security: formObj.postsecurity != null && formObj.postsecurity !== '' ? parseInt(formObj.postsecurity) : appConfig.getNumber('default_file_post_security', 100),
		created_at: new Date(),
		updated_at: null,
		area_count: 0,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		active: true,
		read_perm_flags: normalizeFlags(formObj.read_perm_flags),
		read_rest_flags: normalizeFlags(formObj.read_rest_flags),
		post_perm_flags: normalizeFlags(formObj.post_perm_flags),
		post_rest_flags: normalizeFlags(formObj.post_rest_flags)
	};

	var dbres = await postgres.insertObject(pgObj, "file_groups");
	if (dbres.status === true) {
		returnObj.status = true;
		// Create the group's base directory if specified
		var groupDir = expandHome(pgObj.base_dir) || appConfig.get('file_base_dir', 'files');
		try {
			if (!fs.existsSync(groupDir)) {
				fs.mkdirSync(groupDir, { recursive: true });
				alogger.writeAlog(5, "Created file group directory: " + groupDir, "cyan");
			}
		} catch (dirErr) {
			alogger.writeAlog(3, "Could not create file group directory " + groupDir + ": " + dirErr.message, "yellow");
		}
		alogger.writeAlog(5, "File group created: " + formObj.name + " (" + shorty + ")", "greenbright");
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function getGroupByShortcode(shortcode) {
	var shorty = shortcode.toUpperCase().trim();
	var dbgroup = await postgres.queryOne(
		'SELECT * FROM file_groups WHERE UPPER(shortcode) LIKE UPPER($1)',
		[shorty]
	);
	return dbgroup;
}

async function getAllGroups() {
	var dblist = await postgres.query('SELECT * FROM file_groups ORDER BY sort_order ASC, name ASC');
	return dblist || [];
}

async function getActiveGroups() {
	var dblist = await postgres.query('SELECT * FROM file_groups WHERE active ORDER BY sort_order ASC, name ASC');
	return dblist || [];
}

async function getAllGroupsWithAreas() {
	var grouplist = await postgres.query(
		'SELECT id, name, description, shortcode, base_dir FROM file_groups WHERE active ORDER BY sort_order ASC, name ASC'
	);

	if (grouplist && grouplist.length > 0) {
		for (var group of grouplist) {
			var dbareas = await postgres.query(
				`SELECT fa.id, fa.name, fa.description, fa.shortcode, fa.sub_dir,
				        fa.file_count, fa.total_bytes,
				        fna.areatag, fna.network_id, mn.name AS network_name
				 FROM file_areas fa
				 LEFT JOIN file_network_areas fna ON fna.area_id = fa.id AND fna.active
				 LEFT JOIN message_networks mn ON mn.id = fna.network_id
				 WHERE fa.active AND fa.group_id = $1
				 ORDER BY fa.name ASC`,
				[group.id]
			);
			group.areas = dbareas || [];
			group.areacount = group.areas.length;
		}
	}

	return grouplist || [];
}

async function updateGroup(shortcode, formObj) {
	var returnObj = { status: false, errormessages: [] };

	var shorty = shortcode.toUpperCase().trim();
	var dbgroup = await getGroupByShortcode(shorty);
	if (!dbgroup) {
		returnObj.errormessages.push("Group not found for shortcode " + shorty);
		return returnObj;
	}

	var updateObj = {};
	if (formObj.name        !== undefined) updateObj.name        = formObj.name.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim();
	if (formObj.base_dir    !== undefined) updateObj.base_dir    = formObj.base_dir.trim() || null;
	if (formObj.browsesecurity !== undefined) updateObj.browse_security = parseInt(formObj.browsesecurity);
	if (formObj.readsecurity  !== undefined) updateObj.read_security = parseInt(formObj.readsecurity);
	if (formObj.postsecurity  !== undefined) updateObj.post_security = parseInt(formObj.postsecurity);
	if (formObj.active      !== undefined) updateObj.active      = (formObj.active === "true" || formObj.active === true);
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

	var count = await postgres.updateById(dbgroup.id, updateObj, "file_groups");
	if (count > 0) {
		alogger.writeAlog(5, "File group updated: " + shorty, "greenbright");
		returnObj.status = true;
	} else {
		returnObj.errormessages.push("No rows updated for group " + shorty);
	}

	return returnObj;
}

async function removeGroup(shortcode, deleteFiles) {
	var returnObj = { status: false, errormessages: [], areasRemoved: 0, areasFailed: [] };

	var shorty = shortcode.toUpperCase().trim();
	var dbgroup = await getGroupByShortcode(shorty);
	if (!dbgroup) {
		returnObj.errormessages.push("Group not found for shortcode " + shorty);
		return returnObj;
	}

	var arealist = await postgres.query(
		"SELECT shortcode FROM file_areas WHERE group_id = $1",
		[dbgroup.id]
	);

	if (arealist && arealist.length > 0) {
		alogger.writeAlog(5, "removeFileGroup: removing " + arealist.length + " areas from group " + shorty, "cyan");
		for (var area of arealist) {
			var areaResult = await fileAreas.removeArea(area.shortcode, deleteFiles);
			if (areaResult.status === true) {
				returnObj.areasRemoved++;
			} else {
				alogger.writeAlog(3, "removeFileGroup: failed to remove area " + area.shortcode + ": " + areaResult.errormessages.join(", "), "redbright");
				returnObj.areasFailed.push({ shortcode: area.shortcode, errormessages: areaResult.errormessages });
			}
		}

		if (returnObj.areasFailed.length > 0) {
			returnObj.errormessages.push(returnObj.areasFailed.length + " area(s) could not be removed — group record preserved.");
			return returnObj;
		}
	}

	try {
		await postgres.write("DELETE FROM file_groups WHERE id = $1", [dbgroup.id]);
	} catch (error) {
		returnObj.errormessages.push("Failed to remove group record: " + error.message);
		return returnObj;
	}

	// Optionally remove the group directory from disk
	if (deleteFiles && dbgroup.base_dir) {
		try {
			if (fs.existsSync(dbgroup.base_dir)) {
				fs.rmSync(dbgroup.base_dir, { recursive: true, force: true });
				alogger.writeAlog(5, "removeFileGroup: deleted directory " + dbgroup.base_dir, "cyan");
			}
		} catch (dirErr) {
			alogger.writeAlog(3, "removeFileGroup: could not delete directory " + dbgroup.base_dir + ": " + dirErr.message, "yellow");
		}
	}

	alogger.writeAlog(5, "removeFileGroup: group " + shorty + " removed (" + returnObj.areasRemoved + " areas)", "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function recalculateAreaCounts() {
	await postgres.write(
		`UPDATE file_groups SET area_count = (
			SELECT COUNT(*) FROM file_areas WHERE file_areas.group_id = file_groups.id AND file_areas.active
		)`
	);
}

async function reorderGroups(ids) {
	for (var i = 0; i < ids.length; i++) {
		await postgres.write('UPDATE file_groups SET sort_order = $1 WHERE id = $2', [i, parseInt(ids[i])]);
	}
}

async function reorderAreas(ids) {
	for (var i = 0; i < ids.length; i++) {
		await postgres.write('UPDATE file_areas SET sort_order = $1 WHERE id = $2', [i, parseInt(ids[i])]);
	}
}

export {
	ensureSortOrder,
	normalizeFlags,
	newGroup,
	updateGroup,
	removeGroup,
	getGroupByShortcode,
	getAllGroups,
	getActiveGroups,
	getAllGroupsWithAreas,
	recalculateAreaCounts,
	reorderGroups,
	reorderAreas
};
