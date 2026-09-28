// tests/dynamicImportPaths.test.js: every relative dynamic import resolves.
//
// A dynamic import('...') is resolved only when the line runs, so a wrong
// relative path passes `node --check`, loads fine, and throws the first time
// that branch is reached. Where the call sits inside a try/catch the failure
// is swallowed and the feature silently does nothing: ftnTosser imported
// '../models/pmAttachments.js' from src/middleware/tossers/, which names a
// directory that does not exist, so file-attach netmail went out with the
// attach flag set and no file queued, logged only to the console.
//
// This reads every .js file under src/ and bin/, finds import() calls whose
// argument is a string literal starting with '.', and checks the target file
// exists. Non-literal specifiers are out of scope.
//
// Run: npx mocha --no-config --exit tests/dynamicImportPaths.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir) {
	var out = [];
	for (var e of fs.readdirSync(dir, { withFileTypes: true })) {
		var p = path.join(dir, e.name);
		if (e.isDirectory()) { if (e.name !== 'node_modules') out = out.concat(jsFiles(p)); }
		else if (/\.(m?js)$/.test(e.name)) out.push(p);
	}
	return out;
}

describe('relative dynamic imports', function () {
	var files = jsFiles(path.join(ROOT, 'src')).concat(jsFiles(path.join(ROOT, 'bin')));
	var found = [];
	for (var f of files) {
		var text = fs.readFileSync(f, 'utf8');
		var re = /import\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g, m;
		while ((m = re.exec(text)) !== null) {
			var line = text.slice(0, m.index).split('\n').length;
			found.push({ file: path.relative(ROOT, f), line: line, spec: m[2], target: path.resolve(path.dirname(f), m[2]) });
		}
	}

	it('finds the dynamic imports it is meant to check', function () {
		assert.ok(found.length > 20, 'expected many dynamic imports, found ' + found.length);
	});

	it('resolves every one of them to a file that exists', function () {
		var missing = found.filter(function (d) { return !fs.existsSync(d.target); })
			.map(function (d) { return d.file + ':' + d.line + ' ' + d.spec; });
		assert.deepStrictEqual(missing, []);
	});
});
