// src/models/apiTokens.js
// User API token CRUD and verification.
//
// Tokens authorise script/automation access to /api/v1 routes without
// using cookie sessions. Each user can have multiple tokens for
// different clients (mobile QWK reader, home cron, simulator persona).
//
// Storage:
//   user_api_tokens.token_hash stores a bcrypt hash of the token value.
//   The plaintext token is only returned to the caller at creation time
//   and never stored. Lost tokens must be regenerated.
//
// Token format: canectic_<base64url-48-bytes>. The "canectic_" prefix
// makes leaked tokens easy to spot in logs and commit searches.
//
// Scopes (simple enum, expandable):
//   qwk    -- QWK download only
//   qwk_rw -- QWK download + REP upload
//   (future scopes land here)

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as crypto from 'crypto';
import bcrypt from 'bcrypt';

var VALID_SCOPES = ['qwk', 'qwk_rw'];
var SCOPE_LABELS = {
	'qwk':    'QWK Download',
	'qwk_rw': 'QWK Download + REP Upload'
};

var TOKEN_PREFIX = 'canectic_';
var BCRYPT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

function generatePlaintextToken() {
	var buf = crypto.randomBytes(48);
	var b64 = buf.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return TOKEN_PREFIX + b64;
}

async function hashToken(plaintext) {
	return await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

async function verifyToken(plaintext, hash) {
	if (!plaintext || !hash) return false;
	try {
		return await bcrypt.compare(plaintext, hash);
	} catch (_) {
		return false;
	}
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getAllActive() {
	return await postgres.query(
		'SELECT t.*, u.username FROM user_api_tokens t ' +
		'JOIN users u ON u.id = t.user_id ' +
		'WHERE t.active = true ORDER BY t.created_at DESC'
	) || [];
}

async function getAllForAdmin() {
	return await postgres.query(
		'SELECT t.*, u.username FROM user_api_tokens t ' +
		'JOIN users u ON u.id = t.user_id ' +
		'ORDER BY t.active DESC, t.created_at DESC'
	) || [];
}

async function getByUser(userId) {
	return await postgres.query(
		'SELECT * FROM user_api_tokens WHERE user_id = $1 ORDER BY created_at DESC',
		[parseInt(userId)]
	) || [];
}

async function getActiveByUser(userId) {
	return await postgres.query(
		'SELECT * FROM user_api_tokens WHERE user_id = $1 AND active = true ORDER BY created_at DESC',
		[parseInt(userId)]
	) || [];
}

async function getById(id) {
	return await postgres.queryOne(
		'SELECT * FROM user_api_tokens WHERE id = $1',
		[parseInt(id)]
	);
}

/**
 * Create a new token for a user.
 * Returns { status, insertId, plaintext } on success.
 * The plaintext is only returned here -- it cannot be recovered later.
 */
async function createToken(userId, formObj) {
	var ret = { status: false, errormessages: [], insertId: 0, plaintext: null };

	if (!userId) {
		ret.errormessages.push('user_id required');
		return ret;
	}
	if (!formObj.label || !formObj.label.trim()) {
		ret.errormessages.push('Label is required');
		return ret;
	}

	var scope = (formObj.scope || 'qwk').trim().toLowerCase();
	if (!VALID_SCOPES.includes(scope)) {
		ret.errormessages.push('Invalid scope: ' + scope);
		return ret;
	}

	var expiresAt = null;
	if (formObj.expires_at) {
		var parsed = new Date(formObj.expires_at);
		if (isNaN(parsed.getTime())) {
			ret.errormessages.push('Invalid expires_at');
			return ret;
		}
		expiresAt = parsed;
	}

	var plaintext = generatePlaintextToken();
	var hash;
	try {
		hash = await hashToken(plaintext);
	} catch (err) {
		ret.errormessages.push('Hash failed: ' + err.message);
		return ret;
	}

	var dbObj = {
		user_id:    parseInt(userId),
		label:      formObj.label.trim(),
		token_hash: hash,
		scope:      scope,
		active:     true,
		expires_at: expiresAt,
		created_at: new Date()
	};

	var res = await postgres.insertObject(dbObj, 'user_api_tokens');
	if (!res.status) {
		ret.errormessages = ret.errormessages.concat(res.errormessages || ['Insert failed']);
		return ret;
	}

	ret.status = true;
	ret.insertId = res.insertId;
	ret.plaintext = plaintext;
	alogger.writeAlog(4, 'API token created: user ' + userId + ' label "' + dbObj.label + '" scope ' + scope, 'cyan');
	return ret;
}

async function updateToken(id, formObj) {
	var ret = { status: false, errormessages: [] };
	var existing = await getById(id);
	if (!existing) { ret.errormessages.push('Token not found'); return ret; }

	var updateObj = { updated_at: new Date() };
	if (formObj.label !== undefined) updateObj.label = formObj.label.trim();
	if (formObj.scope !== undefined) {
		var scope = formObj.scope.trim().toLowerCase();
		if (!VALID_SCOPES.includes(scope)) {
			ret.errormessages.push('Invalid scope');
			return ret;
		}
		updateObj.scope = scope;
	}
	if (formObj.active !== undefined) {
		updateObj.active = formObj.active === 'true' || formObj.active === true;
	}

	var count = await postgres.updateById(parseInt(id), updateObj, 'user_api_tokens');
	if (count === 0) { ret.errormessages.push('No rows updated'); return ret; }
	ret.status = true;
	return ret;
}

async function revokeToken(id) {
	var ret = { status: false, errormessages: [] };
	var existing = await getById(id);
	if (!existing) { ret.errormessages.push('Token not found'); return ret; }
	var count = await postgres.updateById(parseInt(id), {
		active: false,
		updated_at: new Date()
	}, 'user_api_tokens');
	if (count === 0) { ret.errormessages.push('Revoke failed'); return ret; }
	ret.status = true;
	alogger.writeAlog(4, 'API token revoked: id ' + id + ' user ' + existing.user_id, 'yellow');
	return ret;
}

async function deleteToken(id) {
	var ret = { status: false, errormessages: [] };
	var err = await postgres.write('DELETE FROM user_api_tokens WHERE id = $1', [parseInt(id)]);
	if (err) { ret.errormessages.push('Delete failed: ' + err.message); return ret; }
	ret.status = true;
	return ret;
}

// ---------------------------------------------------------------------------
// Token verification (for auth middleware)
// ---------------------------------------------------------------------------

/**
 * Verify a plaintext token against the DB. Returns the matching token
 * row + user record on success, or null on failure.
 *
 * Since bcrypt hashing is one-way we have to iterate candidate tokens
 * sharing the same prefix. In practice the number of active tokens is
 * small (dozens at most) and this runs only on API requests.
 */
async function resolveToken(plaintext) {
	if (!plaintext || typeof plaintext !== 'string') return null;
	if (!plaintext.startsWith(TOKEN_PREFIX)) return null;

	var active = await postgres.query(
		'SELECT t.*, u.username, u.id AS user_id_confirm FROM user_api_tokens t ' +
		'JOIN users u ON u.id = t.user_id ' +
		'WHERE t.active = true AND u.active = true ' +
		'AND (t.expires_at IS NULL OR t.expires_at > NOW())'
	);
	if (!active || active.length === 0) return null;

	for (var t of active) {
		if (await verifyToken(plaintext, t.token_hash)) {
			return t;
		}
	}
	return null;
}

async function touchLastUsed(tokenId) {
	try {
		await postgres.write(
			'UPDATE user_api_tokens SET last_used_at = NOW() WHERE id = $1',
			[parseInt(tokenId)]
		);
	} catch (_) {}
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

function scopeAllows(tokenScope, requiredScope) {
	if (!tokenScope) return false;
	if (tokenScope === requiredScope) return true;
	// qwk_rw implies qwk (read-only actions allowed under rw scope)
	if (tokenScope === 'qwk_rw' && requiredScope === 'qwk') return true;
	return false;
}

export {
	VALID_SCOPES,
	SCOPE_LABELS,
	TOKEN_PREFIX,
	getAllActive,
	getAllForAdmin,
	getByUser,
	getActiveByUser,
	getById,
	createToken,
	updateToken,
	revokeToken,
	deleteToken,
	resolveToken,
	touchLastUsed,
	scopeAllows,
	// Exposed for tests / tooling
	generatePlaintextToken,
	hashToken,
	verifyToken
};
