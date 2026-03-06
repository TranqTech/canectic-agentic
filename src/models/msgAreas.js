//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as tableTools from '../middleware/db/tableTools.js';
import * as msgGroups from "./msgGroups.js";
import * as alogger from "../utils/alogger.js";

dotenv.config();

async function updateAreaStats() {
	var arealist = await postgres.query("SELECT shortcode FROM message_areas WHERE active");
	if (arealist && arealist.length > 0) {
		for (var area of arealist) {
			await updateStatsForArea(area.shortcode);
		}
	}
}

async function updateStatsForArea(shortcode) {
	var shorty = shortcode.toLowerCase().trim();
	var dbarea = await getAreaByShortcode(shortcode);
	if (!dbarea) return;

	var msgtable = "mb_" + shorty + "_msgs";

	// Message count
	var countResult = await postgres.query("SELECT COUNT(*) FROM " + msgtable, []);
	var msgcount = (countResult && countResult[0]) ? parseInt(countResult[0].count) : 0;

	// Last message info
	var lastMsgResult = await postgres.query(
		"SELECT system_time, from_user, subject FROM " + msgtable +
		" WHERE system_time IS NOT NULL ORDER BY system_time DESC LIMIT 1",
		[]
	);
	var lastmsg = (lastMsgResult && lastMsgResult[0]) ? lastMsgResult[0] : null;

	var lastfrom    = lastmsg ? lastmsg.from_user          : dbarea.last_from;
	var lastsubject = lastmsg ? (lastmsg.subject || "").trim() : dbarea.last_subject;
	var lasttime    = lastmsg ? lastmsg.system_time        : dbarea.last_message;

	await postgres.write(
		"UPDATE message_areas SET msg_count = $1, last_from = $2, last_subject = $3, last_message = $4 WHERE id = $5",
		[msgcount, lastfrom, lastsubject, lasttime, dbarea.id]
	);
}

async function newArea(formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (!formObj.groupshortcode) {
		returnObj.errormessages.push("Could not determine group!");
		return returnObj;
	}
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

	var groupshort = formObj.groupshortcode.toUpperCase().trim();
	var shorty     = formObj.shortcode.toUpperCase().trim();
	var areatag    = formObj.areatag ? formObj.areatag.toUpperCase().trim() : "";

	if (areatag) {
		var uniquetag = await postgres.checkValueUnique("areatag", areatag, "message_areas");
		if (!uniquetag) {
			returnObj.errormessages.push("Area tag already in use");
		}
	}

	var uniqueShortcode = await postgres.checkValueUnique("shortcode", shorty, "message_areas");
	if (!uniqueShortcode) {
		returnObj.errormessages.push("Shortcode must be unique!");
	}

	var dbgroup = await msgGroups.getGroupByShortcode(formObj.groupshortcode);
	if (!dbgroup) {
		returnObj.errormessages.push("Could not find parent group!");
	}

	if (returnObj.errormessages.length > 0) {
		return returnObj;
	}

	var isnetworked = (formObj.networked === "networked");
	if (isnetworked && !areatag) {
		returnObj.errormessages.push("You cannot have a networked area with no tag!");
		return returnObj;
	}

	returnObj.shortcode = shorty;
	var currtime = new Date();
	var uuid = uuidv4();

	var pgObj = {
		uuid: uuid,
		group_shortcode: groupshort,
		group_id: dbgroup.id,
		group_uuid: dbgroup.uuid,
		name: formObj.name,
		description: formObj.description,
		shortcode: shorty,
		areatag: areatag,
		read_security: formObj.readsecurity,
		post_security: formObj.postsecurity,
		min_age: formObj.minage,
		max_age: formObj.maxage,
		created_at: currtime,
		default_address: formObj.default_address,
		networked: isnetworked,
		updated_at: null,
		active: true,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		msg_count: 0
	};

	var dbres = await postgres.insertObject(pgObj, "message_areas");
	if (dbres.status !== true) {
		returnObj.errormessages.push("Could not write to DB");
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	// Area record written — now create backing tables
	var tableResult = await createTablesForArea(shorty.toLowerCase());
	if (!tableResult.status) {
		// Roll back the area record so DB and tables stay in sync
		alogger.writeAlog(3, "newArea: table creation failed for " + shorty + ", rolling back area record", "redbright");
		try {
			await postgres.write("DELETE FROM message_areas WHERE uuid = $1", [uuid]);
		} catch (delError) {
			alogger.writeAlog(3, "newArea: rollback failed for " + shorty + ": " + delError.message, "redbright");
			returnObj.errormessages.push("Area record rollback failed — manual cleanup may be required for shortcode " + shorty);
		}
		returnObj.errormessages = returnObj.errormessages.concat(tableResult.errormessages);
		return returnObj;
	}

	alogger.writeAlog(5, "Message area created: " + formObj.name + " (" + shorty + ")", "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function createTablesForArea(shorty) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var msgTableTemplate    = process.cwd() + "/src/templates/msgTable.conf";
	var threadTableTemplate = process.cwd() + "/src/templates/threadTable.conf";
	var msgTableRemoved     = process.cwd() + "/src/templates/msgTableRemoved.conf";
	var threadTableRemoved  = process.cwd() + "/src/templates/threadTableRemoved.conf";

	var msgCols         = await tableTools.getColumnsFromFile(msgTableTemplate);
	var threadCols      = await tableTools.getColumnsFromFile(threadTableTemplate);
	var msgRemoveCols   = await tableTools.getColumnsFromFile(msgTableRemoved)    || [];
	var threadRemoveCols = await tableTools.getColumnsFromFile(threadTableRemoved) || [];

	var mTable = "mb_" + shorty + "_msgs";
	var tTable = "mb_" + shorty + "_threads";

	try {
		await tableTools.checkOrCreateTable(mTable, msgCols, msgRemoveCols);
		await tableTools.checkOrCreateTable(tTable, threadCols, threadRemoveCols);
	} catch (error) {
		returnObj.errormessages.push("Table creation failed: " + error.message);
		return returnObj;
	}

	// Verify both tables actually exist after creation attempt
	var msgsExist    = await tableTools.checkTable(mTable);
	var threadsExist = await tableTools.checkTable(tTable);

	if (!msgsExist) {
		returnObj.errormessages.push("Message table " + mTable + " could not be verified after creation");
	}
	if (!threadsExist) {
		returnObj.errormessages.push("Thread table " + tTable + " could not be verified after creation");
	}
	if (!msgsExist || !threadsExist) {
		return returnObj;
	}

	returnObj.status = true;
	return returnObj;
}

async function getAreaByShortcode(shortcode) {
	var shorty = shortcode.toUpperCase().trim();
	var dbarea = await postgres.queryOne(
		'SELECT * FROM message_areas WHERE UPPER(shortcode) LIKE UPPER($1)',
		[shorty]
	);
	return dbarea;
}

async function getAreaByAreatag(areatag) {
	var taggy = areatag.toUpperCase().trim();
	var dbarea = await postgres.queryOne(
		'SELECT * FROM message_areas WHERE UPPER(areatag) LIKE UPPER($1)',
		[taggy]
	);
	return dbarea;
}

async function getListByGroupShortcode(shortcode) {
	var shorty = shortcode.toUpperCase().trim();
	var dblist = await postgres.query(
		'SELECT * FROM message_areas WHERE UPPER(group_shortcode) LIKE UPPER($1)',
		[shorty]
	);
	return dblist || [];
}

async function createMsgTables() {
	var msgTableTemplate   = process.cwd() + "/src/templates/msgTable.conf";
	var threadTableTemplate = process.cwd() + "/src/templates/threadTable.conf";
	var msgTableRemoved    = process.cwd() + "/src/templates/msgTableRemoved.conf";
	var threadTableRemoved = process.cwd() + "/src/templates/threadTableRemoved.conf";

	var msgCols         = await tableTools.getColumnsFromFile(msgTableTemplate);
	var threadCols      = await tableTools.getColumnsFromFile(threadTableTemplate);
	var msgRemoveCols   = await tableTools.getColumnsFromFile(msgTableRemoved)   || [];
	var threadRemoveCols = await tableTools.getColumnsFromFile(threadTableRemoved) || [];

	var dblist = await postgres.query("SELECT shortcode FROM message_areas WHERE active", []);
	if (!dblist || dblist.length === 0) return;

	for (var area of dblist) {
		if (!area.shortcode || area.shortcode.length === 0) continue;
		var shorty = area.shortcode.toLowerCase();
		var mTable = "mb_" + shorty + "_msgs";
		var tTable = "mb_" + shorty + "_threads";
		await tableTools.checkOrCreateTable(mTable, msgCols, msgRemoveCols);
		await tableTools.checkOrCreateTable(tTable, threadCols, threadRemoveCols);
	}
}

async function GetShortcodeList() {
	var scarray = [];
	var shortcodelist = await postgres.query(
		"SELECT shortcode FROM message_areas WHERE active",
		[]
	);
	if (shortcodelist && shortcodelist.length > 0) {
		for (var sc of shortcodelist) {
			if (sc.shortcode) {
				scarray.push(sc.shortcode);
			}
		}
	}
	return scarray;
}

async function removeArea(shortcode, deleteTables) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var shorty = shortcode.toUpperCase().trim();
	var dbarea = await getAreaByShortcode(shorty);
	if (!dbarea) {
		returnObj.errormessages.push("Area not found for shortcode " + shorty);
		return returnObj;
	}

	var tableshorty = shorty.toLowerCase();
	var mTable      = "mb_" + tableshorty + "_msgs";
	var tTable      = "mb_" + tableshorty + "_threads";

	// Drop tables first if requested — do this before removing the area record
	// so that if a drop fails we can bail without leaving an orphaned record
	if (deleteTables) {
		var msgsExist    = await tableTools.checkTable(mTable);
		var threadsExist = await tableTools.checkTable(tTable);

		if (msgsExist) {
			try {
				await tableTools.dropTable(mTable);
			} catch (error) {
				returnObj.errormessages.push("Failed to drop message table " + mTable + ": " + error.message);
				return returnObj;
			}
			// Verify drop succeeded
			var stillExists = await tableTools.checkTable(mTable);
			if (stillExists) {
				returnObj.errormessages.push("Message table " + mTable + " could not be verified as dropped");
				return returnObj;
			}
		}

		if (threadsExist) {
			try {
				await tableTools.dropTable(tTable);
			} catch (error) {
				returnObj.errormessages.push("Failed to drop thread table " + tTable + ": " + error.message);
				return returnObj;
			}
			var stillExists = await tableTools.checkTable(tTable);
			if (stillExists) {
				returnObj.errormessages.push("Thread table " + tTable + " could not be verified as dropped");
				return returnObj;
			}
		}

		alogger.writeAlog(5, "removeArea: tables dropped for " + shorty, "cyan");
	}

	// Remove the area record
	try {
		await postgres.write("DELETE FROM message_areas WHERE id = $1", [dbarea.id]);
	} catch (error) {
		returnObj.errormessages.push("Failed to remove area record: " + error.message);
		return returnObj;
	}

	// Decrement area_count on parent group, guarding against going below zero
	try {
		await postgres.write(
			"UPDATE message_groups SET area_count = GREATEST(area_count - 1, 0) WHERE id = $1",
			[dbarea.group_id]
		);
	} catch (error) {
		// Non-fatal — area is already deleted, just log it
		alogger.writeAlog(4, "removeArea: could not decrement area_count for group_id " + dbarea.group_id + ": " + error.message, "yellow");
	}

	alogger.writeAlog(5, "removeArea: area " + shorty + " removed (deleteTables=" + deleteTables + ")", "greenbright");
	returnObj.status = true;
	return returnObj;
}

export {
	newArea,
	removeArea,
	getAreaByShortcode,
	getAreaByAreatag,
	getListByGroupShortcode,
	createMsgTables,
	createTablesForArea,
	GetShortcodeList,
	updateAreaStats
};