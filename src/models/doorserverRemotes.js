// doorserverRemotes.js -- other Canectic door servers this board sends its
// callers to (#86, phase D).
//
// The secret is this board's own credential for the remote server and has to
// be sent, so it is stored as given (unlike doorserver_systems, where the
// secrets are other boards' and only a hash is kept). The admin page never
// shows it back, only whether one is set.

import { v4 as uuidv4 } from 'uuid';
import * as postgres from '../middleware/db/postgres.js';
import { normaliseSystemId } from './doorserver.js';

var TABLE = 'doorserver_remotes';

/**
 * Cleaned fields and every problem. opts.creating requires a name and a
 * secret; on an update a blank secret means keep the current one.
 */
function validateRemote(input, opts) {
	var o = opts || {};
	var i = input || {};
	var errors = [];
	var values = {};
	var text = function (v, max) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max); };
	if (o.creating) {
		values.name = text(i.name, 32).toLowerCase();
		if (!/^[a-z0-9_-]{1,32}$/.test(values.name)) errors.push('Name must be 1 to 32 of a-z, 0-9, _ or - (it is what menu entries use)');
	}
	values.title = text(i.title, 128) || values.name || '';
	values.url = text(i.url, 512);
	if (!/^wss?:\/\/[^\s]+$/i.test(values.url)) errors.push('Address must start with ws:// or wss://');
	values.system_id = normaliseSystemId(i.system_id);
	if (!values.system_id) errors.push('System ID must be 2 to 12 letters, digits, _ or -');
	var secret = text(i.secret, 256);
	if (secret) values.secret = secret;
	else if (o.creating) errors.push('Secret is required');
	values.active = !(i.active === 'false' || i.active === false);
	values.notes = text(i.notes, 2000);
	return { values: values, errors: errors };
}

/** "name" or "name:door" from a menu entry's argument. */
function parseRemoteArg(arg) {
	var s = String(arg || '').trim();
	var idx = s.indexOf(':');
	var name = (idx === -1 ? s : s.slice(0, idx)).trim().toLowerCase();
	var door = idx === -1 ? '' : s.slice(idx + 1).trim();
	return { name: name, door: door };
}

async function getAll() {
	return await postgres.query('SELECT * FROM ' + TABLE + ' ORDER BY title, name') || [];
}

async function getByName(name) {
	return await postgres.queryOne('SELECT * FROM ' + TABLE + ' WHERE name = $1', [String(name || '').toLowerCase()]);
}

async function getByUuid(uuid) {
	return await postgres.queryOne('SELECT * FROM ' + TABLE + ' WHERE uuid = $1', [uuid]);
}

async function createRemote(input) {
	var check = validateRemote(input, { creating: true });
	if (check.errors.length) return { status: false, errors: check.errors };
	if (await getByName(check.values.name)) return { status: false, errors: ['A remote door server named ' + check.values.name + ' already exists'] };
	var row = Object.assign({ uuid: uuidv4(), created_at: new Date() }, check.values);
	var res = await postgres.insertObject(row, TABLE);
	return res.status ? { status: true, errors: [], remote: await getByUuid(row.uuid) } : { status: false, errors: res.errormessages || ['Could not save'] };
}

async function updateRemote(uuid, input) {
	var check = validateRemote(input, {});
	if (check.errors.length) return { status: false, errors: check.errors };
	var upd = Object.assign({}, check.values, { updated_at: new Date() });
	var sets = [], params = [];
	for (var k of Object.keys(upd)) { params.push(upd[k]); sets.push(k + ' = $' + params.length); }
	params.push(uuid);
	var err = await postgres.write('UPDATE ' + TABLE + ' SET ' + sets.join(', ') + ' WHERE uuid = $' + params.length, params);
	return err ? { status: false, errors: [err.message] } : { status: true, errors: [] };
}

async function deleteRemote(uuid) {
	return !(await postgres.write('DELETE FROM ' + TABLE + ' WHERE uuid = $1', [uuid]));
}

async function touch(uuid) {
	await postgres.write('UPDATE ' + TABLE + ' SET last_used = NOW() WHERE uuid = $1', [uuid]);
}

export { validateRemote, parseRemoteArg, getAll, getByName, getByUuid, createRemote, updateRemote, deleteRemote, touch };
