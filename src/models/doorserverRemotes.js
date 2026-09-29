// doorserverRemotes.js -- door providers: other systems this board sends its
// callers to (#86 phase D, kinds #89).
//
// Kinds:
//   canectic  another Canectic door server (WebSocket; url, system_id, secret)
//   rlogin    an RLogin door server, optionally through an SSH tunnel
//             (DoorParty; Synchronet game servers). settings: host, port,
//             ssh, ssh_host, ssh_port, ssh_user, username_template, tag,
//             password_mode (per_user | fixed), terminal_template,
//             menu_terminal, keep_first_name; secrets: ssh_password, password
//   bbslink   BBSLink (HTTP token exchange, then telnet). settings:
//             system_code, host, http_base, telnet_port; secrets: auth_code,
//             scheme_code
//
// Secrets are this board's own credentials and have to be sent, so they are
// stored as given (unlike doorserver_systems, where the secrets are other
// boards' and only a hash is kept). The admin page never shows one back, only
// whether it is set, and a blank one on an update keeps what is stored.

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import * as postgres from '../middleware/db/postgres.js';
import { normaliseSystemId } from './doorserver.js';

var TABLE = 'doorserver_remotes';

var KINDS = ['canectic', 'rlogin', 'bbslink'];
var KIND_LABELS = { canectic: 'Canectic door server', rlogin: 'RLogin door server', bbslink: 'BBSLink' };

var RLOGIN_DEFAULTS = {
	host: '', port: 513, ssh: false, ssh_host: '', ssh_port: 22, ssh_user: '',
	username_template: '{alias}', tag: '', password_mode: 'per_user',
	terminal_template: '{door}', menu_terminal: 'ansi', keep_first_name: false
};
var BBSLINK_DEFAULTS = { system_code: '', host: 'games.bbslink.net', http_base: 'http://games.bbslink.net', telnet_port: 23 };

// Filled into the form by the preset buttons; nothing is saved from here.
var PRESETS = {
	doorparty: {
		label: 'DoorParty', kind: 'rlogin',
		settings: { host: 'dp.throwbackbbs.com', port: 513, ssh: true, ssh_host: 'dp.throwbackbbs.com', ssh_port: 2022,
			username_template: '[{tag}]{alias}', password_mode: 'per_user', terminal_template: '{door}', menu_terminal: 'ansi' },
		note: 'Apply on Throwback BBS (telnet bbs.throwbackbbs.com) for a system tag and the SSH username and password.'
	},
	synchronet: {
		label: 'Synchronet game server', kind: 'rlogin',
		settings: { port: 513, ssh: false, username_template: '{alias}', password_mode: 'per_user', terminal_template: 'xtrn={door}', menu_terminal: 'ansi' },
		note: 'A Synchronet board that lets other systems in over RLogin; door codes are its external program codes.'
	},
	bbslink: {
		label: 'BBSLink', kind: 'bbslink',
		settings: { host: 'games.bbslink.net', http_base: 'http://games.bbslink.net', telnet_port: 23 },
		note: 'Apply at bbslink.net for a system code, authorisation code and scheme code. The door code menu lists every game.'
	}
};

function text(v, max) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max); }
function checked(v) { return v === true || v === 'true' || v === 'on' || v === '1'; }
function port(v, fallback) { var n = parseInt(v); return n >= 1 && n <= 65535 ? n : fallback; }
function hostname(v) { var h = text(v, 255); return /^[A-Za-z0-9.-]+$/.test(h) ? h : ''; }

function settingsOf(row) {
	var s = row && row.settings;
	if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = null; } }
	return Object.assign({}, row && row.kind === 'bbslink' ? BBSLINK_DEFAULTS : row && row.kind === 'rlogin' ? RLOGIN_DEFAULTS : {}, s || {});
}

function secretsOf(row) {
	var s = row && row.secrets;
	if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = null; } }
	return s || {};
}

/**
 * Cleaned fields and every problem. opts.creating requires a name and the
 * kind's secrets; on an update a blank secret keeps what `current` holds.
 * Form fields: kind, title, active, notes, min_security; canectic: url,
 * system_id, secret; rlogin: rl_*; bbslink: bl_*.
 */
function validateRemote(input, opts, current) {
	var o = opts || {};
	var i = input || {};
	var errors = [];
	var values = {};
	var kind = o.creating ? text(i.kind || 'canectic', 16).toLowerCase() : ((current && current.kind) || 'canectic');
	if (KINDS.indexOf(kind) === -1) { errors.push('Unknown kind of door provider: ' + kind); kind = 'canectic'; }
	if (o.creating) {
		values.name = text(i.name, 32).toLowerCase();
		if (!/^[a-z0-9_-]{1,32}$/.test(values.name)) errors.push('Name must be 1 to 32 of a-z, 0-9, _ or - (it is what menu entries and remote doors use)');
		values.kind = kind;
	}
	values.title = text(i.title, 128) || values.name || (current && current.name) || '';
	values.active = o.creating ? !(i.active === 'false' || i.active === false) : checked(i.active);
	values.notes = text(i.notes, 2000);
	var ms = text(i.min_security, 5);
	values.min_security = ms === '' ? null : (parseInt(ms) >= 0 ? parseInt(ms) : null);
	if (ms !== '' && values.min_security === null) errors.push('Minimum security must be a number, or blank for the verified level');

	var keep = secretsOf(current);
	var secrets = {};
	var secret = function (field, key, label, required) {
		var v = text(i[field], 256);
		if (v) secrets[key] = v;
		else if (keep[key]) secrets[key] = keep[key];
		else if (required) errors.push(label + ' is required');
	};

	if (kind === 'canectic') {
		values.url = text(i.url, 512);
		if (!/^wss?:\/\/[^\s]+$/i.test(values.url)) errors.push('Address must start with ws:// or wss://');
		values.system_id = normaliseSystemId(i.system_id);
		if (!values.system_id) errors.push('System ID must be 2 to 12 letters, digits, _ or -');
		var sec = text(i.secret, 256);
		if (sec) values.secret = sec;
		else if (o.creating) errors.push('Secret is required');
	} else if (kind === 'rlogin') {
		var st = {
			host: hostname(i.rl_host), port: port(i.rl_port, 513),
			ssh: checked(i.rl_ssh), ssh_host: hostname(i.rl_ssh_host), ssh_port: port(i.rl_ssh_port, 22), ssh_user: text(i.rl_ssh_user, 64),
			username_template: text(i.rl_username_template, 64) || '{alias}', tag: text(i.rl_tag, 16).replace(/[\[\]]/g, ''),
			password_mode: i.rl_password_mode === 'fixed' ? 'fixed' : 'per_user',
			terminal_template: text(i.rl_terminal_template, 64) || '{door}', menu_terminal: text(i.rl_menu_terminal, 32) || 'ansi',
			keep_first_name: checked(i.rl_keep_first_name)
		};
		if (!st.host) errors.push('RLogin host is required (a host name or address)');
		if (st.username_template.indexOf('{alias}') === -1) errors.push('The username template must contain {alias}');
		if (st.username_template.indexOf('{tag}') !== -1 && !st.tag) errors.push('The username template uses {tag}, so the system tag is required');
		if (st.terminal_template.indexOf('{door}') === -1) errors.push('The terminal template must contain {door}');
		if (st.ssh) {
			if (!st.ssh_host) st.ssh_host = st.host;
			if (!st.ssh_user) errors.push('SSH username is required when connecting through SSH');
			secret('rl_ssh_password', 'ssh_password', 'SSH password', true);
		}
		if (st.password_mode === 'fixed') secret('rl_password', 'password', 'RLogin password', true);
		values.settings = JSON.stringify(st);
		values.url = 'rlogin://' + st.host + ':' + st.port;
	} else if (kind === 'bbslink') {
		var bl = {
			system_code: text(i.bl_system_code, 32), host: hostname(i.bl_host) || BBSLINK_DEFAULTS.host,
			http_base: text(i.bl_http_base, 255).replace(/\/+$/, '') || BBSLINK_DEFAULTS.http_base, telnet_port: port(i.bl_telnet_port, 23)
		};
		if (!/^[A-Za-z0-9_-]{1,32}$/.test(bl.system_code)) errors.push('BBSLink system code is required');
		if (!/^https?:\/\/[^\s]+$/i.test(bl.http_base)) errors.push('BBSLink web address must start with http:// or https://');
		secret('bl_auth_code', 'auth_code', 'Authorisation code', true);
		secret('bl_scheme_code', 'scheme_code', 'Scheme code', true);
		values.settings = JSON.stringify(bl);
		values.url = 'telnet://' + bl.host + ':' + bl.telnet_port;
	}
	if (kind !== 'canectic') values.secrets = JSON.stringify(secrets);
	return { values: values, errors: errors };
}

/** The lowest security a caller needs to use this provider's doors. */
function minSecurityFor(remote, cfg) {
	if (remote && remote.min_security !== null && remote.min_security !== undefined) return parseInt(remote.min_security) || 0;
	return cfg.getNumber('verified_security', 60);
}

/**
 * Whether a local caller may use a door on this provider: a logged-in user
 * (never a guest or a caller who never logged in) at the provider's minimum
 * security, and never a door-server session passing a caller on.
 * returns { ok, reason }
 */
function mayUseRemote(call, remote, cfg) {
	if (call && call.doorserver_session === true) return { ok: false, reason: 'Doors on other systems are not available through the door server.' };
	var ur = call && call.user_record;
	if (!ur || !ur.id) return { ok: false, reason: 'You need to be logged in to use doors on other systems.' };
	var need = minSecurityFor(remote, cfg);
	var have = parseInt(ur.security) || 0;
	if (have < need) return { ok: false, reason: 'Doors on ' + ((remote && (remote.title || remote.name)) || 'that system') + ' need security ' + need + '.' };
	return { ok: true, reason: '' };
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
	var current = await getByUuid(uuid);
	if (!current) return { status: false, errors: ['No such door provider'] };
	var check = validateRemote(input, {}, current);
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

// --- Caller identities on an RLogin provider ---
//
// DoorParty (and a Synchronet game server) creates the player's account on
// first connect and ties it to the password sent, so each caller gets one,
// made here once and never changed: a changed password loses the account.
// The name sent is the caller's current name, or with keep_first_name the
// one they first used. Rows are per (provider, user); there is no composite
// UNIQUE in the schema, so the oldest row always wins.

var IDENTITY_TABLE = 'door_remote_identities';

function newPassword() {
	var alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	var bytes = crypto.randomBytes(12), out = '';
	for (var b of bytes) out += alphabet[b % alphabet.length];
	return out;
}

/** A name safe to put in an RLogin field: no NUL or other control characters. */
function rloginName(name) {
	return String(name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40) || 'Guest';
}

/**
 * The name and password to send for this caller. user: { id, name }.
 * returns { name, password, created }
 */
async function identityFor(remote, user) {
	var settings = settingsOf(remote);
	var current = rloginName(user.name);
	var row = await postgres.queryOne(
		'SELECT * FROM ' + IDENTITY_TABLE + ' WHERE remote_id = $1 AND user_id = $2 ORDER BY id ASC LIMIT 1', [remote.id, user.id]);
	var created = false;
	if (!row) {
		var res = await postgres.insertObject({ remote_id: remote.id, user_id: user.id, remote_name: current, password: newPassword(), created_at: new Date() }, IDENTITY_TABLE);
		if (!res.status) throw new Error('could not record the caller\'s identity for ' + remote.name);
		row = await postgres.queryOne(
			'SELECT * FROM ' + IDENTITY_TABLE + ' WHERE remote_id = $1 AND user_id = $2 ORDER BY id ASC LIMIT 1', [remote.id, user.id]);
		created = true;
	}
	await postgres.write('UPDATE ' + IDENTITY_TABLE + ' SET last_used = NOW() WHERE id = $1', [row.id]);
	var fixed = settings.password_mode === 'fixed' ? secretsOf(remote).password : null;
	return { name: settings.keep_first_name ? rloginName(row.remote_name) : current, password: fixed || row.password, created: created };
}

/** Record (or clear, with null) the SSH host key fingerprint seen for a provider. */
async function setHostKey(uuid, fingerprint) {
	await postgres.write('UPDATE ' + TABLE + ' SET host_key = $1 WHERE uuid = $2', [fingerprint, uuid]);
}

export {
	KINDS, KIND_LABELS, PRESETS, RLOGIN_DEFAULTS, BBSLINK_DEFAULTS,
	validateRemote, settingsOf, secretsOf, minSecurityFor, mayUseRemote, parseRemoteArg, identityFor, rloginName,
	getAll, getByName, getByUuid, createRemote, updateRemote, deleteRemote, touch, setHostKey
};
