// src/models/netmailRoutes.js -- Custom routing rules for inbound FTN netmail.
//
// Sysop-configurable rules that match inbound netmail (by to_user + optional
// from_user / from_addr filters) and apply one of three actions:
//   - alias:  rewrite to_user so the message falls through to the existing
//             user/processor dispatch (e.g. "BRE-MAIL" -> "sysop", or
//             "areamanager" -> "areafix")
//   - dump:   write the netmail as JSON to a target directory for an
//             external handler to pick up, and consume the message
//   - ignore: silently drop the netmail (no PM delivery, no undeliverable
//             queue, no response). File attachments are NOT touched -- they
//             remain in the inbound dir for wildcards / TIC / etc to handle.
//
// Rules are evaluated in sort_order ascending, first-match-wins, via an
// in-memory cache invalidated on CRUD.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Convert a glob pattern to a case-insensitive RegExp anchored start-to-end.
// Supports * (any characters) and ? (single character). All other regex
// metacharacters are escaped.
function _globToRegex(pattern) {
	var escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	escaped = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp('^' + escaped + '$', 'i');
}

// Match a single pattern (exact or glob, case-insensitive) against a value.
// Empty pattern matches any value (used for optional filter fields).
function _patternMatch(matchType, pattern, value) {
	if (!pattern) return true;
	var v = value || '';
	if (matchType === 'glob') {
		return _globToRegex(pattern).test(v);
	}
	// Default: exact (case-insensitive)
	return pattern.toLowerCase() === v.toLowerCase();
}

// Test whether a rule matches the given inbound netmail metadata.
// fields: { to_user, from_user, from_addr }
function _ruleMatches(rule, fields) {
	if (!_patternMatch(rule.match_type, rule.match_to_user, fields.to_user)) return false;
	if (rule.match_from_user && !_patternMatch(rule.match_type, rule.match_from_user, fields.from_user)) return false;
	if (rule.match_from_addr && !_patternMatch(rule.match_type, rule.match_from_addr, fields.from_addr)) return false;
	return true;
}

// Public: find the first matching active rule. Returns the rule row or null.
// Caller (ftnNetmailAdapter) uses the rule's action + target to decide what
// to do with the message.
//
// fields: { to_user, from_user, from_addr }
// options.rules: optional pre-loaded rule array (bypasses cache, used by tests)
async function matchRoute(fields, options) {
	if (!fields) return null;
	var opts = options || {};

	var ruleSet = opts.rules;
	if (!ruleSet) {
		if (!_cacheLoaded) await _loadCache();
		ruleSet = _cachedRules;
	}

	if (!ruleSet || ruleSet.length === 0) return null;

	for (var rule of ruleSet) {
		if (_ruleMatches(rule, fields)) return rule;
	}
	return null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getAll() {
	var rows = await postgres.query(
		'SELECT * FROM netmail_routes ORDER BY sort_order ASC, id ASC'
	);
	return rows || [];
}

async function getActive() {
	var rows = await postgres.query(
		'SELECT * FROM netmail_routes WHERE active = true ORDER BY sort_order ASC, id ASC'
	);
	return rows || [];
}

async function getById(id) {
	return await postgres.queryOne(
		'SELECT * FROM netmail_routes WHERE id = $1',
		[parseInt(id)]
	);
}

var VALID_ACTIONS = ['alias', 'dump', 'ignore'];
var VALID_MATCH_TYPES = ['exact', 'glob'];

function _validate(data, isUpdate) {
	var errs = [];

	if (!isUpdate || data.match_to_user !== undefined) {
		if (!data.match_to_user || !String(data.match_to_user).trim()) {
			errs.push('Match to_user pattern is required');
		}
	}

	if (!isUpdate || data.action !== undefined) {
		if (!VALID_ACTIONS.includes(data.action)) {
			errs.push('Action must be one of: ' + VALID_ACTIONS.join(', '));
		}
	}

	if (data.match_type !== undefined && !VALID_MATCH_TYPES.includes(data.match_type)) {
		errs.push('Match type must be one of: ' + VALID_MATCH_TYPES.join(', '));
	}

	// Alias and dump require a target; ignore does not.
	if (data.action === 'alias' || data.action === 'dump') {
		if (!data.target || !String(data.target).trim()) {
			errs.push(data.action === 'alias'
				? 'Alias target (new to_user) is required'
				: 'Dump target (directory) is required');
		}
	}

	return errs;
}

async function create(data) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	var errs = _validate(data, false);
	if (errs.length > 0) {
		returnObj.errormessages = errs;
		return returnObj;
	}

	var maxRow = await postgres.queryOne('SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM netmail_routes');
	var nextSort = (maxRow ? maxRow.max_sort : 0) + 1;

	var dbObj = {
		name:             (data.name || '').trim() || 'Unnamed route',
		match_type:       data.match_type || 'exact',
		match_to_user:    String(data.match_to_user).trim(),
		match_from_user:  data.match_from_user ? String(data.match_from_user).trim() : null,
		match_from_addr:  data.match_from_addr ? String(data.match_from_addr).trim() : null,
		action:           data.action,
		target:           data.target ? String(data.target).trim() : null,
		log_level:        data.log_level !== undefined ? parseInt(data.log_level) || 0 : 0,
		sort_order:       data.sort_order !== undefined ? parseInt(data.sort_order) : nextSort,
		active:           data.active !== false && data.active !== 'false',
		created_at:       new Date(),
		updated_at:       null
	};

	var dbres = await postgres.insertObject(dbObj, 'netmail_routes');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages || ['Insert failed']);
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	returnObj.insertId = dbres.insertId;
	alogger.writeAlog(5, 'Netmail route created: ' + dbObj.name + ' (' + dbObj.action + ')', 'greenbright');
	return returnObj;
}

async function update(id, data) {
	var returnObj = { status: false, errormessages: [] };

	var existing = await getById(id);
	if (!existing) {
		returnObj.errormessages.push('Route not found');
		return returnObj;
	}

	// Merge for validation so action/target interdependencies check properly
	var merged = Object.assign({}, existing, data);
	var errs = _validate(merged, true);
	if (errs.length > 0) {
		returnObj.errormessages = errs;
		return returnObj;
	}

	var updateObj = {};
	if (data.name !== undefined)            updateObj.name            = (data.name || '').trim() || 'Unnamed route';
	if (data.match_type !== undefined)      updateObj.match_type      = data.match_type;
	if (data.match_to_user !== undefined)   updateObj.match_to_user   = String(data.match_to_user).trim();
	if (data.match_from_user !== undefined) updateObj.match_from_user = data.match_from_user ? String(data.match_from_user).trim() : null;
	if (data.match_from_addr !== undefined) updateObj.match_from_addr = data.match_from_addr ? String(data.match_from_addr).trim() : null;
	if (data.action !== undefined)          updateObj.action          = data.action;
	if (data.target !== undefined)          updateObj.target          = data.target ? String(data.target).trim() : null;
	if (data.log_level !== undefined)       updateObj.log_level       = parseInt(data.log_level) || 0;
	if (data.sort_order !== undefined)      updateObj.sort_order      = parseInt(data.sort_order);
	if (data.active !== undefined)          updateObj.active          = data.active !== false && data.active !== 'false';
	updateObj.updated_at = new Date();

	var count = await postgres.updateById(parseInt(id), updateObj, 'netmail_routes');
	if (count === 0) {
		returnObj.errormessages.push('No rows updated');
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	alogger.writeAlog(5, 'Netmail route updated: id=' + id, 'greenbright');
	return returnObj;
}

async function remove(id) {
	var returnObj = { status: false, errormessages: [] };

	var err = await postgres.write('DELETE FROM netmail_routes WHERE id = $1', [parseInt(id)]);
	if (err) {
		returnObj.errormessages.push('Delete failed: ' + err.message);
		return returnObj;
	}

	invalidateCache();
	returnObj.status = true;
	alogger.writeAlog(5, 'Netmail route removed: id=' + id, 'greenbright');
	return returnObj;
}

async function reorder(ids) {
	if (!Array.isArray(ids)) return;
	for (var i = 0; i < ids.length; i++) {
		await postgres.write(
			'UPDATE netmail_routes SET sort_order = $1 WHERE id = $2',
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
	matchRoute,
	invalidateCache,
	// Internals exported for tests
	_globToRegex,
	_patternMatch,
	_ruleMatches,
	VALID_ACTIONS,
	VALID_MATCH_TYPES
};
