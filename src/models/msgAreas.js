//imports
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as tableTools from '../middleware/db/tableTools.js';
import * as msgGroups from "./msgGroups.js";
import * as networkAreas from "./networkAreas.js";
import * as alogger from "../utils/alogger.js";

// peerConnections imported lazily to avoid circular risk via peerAreaSubscriptions
async function getPeerConnections() {
	var mod = await import('./peerConnections.js');
	return mod;
}


// Normalize flag input from forms — may arrive as a string, an array, or undefined.
// Always returns a JSON array (or null if empty).
function normalizeFlags(input) {
	if (!input) return JSON.stringify([]);
	if (typeof input === 'string') {
		// Single value from form (only one hidden input) comes as a string
		try {
			var parsed = JSON.parse(input);
			if (Array.isArray(parsed)) return JSON.stringify(parsed);
		} catch (_) {}
		return JSON.stringify([input]);
	}
	if (Array.isArray(input)) return JSON.stringify(input);
	return JSON.stringify([]);
}

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
		read_security: formObj.readsecurity,
		post_security: formObj.postsecurity,
		min_age: formObj.minage,
		max_age: formObj.maxage,
		created_at: currtime,
		updated_at: null,
		active: true,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		msg_count: 0,
		thread_mode: ['standard', 'subscribe_only', 'no_threads'].includes((formObj.thread_mode || '').trim().toLowerCase())
			? formObj.thread_mode.trim().toLowerCase()
			: 'standard',
		post_as: ['username', 'realname'].includes((formObj.post_as || '').trim().toLowerCase())
			? formObj.post_as.trim().toLowerCase()
			: 'username',
		read_perm_flags: normalizeFlags(formObj.read_perm_flags),
		read_rest_flags: normalizeFlags(formObj.read_rest_flags),
		post_perm_flags: normalizeFlags(formObj.post_perm_flags),
		post_rest_flags: normalizeFlags(formObj.post_rest_flags)
	};

	var dbres = await postgres.insertObject(pgObj, "message_areas");
	if (dbres.status !== true) {
		returnObj.errormessages.push("Could not write to DB");
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	var areaId = dbres.insertId;

	// Set qwk_conf_number = area id (default; sysop can override later)
	try {
		await postgres.write(
			"UPDATE message_areas SET qwk_conf_number = $1 WHERE id = $1",
			[areaId]
		);
	} catch (e) {
		alogger.writeAlog(3, "newArea: qwk_conf_number assignment failed for " + shorty + ": " + (e.message || e), "yellow");
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

	// Pre-populate message scan pointers for the new area (all active users)
	try {
		var pointerMod = await import('./userMsgPointers.js');
		await pointerMod.initPointersForArea(shorty);
	} catch (e) {
		alogger.writeAlog(3, "newArea: pointer init failed for area " + shorty + ": " + (e.message || e), "yellow");
	}

	// If a network_id and areatag were provided, map this area onto that network
	// and bootstrap subscription rows for all existing connections on that network.
	if (formObj.network_id && formObj.areatag) {
		var netAreaResult = await networkAreas.addAreaToNetwork(
			formObj.network_id,
			areaId,
			formObj.areatag,
			{ createdByUUID: formObj.createdByUUID, createdByName: formObj.createdByName }
		);
		if (!netAreaResult.status) {
			// Network mapping failure is non-fatal — area and tables are already
			// created successfully. Log it and let the caller know.
			alogger.writeAlog(3,
				"newArea: network mapping failed for " + shorty + " on network " +
				formObj.network_id + ": " + netAreaResult.errormessages.join(", "),
				"redbright"
			);
			returnObj.networkMappingError = netAreaResult.errormessages.join(", ");
		} else {
			// Sync subscription rows for all existing connections on this network
			var peerConns = await getPeerConnections();
			var connections = await peerConns.getConnectionsByNetwork(parseInt(formObj.network_id));
			var pasMod = await import('./peerAreaSubscriptions.js');
			for (var conn of connections) {
				var syncResult = await pasMod.syncConnectionToNetwork(conn.id);
				if (!syncResult.status) {
					alogger.writeAlog(3,
						"newArea: subscription sync failed for connection " + conn.id +
						" after adding area " + shorty + ": " + syncResult.errormessages.join(", "),
						"redbright"
					);
				}
			}
		}
	}

	await recalculateAreaCounts();

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
	// areatag now lives in network_areas — join back to message_areas
	var dbarea = await postgres.queryOne(
		`SELECT ma.*
		 FROM message_areas ma
		 JOIN network_areas na ON na.area_id = ma.id
		 WHERE UPPER(na.areatag) = $1
		 LIMIT 1`,
		[taggy]
	);
	return dbarea;
}

async function getListByGroupShortcode(shortcode) {
	var shorty = shortcode.toUpperCase().trim();
	var dblist = await postgres.query(
		'SELECT * FROM message_areas WHERE UPPER(group_shortcode) LIKE UPPER($1) ORDER BY sort_order ASC, name ASC',
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

async function updateArea(shortcode, formObj) {
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

	// Build update object from only the fields present in the form
	// areatag, networked, and default_address are retired from this table —
	// areatag lives in network_areas; networked is implied by network_areas
	// presence; default_address moved to peer_connections.connection_data.
	var updateObj = {};
	if (formObj.name        !== undefined) updateObj.name            = formObj.name.trim();
	if (formObj.description !== undefined) updateObj.description     = formObj.description.trim();
	if (formObj.readsecurity  !== undefined) updateObj.read_security = parseInt(formObj.readsecurity);
	if (formObj.postsecurity  !== undefined) updateObj.post_security = parseInt(formObj.postsecurity);
	if (formObj.minage        !== undefined) updateObj.min_age       = parseInt(formObj.minage);
	if (formObj.maxage        !== undefined) updateObj.max_age       = parseInt(formObj.maxage);
	if (formObj.active      !== undefined) updateObj.active          = (formObj.active === "true" || formObj.active === true);
	if (formObj.thread_mode !== undefined) {
		var validModes = ['standard', 'subscribe_only', 'no_threads'];
		var mode = (formObj.thread_mode || '').trim().toLowerCase();
		if (validModes.includes(mode)) {
			updateObj.thread_mode = mode;
		}
	}
	if (formObj.post_as !== undefined) {
		var validPostAs = ['username', 'realname'];
		var postAs = (formObj.post_as || '').trim().toLowerCase();
		if (validPostAs.includes(postAs)) {
			updateObj.post_as = postAs;
		}
	}

	// QWK conference number
	if (formObj.qwk_conf_number !== undefined) {
		var confNum = parseInt(formObj.qwk_conf_number);
		if (!isNaN(confNum) && confNum > 0) {
			updateObj.qwk_conf_number = confNum;
		}
	}

	// Flag columns — always update if present in form (even if empty array)
	if (formObj.read_perm_flags !== undefined) updateObj.read_perm_flags = normalizeFlags(formObj.read_perm_flags);
	if (formObj.read_rest_flags !== undefined) updateObj.read_rest_flags = normalizeFlags(formObj.read_rest_flags);
	if (formObj.post_perm_flags !== undefined) updateObj.post_perm_flags = normalizeFlags(formObj.post_perm_flags);
	if (formObj.post_rest_flags !== undefined) updateObj.post_rest_flags = normalizeFlags(formObj.post_rest_flags);

	if (Object.keys(updateObj).length === 0) {
		returnObj.errormessages.push("No updatable fields provided");
		return returnObj;
	}

	updateObj.updated_at = new Date();

	var count = await postgres.updateById(dbarea.id, updateObj, "message_areas");
	if (count > 0) {
		alogger.writeAlog(5, "Message area updated: " + shorty, "greenbright");
		returnObj.status = true;
	} else {
		returnObj.errormessages.push("No rows updated for area " + shorty);
	}

	return returnObj;
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

	// Clean up message pointer/read-tracking rows for this area
	try {
		var pointerMod = await import('./userMsgPointers.js');
		await pointerMod.removePointersForArea(shorty);
	} catch (e) {
		alogger.writeAlog(3, "removeArea: pointer cleanup failed for area " + shorty + ": " + (e.message || e), "yellow");
	}

	// Remove peer_area_subscriptions rows for this area before removing the area record
	var subErr = await postgres.write(
		"DELETE FROM peer_area_subscriptions WHERE area_id = $1",
		[dbarea.id]
	);
	if (subErr) {
		alogger.writeAlog(3,
			"removeArea: failed to remove peer_area_subscriptions for area " + shorty +
			": " + subErr.message,
			"redbright"
		);
		returnObj.errormessages.push("Failed to remove area subscriptions: " + subErr.message);
		return returnObj;
	}

	// Remove network_areas rows for this area
	var naErr = await postgres.write(
		"DELETE FROM network_areas WHERE area_id = $1",
		[dbarea.id]
	);
	if (naErr) {
		alogger.writeAlog(3,
			"removeArea: failed to remove network_areas for area " + shorty +
			": " + naErr.message,
			"redbright"
		);
		returnObj.errormessages.push("Failed to remove network area mappings: " + naErr.message);
		return returnObj;
	}

	// Remove the area record
	try {
		await postgres.write("DELETE FROM message_areas WHERE id = $1", [dbarea.id]);
	} catch (error) {
		returnObj.errormessages.push("Failed to remove area record: " + error.message);
		return returnObj;
	}

	await recalculateAreaCounts();

	alogger.writeAlog(5, "removeArea: area " + shorty + " removed (deleteTables=" + deleteTables + ")", "greenbright");
	returnObj.status = true;
	return returnObj;
}

async function getAllAreas() {
	var dblist = await postgres.query(
		'SELECT * FROM message_areas ORDER BY group_shortcode ASC, sort_order ASC, name ASC',
		[]
	);
	return dblist || [];
}

// Recalculate area_count for all groups from actual data.
// Call at startup or manually to fix drift.
async function recalculateAreaCounts() {
	try {
		await postgres.write(
			`UPDATE message_groups g SET area_count = (
				SELECT COUNT(*) FROM message_areas a WHERE a.group_id = g.id
			)`
		);
		alogger.writeAlog(5, "recalculateAreaCounts: all group area counts updated", "greenbright");
	} catch (error) {
		alogger.writeAlog(3, "recalculateAreaCounts failed: " + error.message, "redbright");
	}
}

// ---------------------------------------------------------------------------
// QWK conference number management
// ---------------------------------------------------------------------------

// Ensure the qwk_conf_number column exists and backfill any NULL values.
// Called at startup from gateway/worker init.
async function ensureQwkConfNumbers() {
	// Add column if missing
	await postgres.write(
		"ALTER TABLE message_areas ADD COLUMN IF NOT EXISTS qwk_conf_number INTEGER"
	);

	// Add unique constraint if missing
	await postgres.write(
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_areas_qwk_conf_number_key')
			THEN ALTER TABLE message_areas ADD CONSTRAINT message_areas_qwk_conf_number_key UNIQUE (qwk_conf_number);
			END IF;
		END $$`
	);

	// Backfill: set qwk_conf_number = id for any areas that don't have one
	await postgres.write(
		"UPDATE message_areas SET qwk_conf_number = id WHERE qwk_conf_number IS NULL"
	);
}

// Look up an area by its QWK conference number.
async function getAreaByConfNumber(confNumber) {
	var row = await postgres.queryOne(
		"SELECT * FROM message_areas WHERE qwk_conf_number = $1",
		[confNumber]
	);
	return row || null;
}

export {
	newArea,
	updateArea,
	removeArea,
	getAreaByShortcode,
	getAreaByAreatag,
	getAreaByConfNumber,
	getAllAreas,
	getListByGroupShortcode,
	createMsgTables,
	createTablesForArea,
	GetShortcodeList,
	updateAreaStats,
	recalculateAreaCounts,
	ensureQwkConfNumbers
};