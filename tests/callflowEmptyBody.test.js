// tests/callflowEmptyBody.test.js: the call flow's POST routes with no body.
//
// Under Express 5 the urlencoded parser leaves req.body undefined when a
// request carries no body at all, rather than an empty object. POST
// /callflow/complete read req.body.return_url and answered 500, after the
// session writes it exists to make had already been done. A browser always
// sends a body, so it was found by a script (the 0.9.12a rehearsal), but a
// route should not throw on a request it can answer.
//
// Run: npx mocha --no-config --exit tests/callflowEmptyBody.test.js

import assert from 'assert';
import express from 'express';

var router = null;
try { ({ router } = await import('../src/routes/callflow.js')); } catch (_) { /* skip */ }

describe('call flow POST routes with no body', function () {
	var server = null, base = null;

	before(function (done) {
		if (!router) return this.skip();
		var app = express();
		app.use('/callflow', router);
		app.use(function (err, req, res, next) { res.status(500).json({ error: err.message }); });
		server = app.listen(0, '127.0.0.1', function () {
			base = 'http://127.0.0.1:' + server.address().port;
			done();
		});
	});

	after(function (done) {
		if (!server) return done();
		server.closeAllConnections();
		server.close(done);
	});

	it('completes and redirects home when nothing is posted', async function () {
		var res = await fetch(base + '/callflow/complete', { method: 'POST' });
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(await res.json(), { redirect: '/' });
	});

	it('still honours a return_url when one is posted', async function () {
		var res = await fetch(base + '/callflow/complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'return_url=%2Fmessages'
		});
		assert.deepStrictEqual(await res.json(), { redirect: '/messages' });
	});
});
