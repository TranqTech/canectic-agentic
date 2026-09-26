// src/routes/api.js
// /api/v1 -- machine-oriented API routes.
//
// Mounted at /api/v1 by src/servers/webserver.js. All routes under this
// router use bearer-token authentication via src/middleware/apiAuth.js
// and bypass the cookie-session middleware used by browser routes.
//
// Versioning: this is the v1 router. Breaking changes should land in a
// separate v2 router and both can run side by side.
//
// CSRF: /api/v1 is exempt from the Origin/Referer CSRF check in
// webserver.js because bearer-token auth provides CSRF defense in its
// own right (a cookie-less API is not vulnerable to XSRF).

import express from 'express';
import * as alogger from '../utils/alogger.js';
import { apiAuth, requireScope } from '../middleware/apiAuth.js';

const router = express.Router();

// All API routes return JSON by default on error; the middleware
// already sets Content-Type. Individual handlers can override for
// binary responses (e.g. QWK packet download sets octet-stream).

// --- Ping / health check (no auth) ---
router.get('/ping', function(req, res) {
	res.json({ status: 'ok', api: 'canectic', version: 'v1' });
});

// --- Authenticated identity check ---
router.get('/me', apiAuth, function(req, res) {
	res.json({
		username: req.apiUser.username,
		fullname: req.apiUser.fullname,
		security: req.apiUser.security,
		scope: req.apiToken.scope,
		token_label: req.apiToken.label
	});
});

// --- QWK routes (attached from the qwk subroute module) ---
import { registerQwkRoutes } from './api/qwk.js';
registerQwkRoutes(router);

// --- QWK networking hub (node authenticates as a peer, not a user) ---
import { registerQnetRoutes } from './api/qnet.js';
registerQnetRoutes(router);

// Fallback 404 for unknown /api/v1 paths so clients get JSON, not HTML
router.use(function(req, res) {
	res.status(404).json({ error: 'not_found', path: req.path });
});

export { router };
