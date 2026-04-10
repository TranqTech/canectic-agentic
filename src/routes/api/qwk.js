// src/routes/api/qwk.js
// QWK/REP API routes -- registered onto the /api/v1 router from routes/api.js.
//
// Full implementation lives in Phase 3 (routes + call logging side effects).
// This stub exposes the function so routes/api.js can import it cleanly
// and the routes themselves remain colocated with the other QWK logic.

import { apiAuth, requireScope } from '../../middleware/apiAuth.js';

/**
 * Register QWK routes onto a parent router (typically the /api/v1 router).
 */
function registerQwkRoutes(parentRouter) {
	// Phase 3 will populate these
	parentRouter.post('/qwk/download', apiAuth, requireScope('qwk'), function(req, res) {
		res.status(501).json({ error: 'not_implemented', message: 'QWK download endpoint pending Phase 3 implementation' });
	});

	parentRouter.post('/qwk/upload', apiAuth, requireScope('qwk_rw'), function(req, res) {
		res.status(501).json({ error: 'not_implemented', message: 'REP upload endpoint pending Phase 3 implementation' });
	});
}

export { registerQwkRoutes };
