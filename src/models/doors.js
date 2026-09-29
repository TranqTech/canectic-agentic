// src/models/doors.js
// PostgreSQL-backed door game configuration management.
// Replaces the hardcoded testingarray with database queries.

import * as postgres from '../middleware/db/postgres.js';
import { isDoorOffered } from './doorCollections.js';

// Valid launch types — keep in sync with doorrunner.js LAUNCH_TYPES
const VALID_LAUNCH_TYPES = [
	'NativeShell',
	'NativeCommand',
	'Dosemu',
	'DosemuPty',
	'SyncJSDoor',
	'Remote',
];

// Legacy DB values that map to current types
const LEGACY_LAUNCH_TYPES = {
	'ExecNative':  'NativeCommand',
	'SpawnNative': 'NativeCommand',
};

// Display labels for admin UI dropdowns
const LAUNCH_TYPE_LABELS = {
	'NativeShell':    'Native (PTY)',
	'NativeCommand':  'Native Commands',
	'Dosemu':         'Dosemu (Console Only)',
	'DosemuPty':      'Dosemu (Full)',
	'SyncJSDoor':     'SyncJS Door',
	'Remote':         'Remote (another system)',
};

const VALID_DROPFILE_TYPES = [
	'doorsys',
	'door32',
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
	var config = normalizeDoorConfig(door);
	// Offered to the door server through a collection (#89), never per door
	config.doorserverAvailable = await isDoorOffered(door.id);
	return config;
}

async function getAllDoors() {
	var doors = await postgres.query(
		'SELECT * FROM doors ORDER BY sort_order ASC, name ASC'
	);
	// Normalize legacy launch types
	if (doors) {
		for (var i = 0; i < doors.length; i++) {
			if (LEGACY_LAUNCH_TYPES[doors[i].launch_type]) {
				doors[i].launch_type = LEGACY_LAUNCH_TYPES[doors[i].launch_type];
			}
		}
	}
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
	launchType = LEGACY_LAUNCH_TYPES[launchType] || launchType;
	if (!VALID_LAUNCH_TYPES.includes(launchType)) {
		result.errormessages.push('Invalid launch type: ' + launchType);
		return result;
	}
	if (launchType === 'Remote' && !String(data.remote_provider || '').trim()) {
		result.errormessages.push('A remote door needs a provider');
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
		remote_provider: String(data.remote_provider || '').trim().toLowerCase() || null,
		remote_door: String(data.remote_door || '').trim().slice(0, 64) || null,
		usereal_local: data.usereal_local === 'true' || data.usereal_local === true,
		usereal_doorsession: data.usereal_doorsession === 'true' || data.usereal_doorsession === true,
		pause_on_exit: data.pause_on_exit !== 'false' && data.pause_on_exit !== false,
		fixed_size: data.fixed_size === 'true' || data.fixed_size === true,
		max_nodes: parseInt(data.max_nodes) || 0,
		active: data.active !== 'false' && data.active !== false,
		sort_order: parseInt(data.sort_order) || 0,
		description: (data.description || '').trim() || null,
		long_desc: (data.long_desc || '').trim() || null,
		long_desc_html: (data.long_desc_html || '').trim() || null,
		icon_url: (data.icon_url || '').trim() || null,
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
	launchType = LEGACY_LAUNCH_TYPES[launchType] || launchType;
	if (launchType && !VALID_LAUNCH_TYPES.includes(launchType)) {
		result.errormessages.push('Invalid launch type: ' + launchType);
		return result;
	}
	if (launchType === 'Remote' && !String(data.remote_provider || '').trim()) {
		result.errormessages.push('A remote door needs a provider');
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
		remote_provider: String(data.remote_provider || '').trim().toLowerCase() || null,
		remote_door: String(data.remote_door || '').trim().slice(0, 64) || null,
		usereal_local: data.usereal_local === 'true' || data.usereal_local === true,
		usereal_doorsession: data.usereal_doorsession === 'true' || data.usereal_doorsession === true,
		pause_on_exit: data.pause_on_exit !== 'false' && data.pause_on_exit !== false,
		fixed_size: data.fixed_size === 'true' || data.fixed_size === true,
		max_nodes: parseInt(data.max_nodes) || 0,
		active: data.active !== 'false' && data.active !== false,
		sort_order: parseInt(data.sort_order) || 0,
		description: (data.description || '').trim() || null,
		long_desc: (data.long_desc || '').trim() || null,
		long_desc_html: (data.long_desc_html || '').trim() || null,
		icon_url: (data.icon_url || '').trim() || null,
		updated_at: new Date()
	};

	if (data.slug) {
		obj.slug = data.slug.trim().toLowerCase();
	}

	await postgres.updateById(id, obj, 'doors');
	result.status = true;
	return result;
}

// Its collection entries go first: they reference the door, so deleting a
// door in any collection used to fail on the foreign key while this still
// reported success, and the admin Delete button silently did nothing.
async function deleteDoor(id) {
	var err = await postgres.write('DELETE FROM door_collection_entries WHERE door_id = $1', [id]);
	if (!err) err = await postgres.write('DELETE FROM doors WHERE id = $1', [id]);
	return err ? { status: false, errormessages: ['Could not delete the door: ' + err.message] } : { status: true, errormessages: [] };
}

/** Switch a door on or off. */
async function setDoorActive(id, active) {
	var err = await postgres.write('UPDATE doors SET active = $2, updated_at = NOW() WHERE id = $1', [id, !!active]);
	return { status: !err };
}

// Duplicate an existing door. Generates a unique slug (`<slug>-copy`,
// `<slug>-copy-2`, ...) and a "(Copy)" / "(Copy 2)" name. The copy is
// created inactive so the sysop can review settings before exposing it.
// All other fields (cmd, dirs, args, launch type, dropfile config, real
// flags, sort order, descriptions, icon) carry over verbatim.
async function duplicateDoor(id) {
	var result = { status: false, errormessages: [], doorId: null };

	var src = await getDoorById(id);
	if (!src) {
		result.errormessages.push('Source door not found');
		return result;
	}

	var newSlug = await _findUniqueSlug(src.slug);
	var newName = await _suggestCopyName(src.name);

	var obj = {
		slug:                newSlug,
		name:                newName,
		cmd:                 src.cmd || null,
		door_script:         src.door_script || null,
		door_dir:            src.door_dir || null,
		door_args:           src.door_args ? JSON.stringify(src.door_args) : null,
		launch_type:         src.launch_type,
		dropfile_type:       src.dropfile_type || null,
		dropfile_dir:        src.dropfile_dir || null,
		db_subdir:           src.db_subdir || null,
		remote_provider:     src.remote_provider || null,
		remote_door:         src.remote_door || null,
		usereal_local:       !!src.usereal_local,
		usereal_doorsession: !!src.usereal_doorsession,
		pause_on_exit:       src.pause_on_exit !== false,
		fixed_size:          !!src.fixed_size,
		max_nodes:           parseInt(src.max_nodes) || 0,
		active:              false, // Copy starts inactive — sysop reviews then enables
		sort_order:          parseInt(src.sort_order) || 0,
		description:         src.description || null,
		long_desc:           src.long_desc || null,
		long_desc_html:      src.long_desc_html || null,
		icon_url:            src.icon_url || null,
		created_at:          new Date(),
		updated_at:          new Date()
	};

	var ins = await postgres.insertObject(obj, 'doors');
	if (!ins.status) {
		result.errormessages.push('Database insert failed');
		return result;
	}

	result.status = true;
	result.doorId = ins.insertId;
	result.slug = newSlug;
	result.name = newName;
	return result;
}

// Pick the next free slug derived from base, scanning -copy, -copy-2, ...
async function _findUniqueSlug(baseSlug) {
	// Strip an existing -copy / -copy-N suffix so duplicates of a copy
	// don't accumulate -copy-copy-copy.
	var stripped = baseSlug.replace(/-copy(-\d+)?$/, '');
	var candidate = stripped + '-copy';
	var n = 1;
	while (await postgres.queryOne('SELECT id FROM doors WHERE slug = $1', [candidate])) {
		n += 1;
		candidate = stripped + '-copy-' + n;
		if (n > 999) break; // sanity
	}
	return candidate;
}

// Suggest a "(Copy)" / "(Copy 2)" suffix on the name, scanning upward
// until unused. Returns the original name + suffix; doesn't validate
// uniqueness in the DB (the slug check covers that).
async function _suggestCopyName(baseName) {
	var stripped = baseName.replace(/\s*\(Copy(?:\s+\d+)?\)\s*$/, '');
	var candidate = stripped + ' (Copy)';
	var existing = await postgres.queryOne('SELECT id FROM doors WHERE name = $1', [candidate]);
	if (!existing) return candidate;
	var n = 2;
	while (true) {
		candidate = stripped + ' (Copy ' + n + ')';
		var hit = await postgres.queryOne('SELECT id FROM doors WHERE name = $1', [candidate]);
		if (!hit) return candidate;
		n += 1;
		if (n > 999) return stripped + ' (Copy ' + Date.now() + ')';
	}
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
		launchType: LEGACY_LAUNCH_TYPES[row.launch_type] || row.launch_type || 'NativeShell',
		dropfileType: row.dropfile_type || undefined,
		dropfileDir: row.dropfile_dir || undefined,
		dbSubdir: row.db_subdir || undefined,
		remoteProvider: row.remote_provider || undefined,
		remoteDoor: row.remote_door || undefined,
		usereal_local: row.usereal_local || false,
		usereal_doorsession: row.usereal_doorsession || false,
		pauseOnExit: row.pause_on_exit !== undefined ? row.pause_on_exit : true,
		fixedSize: row.fixed_size || false,
		maxnodes: row.max_nodes || 0,
		active: row.active !== undefined ? row.active : true,
		// Set by getDoorConfig from the door's collections (#89)
		doorserverAvailable: false,
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

function getLaunchTypeLabels() {
	return LAUNCH_TYPE_LABELS;
}

const DROPFILE_TYPE_LABELS = {
	'doorsys':  'DOOR.SYS',
	'door32':   'DOOR32.SYS',
	'dorinfo':  'DORINFO.DEF',
	'chain':    'CHAIN.TXT',
	'callinfo': 'CALLINFO.BBS',
	'pcboard':  'PCBOARD.SYS',
};

function getValidDropfileTypes() {
	return VALID_DROPFILE_TYPES;
}

function getDropfileTypeLabels() {
	return DROPFILE_TYPE_LABELS;
}

/**
 * Whether a call is a remote BBS's caller on our door server. Set only by the
 * door_auth stage. NOT call.doorsession, which a web Play session sets too
 * (#89): checking that refused every door not offered to the door server
 * to this board's own users playing on the web, in 0.9.13a.
 */
function isDoorServerCall(call) {
	return !!(call && call.doorserver_session === true);
}

/**
 * Whether a call may launch a door (#86).
 *
 * A door-server session (a remote BBS's caller, isDoorServerCall) may launch
 * only a door the sysop has made available to the door server. Checked in
 * CallManager.launchDoor, the one place every launch passes through, because
 * the door is named by the remote client and nothing upstream can be trusted
 * to have filtered it. Local callers are unaffected: their door access is
 * decided by the menu entry that offers the door.
 *
 * returns { ok: boolean, reason?: string }
 */
function mayLaunchDoor(call, doorConfig) {
	if (!doorConfig) return { ok: false, reason: 'no such door' };
	if (isDoorServerCall(call) && !doorConfig.doorserverAvailable) {
		return { ok: false, reason: 'not available to door-server callers' };
	}
	return { ok: true };
}

// --- Remote doors (#89) ---

/** The slug a remote door gets unless the sysop gives one: provider-code. */
function remoteDoorSlug(provider, code) {
	var base = (String(provider || '') + '-' + String(code || 'menu')).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
	return base.slice(0, 64);
}

/**
 * Create a door entry for a door on another system. input: provider (name),
 * code (the door's code there; blank = the provider's own menu), name, slug?,
 * description?. Created active; not in any collection.
 */
async function createRemoteDoor(input) {
	var provider = String(input.provider || '').trim().toLowerCase();
	var code = String(input.code || '').trim().slice(0, 64);
	var name = String(input.name || '').trim() || code || 'Door menu';
	var slug = String(input.slug || '').trim().toLowerCase() || remoteDoorSlug(provider, code);
	return await createDoor({
		slug: slug, name: name, launch_type: 'Remote', remote_provider: provider, remote_door: code,
		description: input.description || '', active: 'true', pause_on_exit: 'false'
	});
}

/** Door entries that run on a provider, by provider name. */
async function getRemoteDoors(provider) {
	return (await postgres.query(
		"SELECT * FROM doors WHERE launch_type = 'Remote' AND remote_provider = $1 ORDER BY name ASC",
		[String(provider || '').toLowerCase()])) || [];
}

export {
	remoteDoorSlug,
	createRemoteDoor,
	setDoorActive,
	getRemoteDoors,
	getDoorConfig,
	getAllDoors,
	getDoorById,
	createDoor,
	updateDoor,
	deleteDoor,
	duplicateDoor,
	getValidLaunchTypes,
	getLaunchTypeLabels,
	getValidDropfileTypes,
	getDropfileTypeLabels,
	mayLaunchDoor,
	isDoorServerCall
};
