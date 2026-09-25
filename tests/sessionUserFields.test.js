// tests/sessionUserFields.test.js — the logged-in user has a username, not a name.
//
// Admin routes read the session through getCurrentUser(req), which returns what
// userAccounts.buildSessionData stored at login: username, firstname, lastname,
// fullname, and no `name`. Thirty places in admin.js read `currentuser.name`
// and so recorded `undefined` (#63): created/updated-by on groups and areas,
// the author fallback for messages posted from the admin pages, who launched a
// web update, and who closed or reopened the board. Nothing failed; the field
// was simply empty, which is why it went unnoticed.
//
// Pure: reads source text and calls buildSessionData. No database.
// Run: npx mocha --no-config --exit tests/sessionUserFields.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSessionData } from '../src/models/useraccounts.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function routeFiles(dir) {
	var out = [];
	for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
		var p = path.join(dir, e.name);
		if (e.isDirectory()) out = out.concat(routeFiles(p));
		else if (e.name.endsWith('.js')) out.push(p);
	}
	return out;
}

describe('the session user', function () {

	it('has a username and no name', function () {
		var s = buildSessionData({ id: 1, uuid: 'u', username: 'Sysop', fullname: 'Sys Op', permissionflags: ['Sysop'] });
		assert.strictEqual(s.username, 'Sysop');
		assert.ok(!('name' in s), 'if a name field is added, this test and #63 need revisiting');
	});

	it('is never read as currentuser.name in a route', function () {
		var offenders = [];
		for (var file of routeFiles(path.join(ROOT, 'src/routes'))) {
			var lines = fs.readFileSync(file, 'utf8').split('\n');
			lines.forEach(function (line, i) {
				if (/\bcurrentuser\s*\.\s*name\b/.test(line) || /getCurrentUser\(req\)\)\s*\|\|\s*\{\}\)\s*\.\s*name\b/.test(line)) {
					offenders.push(path.relative(ROOT, file) + ':' + (i + 1));
				}
			});
		}
		assert.deepStrictEqual(offenders, [], 'currentuser has no name field; use username');
	});
});
