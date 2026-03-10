//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from "../utils/alogger.js";
import * as msgAreas from "./msgAreas.js";

dotenv.config();

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
		security: parseInt(formObj.security),
		created_at: currtime,
		updated_at: null,
		area_count: 0,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		active: true
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
		'SELECT * FROM message_groups ORDER BY name ASC'
	);
	return dblist || [];
}

async function getActiveGroups() {
	var dblist = await postgres.query(
		'SELECT * FROM message_groups WHERE active ORDER BY name ASC'
	);
	return dblist || [];
}

async function getInactiveGroups() {
	var dblist = await postgres.query(
		'SELECT * FROM message_groups WHERE NOT active ORDER BY name ASC'
	);
	return dblist || [];
}

async function getAllGroupsWithAreas() {
	var grouplist = await postgres.query(
		'SELECT id, name, description, shortcode FROM message_groups WHERE active ORDER BY name ASC',
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
	if (formObj.security    !== undefined) updateObj.security    = parseInt(formObj.security) || 0;
	if (formObj.active      !== undefined) updateObj.active      = (formObj.active === "true" || formObj.active === true);

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

export {
	newGroup,
	updateGroup,
	removeGroup,
	getGroupByShortcode,
	getAllGroups,
	getActiveGroups,
	getInactiveGroups,
	getAllGroupsWithAreas
};