// doorserver.js -- remote BBSes registered to use this board's door server
// (#86). See docs/reference/DOORSERVER_DESIGN.md.
//
// Until #86 getClientBBS returned one hardcoded test BBS for ANY system id,
// with an auth token published in the repository. Systems are now rows in
// doorserver_systems, added by the sysop or registered by one of this board's
// own verified users (doorserver_register_security, by default the verified
// level), and a system logs in with its
// system id and a generated secret, stored only as a bcrypt hash and shown
// once when it is made.

import * as crypto from 'crypto';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';
import { parseFlags } from '../utils/areaAccess.js';

var TABLE = 'doorserver_systems';
var SECRET_PREFIX = 'cds_';
var BCRYPT_ROUNDS = 10;
var STATUSES = ['pending', 'approved', 'suspended', 'rejected'];

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** System ids travel in auth frames and RLogin fields: 2-12 of A-Z 0-9 _ -. */
function normaliseSystemId(value) {
	var v = String(value === undefined || value === null ? '' : value).trim().toUpperCase();
	return /^[A-Z0-9_-]{2,12}$/.test(v) ? v : null;
}

/** Prefix for remote usernames here; defaults to the system id. */
function normalisePrefix(value, systemId) {
	var v = String(value === undefined || value === null ? '' : value).trim();
	if (!v) return systemId;
	return /^[A-Za-z0-9_-]{1,12}$/.test(v) ? v : null;
}

/**
 * The fields a registration may set, cleaned, plus every problem found.
 * returns { values, errors: [] }
 */
function validateDetails(input, opts) {
	var o = opts || {};
	var i = input || {};
	var errors = [];
	var values = {};
	var text = function (v, max) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max); };

	if (o.creating) {
		values.system_id = normaliseSystemId(i.system_id);
		if (!values.system_id) errors.push('System ID must be 2 to 12 letters, digits, _ or -');
	}
	values.bbs_name = text(i.bbs_name, 128);
	if (!values.bbs_name) errors.push('BBS name is required');
	values.sysop_name = text(i.sysop_name, 128);
	if (!values.sysop_name) errors.push('Sysop name is required');
	values.contact_email = text(i.contact_email, 256);
	if (values.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contact_email)) errors.push('Contact email does not look like an address');
	values.location = text(i.location, 128);
	values.address = text(i.address, 256);
	if (i.username_prefix !== undefined || o.creating) {
		var prefix = normalisePrefix(i.username_prefix, values.system_id || o.systemId);
		if (prefix === null) errors.push('Username prefix must be up to 12 letters, digits, _ or -');
		else values.username_prefix = prefix;
	}
	return { values: values, errors: errors };
}

/**
 * The lowest security level that may register: doorserver_register_security,
 * or, left blank, the level address verification grants (verified_security).
 */
function registerSecurity(cfg) {
	var c = cfg || appConfig;
	return c.getNumber('doorserver_register_security', c.getNumber('verified_security', 60));
}

/**
 * May this user register a BBS? A verified user can: at or above the
 * registration level, and not still marked Unverified (a hand-raised level
 * without a verified address does not count, and the address is the contact
 * a registration is tied to). cfg defaults to appConfig (tests pass one).
 */
function mayRegister(user, cfg) {
	var c = cfg || appConfig;
	if (!user) return false;
	if (!c.getBoolean('doorserver_enabled', false)) return false;
	if (parseFlags(user.restrictionflags).indexOf('Unverified') !== -1) return false;
	return (parseInt(user.security) || 0) >= registerSecurity(c);
}

/**
 * Is this user's registration approved without waiting for the sysop? Yes at
 * or above doorserver_auto_approve_security, or holding any permission flag
 * in doorserver_auto_approve_flags. Both blank (the default): never.
 */
function autoApproves(user, cfg) {
	var c = cfg || appConfig;
	if (!user) return false;
	var level = c.getNumber('doorserver_auto_approve_security', null);
	if (level !== null && (parseInt(user.security) || 0) >= level) return true;
	var wanted = String(c.get('doorserver_auto_approve_flags', '') || '').split(',')
		.map(function (f) { return f.trim().toLowerCase(); }).filter(Boolean);
	if (!wanted.length) return false;
	return parseFlags(user.permissionflags).some(function (f) { return wanted.indexOf(String(f).toLowerCase()) !== -1; });
}

function generateSecret() {
	return SECRET_PREFIX + crypto.randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getAll() {
	return await postgres.query(
		'SELECT s.*, u.username AS owner_username FROM ' + TABLE + ' s LEFT JOIN users u ON u.id = s.owner_user_id ' +
		"ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, s.bbs_name") || [];
}

async function getForOwner(userId) {
	return await postgres.query('SELECT * FROM ' + TABLE + ' WHERE owner_user_id = $1 ORDER BY bbs_name', [userId]) || [];
}

async function getByUuid(uuid) {
	return await postgres.queryOne('SELECT * FROM ' + TABLE + ' WHERE uuid = $1', [uuid]);
}

async function getBySystemId(systemId) {
	var id = normaliseSystemId(systemId);
	if (!id) return null;
	return await postgres.queryOne('SELECT * FROM ' + TABLE + ' WHERE system_id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Register a system. By the sysop (opts.bySysop) it is approved at once; by
 * a user (opts.user, the session user) it is theirs and waits for approval
 * unless autoApproves(user).
 * returns { status, errors, system, secret } -- secret only here, once.
 */
async function createSystem(input, opts) {
	var o = opts || {};
	var check = validateDetails(input, { creating: true });
	if (check.errors.length) return { status: false, errors: check.errors };
	if (await getBySystemId(check.values.system_id)) {
		return { status: false, errors: ['System ID ' + check.values.system_id + ' is already registered'] };
	}
	var approved = !!o.bySysop || autoApproves(o.user, o.cfg);
	var secret = generateSecret();
	var row = Object.assign({}, check.values, {
		uuid: uuidv4(),
		owner_user_id: o.ownerUserId || null,
		secret_hash: await bcrypt.hash(secret, BCRYPT_ROUNDS),
		secret_prefix: secret.slice(0, 10),
		status: approved ? 'approved' : 'pending',
		max_concurrent: parseInt(input.max_concurrent) > 0 ? parseInt(input.max_concurrent) : appConfig.getNumber('doorserver_max_concurrent', 5),
		notes: o.bySysop ? String(input.notes || '').slice(0, 4000) : null,
		created_at: new Date(),
		approved_at: approved ? new Date() : null,
		approved_by: approved ? (o.actor || (o.bySysop ? 'sysop' : 'auto')) : null,
		session_count: 0
	});
	var res = await postgres.insertObject(row, TABLE);
	if (!res.status) return { status: false, errors: res.errormessages || ['Could not save'] };
	alogger.writeAlog(2, '[DoorServer] registered ' + row.system_id + ' (' + row.bbs_name + '), ' + row.status +
		(o.actor ? ' by ' + o.actor : ''), 'cyan');
	return { status: true, errors: [], system: await getByUuid(row.uuid), secret: secret };
}

/** Update descriptive details (owner or sysop); sysop-only fields in opts. */
async function updateDetails(uuid, input, opts) {
	var o = opts || {};
	var sys = await getByUuid(uuid);
	if (!sys) return { status: false, errors: ['No such system'] };
	var check = validateDetails(input, { systemId: sys.system_id });
	if (check.errors.length) return { status: false, errors: check.errors };
	var upd = Object.assign({}, check.values, { updated_at: new Date() });
	if (o.bySysop) {
		if (input.max_concurrent !== undefined) upd.max_concurrent = Math.max(1, parseInt(input.max_concurrent) || 1);
		if (input.notes !== undefined) upd.notes = String(input.notes || '').slice(0, 4000);
	}
	var sets = [], params = [];
	for (var k of Object.keys(upd)) { params.push(upd[k]); sets.push(k + ' = $' + params.length); }
	params.push(uuid);
	var err = await postgres.write('UPDATE ' + TABLE + ' SET ' + sets.join(', ') + ' WHERE uuid = $' + params.length, params);
	return err ? { status: false, errors: [err.message] } : { status: true, errors: [] };
}

async function setStatus(uuid, status, actor) {
	if (STATUSES.indexOf(status) === -1) return false;
	var approving = status === 'approved';
	var err = await postgres.write(
		'UPDATE ' + TABLE + ' SET status = $1, updated_at = NOW(), ' +
		'approved_at = CASE WHEN $2::boolean THEN NOW() ELSE approved_at END, ' +
		'approved_by = CASE WHEN $2::boolean THEN $3 ELSE approved_by END WHERE uuid = $4',
		[status, approving, actor || 'sysop', uuid]);
	if (err) alogger.writeAlog(2, '[DoorServer] could not set ' + uuid + ' ' + status + ': ' + err.message, 'redbright');
	if (!err) alogger.writeAlog(2, '[DoorServer] ' + uuid + ' set ' + status + ' by ' + (actor || 'sysop'), 'cyan');
	return !err;
}

/** A new secret; the old one stops working at once. Returns the secret. */
async function regenerateSecret(uuid) {
	var secret = generateSecret();
	var err = await postgres.write('UPDATE ' + TABLE + ' SET secret_hash = $1, secret_prefix = $2, updated_at = NOW() WHERE uuid = $3',
		[await bcrypt.hash(secret, BCRYPT_ROUNDS), secret.slice(0, 10), uuid]);
	return err ? null : secret;
}

async function deleteSystem(uuid) {
	return !(await postgres.write('DELETE FROM ' + TABLE + ' WHERE uuid = $1', [uuid]));
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Check a system's credentials. Returns { ok, system?, reason, unknown? };
 * reason is safe to send to the client and never says which half was wrong
 * for an existing system.
 */
async function verifyLogin(systemId, secret) {
	var sys = await getBySystemId(systemId);
	if (!sys) return { ok: false, unknown: true, reason: 'Login refused' };
	var good = false;
	try { good = !!secret && await bcrypt.compare(String(secret), sys.secret_hash || ''); } catch (_) { good = false; }
	if (!good) return { ok: false, reason: 'Login refused' };
	if (sys.status !== 'approved') return { ok: false, system: sys, reason: 'This system is ' + sys.status + ' on this door server' };
	return { ok: true, system: sys, reason: '' };
}

async function recordSession(systemUuid) {
	await postgres.write('UPDATE ' + TABLE + ' SET last_connect = NOW(), session_count = COALESCE(session_count, 0) + 1 WHERE uuid = $1', [systemUuid]);
}

/** Kept for the handler's import; a system row, or null. */
async function getClientBBS(systemId) {
	return await getBySystemId(systemId);
}

export {
	STATUSES, SECRET_PREFIX,
	normaliseSystemId, normalisePrefix, validateDetails, mayRegister, registerSecurity, autoApproves, generateSecret,
	getAll, getForOwner, getByUuid, getBySystemId, getClientBBS,
	createSystem, updateDetails, setStatus, regenerateSecret, deleteSystem,
	verifyLogin, recordSession
};
