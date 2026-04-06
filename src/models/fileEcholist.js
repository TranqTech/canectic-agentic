// fileEcholist.js — File echolist (filebone) registry model.
//
// Maintains a registry of file echo areas available on each network,
// imported from filebone files (FILEBONE.NA, etc.). Multiple filebones
// per network are supported, with one flagged as default.
//
// Identical structure to networkEcholist.js but operates on
// file_echolists / file_echolist_areas tables and links to file_areas.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

async function ensureIndexes() {
	await postgres.write(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_file_echolist_areas_tag ON file_echolist_areas(echolist_id, UPPER(areatag))"
	);
	await postgres.write(
		"CREATE INDEX IF NOT EXISTS idx_file_echolist_areas_active ON file_echolist_areas(echolist_id, active)"
	);
	await postgres.write(
		"CREATE INDEX IF NOT EXISTS idx_file_echolist_areas_local ON file_echolist_areas(local_area_id) WHERE local_area_id IS NOT NULL"
	);
}

// ---------------------------------------------------------------------------
// Filebone CRUD
// ---------------------------------------------------------------------------

async function createEcholist(networkId, name, description, isDefault) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!networkId) { returnObj.errormessages.push('Network ID is required'); return returnObj; }
	if (!name || !name.trim()) { returnObj.errormessages.push('Name is required'); return returnObj; }

	if (isDefault) {
		await postgres.write(
			"UPDATE file_echolists SET is_default = false WHERE network_id = $1 AND is_default = true",
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

	var dbres = await postgres.insertObject(dbObj, 'file_echolists');
	if (dbres.status && dbres.insertId) {
		returnObj.status = true;
		returnObj.insertId = dbres.insertId;
		alogger.writeAlog(5, 'Filebone created: ' + name.trim() + ' (network_id=' + networkId + ')', 'greenbright');
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages || []);
	}
	return returnObj;
}

async function updateEcholist(echolistId, formObj) {
	var returnObj = { status: false, errormessages: [] };
	var dbrow = await getEcholistById(echolistId);
	if (!dbrow) { returnObj.errormessages.push('Filebone not found'); return returnObj; }

	var updateObj = { updated_at: new Date() };
	if (formObj.name !== undefined) updateObj.name = formObj.name.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim();
	if (formObj.active !== undefined) updateObj.active = formObj.active === true || formObj.active === 'true';

	if (formObj.is_default !== undefined) {
		var setDefault = formObj.is_default === true || formObj.is_default === 'true';
		if (setDefault && !dbrow.is_default) {
			await postgres.write(
				"UPDATE file_echolists SET is_default = false WHERE network_id = $1 AND is_default = true",
				[dbrow.network_id]
			);
		}
		updateObj.is_default = setDefault;
	}

	var dbres = await postgres.updateById(echolistId, updateObj, 'file_echolists');
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
	if (!dbrow) { returnObj.errormessages.push('Filebone not found'); return returnObj; }

	await postgres.write("DELETE FROM file_echolist_areas WHERE echolist_id = $1", [parseInt(echolistId)]);

	var dbres = await postgres.write("DELETE FROM file_echolists WHERE id = $1", [parseInt(echolistId)]);
	if (dbres === null) {
		returnObj.status = true;
		alogger.writeAlog(5, 'Filebone removed: ' + dbrow.name, 'yellow');
	} else {
		returnObj.errormessages.push(dbres.message || 'Failed to remove filebone');
	}
	return returnObj;
}

async function getEcholistById(id) {
	return await postgres.queryOne("SELECT * FROM file_echolists WHERE id = $1", [parseInt(id)]);
}

async function getEcholistsByNetwork(networkId) {
	return await postgres.query(
		"SELECT el.*, " +
		"(SELECT COUNT(*) FROM file_echolist_areas ea WHERE ea.echolist_id = el.id AND ea.active = true) AS area_count, " +
		"(SELECT COUNT(*) FROM file_echolist_areas ea WHERE ea.echolist_id = el.id AND ea.active = true AND ea.local_area_id IS NOT NULL) AS carried_count " +
		"FROM file_echolists el WHERE el.network_id = $1 ORDER BY el.is_default DESC, el.name ASC",
		[parseInt(networkId)]
	);
}

async function getAllEcholists() {
	return await postgres.query(
		"SELECT el.*, mn.name AS network_name, mn.domain AS network_domain, " +
		"(SELECT COUNT(*) FROM file_echolist_areas ea WHERE ea.echolist_id = el.id AND ea.active = true) AS area_count, " +
		"(SELECT COUNT(*) FROM file_echolist_areas ea WHERE ea.echolist_id = el.id AND ea.active = true AND ea.local_area_id IS NOT NULL) AS carried_count " +
		"FROM file_echolists el " +
		"JOIN message_networks mn ON mn.id = el.network_id " +
		"ORDER BY mn.name ASC, el.is_default DESC, el.name ASC"
	);
}

async function getDefaultEcholist(networkId) {
	return await postgres.queryOne(
		"SELECT * FROM file_echolists WHERE network_id = $1 AND is_default = true",
		[parseInt(networkId)]
	);
}

// ---------------------------------------------------------------------------
// Area CRUD (individual)
// ---------------------------------------------------------------------------

async function getAreaById(areaId) {
	return await postgres.queryOne("SELECT * FROM file_echolist_areas WHERE id = $1", [parseInt(areaId)]);
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

	var dbres = await postgres.insertObject(dbObj, 'file_echolist_areas');
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

	var dbres = await postgres.updateById(areaId, updateObj, 'file_echolist_areas');
	if (dbres.status) {
		returnObj.status = true;
	} else {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages || []);
	}
	return returnObj;
}

async function removeArea(areaId) {
	var dbres = await postgres.write("DELETE FROM file_echolist_areas WHERE id = $1", [parseInt(areaId)]);
	return { status: dbres === null, errormessages: dbres !== null ? [dbres.message || 'Failed to remove area'] : [] };
}

// ---------------------------------------------------------------------------
// Import + Diff
// ---------------------------------------------------------------------------

async function buildImportDiff(echolistId, parsedAreas) {
	var existing = await postgres.query(
		"SELECT * FROM file_echolist_areas WHERE echolist_id = $1",
		[parseInt(echolistId)]
	);

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

	var removedAreas = [];
	var localCarriedRemovals = [];
	for (var tag in existingMap) {
		if (!existingMap.hasOwnProperty(tag)) continue;
		if (seen.has(tag)) continue;
		var row = existingMap[tag];
		if (!row.active) continue;
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

	for (var entry of diff.newAreas) {
		if (entry.reactivate_id) {
			await postgres.updateById(entry.reactivate_id, {
				description: entry.description,
				active: true,
				last_seen: now,
				removed_at: null
			}, 'file_echolist_areas');
		} else {
			await postgres.insertObject({
				echolist_id: parseInt(echolistId),
				areatag: entry.areatag,
				description: entry.description,
				tags: '[]',
				active: true,
				first_seen: now,
				last_seen: now
			}, 'file_echolist_areas');
		}
		newCount++;
	}

	for (var entry of diff.changedAreas) {
		await postgres.updateById(entry.id, {
			description: entry.newDescription,
			last_seen: now
		}, 'file_echolist_areas');
		changedCount++;
	}

	for (var entry of diff.removedAreas) {
		await postgres.updateById(entry.id, {
			active: false,
			removed_at: now
		}, 'file_echolist_areas');
		removedCount++;
	}

	await postgres.write(
		"UPDATE file_echolist_areas SET last_seen = $1 WHERE echolist_id = $2 AND active = true AND removed_at IS NULL",
		[now, parseInt(echolistId)]
	);

	await postgres.updateById(echolistId, { last_imported_at: now }, 'file_echolists');

	alogger.writeAlog(5,
		'Filebone import: echolist_id=' + echolistId +
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

	var sql = "SELECT ea.* FROM file_echolist_areas ea WHERE " + conditions.join(" AND ") +
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
		"FROM file_echolist_areas WHERE echolist_id = $1",
		[parseInt(echolistId)]
	);
	return row || { total_active: 0, total_inactive: 0, locally_carried: 0, available: 0 };
}

// ---------------------------------------------------------------------------
// local_area_id sync
// ---------------------------------------------------------------------------

async function syncLocalAreaId(networkId, areaId, areatag, action) {
	var echolists = await postgres.query(
		"SELECT id FROM file_echolists WHERE network_id = $1",
		[parseInt(networkId)]
	);
	if (!echolists || echolists.length === 0) return;

	var echolistIds = echolists.map(function(e) { return e.id; });

	if (action === 'add') {
		await postgres.write(
			"UPDATE file_echolist_areas SET local_area_id = $1 " +
			"WHERE UPPER(areatag) = UPPER($2) AND echolist_id = ANY($3)",
			[parseInt(areaId), areatag, echolistIds]
		);
	} else if (action === 'remove') {
		await postgres.write(
			"UPDATE file_echolist_areas SET local_area_id = NULL " +
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
	getAreasByEcholist,
	getEcholistStats,
	syncLocalAreaId
};
