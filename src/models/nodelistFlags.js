// nodelistFlags.js — Managed FTN nodelist flag definitions.
//
// Provides the list of known flags for the coordinator node editor,
// with descriptions, argument metadata, and sort ordering.
// Seeded from config/default/nodelist-flags.json on first run.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { readFileSync } from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function getAll() {
	return await postgres.query(
		'SELECT * FROM nodelist_flag_definitions ORDER BY sort_order ASC, code ASC'
	) || [];
}

async function getActive() {
	return await postgres.query(
		'SELECT * FROM nodelist_flag_definitions WHERE active = true ORDER BY sort_order ASC, code ASC'
	) || [];
}

async function getById(id) {
	return await postgres.queryOne(
		'SELECT * FROM nodelist_flag_definitions WHERE id = $1',
		[parseInt(id)]
	);
}

async function getByCode(code) {
	return await postgres.queryOne(
		'SELECT * FROM nodelist_flag_definitions WHERE UPPER(code) = UPPER($1)',
		[code.trim()]
	);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function create(formObj) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	var code = (formObj.code || '').trim().toUpperCase();
	if (!code) returnObj.errormessages.push('Flag code is required');
	if (code && code.length > 16) returnObj.errormessages.push('Flag code must be 16 characters or fewer');
	if (returnObj.errormessages.length > 0) return returnObj;

	// Check for duplicate
	var existing = await getByCode(code);
	if (existing) {
		returnObj.errormessages.push('Flag "' + code + '" already exists');
		return returnObj;
	}

	var dbObj = {
		code:           code,
		description:    (formObj.description || '').trim(),
		has_argument:   formObj.has_argument === 'true' || formObj.has_argument === true,
		argument_hint:  (formObj.argument_hint || '').trim() || null,
		sort_order:     parseInt(formObj.sort_order) || 0,
		active:         formObj.active !== 'false' && formObj.active !== false,
		created_at:     new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'nodelist_flag_definitions');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	returnObj.status = true;
	returnObj.insertId = dbres.insertId;
	alogger.writeAlog(5, 'Nodelist flag defined: ' + code, 'greenbright');
	return returnObj;
}

async function update(id, formObj) {
	var returnObj = { status: false, errormessages: [] };
	var existing = await getById(id);
	if (!existing) { returnObj.errormessages.push('Flag not found'); return returnObj; }

	var updateObj = { updated_at: new Date() };

	if (formObj.code !== undefined) {
		var code = formObj.code.trim().toUpperCase();
		if (!code) { returnObj.errormessages.push('Flag code is required'); return returnObj; }
		// Check duplicate if code changed
		if (code !== existing.code) {
			var dupe = await getByCode(code);
			if (dupe) { returnObj.errormessages.push('Flag "' + code + '" already exists'); return returnObj; }
		}
		updateObj.code = code;
	}
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim();
	if (formObj.has_argument !== undefined) updateObj.has_argument = formObj.has_argument === 'true' || formObj.has_argument === true;
	if (formObj.argument_hint !== undefined) updateObj.argument_hint = formObj.argument_hint.trim() || null;
	if (formObj.sort_order !== undefined) updateObj.sort_order = parseInt(formObj.sort_order) || 0;
	if (formObj.active !== undefined) updateObj.active = formObj.active !== 'false' && formObj.active !== false;

	var count = await postgres.updateById(parseInt(id), updateObj, 'nodelist_flag_definitions');
	if (count === 0) { returnObj.errormessages.push('No rows updated'); return returnObj; }

	returnObj.status = true;
	return returnObj;
}

async function remove(id) {
	var returnObj = { status: false, errormessages: [] };
	var err = await postgres.write('DELETE FROM nodelist_flag_definitions WHERE id = $1', [parseInt(id)]);
	if (err) { returnObj.errormessages.push('Delete failed: ' + err.message); return returnObj; }
	returnObj.status = true;
	return returnObj;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seedDefaults() {
	var existing = await postgres.query('SELECT id FROM nodelist_flag_definitions LIMIT 1');
	if (existing && existing.length > 0) return;

	var jsonPath = path.join(path.dirname('./'), 'config', 'default', 'nodelist-flags.json');
	try {
		var flags = JSON.parse(readFileSync(jsonPath, 'utf8'));
		for (var flag of flags) {
			await postgres.insertObject({
				code:          flag.code,
				description:   flag.description || '',
				has_argument:  flag.has_argument || false,
				argument_hint: flag.argument_hint || null,
				sort_order:    flag.sort_order || 0,
				active:        true,
				created_at:    new Date()
			}, 'nodelist_flag_definitions');
		}
		alogger.writeAlog(2, 'Seeded ' + flags.length + ' nodelist flag definitions', 'greenbright');
	} catch (err) {
		alogger.writeAlog(3, 'Failed to seed nodelist flags: ' + err.message, 'yellow');
	}
}

export {
	getAll,
	getActive,
	getById,
	getByCode,
	create,
	update,
	remove,
	seedDefaults
};
