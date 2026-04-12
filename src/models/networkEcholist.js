// networkEcholist.js — Network echolist registry model.
//
// Maintains a registry of echomail areas available on each network,
// imported from echolist files (BACKBONE.NA, etc.). Multiple echolists
// per network are supported, with one flagged as default.
//
// Uses historical tracking (first_seen/last_seen/removed_at/active)
// matching the ftn_nodelist pattern. Import performs a diff against
// existing entries: new areas are inserted, missing areas are soft-deleted,
// changed descriptions are updated.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

async function ensureIndexes() {
	await postgres.write(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_echolist_areas_tag ON network_echolist_areas(echolist_id, UPPER(areatag))"
	);
	await postgres.write(
		"CREATE INDEX IF NOT EXISTS idx_echolist_areas_active ON network_echolist_areas(echolist_id, active)"
	);
	await postgres.write(
		"CREATE INDEX IF NOT EXISTS idx_echolist_areas_local ON network_echolist_areas(local_area_id) WHERE local_area_id IS NOT NULL"
	);
	await postgres.write("ALTER TABLE network_echolists ADD COLUMN IF NOT EXISTS scan_area VARCHAR(255)");
}

// ---------------------------------------------------------------------------
// Echolist CRUD
// ---------------------------------------------------------------------------

async function createEcholist(networkId, name, description, isDefault) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!networkId) { returnObj.errormessages.push('Network ID is required'); return returnObj; }
	if (!name || !name.trim()) { returnObj.errormessages.push('Name is required'); return returnObj; }

	// Check for existing echolist with same name on this network -- return it instead of creating duplicate
	var existing = await postgres.queryOne(
		"SELECT id FROM network_echolists WHERE network_id = $1 AND LOWER(name) = LOWER($2)",
		[parseInt(networkId), name.trim()]
	);
	if (existing) {
		returnObj.status = true;
		returnObj.insertId = existing.id;
		returnObj.existing = true;
		return returnObj;
	}

	// If setting as default, clear existing default for this network
	if (isDefault) {
		await postgres.write(
			"UPDATE network_echolists SET is_default = false WHERE network_id = $1 AND is_default = true",
			[parseInt(networkId)]
		);
	}

	var dbObj = {
		network_id: parseInt(networkId),
		name: name.trim(),
		description: (description || '').trim(),
		is_default: isDefault === true || isDefault === 'true',
		active: true,
		created_at: new Date()
	};
	if (arguments.length > 4 && arguments[4]) {
		var opts = arguments[4];
		if (opts.scan_area !== undefined) dbObj.scan_area = opts.scan_area ? opts.scan_area.trim() : null;
	}

	var dbres = await postgres.insertObject(dbObj, 'network_echolists');
	if (dbres.status && dbres.insertId) {
		returnObj.status = true;
		returnObj.insertId = dbres.insertId;
		alogger.writeAlog(5, 'Echolist created: ' + name.trim() + ' (network_id=' + networkId + ')', 'greenbright');
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages || []);
	}
	return returnObj;
}

async function updateEcholist(echolistId, formObj) {
	var returnObj = { status: false, errormessages: [] };
	var dbrow = await getEcholistById(echolistId);
	if (!dbrow) { returnObj.errormessages.push('Echolist not found'); return returnObj; }

	var updateObj = { updated_at: new Date() };
	if (formObj.name !== undefined) updateObj.name = formObj.name.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim();
	if (formObj.active !== undefined) updateObj.active = formObj.active === true || formObj.active === 'true';

	if (formObj.is_default !== undefined) {
		var setDefault = formObj.is_default === true || formObj.is_default === 'true';
		if (setDefault && !dbrow.is_default) {
			await postgres.write(
				"UPDATE network_echolists SET is_default = false WHERE network_id = $1 AND is_default = true",
				[dbrow.network_id]
			);
		}
		updateObj.is_default = setDefault;
	}
	if (formObj.scan_area !== undefined) updateObj.scan_area = formObj.scan_area ? formObj.scan_area.trim() : null;

	var dbres = await postgres.updateById(echolistId, updateObj, 'network_echolists');
	if (dbres.status) {
		returnObj.status = true;
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages || []);
	}
	return returnObj;
}

async function removeEcholist(echolistId) {
	var returnObj = { status: false, errormessages: [] };
	var dbrow = await getEcholistById(echolistId);
	if (!dbrow) { returnObj.errormessages.push('Echolist not found'); return returnObj; }

	// Delete all area entries first
	await postgres.write("DELETE FROM network_echolist_areas WHERE echolist_id = $1", [parseInt(echolistId)]);

	var dbres = await postgres.write("DELETE FROM network_echolists WHERE id = $1", [parseInt(echolistId)]);
	if (dbres === null) {
		returnObj.status = true;
		alogger.writeAlog(5, 'Echolist removed: ' + dbrow.name, 'yellow');
	} else {
		returnObj.errormessages.push(dbres.message || 'Failed to remove echolist');
	}
	return returnObj;
}

async function getEcholistById(id) {
	return await postgres.queryOne("SELECT * FROM network_echolists WHERE id = $1", [parseInt(id)]);
}

async function getEcholistsByNetwork(networkId) {
	return await postgres.query(
		"SELECT el.*, " +
		"(SELECT COUNT(*) FROM network_echolist_areas ea WHERE ea.echolist_id = el.id AND ea.active = true) AS area_count, " +
		"(SELECT COUNT(*) FROM network_echolist_areas ea WHERE ea.echolist_id = el.id AND ea.active = true AND ea.local_area_id IS NOT NULL) AS carried_count " +
		"FROM network_echolists el WHERE el.network_id = $1 ORDER BY el.is_default DESC, el.name ASC",
		[parseInt(networkId)]
	);
}

async function getAllEcholists() {
	return await postgres.query(
		"SELECT el.*, mn.name AS network_name, mn.domain AS network_domain, " +
		"(SELECT COUNT(*) FROM network_echolist_areas ea WHERE ea.echolist_id = el.id AND ea.active = true) AS area_count, " +
		"(SELECT COUNT(*) FROM network_echolist_areas ea WHERE ea.echolist_id = el.id AND ea.active = true AND ea.local_area_id IS NOT NULL) AS carried_count " +
		"FROM network_echolists el " +
		"JOIN message_networks mn ON mn.id = el.network_id " +
		"ORDER BY mn.name ASC, el.is_default DESC, el.name ASC"
	);
}

async function getDefaultEcholist(networkId) {
	return await postgres.queryOne(
		"SELECT * FROM network_echolists WHERE network_id = $1 AND is_default = true",
		[parseInt(networkId)]
	);
}

// ---------------------------------------------------------------------------
// Area CRUD (individual)
// ---------------------------------------------------------------------------

async function getAreaById(areaId) {
	return await postgres.queryOne("SELECT * FROM network_echolist_areas WHERE id = $1", [parseInt(areaId)]);
}

async function addArea(echolistId, areatag, description, tags) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };
	if (!areatag || !areatag.trim()) { returnObj.errormessages.push('Areatag is required'); return returnObj; }

	var dbObj = {
		echolist_id: parseInt(echolistId),
		areatag: areatag.trim(),
		description: (description || '').trim(),
		tags: JSON.stringify(tags || []),
		active: true,
		first_seen: new Date(),
		last_seen: new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'network_echolist_areas');
	if (dbres.status && dbres.insertId) {
		returnObj.status = true;
		returnObj.insertId = dbres.insertId;
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages || []);
	}
	return returnObj;
}

async function updateArea(areaId, formObj) {
	var returnObj = { status: false, errormessages: [] };
	var updateObj = {};

	if (formObj.description !== undefined) updateObj.description = formObj.description.trim();
	if (formObj.tags !== undefined) {
		updateObj.tags = typeof formObj.tags === 'string' ? formObj.tags : JSON.stringify(formObj.tags || []);
	}
	if (formObj.active !== undefined) updateObj.active = formObj.active === true || formObj.active === 'true';
	if (formObj.local_area_id !== undefined) updateObj.local_area_id = formObj.local_area_id ? parseInt(formObj.local_area_id) : null;

	if (Object.keys(updateObj).length === 0) {
		returnObj.status = true;
		return returnObj;
	}

	var dbres = await postgres.updateById(areaId, updateObj, 'network_echolist_areas');
	if (dbres.status) {
		returnObj.status = true;
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages || []);
	}
	return returnObj;
}

async function removeArea(areaId) {
	var dbres = await postgres.write("DELETE FROM network_echolist_areas WHERE id = $1", [parseInt(areaId)]);
	return { status: dbres === null, errormessages: dbres !== null ? [dbres.message || 'Failed to remove area'] : [] };
}

// ---------------------------------------------------------------------------
// Import + Diff
// ---------------------------------------------------------------------------

async function buildImportDiff(echolistId, parsedAreas) {
	// Load existing areas for this echolist
	var existing = await postgres.query(
		"SELECT * FROM network_echolist_areas WHERE echolist_id = $1",
		[parseInt(echolistId)]
	);

	// Build map of existing areas keyed by uppercase areatag
	var existingMap = {};
	for (var row of (existing || [])) {
		existingMap[row.areatag.toUpperCase()] = row;
	}

	var newAreas = [];
	var changedAreas = [];
	var unchangedCount = 0;
	var seen = new Set();

	for (var parsed of parsedAreas) {
		var tag = parsed.areatag.toUpperCase();
		seen.add(tag);

		var match = existingMap[tag];
		if (!match) {
			newAreas.push({ areatag: parsed.areatag, description: parsed.description || '' });
		} else if (!match.active) {
			// Was previously removed, re-adding
			newAreas.push({ areatag: parsed.areatag, description: parsed.description || '', reactivate_id: match.id });
		} else {
			var descChanged = (parsed.description || '').trim() !== (match.description || '').trim();
			if (descChanged) {
				changedAreas.push({
					id: match.id,
					areatag: match.areatag,
					oldDescription: match.description || '',
					newDescription: (parsed.description || '').trim()
				});
			} else {
				unchangedCount++;
			}
		}
	}

	// Areas in DB but not in the incoming file
	var removedAreas = [];
	var localCarriedRemovals = [];
	for (var tag in existingMap) {
		if (!existingMap.hasOwnProperty(tag)) continue;
		if (seen.has(tag)) continue;
		var row = existingMap[tag];
		if (!row.active) continue; // Already inactive, skip
		removedAreas.push({
			id: row.id,
			areatag: row.areatag,
			description: row.description || '',
			local_area_id: row.local_area_id
		});
		if (row.local_area_id) {
			localCarriedRemovals.push({
				id: row.id,
				areatag: row.areatag,
				local_area_id: row.local_area_id
			});
		}
	}

	return {
		newAreas: newAreas,
		changedAreas: changedAreas,
		removedAreas: removedAreas,
		unchangedCount: unchangedCount,
		localCarriedRemovals: localCarriedRemovals
	};
}

async function executeImport(echolistId, diff) {
	var now = new Date();
	var newCount = 0;
	var changedCount = 0;
	var removedCount = 0;

	// Insert new areas
	for (var entry of diff.newAreas) {
		if (entry.reactivate_id) {
			// Reactivate previously removed entry
			await postgres.updateById(entry.reactivate_id, {
				description: entry.description,
				active: true,
				last_seen: now,
				removed_at: null
			}, 'network_echolist_areas');
		} else {
			await postgres.insertObject({
				echolist_id: parseInt(echolistId),
				areatag: entry.areatag,
				description: entry.description,
				tags: '[]',
				active: true,
				first_seen: now,
				last_seen: now
			}, 'network_echolist_areas');
		}
		newCount++;
	}

	// Update changed descriptions
	for (var entry of diff.changedAreas) {
		await postgres.updateById(entry.id, {
			description: entry.newDescription,
			last_seen: now
		}, 'network_echolist_areas');
		changedCount++;
	}

	// Soft-delete removed areas
	for (var entry of diff.removedAreas) {
		await postgres.updateById(entry.id, {
			active: false,
			removed_at: now
		}, 'network_echolist_areas');
		removedCount++;
	}

	// Touch last_seen on unchanged areas
	await postgres.write(
		"UPDATE network_echolist_areas SET last_seen = $1 WHERE echolist_id = $2 AND active = true AND removed_at IS NULL",
		[now, parseInt(echolistId)]
	);

	// Update echolist last_imported_at
	await postgres.updateById(echolistId, { last_imported_at: now }, 'network_echolists');

	// Back-fill local_area_id for echolist entries that match existing network_areas
	// This handles the case where areas were mapped before the echolist was imported
	var echolist = await getEcholistById(echolistId);
	if (echolist) {
		await postgres.write(
			"UPDATE network_echolist_areas nea SET local_area_id = na.area_id " +
			"FROM network_areas na " +
			"WHERE na.network_id = $1 " +
			"AND UPPER(nea.areatag) = UPPER(na.areatag) " +
			"AND nea.echolist_id = $2 " +
			"AND nea.local_area_id IS NULL " +
			"AND nea.active = true",
			[echolist.network_id, parseInt(echolistId)]
		);
	}

	alogger.writeAlog(5,
		'Echolist import: echolist_id=' + echolistId +
		' new=' + newCount + ' changed=' + changedCount +
		' removed=' + removedCount + ' unchanged=' + diff.unchangedCount,
		'greenbright'
	);

	return { newCount: newCount, changedCount: changedCount, removedCount: removedCount, unchangedCount: diff.unchangedCount };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

async function getAreasByEcholist(echolistId, opts) {
	opts = opts || {};
	var conditions = ["ea.echolist_id = $1"];
	var params = [parseInt(echolistId)];
	var paramIdx = 2;

	if (opts.activeOnly !== false) {
		conditions.push("ea.active = true");
	}

	if (opts.search) {
		conditions.push("(ea.areatag ILIKE $" + paramIdx + " OR ea.description ILIKE $" + paramIdx + ")");
		params.push('%' + opts.search + '%');
		paramIdx++;
	}

	if (opts.unsubscribedOnly) {
		conditions.push("ea.local_area_id IS NULL");
	}

	if (opts.subscribedOnly) {
		conditions.push("ea.local_area_id IS NOT NULL");
	}

	var sql = "SELECT ea.* FROM network_echolist_areas ea WHERE " + conditions.join(" AND ") +
		" ORDER BY ea.areatag ASC";

	if (opts.limit) {
		sql += " LIMIT $" + paramIdx;
		params.push(parseInt(opts.limit));
		paramIdx++;
	}
	if (opts.offset) {
		sql += " OFFSET $" + paramIdx;
		params.push(parseInt(opts.offset));
	}

	return await postgres.query(sql, params) || [];
}

async function getEcholistStats(echolistId) {
	var row = await postgres.queryOne(
		"SELECT " +
		"COUNT(*) FILTER (WHERE active = true) AS total_active, " +
		"COUNT(*) FILTER (WHERE active = false) AS total_inactive, " +
		"COUNT(*) FILTER (WHERE active = true AND local_area_id IS NOT NULL) AS locally_carried, " +
		"COUNT(*) FILTER (WHERE active = true AND local_area_id IS NULL) AS available " +
		"FROM network_echolist_areas WHERE echolist_id = $1",
		[parseInt(echolistId)]
	);
	return row || { total_active: 0, total_inactive: 0, locally_carried: 0, available: 0 };
}

async function getAreasAcrossNetwork(networkId) {
	return await postgres.query(
		"SELECT " +
		"UPPER(ea.areatag) AS areatag_upper, " +
		"MIN(ea.areatag) AS areatag, " +
		"MAX(ea.description) AS description, " +
		"MAX(ea.local_area_id) AS local_area_id, " +
		"array_agg(DISTINCT el.name ORDER BY el.name ASC) AS echolist_names " +
		"FROM network_echolist_areas ea " +
		"JOIN network_echolists el ON el.id = ea.echolist_id " +
		"WHERE el.network_id = $1 AND ea.active = true " +
		"GROUP BY UPPER(ea.areatag) " +
		"ORDER BY UPPER(ea.areatag) ASC",
		[parseInt(networkId)]
	) || [];
}

// ---------------------------------------------------------------------------
// local_area_id sync
// ---------------------------------------------------------------------------

// Full reconciliation: set local_area_id where matching network_areas exist,
// clear where they don't. Safe to run repeatedly (idempotent).
async function reconcileLocalAreaIds() {
	// Set local_area_id where a matching network_areas mapping exists
	await postgres.write(
		"UPDATE network_echolist_areas SET local_area_id = na.area_id " +
		"FROM network_areas na, network_echolists nel " +
		"WHERE nel.id = network_echolist_areas.echolist_id " +
		"AND na.network_id = nel.network_id " +
		"AND UPPER(network_echolist_areas.areatag) = UPPER(na.areatag) " +
		"AND network_echolist_areas.active = true " +
		"AND (network_echolist_areas.local_area_id IS NULL OR network_echolist_areas.local_area_id != na.area_id)"
	);

	// Clear local_area_id where no matching network_areas mapping exists
	await postgres.write(
		"UPDATE network_echolist_areas SET local_area_id = NULL " +
		"FROM network_echolists nel " +
		"WHERE nel.id = network_echolist_areas.echolist_id " +
		"AND network_echolist_areas.local_area_id IS NOT NULL " +
		"AND network_echolist_areas.active = true " +
		"AND NOT EXISTS (" +
		"  SELECT 1 FROM network_areas na " +
		"  WHERE na.network_id = nel.network_id " +
		"  AND UPPER(na.areatag) = UPPER(network_echolist_areas.areatag)" +
		")"
	);

	alogger.writeAlog(5, 'Echolist local_area_id reconciliation complete', 'greenbright');
}

async function syncLocalAreaId(networkId, areaId, areatag, action) {
	var echolists = await postgres.query(
		"SELECT id FROM network_echolists WHERE network_id = $1",
		[parseInt(networkId)]
	);
	if (!echolists || echolists.length === 0) return;

	var echolistIds = echolists.map(function(e) { return e.id; });

	if (action === 'add') {
		await postgres.write(
			"UPDATE network_echolist_areas SET local_area_id = $1 " +
			"WHERE UPPER(areatag) = UPPER($2) AND echolist_id = ANY($3)",
			[parseInt(areaId), areatag, echolistIds]
		);
	} else if (action === 'remove') {
		await postgres.write(
			"UPDATE network_echolist_areas SET local_area_id = NULL " +
			"WHERE UPPER(areatag) = UPPER($1) AND echolist_id = ANY($2)",
			[areatag, echolistIds]
		);
	}
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export {
	ensureIndexes,
	createEcholist,
	updateEcholist,
	removeEcholist,
	getEcholistById,
	getEcholistsByNetwork,
	getAllEcholists,
	getDefaultEcholist,
	getAreaById,
	addArea,
	updateArea,
	removeArea,
	buildImportDiff,
	executeImport,
	touchLastImported,
	getAreasByEcholist,
	getEcholistStats,
	getAreasAcrossNetwork,
	reconcileLocalAreaIds,
	syncLocalAreaId
};

// Bump last_imported_at without doing any other writes. Used by the
// auto-scanner when it processes an echolist file successfully but the
// diff comes back empty (no new/changed/removed areas). Without this
// touch, the next scan run would re-parse and re-diff the same file
// indefinitely because _isNewer keeps returning true.
async function touchLastImported(echolistId) {
	await postgres.updateById(echolistId, { last_imported_at: new Date() }, 'network_echolists');
}
