// src/middleware/apiAuth.js
// Authentication middleware for /api/v1 routes.
//
// Expects:
//   Authorization: Bearer canectic_<token>
//
// On success attaches to the request:
//   req.apiUser  -- the full user row
//   req.apiToken -- the token row (with last_used_at freshened)
//
// On failure returns JSON:
//   401 { error: 'auth_required' }       -- no / malformed header
//   401 { error: 'invalid_token' }       -- token not recognised or expired
//   403 { error: 'insufficient_scope' }  -- token exists but scope doesn't permit the action
//
// Individual routes can call requireScope(scope) to gate by scope after
// the main middleware has attached req.apiToken.

import * as apiTokens from '../models/apiTokens.js';
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

/**
 * Parse a Bearer token from the Authorization header.
 * Returns the token string or null.
 */
function extractBearer(req) {
	var auth = req.headers['authorization'];
	if (!auth || typeof auth !== 'string') return null;
	var match = auth.match(/^\s*Bearer\s+(\S+)\s*$/i);
	return match ? match[1] : null;
}

/**
 * Express middleware: authenticate a request via API token.
 * Attaches req.apiUser and req.apiToken on success.
 */
async function apiAuth(req, res, next) {
	var plaintext = extractBearer(req);
	if (!plaintext) {
		return res.status(401).json({ error: 'auth_required', message: 'Missing Authorization: Bearer header' });
	}

	var token;
	try {
		token = await apiTokens.resolveToken(plaintext);
	} catch (err) {
		alogger.writeAlog(3, '[apiAuth] token resolution error: ' + err.message, 'redbright');
		return res.status(500).json({ error: 'auth_error' });
	}

	if (!token) {
		return res.status(401).json({ error: 'invalid_token', message: 'Token not recognised, expired, or revoked' });
	}

	// Load the user record
	var user;
	try {
		user = await postgres.queryOne('SELECT * FROM users WHERE id = $1', [token.user_id]);
	} catch (err) {
		alogger.writeAlog(3, '[apiAuth] user load error: ' + err.message, 'redbright');
		return res.status(500).json({ error: 'auth_error' });
	}

	if (!user || !user.active) {
		return res.status(401).json({ error: 'invalid_token', message: 'User account unavailable' });
	}

	// Check user restriction flags for "Banned"
	var rflags = user.restrictionflags || [];
	if (typeof rflags === 'string') {
		try { rflags = JSON.parse(rflags); } catch (_) { rflags = []; }
	}
	if (Array.isArray(rflags) && rflags.includes('Banned')) {
		return res.status(403).json({ error: 'account_restricted', message: 'Account is banned' });
	}

	// Freshen last_used_at (fire and forget)
	apiTokens.touchLastUsed(token.id).catch(function(_) {});

	req.apiUser = user;
	req.apiToken = token;
	return next();
}

/**
 * Middleware factory: require a specific scope on the authenticated token.
 * Usage: router.post('/qwk/upload', apiAuth, requireScope('qwk_rw'), handler);
 */
function requireScope(scope) {
	return function(req, res, next) {
		if (!req.apiToken) {
			return res.status(401).json({ error: 'auth_required' });
		}
		if (!apiTokens.scopeAllows(req.apiToken.scope, scope)) {
			return res.status(403).json({
				error: 'insufficient_scope',
				message: 'Token scope "' + req.apiToken.scope + '" does not permit ' + scope
			});
		}
		return next();
	};
}

export {
	apiAuth,
	requireScope,
	extractBearer
};
