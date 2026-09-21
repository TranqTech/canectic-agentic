// tests/loginNoPasswordLog.test.js: nothing writes a request body to the log.
//
// The web login route began with console.log(req.body), which put every
// user's password in plain text into the gateway's pm2 log on every web
// login. Checked across every route file because the same debugging line in
// register, password reset or the profile page would do the same thing, and
// nothing about it fails.
//
// Run: npx mocha --no-config --exit tests/loginNoPasswordLog.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

var REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
	var out = [];
	for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
		var p = path.join(dir, e.name);
		if (e.isDirectory()) out = out.concat(walk(p));
		else if (e.name.endsWith('.js')) out.push(p);
	}
	return out;
}

describe('request bodies and the log', function () {
	it('no route logs a request body to the console', function () {
		var offenders = [];
		for (var file of walk(path.join(REPO, 'src/routes'))) {
			var lines = fs.readFileSync(file, 'utf8').split('\n');
			lines.forEach(function (line, i) {
				if (/console\.(log|info|warn|error|debug)\(\s*req\.body\b/.test(line)) {
					offenders.push(path.relative(REPO, file) + ':' + (i + 1));
				}
			});
		}
		assert.deepStrictEqual(offenders, [],
			'a request body can hold a password, and console output lands in the pm2 log:\n  ' + offenders.join('\n  '));
	});
});
