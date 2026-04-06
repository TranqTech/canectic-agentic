//imports
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from "../utils/alogger.js";
import * as msgAreas from "./msgAreas.js";
import appConfig from "../config/appConfig.js";

// Ensure sort_order and post_as columns exist (migration)
async function ensureSortOrder() {
	await postgres.write("ALTER TABLE message_groups ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0");
	await postgres.write("ALTER TABLE message_areas ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0");
	await postgres.write("ALTER TABLE message_groups ADD COLUMN IF NOT EXISTS post_as VARCHAR(16) DEFAULT 'username'");
}


// Normalize flag input from forms — may arrive as a string, an array, or undefined.
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
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (!formObj.name) {
		returnObj.errormessages.push("Name cannot be empty!");
	}
	if (!formObj.description) {
		returnObj.errormessages.push("Description cannot be empty!");
	}
	if (!formObj.shortcode) {
		returnObj.errormessages.push("Must have a shortcode!");
	}
	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	var shorty = formObj.shortcode.toUpperCase().trim();
	var uniqueShortcode = await postgres.checkValueUnique("shortcode", shorty, "message_groups");
	if (!uniqueShortcode) {
		returnObj.errormessages.push("Shortcode must be unique!");
		return returnObj;
	}

	returnObj.shortcode = shorty;
	var currtime = new Date();
	var uuid = uuidv4();

	var pgObj = {
		uuid: uuid,
		name: formObj.name,
		description: formObj.description,
		shortcode: shorty,
		read_security: formObj.readsecurity != null && formObj.readsecurity !== '' ? parseInt(formObj.readsecurity) : appConfig.getNumber('defaultsecurity', 50),
		post_security: formObj.postsecurity != null && formObj.postsecurity !== '' ? parseInt(formObj.postsecurity) : appConfig.getNumber('defaultsecurity', 50),
		created_at: currtime,
		updated_at: null,
		area_count: 0,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		active: true,
		read_perm_flags: normalizeFlags(formObj.read_perm_flags),
		read_rest_flags: normalizeFlags(formObj.read_rest_flags),
		post_perm_flags: normalizeFlags(formObj.post_perm_flags),
		post_rest_flags: normalizeFlags(formObj.post_rest_flags),
		post_as: ['username', 'realname'].includes((formObj.post_as || '').trim().toLowerCase())
			? formObj.post_as.trim().toLowerCase() : 'username'
	};

	var dbres = await postgres.insertObject(pgObj, "message_groups");
	if (dbres.status === true) {
		returnObj.status = true;
		alogger.writeAlog(5, "Message group created: " + formObj.name + " (" + shorty + ")", "greenbright");
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
	}

	return returnObj;
}

async function getGroupByShortcode(shortcode) {
	var shorty = shortcode.toUpperCase().trim();
	var dbgroup = await postgres.queryOne(
		'SELECT * FROM message_groups WHERE UPPER(shortcode) LIKE UPPER($1)',
		[shorty]
	);
	return dbgroup;
}

async function getAllGroups() {
	var dblist = await postgres.query(
		'SELECT * FROM message_groups ORDER BY sort_order ASC, name ASC'
	);
	return dblist || [];
}

async function getActiveGroups() {
	var dblist = await postgres.query(
		'SELECT * FROM message_groups WHERE active ORDER BY sort_order ASC, name ASC'
	);
	return dblist || [];
}

async function getInactiveGroups() {
	var dblist = await postgres.query(
		'SELECT * FROM message_groups WHERE NOT active ORDER BY sort_order ASC, name ASC'
	);
	return dblist || [];
}

async function getAllGroupsWithAreas() {
	var grouplist = await postgres.query(
		'SELECT id, name, description, shortcode FROM message_groups WHERE active ORDER BY sort_order ASC, name ASC',
		[]
	);

	if (grouplist && grouplist.length > 0) {
		for (var group of grouplist) {
			var dbareas = await postgres.query(
				`SELECT ma.id, ma.name, ma.description, ma.shortcode,
				        na.areatag, na.network_id, mn.name AS network_name
				 FROM message_areas ma
				 LEFT JOIN network_areas na ON na.area_id = ma.id AND na.active
				 LEFT JOIN message_networks mn ON mn.id = na.network_id
				 WHERE ma.active AND ma.group_id = $1
				 ORDER BY ma.name ASC`,
				[group.id]
			);
			group.areas = dbareas || [];
			group.areacount = group.areas.length;
		}
	}

	return grouplist || [];
}

async function updateGroup(shortcode, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var shorty  = shortcode.toUpperCase().trim();
	var dbgroup = await getGroupByShortcode(shorty);
	if (!dbgroup) {
		returnObj.errormessages.push("Group not found for shortcode " + shorty);
		return returnObj;
	}

	// Build update object from only the fields present in the form
	var updateObj = {};
	if (formObj.name        !== undefined) updateObj.name        = formObj.name.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim();
	if (formObj.readsecurity  !== undefined) updateObj.read_security = parseInt(formObj.readsecurity);
	if (formObj.postsecurity  !== undefined) updateObj.post_security = parseInt(formObj.postsecurity);
	if (formObj.active      !== undefined) updateObj.active      = (formObj.active === "true" || formObj.active === true);
	if (formObj.read_perm_flags !== undefined) updateObj.read_perm_flags = normalizeFlags(formObj.read_perm_flags);
	if (formObj.read_rest_flags !== undefined) updateObj.read_rest_flags = normalizeFlags(formObj.read_rest_flags);
	if (formObj.post_perm_flags !== undefined) updateObj.post_perm_flags = normalizeFlags(formObj.post_perm_flags);
	if (formObj.post_rest_flags !== undefined) updateObj.post_rest_flags = normalizeFlags(formObj.post_rest_flags);
	if (formObj.post_as !== undefined) {
		var postAs = (formObj.post_as || '').trim().toLowerCase();
		if (['username', 'realname'].includes(postAs)) updateObj.post_as = postAs;
	}

	if (Object.keys(updateObj).length === 0) {
		returnObj.errormessages.push("No updatable fields provided");
		return returnObj;
	}

	updateObj.updated_at = new Date();

	var count = await postgres.updateById(dbgroup.id, updateObj, "message_groups");
	if (count > 0) {
		alogger.writeAlog(5, "Message group updated: " + shorty, "greenbright");
		returnObj.status = true;
	} else {
		returnObj.errormessages.push("No rows updated for group " + shorty);
	}

	return returnObj;
}

async function removeGroup(shortcode, deleteTables) {
	var returnObj = {
		status: false,
		errormessages: [],
		areasRemoved: 0,
		areasFailed: []
	};

	var shorty  = shortcode.toUpperCase().trim();
	var dbgroup = await getGroupByShortcode(shorty);
	if (!dbgroup) {
		returnObj.errormessages.push("Group not found for shortcode " + shorty);
		return returnObj;
	}

	// Get all child areas regardless of active state so nothing is left orphaned
	var arealist = await postgres.query(
		"SELECT shortcode FROM message_areas WHERE group_id = $1",
		[dbgroup.id]
	);

	if (arealist && arealist.length > 0) {
		alogger.writeAlog(5, "removeGroup: removing " + arealist.length + " areas from group " + shorty, "cyan");
		for (var area of arealist) {
			var areaResult = await msgAreas.removeArea(area.shortcode, deleteTables);
			if (areaResult.status === true) {
				returnObj.areasRemoved++;
			} else {
				// Collect failures but keep going — remove as many areas as possible
				alogger.writeAlog(3, "removeGroup: failed to remove area " + area.shortcode + ": " + areaResult.errormessages.join(", "), "redbright");
				returnObj.areasFailed.push({
					shortcode:     area.shortcode,
					errormessages: areaResult.errormessages
				});
			}
		}

		// If any areas failed, bail before removing the group record
		if (returnObj.areasFailed.length > 0) {
			returnObj.errormessages.push(
				returnObj.areasFailed.length + " area(s) could not be removed — group record preserved. See areasFailed for details."
			);
			return returnObj;
		}
	}

	// All areas cleared — remove the group record
	try {
		await postgres.write("DELETE FROM message_groups WHERE id = $1", [dbgroup.id]);
	} catch (error) {
		returnObj.errormessages.push("Failed to remove group record: " + error.message);
		return returnObj;
	}

	alogger.writeAlog(5, "removeGroup: group " + shorty + " removed (" + returnObj.areasRemoved + " areas, deleteTables=" + deleteTables + ")", "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function reorderGroups(ids) {
	for (var i = 0; i < ids.length; i++) {
		await postgres.write('UPDATE message_groups SET sort_order = $1 WHERE id = $2', [i, parseInt(ids[i])]);
	}
}

async function reorderAreas(ids) {
	for (var i = 0; i < ids.length; i++) {
		await postgres.write('UPDATE message_areas SET sort_order = $1 WHERE id = $2', [i, parseInt(ids[i])]);
	}
}

// Push group-level defaults to all member areas.
// fields: array of field names to push, e.g. ['security', 'flags', 'post_as'] or ['all']
async function pushDefaultsToAreas(shortcode, fields) {
	var group = await getGroupByShortcode(shortcode);
	if (!group) return { status: false, errormessages: ['Group not found'], updated: 0 };

	var pushAll = !fields || fields.length === 0 || fields.includes('all');
	var updateObj = {};

	if (pushAll || fields.includes('security')) {
		updateObj.read_security = group.read_security;
		updateObj.post_security = group.post_security;
	}
	if (pushAll || fields.includes('flags')) {
		updateObj.read_perm_flags = group.read_perm_flags;
		updateObj.read_rest_flags = group.read_rest_flags;
		updateObj.post_perm_flags = group.post_perm_flags;
		updateObj.post_rest_flags = group.post_rest_flags;
	}
	if (pushAll || fields.includes('post_as')) {
		updateObj.post_as = group.post_as || 'username';
	}

	if (Object.keys(updateObj).length === 0) {
		return { status: false, errormessages: ['No fields to push'], updated: 0 };
	}

	// Build SET clause
	var setClauses = [];
	var params = [];
	var paramIdx = 1;
	for (var col in updateObj) {
		if (!updateObj.hasOwnProperty(col)) continue;
		var val = updateObj[col];
		if (typeof val === 'object' && val !== null) val = JSON.stringify(val);
		setClauses.push(col + ' = $' + paramIdx);
		params.push(val);
		paramIdx++;
	}
	params.push(group.shortcode);

	var err = await postgres.write(
		'UPDATE message_areas SET ' + setClauses.join(', ') + ', updated_at = NOW() WHERE group_shortcode = $' + paramIdx,
		params
	);

	if (err) {
		return { status: false, errormessages: [err.message || 'Database error'], updated: 0 };
	}

	var countRow = await postgres.queryOne(
		'SELECT COUNT(*) AS cnt FROM message_areas WHERE group_shortcode = $1',
		[group.shortcode]
	);
	var updated = countRow ? parseInt(countRow.cnt) : 0;

	alogger.writeAlog(5, 'Pushed group defaults to ' + updated + ' area(s) in ' + shortcode + ' (fields: ' + (pushAll ? 'all' : fields.join(',')) + ')', 'greenbright');
	return { status: true, updated: updated };
}

export {
	ensureSortOrder,
	newGroup,
	updateGroup,
	removeGroup,
	getGroupByShortcode,
	getAllGroups,
	getActiveGroups,
	getInactiveGroups,
	getAllGroupsWithAreas,
	reorderGroups,
	reorderAreas,
	pushDefaultsToAreas
};