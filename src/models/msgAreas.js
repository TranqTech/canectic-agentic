//imports
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as tableTools from '../middleware/db/tableTools.js';
import * as msgGroups from "./msgGroups.js";
import { normaliseThreadMode, isThreadMode } from "../utils/threadMode.js";
import { normaliseCharsetMode, isCharsetMode } from "../utils/charsetPolicy.js";
import * as networkAreas from "./networkAreas.js";
import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";

// peerConnections imported lazily to avoid circular risk via peerAreaSubscriptions
async function getPeerConnections() {
	var mod = await import('./peerConnections.js');
	return mod;
}

// Conference number reservation for user QWK packets.
//
// Conference 0 is E-mail (personal mail) by QWK convention. Canectic
// reserves the next 100 conference numbers (1..100) for system content
// that we emit into user QWK downloads: announcements, the wall,
// bulletins, and future additions.
//
// Above the reserved range, conference numbers are allocated in
// per-group blocks of size `qwk_group_stride` (config, default 1000).
// Each message_group owns a block starting at message_groups.qwk_conf_start
// and running to qwk_conf_start + stride - 1. Areas in the group are
// given consecutive offsets within the block, picking the lowest
// unused slot. The intent is that areas in the same group cluster
// together in QWK readers' conference list rather than scattering by
// creation id.
//
// Sysops can still override an individual area's qwk_conf_number via
// the admin form (escape hatch for special cases), and the override
// is allowed to live outside its group's block as long as it doesn't
// collide with any other area.
//
// Changing this constant after an install has areas is a breaking
// operation -- existing area numbers won't automatically shift.
const RESERVED_CONF_COUNT = 100;

// Look up the next free conference number inside a group's block.
// Returns the integer slot, or throws if the block is full.
//
// Behaviour:
//   - Loads existing qwk_conf_numbers in the group within the block
//     window [start, start + stride - 1]
//   - Returns start + lowest unused offset
//   - Throws { code: 'block_full', message } if every slot is taken
//   - Throws { code: 'no_start', message } if the group has no
//     qwk_conf_start (shouldn't happen for groups created via the
//     normal newGroup path; safety net for old groups missing the
//     value -- run the migration tool)
async function nextConfNumberInGroup(group) {
	if (!group || group.qwk_conf_start == null) {
		var err = new Error('Group "' + (group ? group.shortcode : '?') +
			'" has no qwk_conf_start. Run `node src/tools/qwkConfRenumber.js` ' +
			'to assign one.');
		err.code = 'no_start';
		throw err;
	}

	var stride = appConfig.getNumber('qwk_group_stride', 1000);
	if (stride <= 0) stride = 1000;

	var start = parseInt(group.qwk_conf_start, 10);
	var end = start + stride - 1;

	var rows = await postgres.query(
		'SELECT qwk_conf_number FROM message_areas ' +
		'WHERE group_id = $1 AND qwk_conf_number BETWEEN $2 AND $3 ' +
		'ORDER BY qwk_conf_number ASC',
		[group.id, start, end]
	);

	var taken = new Set();
	if (rows && rows.length > 0) {
		for (var r of rows) {
			if (r.qwk_conf_number != null) taken.add(parseInt(r.qwk_conf_number, 10));
		}
	}

	for (var slot = start; slot <= end; slot++) {
		if (!taken.has(slot)) return slot;
	}

	var blockErr = new Error('Group "' + group.shortcode + '" conference block is full ' +
		'(' + start + '-' + end + ', ' + stride + ' slots all in use). ' +
		'Increase qwk_group_stride or move areas out of this group before adding more.');
	blockErr.code = 'block_full';
	throw blockErr;
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
		// Retention. Blank or 0 means no limit, stored as NULL so the daily
		// prune skips the area entirely rather than treating 0 as "keep none".
		max_age_days: (formObj.max_age_days && parseInt(formObj.max_age_days) > 0)
			? parseInt(formObj.max_age_days) : null,
		max_messages: (formObj.max_messages && parseInt(formObj.max_messages) > 0)
			? parseInt(formObj.max_messages) : null,
		created_at: currtime,
		updated_at: null,
		active: true,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		msg_count: 0,
		// Falls back to the GROUP's default rather than straight to
		// 'standard', so a group set to flat does not hand every area created
		// in it a threaded default the sysop then undoes one at a time. An
		// explicit choice on the form still wins.
		thread_mode: normaliseThreadMode(formObj.thread_mode, normaliseThreadMode(dbgroup.thread_mode)),
		// Wire encoding for outbound FTN. 'auto' sends CP437 whenever the body
		// fits it, which is nearly always, and UTF-8 only when it would lose
		// something. Either way the message declares what it carries.
		// Falls back to the GROUP's default, so a network-wide UTF-8 policy
		// does not have to be set on every area by hand.
		charset: normaliseCharsetMode(formObj.charset, normaliseCharsetMode(dbgroup.charset)),
		post_as: ['username', 'realname'].includes((formObj.post_as || '').trim().toLowerCase())
			? formObj.post_as.trim().toLowerCase()
			: 'username',
		newscan_default: formObj.newscan_default === 'true' || formObj.newscan_default === true,
		read_perm_flags: normalizeFlags(formObj.read_perm_flags),
		read_rest_flags: normalizeFlags(formObj.read_rest_flags),
		post_perm_flags: normalizeFlags(formObj.post_perm_flags),
		post_rest_flags: normalizeFlags(formObj.post_rest_flags)
	};

	// Pre-assign the qwk_conf_number from the group's block BEFORE
	// inserting the row, so we can fail-fast if the block is full
	// without leaving a half-created area record behind. The slot
	// search reads existing rows in the group; the new row isn't
	// among them yet, so the slot it picks is guaranteed unused.
	try {
		pgObj.qwk_conf_number = await nextConfNumberInGroup(dbgroup);
	} catch (e) {
		if (e && e.code === 'block_full') {
			returnObj.errormessages.push(e.message);
			return returnObj;
		}
		if (e && e.code === 'no_start') {
			returnObj.errormessages.push(e.message);
			return returnObj;
		}
		alogger.writeAlog(3, "newArea: qwk slot lookup failed for " + shorty + ": " + (e.message || e), "yellow");
		returnObj.errormessages.push("QWK conference number assignment failed: " + (e.message || e));
		return returnObj;
	}

	var dbres = await postgres.insertObject(pgObj, "message_areas");
	if (dbres.status !== true) {
		returnObj.errormessages.push("Could not write to DB");
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	var areaId = dbres.insertId;

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
			// Sync subscription rows for all connections on this network:
			// allowed = true (peers can see the area), enabled = false (sysop enables explicitly)
			var pasMod = await import('./peerAreaSubscriptions.js');
			await pasMod.syncNetworkAreaToConnections(parseInt(formObj.network_id), areaId, { allowAll: true });
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
	if (formObj.max_age_days  !== undefined) updateObj.max_age_days  =
		(formObj.max_age_days !== '' && parseInt(formObj.max_age_days) > 0) ? parseInt(formObj.max_age_days) : null;
	if (formObj.max_messages  !== undefined) updateObj.max_messages  =
		(formObj.max_messages !== '' && parseInt(formObj.max_messages) > 0) ? parseInt(formObj.max_messages) : null;
	if (formObj.active      !== undefined) updateObj.active          = (formObj.active === "true" || formObj.active === true);
	if (formObj.thread_mode !== undefined && isThreadMode(formObj.thread_mode)) {
		updateObj.thread_mode = normaliseThreadMode(formObj.thread_mode);
	}
	if (formObj.charset !== undefined && isCharsetMode(formObj.charset)) {
		updateObj.charset = normaliseCharsetMode(formObj.charset);
	}
	if (formObj.post_as !== undefined) {
		var validPostAs = ['username', 'realname'];
		var postAs = (formObj.post_as || '').trim().toLowerCase();
		if (validPostAs.includes(postAs)) {
			updateObj.post_as = postAs;
		}
	}

	if (formObj.newscan_default !== undefined) {
		updateObj.newscan_default = formObj.newscan_default === 'true' || formObj.newscan_default === true;
	}

	// QWK conference number sysop override. Areas are normally assigned
	// from their group's block, but a sysop can override an individual
	// area to any value > RESERVED_CONF_COUNT that isn't in use anywhere
	// else. The override is allowed to live outside the group's block --
	// this is the documented escape hatch.
	//
	// Empty string is treated as "don't touch this field". The admin
	// form sends an empty value when the field is blank, and we don't
	// want that to reject an otherwise-valid edit of unrelated fields.
	if (formObj.qwk_conf_number !== undefined && formObj.qwk_conf_number !== '') {
		var confNum = parseInt(formObj.qwk_conf_number);
		if (isNaN(confNum) || confNum <= RESERVED_CONF_COUNT) {
			returnObj.errormessages.push(
				"QWK conference number must be greater than " + RESERVED_CONF_COUNT +
				" (numbers 1-" + RESERVED_CONF_COUNT + " are reserved for system conferences)"
			);
			return returnObj;
		}
		// Collision check against any other area (in any group)
		var existing = await postgres.queryOne(
			"SELECT shortcode FROM message_areas WHERE qwk_conf_number = $1 AND id != $2",
			[confNum, dbarea.id]
		);
		if (existing) {
			returnObj.errormessages.push(
				"QWK conference number " + confNum + " is already in use by area '" +
				existing.shortcode + "'"
			);
			return returnObj;
		}
		updateObj.qwk_conf_number = confNum;
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

// Move a message area from its current group to a target group.
//
// What moves:
//   - message_areas.group_id, group_uuid, group_shortcode
//   - message_areas.qwk_conf_number is reassigned from the target
//     group's block (lowest unused offset)
//   - If opts.applyDefaults: also the target group's security / flags /
//     post_as / newscan_default / min_age / max_age are copied onto the
//     area, overwriting any per-area customisations
//
// What stays put (all keyed by shortcode or area id, not group):
//   - Backing tables mb_<shortcode>_msgs / _threads
//   - user_msg_pointers (read tracking)
//   - user_msg_subscriptions
//   - peer_area_subscriptions
//   - network_areas (network mappings)
//   - last_* and msg_count stats
//
// Behaviour:
//   - Returns { status: true, newGroupShortcode, noop: true } if the
//     area is already in the target group (caller surfaces a friendly
//     message rather than an error)
//   - Returns { status: false, errormessages } if the target group or
//     source area cannot be found
//   - On successful move, decrements the old group's area_count and
//     increments the new group's (via direct UPDATEs; the
//     recalculateAreaCounts() drift fix is available if needed)
//
// opts: { applyDefaults: bool }
async function moveArea(shortcode, targetGroupShortcode, opts) {
	var options = opts || {};
	var returnObj = {
		status: false,
		errormessages: [],
		noop: false,
		newGroupShortcode: null
	};

	var shorty = (shortcode || '').toLowerCase().trim();
	var targetShorty = (targetGroupShortcode || '').trim();
	if (!shorty) {
		returnObj.errormessages.push('No shortcode provided');
		return returnObj;
	}
	if (!targetShorty) {
		returnObj.errormessages.push('No target group provided');
		return returnObj;
	}

	var dbarea = await getAreaByShortcode(shorty);
	if (!dbarea) {
		returnObj.errormessages.push('Area "' + shorty + '" not found');
		return returnObj;
	}

	var targetGroup = await msgGroups.getGroupByShortcode(targetShorty);
	if (!targetGroup) {
		returnObj.errormessages.push('Target group "' + targetShorty + '" not found');
		return returnObj;
	}

	// No-op if the area is already in the target group. Surface as
	// success with noop: true so the route can flash a friendly
	// "already in that group" message rather than an error.
	if (dbarea.group_shortcode === targetGroup.shortcode) {
		returnObj.status = true;
		returnObj.noop = true;
		returnObj.newGroupShortcode = targetGroup.shortcode;
		return returnObj;
	}

	var oldGroupShortcode = dbarea.group_shortcode;
	var oldGroupId = dbarea.group_id;

	// Reserve the new conference number from the target group's block
	// BEFORE writing anything. If the block is full, abort cleanly --
	// nothing has been touched yet so the area stays where it was.
	var newConfNumber;
	try {
		newConfNumber = await nextConfNumberInGroup(targetGroup);
	} catch (e) {
		if (e && (e.code === 'block_full' || e.code === 'no_start')) {
			returnObj.errormessages.push(e.message);
			return returnObj;
		}
		returnObj.errormessages.push('QWK conference assignment failed: ' + (e.message || e));
		return returnObj;
	}

	// Build the update set. Always moves the group FKs and reassigns
	// the conference number. Optionally overwrites the per-area
	// settings with the target group's defaults.
	var updateObj = {
		group_id: targetGroup.id,
		group_uuid: targetGroup.uuid,
		group_shortcode: targetGroup.shortcode,
		qwk_conf_number: newConfNumber,
		updated_at: new Date()
	};

	if (options.applyDefaults) {
		if (targetGroup.read_security !== undefined && targetGroup.read_security !== null) {
			updateObj.read_security = targetGroup.read_security;
		}
		if (targetGroup.post_security !== undefined && targetGroup.post_security !== null) {
			updateObj.post_security = targetGroup.post_security;
		}
		if (targetGroup.post_as) {
			updateObj.post_as = targetGroup.post_as;
		}
		if (targetGroup.newscan_default !== undefined && targetGroup.newscan_default !== null) {
			updateObj.newscan_default = targetGroup.newscan_default === true;
		}
		if (targetGroup.min_age !== undefined && targetGroup.min_age !== null) {
			updateObj.min_age = targetGroup.min_age;
		}
		if (targetGroup.max_age !== undefined && targetGroup.max_age !== null) {
			updateObj.max_age = targetGroup.max_age;
		}
		// Flag columns -- copy the target group's arrays verbatim. The
		// DB column type is JSONB so we serialise to a JSON string.
		updateObj.read_perm_flags = JSON.stringify(targetGroup.read_perm_flags || []);
		updateObj.read_rest_flags = JSON.stringify(targetGroup.read_rest_flags || []);
		updateObj.post_perm_flags = JSON.stringify(targetGroup.post_perm_flags || []);
		updateObj.post_rest_flags = JSON.stringify(targetGroup.post_rest_flags || []);
	}

	var count = await postgres.updateById(dbarea.id, updateObj, 'message_areas');
	if (!count || count < 1) {
		returnObj.errormessages.push('Failed to move area "' + shorty + '"');
		return returnObj;
	}

	// Adjust area_count on both groups. Use direct UPDATEs rather than
	// recalculateAreaCounts() because it's cheaper for a single move and
	// the counts can't go stale from this one operation. If the counts
	// are ever observed to drift, recalculateAreaCounts() exists as a
	// safety net.
	try {
		if (oldGroupId) {
			await postgres.write(
				'UPDATE message_groups SET area_count = GREATEST(0, COALESCE(area_count, 0) - 1), updated_at = NOW() WHERE id = $1',
				[oldGroupId]
			);
		}
		await postgres.write(
			'UPDATE message_groups SET area_count = COALESCE(area_count, 0) + 1, updated_at = NOW() WHERE id = $1',
			[targetGroup.id]
		);
	} catch (countErr) {
		alogger.writeAlog(3,
			'moveArea: area_count update failed after move (' + oldGroupShortcode +
			' -> ' + targetGroup.shortcode + '): ' + (countErr.message || countErr) +
			' -- run recalculateAreaCounts() to fix drift',
			'yellow');
	}

	alogger.writeAlog(5,
		'Message area moved: ' + shorty + ' from ' + oldGroupShortcode +
		' to ' + targetGroup.shortcode +
		(options.applyDefaults ? ' (with group defaults applied)' : ''),
		'greenbright');

	returnObj.status = true;
	returnObj.newGroupShortcode = targetGroup.shortcode;
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

	// Clear echolist entries pointing at this area.
	//
	// Deleting the network_areas rows above is not enough on its own. The daily
	// reconciliation clears local_area_id by areatag and only for active
	// entries, so an inactive one keeps the pointer for ever and every entry
	// keeps it until the next daily run. Area ids come from a sequence, so a
	// stale pointer does not stay merely dangling: a later area can be created
	// with the same id, at which point the echolist reports an unrelated area
	// as locally carried. Clearing by id needs no areatag match and covers
	// inactive rows.
	var elErr = await postgres.write(
		"UPDATE network_echolist_areas SET local_area_id = NULL WHERE local_area_id = $1",
		[dbarea.id]
	);
	if (elErr) {
		alogger.writeAlog(3,
			"removeArea: failed to clear echolist local_area_id for area " + shorty +
			": " + elErr.message,
			"redbright"
		);
		returnObj.errormessages.push("Failed to clear echolist links: " + elErr.message);
		return returnObj;
	}

	// Remove the area record.
	//
	// postgres.write reports a failure in its return value rather than
	// throwing, so the try/catch this used to have could never fire: a delete
	// that failed left the area in place and returned status true.
	var delErr = await postgres.write("DELETE FROM message_areas WHERE id = $1", [dbarea.id]);
	if (delErr) {
		returnObj.errormessages.push("Failed to remove area record: " + delErr.message);
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

// Startup-time invariants for the qwk_conf_number column. This function
// does NOT migrate data -- the upgrade-path data migration (shifting
// existing rows into id + RESERVED_CONF_COUNT form) lives in the
// standalone tool src/tools/qwkConfRenumber.js and is run explicitly
// by the sysop at upgrade time, per the changelog instructions.
//
// What this function DOES do at every startup:
//   1. Ensure the UNIQUE constraint exists on qwk_conf_number. The
//      column itself is declared in db/schema/tablecolumns/message_areas.conf
//      and the auto-migrator creates it; the .conf format can't
//      express constraints so we add the UNIQUE here.
//   2. Scan for any rows whose qwk_conf_number sits inside the reserved
//      range [1..RESERVED_CONF_COUNT] and log a level-1 warning naming
//      each one. These are explicit sysop customisations -- we do not
//      touch them, but the sysop should know they collide with the
//      system conference range and may produce duplicate entries in
//      user QWK downloads.
//
// Pre-existing installs upgrading to this release need to run
//   node src/tools/qwkConfRenumber.js
// once, before normal operation, to shift existing areas into the
// reserved-range-compatible scheme. Subsequent runs of that tool are
// idempotent (setting qwk_conf_number = id + RESERVED_CONF_COUNT on a
// row that already has that value is a no-op).
async function ensureQwkConfNumbers() {
	// Ensure the UNIQUE constraint exists. Idempotent.
	try {
		await postgres.write(
			`DO $$ BEGIN
				IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_areas_qwk_conf_number_key')
				THEN ALTER TABLE message_areas ADD CONSTRAINT message_areas_qwk_conf_number_key UNIQUE (qwk_conf_number);
				END IF;
			END $$`
		);
	} catch (e) {
		alogger.writeAlog(2,
			'ensureQwkConfNumbers: unique constraint setup failed: ' + (e.message || e),
			'redbright');
	}

	// Warn about any rows currently holding a value inside the reserved
	// range. These are sysop assignments (or legacy data from before the
	// reserved-range scheme was introduced) and need manual resolution:
	// the tool won't auto-move them because the intent isn't clear.
	try {
		var conflicts = await postgres.query(
			"SELECT id, shortcode, qwk_conf_number FROM message_areas " +
			"WHERE qwk_conf_number IS NOT NULL AND qwk_conf_number BETWEEN 1 AND $1 " +
			"ORDER BY qwk_conf_number ASC",
			[RESERVED_CONF_COUNT]
		);
		if (conflicts && conflicts.length > 0) {
			for (var c of conflicts) {
				alogger.writeAlog(1,
					'ensureQwkConfNumbers: message area "' + c.shortcode + '" has ' +
					'qwk_conf_number=' + c.qwk_conf_number + ' which is inside the reserved ' +
					'range (1-' + RESERVED_CONF_COUNT + '). System conferences may emit with ' +
					'the same number, creating duplicates in downloaded QWK packets. ' +
					'Run `node src/tools/qwkConfRenumber.js` if this is an upgrade, or ' +
					'renumber manually via /admin/msgAreas to a value > ' + RESERVED_CONF_COUNT + '.',
					'yellowbright', true);
			}
		}
	} catch (e) {
		alogger.writeAlog(2,
			'ensureQwkConfNumbers: reserved-range scan failed: ' + (e.message || e),
			'yellow');
	}
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
	RESERVED_CONF_COUNT,
	newArea,
	updateArea,
	moveArea,
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
	updateStatsForArea,
	recalculateAreaCounts,
	ensureQwkConfNumbers,
	nextConfNumberInGroup
};