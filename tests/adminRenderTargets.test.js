// tests/adminRenderTargets.test.js: every template a route renders exists.
//
// requireAdmin refused with:
//
//     return res.status(403).render('admin/unauthorized', ...)
//
// and there was no src/views/admin/unauthorized.pug. The render threw ENOENT,
// Express caught it, and the client got 500. The guard had already decided on
// 403 and had already written the alog line saying so, so the logs and the
// response disagreed, on every admin route using the middleware.
//
// Nothing could catch that, because a render target is a string resolved at
// request time and the only route that exercised this one was the refusal path.
// So this walks every res.render() call in src/routes with a literal view name
// and checks the file is there. It is a cheap, total check of a class of bug
// that otherwise only shows in production, on the error path, where it is least
// welcome.
//
// Run: npx mocha --spec tests/adminRenderTargets.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';

var VIEWS  = 'src/views';
var ROUTES = 'src/routes';

function jsFilesUnder(dir) {
	var out = [];
	for (var entry of fs.readdirSync(dir, { withFileTypes: true })) {
		var p = path.join(dir, entry.name);
		if (entry.isDirectory()) out = out.concat(jsFilesUnder(p));
		else if (entry.name.endsWith('.js')) out.push(p);
	}
	return out;
}

// Express resolves a view name that names a directory to <dir>/index.pug, which
// this codebase relies on: admin/msgGroups is a directory, not a file. A check
// that only looked for <name>.pug would report a dozen working pages as broken
// and would have been deleted rather than fixed.
function viewExists(view) {
	if (fs.existsSync(path.join(VIEWS, view + '.pug'))) return true;
	return fs.existsSync(path.join(VIEWS, view, 'index.pug'));
}

// res.render('name', ...) and res.render("name", ...). Template literals and
// variables are skipped: the name is not knowable without running the route,
// and a test that guessed would be worse than no test.
function literalRenderTargets(file) {
	var src = fs.readFileSync(file, 'utf8');
	var re  = /\.render\(\s*(['"])([^'"]+)\1/g;
	var out = [];
	var m;
	while ((m = re.exec(src)) !== null) {
		out.push({
			view: m[2],
			line: src.slice(0, m.index).split('\n').length
		});
	}
	return out;
}

describe('route render targets', function () {
	var targets = [];

	before(function () {
		for (var file of jsFilesUnder(ROUTES)) {
			for (var t of literalRenderTargets(file)) {
				targets.push({ file: file, view: t.view, line: t.line });
			}
		}
	});

	it('finds render calls to check, so an empty pass cannot look like success', function () {
		assert.ok(targets.length > 50,
			'expected to find plenty of render targets, found ' + targets.length);
	});

	it('every literal render target resolves to a template', function () {
		var missing = targets
			.filter(function (t) { return !viewExists(t.view); })
			.map(function (t) { return t.file + ':' + t.line + ' renders ' + t.view; });

		assert.deepStrictEqual(missing, [],
			'render targets with no template:\n  ' + missing.join('\n  '));
	});

	it('the admin refusal page in particular exists', function () {
		// Named on its own because it is the one that was missing, and because
		// it is reachable only from the refusal path, where a regression would
		// otherwise turn every 403 into a 500 again without any route breaking.
		assert.ok(viewExists('admin/unauthorized'),
			'admin/unauthorized is what requireAdmin renders when it refuses');
	});
});

describe('admin unauthorized page renders', function () {
	var pug = null;

	before(async function () {
		try { pug = (await import('pug')).default; } catch (_) { pug = null; }
	});

	beforeEach(function () { if (!pug) this.skip(); });

	function render(locals) {
		return pug.renderFile(path.join(VIEWS, 'admin', 'unauthorized.pug'),
			Object.assign({
				title: 'Unauthorized',
				activelink: '',
				ismobile: false,
				currentPath: '/admin/config',
				basedir: VIEWS
			}, locals));
	}

	it('renders the refusal for a logged-in user without admin access', function () {
		var html = render({
			currentuser: { username: 'someone', security: 10, permissionflags: [] }
		});
		assert.ok(/not authorized/i.test(html),
			'expected the unauthorized partial, got ' + html.length + ' bytes without it');
	});

	it('offers a login form when there is no user at all', function () {
		// A refusal to an unauthenticated caller should give them the way in,
		// not a bare "not authorized" for an account they do not have.
		var html = render({ currentuser: null });
		assert.ok(/action="\/users\/login"/.test(html),
			'expected the login partial for an unauthenticated caller');
	});
});

// ---------------------------------------------------------------------------
// View helpers must be on res.locals, not passed per render
// ---------------------------------------------------------------------------
//
// threadModeLabel was passed in the locals object of each render that needed
// it. There are three renders of admin/msgGroups/view and I updated two, so
// the third threw "threadModeLabel is not a function" — a 500 on a page the
// suite never loads, found by a person opening it.
//
// A general "does every identifier a template calls resolve?" check is not
// worth having: run against these views it reports 583 candidates, nearly all
// CSS class names and inline JavaScript. So this is a declared list instead.
// Adding a helper to it is the moment to decide it belongs in res.locals, and
// once it is there no route added later can forget it.

describe('admin view helpers', function () {

	var VIEW_HELPERS = ['threadModeLabel'];

	var adminSource = fs.readFileSync(path.join(ROUTES, 'admin.js'), 'utf8');

	function adminViews(dir, out) {
		out = out || [];
		for (var entry of fs.readdirSync(dir, { withFileTypes: true })) {
			var full = path.join(dir, entry.name);
			if (entry.isDirectory()) adminViews(full, out);
			else if (entry.name.endsWith('.pug')) out.push(full);
		}
		return out;
	}

	VIEW_HELPERS.forEach(function (helper) {
		it(helper + ' is set on res.locals, so no render can omit it', function () {
			var users = adminViews(path.join(VIEWS, 'admin')).filter(function (f) {
				return new RegExp('\\b' + helper + '\\s*\\(').test(fs.readFileSync(f, 'utf8'));
			});
			if (users.length === 0) this.skip();

			assert.ok(new RegExp('res\\.locals\\.' + helper + '\\s*=').test(adminSource),
				helper + ' is called by ' + users.length + ' admin view(s) but src/routes/admin.js ' +
				'never assigns res.locals.' + helper + '. Passing it per render means every ' +
				'render site has to remember, and one of them will not.');
		});
	});
});
