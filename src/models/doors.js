// src/models/doors.js
// PostgreSQL-backed door game configuration management.
// Replaces the hardcoded testingarray with database queries.

import * as postgres from '../middleware/db/postgres.js';

// Valid launch types — keep in sync with doorrunner.js LAUNCH_TYPES
const VALID_LAUNCH_TYPES = [
	'NativeShell',
	'ExecNative',
	'SpawnNative',
	'Dosemu',
	'DosemuPty',
	'SyncJSDoor',
];

const VALID_DROPFILE_TYPES = [
	'doorsys',
	'dorinfo',
	'chain',
	'callinfo',
	'pcboard',
	'',
];

// --- Door CRUD ---

async function getDoorConfig(slugname) {
	var door = await postgres.queryOne(
		'SELECT * FROM doors WHERE slug = $1',
		[slugname]
	);
	if (!door) return null;

	// Normalize DB column names to the camelCase keys the DoorRunner expects
	return normalizeDoorConfig(door);
}

async function getAllDoors() {
	var doors = await postgres.query(
		'SELECT * FROM doors ORDER BY sort_order ASC, name ASC'
	);
	return doors || [];
}

async function getDoorById(id) {
	return await postgres.queryOne('SELECT * FROM doors WHERE id = $1', [id]);
}

async function createDoor(data) {
	var result = { status: false, errormessages: [], doorId: null };

	var slug = (data.slug || '').trim().toLowerCase();
	if (!slug) {
		result.errormessages.push('Slug is required');
		return result;
	}
	if (!/^[a-z0-9_-]+$/.test(slug)) {
		result.errormessages.push('Slug must contain only lowercase letters, numbers, hyphens, and underscores');
		return result;
	}

	var name = (data.name || '').trim();
	if (!name) {
		result.errormessages.push('Name is required');
		return result;
	}

	var launchType = (data.launch_type || 'NativeShell').trim();
	if (!VALID_LAUNCH_TYPES.includes(launchType)) {
		result.errormessages.push('Invalid launch type: ' + launchType);
		return result;
	}

	// Check slug uniqueness
	var existing = await postgres.queryOne('SELECT id FROM doors WHERE slug = $1', [slug]);
	if (existing) {
		result.errormessages.push('A door with that slug already exists');
		return result;
	}

	// Parse door_args
	var doorArgs = null;
	if (data.door_args) {
		if (typeof data.door_args === 'string') {
			try { doorArgs = JSON.parse(data.door_args); } catch (_) {
				// Treat as a single arg if not valid JSON
				doorArgs = data.door_args.split(/\s+/).filter(Boolean);
			}
		} else {
			doorArgs = data.door_args;
		}
	}

	var obj = {
		slug: slug,
		name: name,
		cmd: (data.cmd || '').trim() || null,
		door_script: (data.door_script || '').trim() || null,
		door_dir: (data.door_dir || '').trim() || null,
		door_args: doorArgs ? JSON.stringify(doorArgs) : null,
		launch_type: launchType,
		dropfile_type: (data.dropfile_type || '').trim() || null,
		dropfile_dir: (data.dropfile_dir || '').trim() || null,
		db_subdir: (data.db_subdir || '').trim() || null,
		usereal_local: data.usereal_local === 'true' || data.usereal_local === true,
		usereal_doorsession: data.usereal_doorsession === 'true' || data.usereal_doorsession === true,
		pause_on_exit: data.pause_on_exit !== 'false' && data.pause_on_exit !== false,
		fixed_size: data.fixed_size === 'true' || data.fixed_size === true,
		max_nodes: parseInt(data.max_nodes) || 0,
		active: data.active !== 'false' && data.active !== false,
		sort_order: parseInt(data.sort_order) || 0,
		description: (data.description || '').trim() || null,
		created_at: new Date(),
		updated_at: new Date()
	};

	var insertResult = await postgres.insertObject(obj, 'doors');
	if (insertResult.status) {
		result.status = true;
		result.doorId = insertResult.insertId;
	} else {
		result.errormessages.push('Database insert failed');
	}
	return result;
}

async function updateDoor(id, data) {
	var result = { status: false, errormessages: [] };

	var launchType = (data.launch_type || '').trim();
	if (launchType && !VALID_LAUNCH_TYPES.includes(launchType)) {
		result.errormessages.push('Invalid launch type: ' + launchType);
		return result;
	}

	// If slug is changing, check uniqueness
	if (data.slug) {
		var slug = data.slug.trim().toLowerCase();
		if (!/^[a-z0-9_-]+$/.test(slug)) {
			result.errormessages.push('Slug must contain only lowercase letters, numbers, hyphens, and underscores');
			return result;
		}
		var existing = await postgres.queryOne('SELECT id FROM doors WHERE slug = $1 AND id != $2', [slug, id]);
		if (existing) {
			result.errormessages.push('A door with that slug already exists');
			return result;
		}
	}

	// Parse door_args
	var doorArgs = null;
	if (data.door_args !== undefined) {
		if (typeof data.door_args === 'string' && data.door_args.trim()) {
			try { doorArgs = JSON.parse(data.door_args); } catch (_) {
				doorArgs = data.door_args.split(/\s+/).filter(Boolean);
			}
		} else if (Array.isArray(data.door_args)) {
			doorArgs = data.door_args;
		}
	}

	var obj = {
		name: (data.name || '').trim(),
		cmd: (data.cmd || '').trim() || null,
		door_script: (data.door_script || '').trim() || null,
		door_dir: (data.door_dir || '').trim() || null,
		door_args: doorArgs ? JSON.stringify(doorArgs) : null,
		launch_type: launchType || 'NativeShell',
		dropfile_type: (data.dropfile_type || '').trim() || null,
		dropfile_dir: (data.dropfile_dir || '').trim() || null,
		db_subdir: (data.db_subdir || '').trim() || null,
		usereal_local: data.usereal_local === 'true' || data.usereal_local === true,
		usereal_doorsession: data.usereal_doorsession === 'true' || data.usereal_doorsession === true,
		pause_on_exit: data.pause_on_exit !== 'false' && data.pause_on_exit !== false,
		fixed_size: data.fixed_size === 'true' || data.fixed_size === true,
		max_nodes: parseInt(data.max_nodes) || 0,
		active: data.active !== 'false' && data.active !== false,
		sort_order: parseInt(data.sort_order) || 0,
		description: (data.description || '').trim() || null,
		updated_at: new Date()
	};

	if (data.slug) {
		obj.slug = data.slug.trim().toLowerCase();
	}

	await postgres.updateById(id, obj, 'doors');
	result.status = true;
	return result;
}

async function deleteDoor(id) {
	await postgres.write('DELETE FROM doors WHERE id = $1', [id]);
	return { status: true };
}

// --- Helpers ---

// Normalize a DB row to the camelCase config shape expected by DoorRunner/SyncJSDoorRunner
function normalizeDoorConfig(row) {
	if (!row) return null;
	var config = {
		slug: row.slug,
		name: row.name,
		cmd: row.cmd || undefined,
		doorScript: row.door_script || undefined,
		doorDir: row.door_dir || undefined,
		doorArgs: row.door_args || undefined,
		launchType: row.launch_type || 'NativeShell',
		dropfileType: row.dropfile_type || undefined,
		dropfileDir: row.dropfile_dir || undefined,
		dbSubdir: row.db_subdir || undefined,
		usereal_local: row.usereal_local || false,
		usereal_doorsession: row.usereal_doorsession || false,
		pauseOnExit: row.pause_on_exit !== undefined ? row.pause_on_exit : true,
		fixedSize: row.fixed_size || false,
		maxnodes: row.max_nodes || 0,
		active: row.active !== undefined ? row.active : true,
	};

	// Parse JSONB door_args if it came back as string
	if (typeof config.doorArgs === 'string') {
		try { config.doorArgs = JSON.parse(config.doorArgs); } catch (_) { config.doorArgs = undefined; }
	}

	return config;
}

function getValidLaunchTypes() {
	return VALID_LAUNCH_TYPES;
}

function getValidDropfileTypes() {
	return VALID_DROPFILE_TYPES;
}

export {
	getDoorConfig,
	getAllDoors,
	getDoorById,
	createDoor,
	updateDoor,
	deleteDoor,
	getValidLaunchTypes,
	getValidDropfileTypes
};
