// tests/errorHandler.test.js: the Express error handler logs server errors.
//
// It used to render the error page and log nothing, so an exception in an
// admin route left no trace at all. A group save on a production board failed
// to take, and the logs could not say whether the save threw or was never
// submitted. These tests hold the handler to logging 5xx with enough to find
// the fault, and to NOT logging 4xx, which scanners produce by the thousand.
//
// Run: npx mocha --no-config --exit tests/errorHandler.test.js

import assert from 'assert';
import { createErrorHandler } from '../src/middleware/errorHandler.js';

function fakeReq(method, url) {
	return { method: method, originalUrl: url, url: url };
}

function fakeRes() {
	var res = {
		headersSent: false,
		locals: {},
		statusCode: null,
		rendered: null,
		status: function (code) { res.statusCode = code; return res; },
		render: function (view) { res.rendered = view; }
	};
	return res;
}

function setup(nodeEnv) {
	var logged = [];
	var handler = createErrorHandler({
		log: function (level, message) { logged.push({ level: level, message: message }); },
		nodeEnv: nodeEnv || 'production'
	});
	return { handler: handler, logged: logged };
}

describe('createErrorHandler', function () {

	it('logs a thrown error with method, path and stack', function () {
		var t = setup();
		var err = new Error('column "thread_mode" does not exist');
		var res = fakeRes();

		t.handler(err, fakeReq('POST', '/admin/msgGroup/FIDONET/update'), res, function () {});

		assert.strictEqual(t.logged.length, 1, 'a 500 must be logged');
		var line = t.logged[0].message;
		assert.ok(t.logged[0].level <= 1, 'a server error is important, not verbose');
		assert.ok(line.includes('500'), line);
		assert.ok(line.includes('POST /admin/msgGroup/FIDONET/update'), line);
		assert.ok(line.includes('column "thread_mode" does not exist'), line);
		assert.ok(line.includes('errorHandler.test.js'), 'the stack says where it was thrown: ' + line);
	});

	it('treats an error with no status as a 500', function () {
		var t = setup();
		var res = fakeRes();
		t.handler(new Error('boom'), fakeReq('GET', '/x'), res, function () {});
		assert.strictEqual(res.statusCode, 500);
		assert.strictEqual(res.rendered, 'error');
	});

	it('does not log a 404', function () {
		var t = setup();
		var err = new Error('Not Found');
		err.status = 404;
		var res = fakeRes();

		t.handler(err, fakeReq('GET', '/wp-login.php'), res, function () {});

		assert.strictEqual(t.logged.length, 0, 'scanner noise must not bury real errors');
		assert.strictEqual(res.statusCode, 404);
		assert.strictEqual(res.rendered, 'error');
	});

	it('leaves the query string out of the log', function () {
		var t = setup();
		t.handler(new Error('boom'), fakeReq('GET', '/search?q=secret&page=2'), fakeRes(), function () {});
		assert.ok(t.logged[0].message.includes('GET /search:'), t.logged[0].message);
		assert.ok(!t.logged[0].message.includes('secret'), t.logged[0].message);
	});

	it('shows the error object on the page only in development', function () {
		var err = new Error('boom');

		var prod = fakeRes();
		setup('production').handler(err, fakeReq('GET', '/x'), prod, function () {});
		assert.deepStrictEqual(prod.locals.error, {});
		assert.strictEqual(prod.locals.message, 'boom');

		var dev = fakeRes();
		setup('development').handler(err, fakeReq('GET', '/x'), dev, function () {});
		assert.strictEqual(dev.locals.error, err);
	});

	it('hands off to Express when headers were already sent, and still logs', function () {
		var t = setup();
		var res = fakeRes();
		res.headersSent = true;
		var passed = null;

		t.handler(new Error('mid-stream'), fakeReq('GET', '/files/download/1'), res, function (e) { passed = e; });

		assert.strictEqual(t.logged.length, 1);
		assert.ok(passed instanceof Error, 'the error goes to the default handler');
		assert.strictEqual(res.rendered, null, 'a page cannot be rendered over a response already sent');
	});
});
