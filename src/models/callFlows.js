// callFlows.js — Call flow and call pool configuration.
//
// DB-backed call flow definitions and pool-to-flow assignments.
// Replaces the hardcoded callFlows and callpools arrays in callmanager.js
// and gateway.js. Falls back to built-in defaults if DB is empty.
//
// Flows are arrays of stage objects: [{ stage: "negotiate" }, { stage: "displayScreen", arg: "type:Welcome" }]
// Pools map a name to a flow and optionally define WebSocket paths.
//
// A flow has a kind (#91). 'terminal' flows are run by CallManager for the
// pools that name them. The one 'web' flow is the web call flow, its stages
// are web blocks (src/webBlocks/catalog.js), and it belongs to no pool. The
// two vocabularies must never mix: CallManager hangs up on a stage it does
// not know, so a web flow reaching a terminal pool would disconnect every
// caller on it. Saves are therefore checked per kind, pools accept only
// terminal flows, and CallManager loads only terminal flows.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { DEFAULT_WEB_FLOW, normaliseWebStages, catalogEntry } from '../webBlocks/catalog.js';
import { missingPages } from './webPages.js';

var FLOW_KINDS = Object.freeze(['terminal', 'web']);

// ---------------------------------------------------------------------------
// Built-in defaults (seeded on first run, used as fallback)
// ---------------------------------------------------------------------------

var DEFAULT_FLOWS = [
	{
		name: 'Standard', title: 'Standard Login',
		description: 'Full BBS login experience with call flow stages',
		is_system: true, kind: 'terminal',
		stages: [
			{ stage: 'negotiate' },
			{ stage: 'logon' },
			{ stage: 'last_callers' },
			{ stage: 'check_online' },
			{ stage: 'announcements' },
			{ stage: 'wall' },
			{ stage: 'verify_mail' },
			{ stage: 'check_email' },
			{ stage: 'check_batch' },
			{ stage: 'menu' },
			{ stage: 'goodbye' }
		]
	},
	{
		name: 'Doorserver', title: 'Door Server',
		description: 'Direct door game launch for dedicated door servers',
		is_system: true, kind: 'terminal',
		stages: [
			{ stage: 'door_auth' },
			{ stage: 'door_launch' },
			{ stage: 'goodbye' }
		]
	},
	{
		name: 'WebDoor', title: 'Web Door',
		description: 'Web-based door game launch via token authentication',
		is_system: true, kind: 'terminal',
		stages: [
			{ stage: 'webdoor_auth' },
			{ stage: 'door_launch' },
			{ stage: 'goodbye' }
		]
	},
	{
		// Seeded by kind, not name: a board may already have a flow of its
		// own called Web (see seedDefaults)
		name: 'Web', title: 'Web Login',
		description: 'Guided web login: what is new since the last visit',
		is_system: true, kind: 'web',
		stages: DEFAULT_WEB_FLOW.map(function (n) { return { stage: n }; })
	}
];

var DEFAULT_POOLS = [
	{
		name: 'PrimaryBBS', flow_name: 'Standard',
		description: 'Main BBS connection pool',
		is_system: true,
		ws_paths: ['/', '/ws/bbs']
	},
	{
		name: 'Doorserver', flow_name: 'Doorserver',
		description: 'Dedicated door server pool',
		is_system: true,
		ws_paths: ['/ws/doorserver']
	},
	{
		name: 'WebDoor', flow_name: 'WebDoor',
		description: 'Web door launcher pool',
		is_system: true,
		ws_paths: ['/ws/webdoor']
	}
];

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

var _flowCache = null;
var _poolCache = null;

function invalidateCache() {
	_flowCache = null;
	_poolCache = null;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

// The web flow is found by kind, so it is seeded when no web flow exists,
// under the first free name: an older board may have made its own "Web".
// Names compare case-insensitively, as getFlowByName and CallManager do.
function firstFreeFlowName(preferred, existingNames) {
	var taken = new Set((existingNames || []).map(function (n) { return String(n).toLowerCase(); }));
	var candidates = [preferred, 'WebLogin'];
	for (var n = 2; n < 100; n++) candidates.push('WebLogin' + n);
	for (var name of candidates) {
		if (!taken.has(name.toLowerCase())) return name;
	}
	return null;
}

async function seedWebFlowName(preferred) {
	var rows = await postgres.query('SELECT name FROM call_flows', []) || [];
	return firstFreeFlowName(preferred, rows.map(function (r) { return r.name; }));
}

async function seedDefaults() {
	var seeded = 0;

	for (var def of DEFAULT_FLOWS) {
		var existing;
		var seedName = def.name;
		if (def.kind === 'web') {
			existing = await postgres.queryOne("SELECT id FROM call_flows WHERE kind = 'web' LIMIT 1", []);
			if (!existing) {
				seedName = await seedWebFlowName(def.name);
				if (!seedName) continue;
			}
		} else {
			existing = await postgres.queryOne(
				'SELECT id FROM call_flows WHERE name = $1', [def.name]
			);
		}
		if (!existing) {
			await postgres.insertObject({
				kind: def.kind || 'terminal',
				name: seedName,
				title: def.title || def.name,
				description: def.description || '',
				stages: JSON.stringify(def.stages),
				is_system: def.is_system || false,
				active: true,
				created_at: new Date()
			}, 'call_flows');
			seeded++;
		}
	}

	for (var def of DEFAULT_POOLS) {
		var existing = await postgres.queryOne(
			'SELECT id FROM call_pools WHERE name = $1', [def.name]
		);
		if (!existing) {
			await postgres.insertObject({
				name: def.name,
				flow_name: def.flow_name,
				ws_paths: JSON.stringify(def.ws_paths),
				description: def.description || '',
				is_system: def.is_system || false,
				active: true,
				created_at: new Date()
			}, 'call_pools');
			seeded++;
		}
	}

	if (seeded > 0) {
		invalidateCache();
		alogger.writeAlog(3, '[callFlows] Seeded ' + seeded + ' default flow/pool record(s)', 'cyan');
	}
}

// ---------------------------------------------------------------------------
// Stage validation, per kind
// ---------------------------------------------------------------------------

// Stages CallManager runs that the admin dropdown does not offer: aliases and
// older names still in its handler registry. A test checks this set plus the
// dropdown against the registry itself.
var TERMINAL_EXTRA_STAGES = Object.freeze(['event_login', 'whos_online']);

function terminalStageNames() {
	var names = new Set(TERMINAL_EXTRA_STAGES);
	for (var s of getAvailableStages()) names.add(s.name);
	return names;
}

/**
 * Check a terminal flow's stages. Returns { stages, errors }; stages keep the
 * shape they were given (a bare name or { stage, arg }).
 */
function normaliseTerminalStages(input) {
	if (!Array.isArray(input)) return { stages: [], errors: ['Stages must be a list'] };
	var known = terminalStageNames();
	var errors = [];
	var stages = [];
	for (var item of input) {
		var name = typeof item === 'string' ? item : (item && typeof item.stage === 'string' ? item.stage : null);
		if (name && known.has(name)) {
			stages.push(item);
		} else if (name && catalogEntry(name)) {
			errors.push(name + ' is a web stage; a terminal flow cannot use it');
		} else {
			errors.push('Not a terminal stage: ' + (name === null ? JSON.stringify(item) : name));
		}
	}
	return { stages: stages, errors: errors };
}

function normaliseStagesFor(kind, input) {
	return kind === 'web' ? normaliseWebStages(input) : normaliseTerminalStages(input);
}

function flowKind(row) {
	return row && row.kind === 'web' ? 'web' : 'terminal';
}

// Stages arrive as a JSON string from a form or an array from the editor.
// undefined means not submitted; a string that is not JSON is an error, not
// an empty flow.
function parseStagesInput(raw) {
	if (raw === undefined) return { value: undefined };
	if (Array.isArray(raw)) return { value: raw };
	if (typeof raw === 'string') {
		if (!raw.trim()) return { value: [] };
		try { return { value: JSON.parse(raw) }; } catch (_) {
			return { error: 'Stages are not valid JSON' };
		}
	}
	return { error: 'Stages must be a list' };
}

// ---------------------------------------------------------------------------
// Flow CRUD
// ---------------------------------------------------------------------------

async function getAllFlows() {
	if (_flowCache) return _flowCache;
	var rows = await postgres.query('SELECT * FROM call_flows ORDER BY is_system DESC, name ASC') || [];
	_flowCache = rows;
	return rows;
}

async function getActiveFlows() {
	var rows = await postgres.query(
		'SELECT * FROM call_flows WHERE active = true ORDER BY is_system DESC, name ASC'
	) || [];
	return rows;
}

async function getFlowByName(name) {
	return await postgres.queryOne(
		'SELECT * FROM call_flows WHERE LOWER(name) = LOWER($1)', [name]
	);
}

async function getFlowById(id) {
	return await postgres.queryOne('SELECT * FROM call_flows WHERE id = $1', [parseInt(id)]);
}

async function createFlow(formObj) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!formObj.name || !formObj.name.trim()) {
		returnObj.errormessages.push('Name is required');
		return returnObj;
	}

	// Slug-safe name
	var name = formObj.name.trim().replace(/[^a-zA-Z0-9_-]/g, '');
	if (!name) {
		returnObj.errormessages.push('Name must contain alphanumeric characters');
		return returnObj;
	}

	var existing = await getFlowByName(name);
	if (existing) {
		returnObj.errormessages.push('A flow with this name already exists');
		return returnObj;
	}

	// New flows are terminal flows: there is one web flow, seeded
	var parsed = parseStagesInput(formObj.stages === undefined ? [] : formObj.stages);
	if (parsed.error) {
		returnObj.errormessages.push(parsed.error);
		return returnObj;
	}
	var checked = normaliseTerminalStages(parsed.value);
	if (checked.errors.length > 0) {
		returnObj.errormessages = checked.errors;
		return returnObj;
	}
	var stages = checked.stages;

	var dbObj = {
		kind: 'terminal',
		name: name,
		title: formObj.title ? formObj.title.trim() : name,
		description: formObj.description ? formObj.description.trim() : null,
		stages: JSON.stringify(stages),
		is_system: false,
		active: formObj.active !== 'false' && formObj.active !== false,
		created_at: new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'call_flows');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	returnObj.insertId = dbres.insertId;
	alogger.writeAlog(5, 'Call flow created: ' + name, 'greenbright');
	return returnObj;
}

async function updateFlow(id, formObj) {
	var returnObj = { status: false, errormessages: [] };

	var existing = await getFlowById(id);
	if (!existing) {
		returnObj.errormessages.push('Flow not found');
		return returnObj;
	}

	var kind = flowKind(existing);
	var updateObj = { updated_at: new Date() };
	if (formObj.title !== undefined) updateObj.title = formObj.title.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description ? formObj.description.trim() : null;
	// The web flow is always on: callflow_enabled is the switch for the web
	// call flow, and two switches for one thing is one too many
	if (formObj.active !== undefined && kind !== 'web') updateObj.active = formObj.active !== 'false' && formObj.active !== false;

	if (formObj.stages !== undefined) {
		var parsed = parseStagesInput(formObj.stages);
		if (parsed.error) {
			returnObj.errormessages.push(parsed.error);
			return returnObj;
		}
		var checked = normaliseStagesFor(kind, parsed.value);
		if (checked.errors.length === 0 && kind === 'web') checked.errors = await missingPages(checked.stages);
		if (checked.errors.length > 0) {
			returnObj.errormessages = checked.errors;
			return returnObj;
		}
		updateObj.stages = JSON.stringify(checked.stages);
	}

	// System flows: name cannot be changed
	if (formObj.name !== undefined && !existing.is_system) {
		var name = formObj.name.trim().replace(/[^a-zA-Z0-9_-]/g, '');
		if (name) updateObj.name = name;
	}

	var count = await postgres.updateById(parseInt(id), updateObj, 'call_flows');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	alogger.writeAlog(5, 'Call flow updated: id=' + id, 'greenbright');
	return returnObj;
}

async function deleteFlow(id) {
	var returnObj = { status: false, errormessages: [] };
	var existing = await getFlowById(id);
	if (!existing) {
		returnObj.errormessages.push('Flow not found');
		return returnObj;
	}
	if (existing.is_system) {
		returnObj.errormessages.push('Cannot delete system flow');
		return returnObj;
	}

	var err = await postgres.write('DELETE FROM call_flows WHERE id = $1', [parseInt(id)]);
	if (err) {
		returnObj.errormessages.push('Delete failed: ' + err.message);
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	alogger.writeAlog(5, 'Call flow deleted: ' + existing.name, 'greenbright');
	return returnObj;
}

// ---------------------------------------------------------------------------
// Pool CRUD
// ---------------------------------------------------------------------------

// Why a pool may not use this flow, or null when it may.
async function poolFlowProblem(flowName) {
	var flow = await getFlowByName(flowName);
	if (!flow) return 'No call flow is called ' + flowName;
	if (flowKind(flow) !== 'terminal') return (flow.title || flow.name) + ' is the web call flow; a pool needs a terminal flow';
	return null;
}

async function getAllPools() {
	if (_poolCache) return _poolCache;
	var rows = await postgres.query('SELECT * FROM call_pools ORDER BY is_system DESC, name ASC') || [];
	_poolCache = rows;
	return rows;
}

async function getActivePools() {
	var rows = await postgres.query(
		'SELECT * FROM call_pools WHERE active = true ORDER BY is_system DESC, name ASC'
	) || [];
	return rows;
}

async function getPoolByName(name) {
	return await postgres.queryOne(
		'SELECT * FROM call_pools WHERE LOWER(name) = LOWER($1)', [name]
	);
}

async function getPoolById(id) {
	return await postgres.queryOne('SELECT * FROM call_pools WHERE id = $1', [parseInt(id)]);
}

async function createPool(formObj) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!formObj.name || !formObj.name.trim()) {
		returnObj.errormessages.push('Name is required');
		return returnObj;
	}
	if (!formObj.flow_name || !formObj.flow_name.trim()) {
		returnObj.errormessages.push('Flow is required');
		return returnObj;
	}

	var name = formObj.name.trim();
	var existing = await getPoolByName(name);
	if (existing) {
		returnObj.errormessages.push('A pool with this name already exists');
		return returnObj;
	}

	var flowProblem = await poolFlowProblem(formObj.flow_name.trim());
	if (flowProblem) {
		returnObj.errormessages.push(flowProblem);
		return returnObj;
	}

	var wsPaths = formObj.ws_paths;
	if (typeof wsPaths === 'string') {
		try { wsPaths = JSON.parse(wsPaths); } catch (_) {
			// Comma-separated fallback
			wsPaths = wsPaths.split(',').map(function(p) { return p.trim(); }).filter(Boolean);
		}
	}
	if (!Array.isArray(wsPaths)) wsPaths = [];

	var dbObj = {
		name: name,
		flow_name: formObj.flow_name.trim(),
		ws_paths: JSON.stringify(wsPaths),
		description: formObj.description ? formObj.description.trim() : null,
		is_system: false,
		active: formObj.active !== 'false' && formObj.active !== false,
		created_at: new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'call_pools');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	returnObj.insertId = dbres.insertId;
	alogger.writeAlog(5, 'Call pool created: ' + name, 'greenbright');
	return returnObj;
}

async function updatePool(id, formObj) {
	var returnObj = { status: false, errormessages: [] };

	var existing = await getPoolById(id);
	if (!existing) {
		returnObj.errormessages.push('Pool not found');
		return returnObj;
	}

	var updateObj = { updated_at: new Date() };
	if (formObj.flow_name !== undefined) {
		var flowProblem = await poolFlowProblem(formObj.flow_name.trim());
		if (flowProblem) {
			returnObj.errormessages.push(flowProblem);
			return returnObj;
		}
		updateObj.flow_name = formObj.flow_name.trim();
	}
	if (formObj.description !== undefined) updateObj.description = formObj.description ? formObj.description.trim() : null;
	if (formObj.active !== undefined) updateObj.active = formObj.active !== 'false' && formObj.active !== false;

	if (formObj.ws_paths !== undefined) {
		var wsPaths = formObj.ws_paths;
		if (typeof wsPaths === 'string') {
			try { wsPaths = JSON.parse(wsPaths); } catch (_) {
				wsPaths = wsPaths.split(',').map(function(p) { return p.trim(); }).filter(Boolean);
			}
		}
		if (Array.isArray(wsPaths)) {
			updateObj.ws_paths = JSON.stringify(wsPaths);
		}
	}

	// System pools: name cannot be changed
	if (formObj.name !== undefined && !existing.is_system) {
		updateObj.name = formObj.name.trim();
	}

	var count = await postgres.updateById(parseInt(id), updateObj, 'call_pools');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	alogger.writeAlog(5, 'Call pool updated: id=' + id, 'greenbright');
	return returnObj;
}

async function deletePool(id) {
	var returnObj = { status: false, errormessages: [] };
	var existing = await getPoolById(id);
	if (!existing) {
		returnObj.errormessages.push('Pool not found');
		return returnObj;
	}
	if (existing.is_system) {
		returnObj.errormessages.push('Cannot delete system pool');
		return returnObj;
	}

	var err = await postgres.write('DELETE FROM call_pools WHERE id = $1', [parseInt(id)]);
	if (err) {
		returnObj.errormessages.push('Delete failed: ' + err.message);
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	alogger.writeAlog(5, 'Call pool deleted: ' + existing.name, 'greenbright');
	return returnObj;
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

/**
 * Get a flow's stages array by name. Returns the parsed JSONB array.
 * Used by callmanager.js at runtime.
 */
async function getFlowStages(flowName) {
	var flow = await getFlowByName(flowName);
	if (!flow) return null;
	// A terminal runtime helper: a web flow's stages mean nothing to CallManager
	if (flowKind(flow) !== 'terminal') return null;

	var stages = flow.stages;
	if (typeof stages === 'string') {
		try { stages = JSON.parse(stages); } catch (_) { stages = []; }
	}
	return Array.isArray(stages) ? stages : [];
}

/**
 * The web call flow's row, or null when there is none (the seed failed).
 *
 * Read from the database every time, not through the flow cache: that cache
 * lives for the whole process and is cleared only by writes made in the same
 * process, so an edit made anywhere else went unseen until a restart. A
 * one-row query a few times per login costs nothing.
 */
async function getWebFlow() {
	return await postgres.queryOne(
		"SELECT * FROM call_flows WHERE kind = 'web' ORDER BY is_system DESC, id ASC LIMIT 1", []
	);
}

/** The web call flow's stages, or null when there is no web flow. */
async function getWebFlowStages() {
	var flow = await getWebFlow();
	if (!flow) return null;
	var stages = flow.stages;
	if (typeof stages === 'string') {
		try { stages = JSON.parse(stages); } catch (_) { stages = []; }
	}
	return Array.isArray(stages) ? stages : [];
}

/**
 * Get available stage names for the admin UI dropdown.
 * These are the handler registry keys from callmanager.js.
 */
function getAvailableStages() {
	return [
		{ name: 'negotiate',      label: 'Terminal Negotiation',   system: true },
		{ name: 'logon',          label: 'Login/Registration',     system: true },
		{ name: 'login',          label: 'Login Only',             system: false },
		{ name: 'last_callers',   label: 'Last Callers',           system: false },
		{ name: 'check_online',   label: 'Who\'s Online Check',    system: false },
		{ name: 'announcements',  label: 'Announcements',          system: false },
		{ name: 'wall',           label: 'The Wall',               system: false },
		{ name: 'verify_mail',    label: 'Verify Mail Address',    system: false },
		{ name: 'check_email',    label: 'Check Private Mail',     system: false },
		{ name: 'check_batch',    label: 'Check Download Batch',   system: false },
		{ name: 'sysinfo',        label: 'System Info',            system: false },
		{ name: 'bulletins',      label: 'Bulletins',              system: false },
		{ name: 'menu',           label: 'Main Menu',              system: true },
		{ name: 'goodbye',        label: 'Goodbye (Disconnect)',   system: true },
		{ name: 'door_auth',      label: 'Door Authentication',    system: true },
		{ name: 'webdoor_auth',   label: 'Web Door Authentication', system: true },
		{ name: 'door_launch',    label: 'Door Launch',            system: true },
		{ name: 'displayScreen',  label: 'Display Screen',         system: false, needsArg: true, argLabel: 'type:Welcome or subdir/filename' },
	];
}

// Built-in defaults for fallback
function getDefaultFlows() { return DEFAULT_FLOWS; }
function getDefaultPools() { return DEFAULT_POOLS; }

export {
	seedDefaults,
	invalidateCache,
	getAllFlows,
	getActiveFlows,
	getFlowByName,
	getFlowById,
	createFlow,
	updateFlow,
	deleteFlow,
	getAllPools,
	getActivePools,
	getPoolByName,
	getPoolById,
	createPool,
	updatePool,
	deletePool,
	getFlowStages,
	getWebFlow,
	getWebFlowStages,
	getAvailableStages,
	normaliseTerminalStages,
	normaliseStagesFor,
	poolFlowProblem,
	firstFreeFlowName,
	FLOW_KINDS,
	TERMINAL_EXTRA_STAGES,
	getDefaultFlows,
	getDefaultPools
};
