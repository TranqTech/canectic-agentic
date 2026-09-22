// tests/updateWithdrawnNotice.test.js: telling a board it runs a withdrawn release.
//
// The update check has reported `withdrawn` for the running version since
// withdrawal existed, and the Update page never showed it, so a board on a
// pulled release looked exactly like a current one.
//
// Run: npx mocha --no-config --exit tests/updateWithdrawnNotice.test.js

import assert from 'assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import pug from 'pug';
import * as fs from 'fs';
import { evaluate } from '../src/release/updateVerdict.js';
import { withdrawRelease } from '../src/release/releaseIndex.js';

var VIEWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
var render = pug.compileFile(path.join(VIEWS, 'partials', 'update', 'withdrawnNotice.pug'), { basedir: VIEWS });

function checked(current, opts) {
	var idx = withdrawRelease({ channel: 'stable', releases: [
		{ version: '0.9.9a', migrations: [] }, { version: '0.9.8a', migrations: [] }, { version: '0.9.6a', migrations: [] }
	] }, '0.9.8a', opts);
	return evaluate({ current: current, channel: 'stable', indexes: { stable: idx }, appliedMigrations: [] });
}

describe('the Update page on a withdrawn release', function () {

	it('says the running release was withdrawn, why, and what replaces it', function () {
		var html = render({ result: checked('0.9.8a', { reason: 'an update into it can stop partway', by: '0.9.9a' }), running: '0.9.8a' });
		assert.ok(/0\.9\.8a has been withdrawn\./.test(html), html);
		assert.ok(/an update into it can stop partway/.test(html), html);
		assert.ok(/0\.9\.9a replaces it/.test(html), html);
	});

	it('says to stay put when nothing replaces it yet', function () {
		var html = render({ result: checked('0.9.8a', { reason: 'broken' }), running: '0.9.8a' });
		assert.ok(/No replacement is published yet/.test(html), html);
	});

	it('says nothing on a release that was not withdrawn', function () {
		assert.strictEqual(render({ result: checked('0.9.9a', { reason: 'x', by: '0.9.9a' }), running: '0.9.9a' }).trim(), '');
		assert.strictEqual(render({ result: null, running: '0.9.9a' }).trim(), '');
	});

	it('is on the Update page', function () {
		var page = fs.readFileSync(path.join(VIEWS, 'admin', 'update', 'index.pug'), 'utf8');
		assert.ok(/include \.\.\/\.\.\/partials\/update\/withdrawnNotice/.test(page));
	});
});
