// src/models/fileWildcards.js — Inbound file wildcard routing rules.
//
// Sysop-configurable rules that match inbound filenames against glob
// patterns and route them to specific directories instead of ftn/in/.
// Rules are cached in memory and invalidated via CONFIG_CHANGED event.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// --- In-memory cache ---

var _cachedRules = null;
var _cacheLoaded = false;

async function _loadCache() {
	_cachedRules = await getActive();
	_cacheLoaded = true;
}

function invalidateCache() {
	_cachedRules = null;
	_cacheLoaded = false;
}

// --- Glob matching ---

/**
 * Match a filename against a glob pattern (case-insensitive).
 * Supports * (any characters) and ? (single character).
 */
function _globMatch(pattern, filename) {
	// Convert glob to regex: escape special chars, then convert * and ?
	var escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	escaped = escaped.replace(/\*/g, '.*');
	escaped = escaped.replace(/\?/g, '.');
	var regex = new RegExp('^' + escaped + '$', 'i');
	return regex.test(filename);
}

/**
 * Test a filename against the cached rule set.
 * Returns the first matching rule or null.
 *
 * @param {string} filename — inbound filename (basename only)
 * @param {Array}  [rules]  — optional pre-loaded rules (otherwise uses cache)
 * @returns {object|null} matching rule row or null
 */
async function matchFilename(filename, rules) {
	if (!filename) return null;

	var ruleSet = rules;
	if (!ruleSet) {
		if (!_cacheLoaded) await _loadCache();
		ruleSet = _cachedRules;
	}

	if (!ruleSet || ruleSet.length === 0) return null;

	for (var rule of ruleSet) {
		if (_globMatch(rule.pattern, filename)) {
			return rule;
		}
	}
	return null;
}

// --- CRUD ---

async function getAll() {
	var rows = await postgres.query(
		'SELECT * FROM file_wildcards ORDER BY sort_order ASC, id ASC'
	);
	return rows || [];
}

async function getActive() {
	var rows = await postgres.query(
		'SELECT * FROM file_wildcards WHERE active = true ORDER BY sort_order ASC, id ASC'
	);
	return rows || [];
}

async function getById(id) {
	return await postgres.queryOne(
		'SELECT * FROM file_wildcards WHERE id = $1',
		[parseInt(id)]
	);
}

async function create(data) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!data.pattern || !data.pattern.trim()) {
		returnObj.errormessages.push('Pattern is required');
		return returnObj;
	}
	if (!data.target_dir || !data.target_dir.trim()) {
		returnObj.errormessages.push('Target directory is required');
		return returnObj;
	}

	// Get next sort_order
	var maxRow = await postgres.queryOne('SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM file_wildcards');
	var nextSort = (maxRow ? maxRow.max_sort : 0) + 1;

	var dbObj = {
		pattern:     data.pattern.trim(),
		target_dir:  data.target_dir.trim(),
		description: data.description ? data.description.trim() : null,
		still_toss:  data.still_toss === true || data.still_toss === 'true',
		sort_order:  data.sort_order !== undefined ? parseInt(data.sort_order) : nextSort,
		active:      data.active !== false && data.active !== 'false',
		created_at:  new Date(),
		updated_at:  null
	};

	var dbres = await postgres.insertObject(dbObj, 'file_wildcards');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	returnObj.insertId = dbres.insertId;
	alogger.writeAlog(5, 'File wildcard created: ' + dbObj.pattern + ' -> ' + dbObj.target_dir, 'greenbright');
	return returnObj;
}

async function update(id, data) {
	var returnObj = { status: false, errormessages: [] };

	var existing = await getById(id);
	if (!existing) {
		returnObj.errormessages.push('Wildcard rule not found');
		return returnObj;
	}

	var updateObj = {};
	if (data.pattern !== undefined)     updateObj.pattern     = data.pattern.trim();
	if (data.target_dir !== undefined)  updateObj.target_dir  = data.target_dir.trim();
	if (data.description !== undefined) updateObj.description = data.description ? data.description.trim() : null;
	if (data.still_toss !== undefined)  updateObj.still_toss  = data.still_toss === true || data.still_toss === 'true';
	if (data.sort_order !== undefined)  updateObj.sort_order  = parseInt(data.sort_order);
	if (data.active !== undefined)      updateObj.active      = data.active !== false && data.active !== 'false';
	updateObj.updated_at = new Date();

	var count = await postgres.updateById(parseInt(id), updateObj, 'file_wildcards');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	alogger.writeAlog(5, 'File wildcard updated: id=' + id, 'greenbright');
	return returnObj;
}

async function remove(id) {
	var returnObj = { status: false, errormessages: [] };

	var err = await postgres.write('DELETE FROM file_wildcards WHERE id = $1', [parseInt(id)]);
	if (err) {
		returnObj.errormessages.push('Delete failed: ' + err.message);
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	alogger.writeAlog(5, 'File wildcard removed: id=' + id, 'greenbright');
	return returnObj;
}

async function reorder(ids) {
	if (!Array.isArray(ids)) return;
	for (var i = 0; i < ids.length; i++) {
		await postgres.write(
			'UPDATE file_wildcards SET sort_order = $1 WHERE id = $2',
			[i, parseInt(ids[i])]
		);
	}
	invalidateCache();
}

export {
	getAll,
	getActive,
	getById,
	create,
	update,
	remove,
	reorder,
	matchFilename,
	invalidateCache,
	_globMatch
};
