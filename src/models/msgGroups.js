//imports
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from "../utils/alogger.js";
import * as msgAreas from "./msgAreas.js";
import appConfig from "../config/appConfig.js";

// QWK conference number block model
// ----------------------------------
// Each message group owns a contiguous block of QWK conference numbers
// of size `qwk_group_stride` (config, default 1000). The block runs from
// the group's qwk_conf_start through qwk_conf_start + stride - 1. Areas
// in the group are assigned consecutive offsets within this block, so
// downloaded QWK packets list areas grouped together in mail readers.
//
// Conference numbers 1..RESERVED_CONF_COUNT (currently 100) are reserved
// for system conferences (announcements, wall, bulletins) and never get
// assigned to a group. The first user group starts at the next stride
// boundary at or above RESERVED_CONF_COUNT + 1.

const RESERVED_CONF_COUNT = 100;

// Compute the next available group conference start. Used to pre-fill
// the create-group form and as the default for newGroup() when the
// caller doesn't supply an explicit value.
//
// Behaviour:
//   - If no groups have a qwk_conf_start, returns the first stride
//     boundary at or above RESERVED_CONF_COUNT + 1 (e.g. stride=1000
//     -> 1000; stride=500 -> 500; stride=50 -> 150 because 100 is
//     inside the reserved range and the next 50-multiple above 100
//     is 150).
//   - Otherwise returns MAX(existing) + stride.
async function nextGroupConfStart() {
	var stride = appConfig.getNumber('qwk_group_stride', 1000);
	if (stride <= 0) stride = 1000;

	var row = await postgres.queryOne(
		'SELECT MAX(qwk_conf_start) AS m FROM message_groups WHERE qwk_conf_start IS NOT NULL'
	);
	var max = row && row.m != null ? parseInt(row.m, 10) : null;

	if (max === null || isNaN(max)) {
		// First group: round up to the next stride boundary that's
		// strictly above RESERVED_CONF_COUNT.
		var first = stride;
		while (first <= RESERVED_CONF_COUNT) first += stride;
		return first;
	}

	return max + stride;
}

// Validate a candidate qwk_conf_start. Returns null if valid, or an
// error message string. excludeGroupId lets edit flows skip the row
// being changed when checking for collisions.
async function validateGroupConfStart(value, excludeGroupId) {
	if (value === null || value === undefined || value === '') {
		return 'Conference start is required';
	}
	var n = parseInt(value, 10);
	if (isNaN(n) || n <= RESERVED_CONF_COUNT) {
		return 'Conference start must be greater than ' + RESERVED_CONF_COUNT +
			' (1-' + RESERVED_CONF_COUNT + ' are reserved for system conferences)';
	}
	var sql = 'SELECT shortcode, name FROM message_groups WHERE qwk_conf_start = $1';
	var params = [n];
	if (excludeGroupId) {
		sql += ' AND id != $2';
		params.push(excludeGroupId);
	}
	var existing = await postgres.queryOne(sql, params);
	if (existing) {
		return 'Conference start ' + n + ' is already in use by group "' +
			(existing.name || existing.shortcode) + '"';
	}
	return null;
}

// Ensure the UNIQUE constraint exists on message_groups.qwk_conf_start.
// The .conf schema can't express constraints, so we add it here at
// startup. Idempotent.
async function ensureQwkConfStartConstraint() {
	try {
		await postgres.write(
			"DO $$ BEGIN " +
			"IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_groups_qwk_conf_start_key') " +
			"THEN ALTER TABLE message_groups ADD CONSTRAINT message_groups_qwk_conf_start_key UNIQUE (qwk_conf_start); " +
			"END IF; END $$"
		);
	} catch (e) {
		alogger.writeAlog(2,
			'ensureQwkConfStartConstraint: setup failed: ' + (e.message || e),
			'redbright');
	}
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

	// QWK conference start: if the form supplied one, validate it.
	// Otherwise auto-assign via nextGroupConfStart() so newly created
	// groups always carve out a fresh block above the existing groups.
	var confStart;
	if (formObj.qwk_conf_start !== undefined && formObj.qwk_conf_start !== null && String(formObj.qwk_conf_start).trim() !== '') {
		var startErr = await validateGroupConfStart(formObj.qwk_conf_start, null);
		if (startErr) {
			returnObj.errormessages.push(startErr);
			return returnObj;
		}
		confStart = parseInt(formObj.qwk_conf_start, 10);
	} else {
		confStart = await nextGroupConfStart();
	}

	returnObj.shortcode = shorty;
	var currtime = new Date();
	var uuid = uuidv4();

	var pgObj = {
		uuid: uuid,
		name: formObj.name,
		description: formObj.description,
		shortcode: shorty,
		read_security: formObj.readsecurity != null && formObj.readsecurity !== '' ? parseInt(formObj.readsecurity) : appConfig.getNumber('default_msg_read_security', 50),
		post_security: formObj.postsecurity != null && formObj.postsecurity !== '' ? parseInt(formObj.postsecurity) : appConfig.getNumber('default_msg_post_security', 60),
		created_at: currtime,
		updated_at: null,
		area_count: 0,
		created_by_uuid: formObj.createdByUUID,
		created_by_name: formObj.createdByName,
		active: true,
		qwk_conf_start: confStart,
		read_perm_flags: normalizeFlags(formObj.read_perm_flags),
		read_rest_flags: normalizeFlags(formObj.read_rest_flags),
		post_perm_flags: normalizeFlags(formObj.post_perm_flags),
		post_rest_flags: normalizeFlags(formObj.post_rest_flags),
		post_as: ['username', 'realname'].includes((formObj.post_as || '').trim().toLowerCase())
			? formObj.post_as.trim().toLowerCase() : 'username',
		newscan_default: formObj.newscan_default === 'true' || formObj.newscan_default === true,
		// Retention defaults for areas created in this group. NULL means no
		// pruning, which is what every group and area starts as.
		max_age_days: (formObj.max_age_days && parseInt(formObj.max_age_days) > 0)
			? parseInt(formObj.max_age_days) : null,
		max_messages: (formObj.max_messages && parseInt(formObj.max_messages) > 0)
			? parseInt(formObj.max_messages) : null,
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
	if (formObj.newscan_default !== undefined) {
		updateObj.newscan_default = formObj.newscan_default === 'true' || formObj.newscan_default === true;
	if (formObj.max_age_days !== undefined) updateObj.max_age_days =
		(formObj.max_age_days !== '' && parseInt(formObj.max_age_days) > 0) ? parseInt(formObj.max_age_days) : null;
	if (formObj.max_messages !== undefined) updateObj.max_messages =
		(formObj.max_messages !== '' && parseInt(formObj.max_messages) > 0) ? parseInt(formObj.max_messages) : null;
	}

	// QWK conference start. If supplied and different from the current
	// value, validate it and queue a renumber of every area in this
	// group, preserving each area's offset within the block.
	var newConfStart = null;
	if (formObj.qwk_conf_start !== undefined && String(formObj.qwk_conf_start).trim() !== '') {
		var candidate = parseInt(formObj.qwk_conf_start, 10);
		if (isNaN(candidate)) {
			returnObj.errormessages.push('Invalid QWK conference start value');
			return returnObj;
		}
		if (candidate !== dbgroup.qwk_conf_start) {
			var startErr = await validateGroupConfStart(candidate, dbgroup.id);
			if (startErr) {
				returnObj.errormessages.push(startErr);
				return returnObj;
			}
			newConfStart = candidate;
		}
	}

	if (Object.keys(updateObj).length === 0 && newConfStart === null) {
		returnObj.errormessages.push("No updatable fields provided");
		return returnObj;
	}

	// If the conf-start is changing, do the area renumber FIRST so we
	// don't write a new start value while areas still hold offsets
	// computed against the old one. The renumber preserves each area's
	// offset (area.qwk_conf_number - oldStart) so the relative ordering
	// is unchanged. If the renumber fails because of collisions with
	// areas in another group, the entire updateGroup call aborts and
	// the conf-start stays at its old value.
	if (newConfStart !== null) {
		var oldStart = dbgroup.qwk_conf_start != null ? parseInt(dbgroup.qwk_conf_start, 10) : null;
		var renumberRes = await renumberGroupAreas(dbgroup.id, oldStart, newConfStart);
		if (!renumberRes.status) {
			returnObj.errormessages = returnObj.errormessages.concat(renumberRes.errormessages);
			return returnObj;
		}
		updateObj.qwk_conf_start = newConfStart;
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

// Renumber all areas in a group from oldStart to newStart, preserving
// each area's offset. Returns { status, errormessages, conflicts }.
//
// Behaviour:
//   - If oldStart is null (group has no current start), assigns
//     consecutive offsets starting at 0 in id-asc order. This case
//     handles a group whose qwk_conf_start was never set picking up a
//     value for the first time.
//   - Otherwise computes each area's new number as
//     newStart + (area.qwk_conf_number - oldStart). Areas without a
//     qwk_conf_number get sequential offsets at the tail.
//   - Validates every new number against the reserved range and
//     against any area outside this group; aborts on first collision
//     with a list of conflicts.
//   - Two-phase write: scratch range (negative numbers) first, then
//     final values. The DB UNIQUE constraint allows negatives, and
//     this dodges intra-group collisions during the move (e.g. when
//     the new range overlaps the old range).
async function renumberGroupAreas(groupId, oldStart, newStart) {
	var returnObj = { status: false, errormessages: [], conflicts: [] };

	var stride = appConfig.getNumber('qwk_group_stride', 1000);
	if (stride <= 0) stride = 1000;

	// Load areas in this group ordered by sort_order, id
	var areas = await postgres.query(
		'SELECT id, shortcode, qwk_conf_number FROM message_areas ' +
		'WHERE group_id = $1 ORDER BY sort_order ASC, id ASC',
		[groupId]
	);
	if (!areas || areas.length === 0) {
		returnObj.status = true;
		return returnObj;
	}

	// Compute each area's new conference number
	var nextSequentialOffset = 0;
	var assignments = []; // [{ id, shortcode, oldNum, newNum }]

	for (var area of areas) {
		var oldNum = area.qwk_conf_number != null ? parseInt(area.qwk_conf_number, 10) : null;
		var offset;
		if (oldStart != null && oldNum != null) {
			offset = oldNum - oldStart;
			if (offset < 0 || offset >= stride) {
				// Area's existing number is outside the group's old
				// block (sysop manual override). Place it at the tail.
				offset = -1;
			}
		} else {
			offset = -1;
		}
		if (offset < 0) {
			offset = nextSequentialOffset++;
		}
		var newNum = newStart + offset;
		assignments.push({
			id: area.id,
			shortcode: area.shortcode,
			oldNum: oldNum,
			newNum: newNum,
			offset: offset
		});
	}

	// Validate: every new number must be > RESERVED_CONF_COUNT and
	// inside the new block window
	for (var a of assignments) {
		if (a.newNum <= RESERVED_CONF_COUNT) {
			returnObj.errormessages.push(
				'Area "' + a.shortcode + '" would land at conference ' + a.newNum +
				' which is inside the reserved range (1-' + RESERVED_CONF_COUNT + ')'
			);
		}
		if (a.offset >= stride) {
			returnObj.errormessages.push(
				'Area "' + a.shortcode + '" would land at offset ' + a.offset +
				' which exceeds the group stride of ' + stride +
				'. Increase qwk_group_stride or remove areas before renumbering.'
			);
		}
	}
	if (returnObj.errormessages.length > 0) return returnObj;

	// Validate: no collision with any area OUTSIDE this group
	var newNums = assignments.map(function(x) { return x.newNum; });
	var collisionRows = await postgres.query(
		'SELECT id, shortcode, qwk_conf_number FROM message_areas ' +
		'WHERE group_id != $1 AND qwk_conf_number = ANY($2::int[])',
		[groupId, newNums]
	);
	if (collisionRows && collisionRows.length > 0) {
		for (var c of collisionRows) {
			returnObj.conflicts.push({
				shortcode: c.shortcode,
				qwk_conf_number: c.qwk_conf_number
			});
			returnObj.errormessages.push(
				'Conference ' + c.qwk_conf_number + ' is already used by area "' +
				c.shortcode + '" in another group'
			);
		}
		return returnObj;
	}

	// Two-phase write: park each area at -id (guaranteed unique because
	// id is unique and negative values are outside any real range), then
	// move each area to its final number. The intermediate step exists
	// purely to dodge UNIQUE collisions when the new range overlaps the
	// old range (e.g. moving group from start=1000 to start=1500 with
	// stride=1000).
	try {
		for (var a2 of assignments) {
			await postgres.write(
				'UPDATE message_areas SET qwk_conf_number = $1 WHERE id = $2',
				[-1 * parseInt(a2.id, 10), a2.id]
			);
		}
		for (var a3 of assignments) {
			await postgres.write(
				'UPDATE message_areas SET qwk_conf_number = $1 WHERE id = $2',
				[a3.newNum, a3.id]
			);
		}
	} catch (e) {
		returnObj.errormessages.push('Renumber write failed: ' + (e.message || e));
		alogger.writeAlog(2,
			'renumberGroupAreas: write failed for group ' + groupId + ': ' + (e.message || e),
			'redbright');
		return returnObj;
	}

	alogger.writeAlog(5,
		'renumberGroupAreas: group_id=' + groupId + ' renumbered ' + assignments.length +
		' area(s) to start=' + newStart,
		'greenbright');
	returnObj.status = true;
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

	// An explicitly empty list means push nothing. Only an omitted argument or
	// an explicit 'all' means everything, so a caller that filters its field
	// list down to zero cannot accidentally overwrite every area setting.
	var pushAll = !fields || fields.includes('all');
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
	if (pushAll || fields.includes('newscan_default')) {
		updateObj.newscan_default = group.newscan_default || false;
	}
	if (pushAll || fields.includes('retention')) {
		// Note both can be null, and null means no pruning. Pushing retention
		// from a group that has no limits set therefore turns pruning OFF on
		// every area in the group, which is why the UI leaves this unchecked.
		updateObj.max_age_days = group.max_age_days;
		updateObj.max_messages = group.max_messages;
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
	pushDefaultsToAreas,
	nextGroupConfStart,
	validateGroupConfStart,
	ensureQwkConfStartConstraint,
	renumberGroupAreas,
	RESERVED_CONF_COUNT
};