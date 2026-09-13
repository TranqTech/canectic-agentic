// tests/updateCheckJob.test.js: the impure half of the update check.
//
// Almost everything that can be wrong here lives in updateVerdict.js and is
// tested there. What is left is URL construction, which does not look worth a
// test until you consider the failure: a missing or doubled slash makes every
// check 404 for ever, on an opt-in daily job whose visible symptom is that no
// update is ever offered. That is indistinguishable from a project that stopped
// releasing.
//
// Pure: importing the module does not connect to anything.

import assert from 'assert';
import * as http from 'http';
import { indexUrl, fetchIndex } from '../src/maintenance/updateCheck.js';

describe('indexUrl', function () {

	it('appends the channel index to a base URL', function () {
		assert.strictEqual(indexUrl('https://example.test/releases/', 'stable'),
			'https://example.test/releases/index-stable.json');
	});

	it('tolerates a base URL with no trailing slash', function () {
		// A sysop typing the URL into /admin/config will leave the slash off
		// about half the time, and without this every check 404s.
		assert.strictEqual(indexUrl('https://example.test/releases', 'development'),
			'https://example.test/releases/index-development.json');
	});

	it('does not double a slash that is already there', function () {
		assert.strictEqual(indexUrl('https://example.test/', 'stable'),
			'https://example.test/index-stable.json');
	});

	it('trims surrounding whitespace, which a paste leaves behind', function () {
		assert.strictEqual(indexUrl('  https://example.test/rel  ', 'stable'),
			'https://example.test/rel/index-stable.json');
	});

	it('has no URL when none is configured, rather than building a relative one', function () {
		assert.strictEqual(indexUrl('', 'stable'), null);
		assert.strictEqual(indexUrl(null, 'stable'), null);
		assert.strictEqual(indexUrl('   ', 'stable'), null);
	});
});

describe('fetchIndex', function () {

	var server, base;
	var routes = {};

	before(function (done) {
		server = http.createServer(function (req, res) {
			var route = routes[req.url];
			if (!route) { res.writeHead(404); res.end('not found'); return; }
			res.writeHead(route.status || 200, { 'Content-Type': 'application/json' });
			res.end(route.body);
		});
		server.listen(0, '127.0.0.1', function () {
			base = 'http://127.0.0.1:' + server.address().port;
			done();
		});
	});

	after(function (done) { server.close(done); });

	it('parses a published index', function () {
		routes['/index-stable.json'] = { body: JSON.stringify({
			index_version: 1, channel: 'stable',
			releases: [{ version: '0.9.6a', migrations: ['0001-a'] }]
		}) };
		return fetchIndex(base + '/index-stable.json').then(function (got) {
			assert.strictEqual(got.missing, false);
			assert.strictEqual(got.index.releases[0].version, '0.9.6a');
		});
	});

	it('treats a missing index as missing, not as a failure', function () {
		// A channel with nothing published has no index. Raising that as an
		// error would make a stable-only project look broken to everyone on
		// development, every single day.
		return fetchIndex(base + '/index-development.json').then(function (got) {
			assert.strictEqual(got.missing, true);
			assert.strictEqual(got.index, null);
		});
	});

	it('throws on a server error rather than reporting nothing available', function () {
		routes['/broken.json'] = { status: 500, body: 'boom' };
		return fetchIndex(base + '/broken.json').then(function () {
			assert.fail('should have thrown');
		}, function (e) {
			assert.ok(/HTTP 500/.test(e.message), e.message);
		});
	});

	it('throws on a document that is not an index', function () {
		// A captive portal or an error page served with 200 is the realistic
		// version of this, and silently treating it as an empty channel would
		// report "up to date" for ever.
		routes['/html.json'] = { body: '<html>hello</html>' };
		return fetchIndex(base + '/html.json').then(function () {
			assert.fail('should have thrown');
		}, function (e) {
			assert.ok(/not valid JSON/.test(e.message), e.message);
		});
	});

	it('throws on valid JSON that carries no releases', function () {
		routes['/empty.json'] = { body: '{"channel":"stable"}' };
		return fetchIndex(base + '/empty.json').then(function () {
			assert.fail('should have thrown');
		}, function (e) {
			assert.ok(/no releases array/.test(e.message), e.message);
		});
	});
});
