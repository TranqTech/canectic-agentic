// tests/routes.test.js
// Route registration tests — verifies that expected routes are present in each
// Express router's stack without making any HTTP requests or DB connections.
//
// Strategy: import the router, walk router.stack to collect all registered
// paths and methods, then assert presence of expected entries.

import assert from 'assert';

// ---------------------------------------------------------------------------
// Helper: flatten a router's stack into an array of { method, path } objects.
// Express stores routes in router.stack. Each layer may be a Route (has
// layer.route) or a middleware (no layer.route). We only care about routes.
// Multi-path routes (router.get(['/', '/foo'], ...)) produce one layer whose
// route.path is an array.
// ---------------------------------------------------------------------------
function collectRoutes(router) {
	var found = [];
	if (!router || !Array.isArray(router.stack)) return found;
	for (var layer of router.stack) {
		if (!layer.route) continue;
		var routePath = layer.route.path;
		var paths = Array.isArray(routePath) ? routePath : [routePath];
		var methods = Object.keys(layer.route.methods).map(function(m) { return m.toUpperCase(); });
		for (var p of paths) {
			for (var m of methods) {
				found.push({ method: m, path: p });
			}
		}
	}
	return found;
}

function hasRoute(routes, method, path) {
	return routes.some(function(r) {
		return r.method === method.toUpperCase() && r.path === path;
	});
}

// ---------------------------------------------------------------------------
// files.js router (mounted at /files)
// ---------------------------------------------------------------------------
describe('routes/files.js', function() {
	var filesRoutes;

	before(async function() {
		try {
			var mod = await import('../src/routes/files.js');
			filesRoutes = collectRoutes(mod.router);
		} catch (err) {
			// If import fails (rare, since pg Pool is lazy), surface the error
			throw new Error('Failed to import src/routes/files.js: ' + err.message);
		}
	});

	it('registers GET / (group listing)', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/'), 'Missing GET /');
	});

	it('registers GET /search', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/search'), 'Missing GET /search');
	});

	it('registers GET /info/:uuid.json', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/info/:uuid.json'), 'Missing GET /info/:uuid.json');
	});

	it('registers GET /group/:shortcode', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/group/:shortcode'), 'Missing GET /group/:shortcode');
	});

	it('registers GET /area/:shortcode', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/area/:shortcode'), 'Missing GET /area/:shortcode');
	});

	it('registers GET /view/:uuid', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/view/:uuid'), 'Missing GET /view/:uuid');
	});

	it('registers GET /download/:uuid', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/download/:uuid'), 'Missing GET /download/:uuid');
	});

	it('registers GET /area/:shortcode/files.json', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/area/:shortcode/files.json'), 'Missing GET /area/:shortcode/files.json');
	});

	it('registers GET /area/:shortcode/upload', function() {
		assert.ok(hasRoute(filesRoutes, 'GET', '/area/:shortcode/upload'), 'Missing GET /area/:shortcode/upload');
	});

	it('registers POST /area/:shortcode/upload', function() {
		assert.ok(hasRoute(filesRoutes, 'POST', '/area/:shortcode/upload'), 'Missing POST /area/:shortcode/upload');
	});
});

// ---------------------------------------------------------------------------
// index.js router (mounted at /)
// ---------------------------------------------------------------------------
describe('routes/index.js', function() {
	var indexRoutes;

	before(async function() {
		try {
			var mod = await import('../src/routes/index.js');
			indexRoutes = collectRoutes(mod.router);
		} catch (err) {
			throw new Error('Failed to import src/routes/index.js: ' + err.message);
		}
	});

	it('registers GET / (landing)', function() {
		assert.ok(hasRoute(indexRoutes, 'GET', '/'), 'Missing GET /');
	});

	it('registers GET /messages', function() {
		assert.ok(hasRoute(indexRoutes, 'GET', '/messages'), 'Missing GET /messages');
	});

	it('registers GET /messages/group/:shortcode', function() {
		assert.ok(hasRoute(indexRoutes, 'GET', '/messages/group/:shortcode'), 'Missing GET /messages/group/:shortcode');
	});

	it('registers GET /messages/area/:shortcode', function() {
		assert.ok(hasRoute(indexRoutes, 'GET', '/messages/area/:shortcode'), 'Missing GET /messages/area/:shortcode');
	});

	it('registers GET /messages/area/:shortcode/thread/:uuid', function() {
		assert.ok(hasRoute(indexRoutes, 'GET', '/messages/area/:shortcode/thread/:uuid'), 'Missing GET /messages/area/:shortcode/thread/:uuid');
	});

	it('registers POST /messages/area/:shortcode/newthread', function() {
		assert.ok(hasRoute(indexRoutes, 'POST', '/messages/area/:shortcode/newthread'), 'Missing POST /messages/area/:shortcode/newthread');
	});

	it('registers POST /messages/area/:shortcode/thread/:uuid/reply', function() {
		assert.ok(hasRoute(indexRoutes, 'POST', '/messages/area/:shortcode/thread/:uuid/reply'), 'Missing POST /messages/area/:shortcode/thread/:uuid/reply');
	});
});

// ---------------------------------------------------------------------------
// users.js router (mounted at /users)
// ---------------------------------------------------------------------------
describe('routes/users.js', function() {
	var usersRoutes;

	before(async function() {
		try {
			var mod = await import('../src/routes/users.js');
			usersRoutes = collectRoutes(mod.router);
		} catch (err) {
			throw new Error('Failed to import src/routes/users.js: ' + err.message);
		}
	});

	it('registers GET /login', function() {
		assert.ok(hasRoute(usersRoutes, 'GET', '/login'), 'Missing GET /login');
	});

	it('registers POST /login', function() {
		assert.ok(hasRoute(usersRoutes, 'POST', '/login'), 'Missing POST /login');
	});

	it('registers GET /logout', function() {
		assert.ok(hasRoute(usersRoutes, 'GET', '/logout'), 'Missing GET /logout');
	});

	it('registers GET /register', function() {
		assert.ok(hasRoute(usersRoutes, 'GET', '/register'), 'Missing GET /register');
	});

	it('registers POST /register', function() {
		assert.ok(hasRoute(usersRoutes, 'POST', '/register'), 'Missing POST /register');
	});
});

// ---------------------------------------------------------------------------
// pm.js router (mounted at /pm)
// Note: the inbox is registered as router.get(['/', '/inbox'], ...) — this
// creates layers where path is an array. collectRoutes() handles this by
// expanding array paths, so both '/' and '/inbox' will appear.
// ---------------------------------------------------------------------------
describe('routes/pm.js', function() {
	var pmRoutes;

	before(async function() {
		try {
			var mod = await import('../src/routes/pm.js');
			pmRoutes = collectRoutes(mod.router);
		} catch (err) {
			throw new Error('Failed to import src/routes/pm.js: ' + err.message);
		}
	});

	it('registers GET /inbox (via multi-path registration)', function() {
		assert.ok(hasRoute(pmRoutes, 'GET', '/inbox'), 'Missing GET /inbox');
	});

	it('registers GET / (inbox alias via multi-path registration)', function() {
		assert.ok(hasRoute(pmRoutes, 'GET', '/'), 'Missing GET / (inbox alias)');
	});

	it('registers GET /sent', function() {
		assert.ok(hasRoute(pmRoutes, 'GET', '/sent'), 'Missing GET /sent');
	});

	it('registers GET /trash', function() {
		assert.ok(hasRoute(pmRoutes, 'GET', '/trash'), 'Missing GET /trash');
	});

	it('registers POST /compose/local', function() {
		assert.ok(hasRoute(pmRoutes, 'POST', '/compose/local'), 'Missing POST /compose/local');
	});

	it('registers POST /compose/network', function() {
		assert.ok(hasRoute(pmRoutes, 'POST', '/compose/network'), 'Missing POST /compose/network');
	});
});

// ---------------------------------------------------------------------------
// admin.js router (mounted at /admin)
// ---------------------------------------------------------------------------
describe('routes/admin.js', function() {
	var adminRoutes;

	before(async function() {
		try {
			var mod = await import('../src/routes/admin.js');
			adminRoutes = collectRoutes(mod.router);
		} catch (err) {
			throw new Error('Failed to import src/routes/admin.js: ' + err.message);
		}
	});

	it('registers GET / (dashboard)', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/'), 'Missing GET /');
	});

	it('registers GET /config', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/config'), 'Missing GET /config');
	});

	it('registers POST /config', function() {
		assert.ok(hasRoute(adminRoutes, 'POST', '/config'), 'Missing POST /config');
	});

	it('registers GET /fileGroups', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/fileGroups'), 'Missing GET /fileGroups');
	});

	it('registers GET /fileAreas', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/fileAreas'), 'Missing GET /fileAreas');
	});

	it('registers GET /nodelists', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/nodelists'), 'Missing GET /nodelists');
	});

	it('registers POST /nodelists/import', function() {
		assert.ok(hasRoute(adminRoutes, 'POST', '/nodelists/import'), 'Missing POST /nodelists/import');
	});

	it('registers GET /nodelist/:networkId', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/nodelist/:networkId'), 'Missing GET /nodelist/:networkId');
	});

	it('registers GET /users', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/users'), 'Missing GET /users');
	});

	it('registers GET /msgGroups', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/msgGroups'), 'Missing GET /msgGroups');
	});

	it('registers GET /msgAreas', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/msgAreas'), 'Missing GET /msgAreas');
	});

	it('registers GET /doors', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/doors'), 'Missing GET /doors');
	});

	it('registers GET /menus', function() {
		assert.ok(hasRoute(adminRoutes, 'GET', '/menus'), 'Missing GET /menus');
	});
});
