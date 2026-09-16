// tests/optionalTools.test.js: the external programs Canectic runs.
//
// None of them are needed to boot a board, which is exactly why they go
// unnoticed: each one is discovered missing at the moment a sysop first uses
// the feature it belongs to, usually with a caller watching. A DOS door that
// exits instantly looks like a Canectic bug and is a missing package.
//
// `socat` appeared in no install instruction anywhere, despite being what the
// DosemuPty launch type needs to give a door a serial port, and DosemuPty is
// the mode the documentation recommends for interactive DOS doors. dosemu2 was
// documented, but as `sudo apt install dosemu2`, which fails on a stock Ubuntu
// because it exists only in a PPA. Neither was going to be noticed by reading
// the code, and neither was noticed for a long time.
//
// So the assertion that matters here is the last one: every tool declared in
// the list is named in INSTALL.md. Prose drifts from the code that needs it,
// and a list nobody checks is the same as no list. Adding a tool without
// writing it down now fails.
//
// Pure. The PATH lookup is injected, so these do not depend on what happens to
// be installed on the machine running them.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { OPTIONAL_TOOLS, missingTools, installHint, describeMissing } from '../src/maintenance/optionalTools.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the optional tool list', function () {

	it('declares a command, a package, what it enables and what is lost', function () {
		assert.ok(OPTIONAL_TOOLS.length > 0);
		for (var t of OPTIONAL_TOOLS) {
			for (var field of ['command', 'pkg', 'enables', 'without']) {
				assert.ok(t[field] && typeof t[field] === 'string' && t[field].trim(),
					t.command + ' has no ' + field);
			}
		}
	});

	it('names each command once', function () {
		var names = OPTIONAL_TOOLS.map(function (t) { return t.command; });
		assert.deepStrictEqual(names, Array.from(new Set(names)));
	});

	it('covers the two a DOS door needs', function () {
		var names = OPTIONAL_TOOLS.map(function (t) { return t.command; });
		assert.ok(names.indexOf('dosemu') !== -1, 'dosemu is not declared');
		assert.ok(names.indexOf('socat') !== -1, 'socat is not declared, which is how it went undocumented');
	});
});

describe('finding what is missing', function () {

	it('reports nothing when everything is there', function () {
		assert.deepStrictEqual(missingTools(function () { return true; }), []);
	});

	it('reports everything when nothing is there', function () {
		assert.strictEqual(missingTools(function () { return false; }).length, OPTIONAL_TOOLS.length);
	});

	it('reports only the absent one', function () {
		var missing = missingTools(function (c) { return c !== 'socat'; });
		assert.deepStrictEqual(missing.map(function (t) { return t.command; }), ['socat']);
	});

	it('says what was lost and how to get it back', function () {
		var lines = describeMissing(missingTools(function (c) { return c !== 'socat'; }));
		assert.strictEqual(lines.length, 1);
		assert.match(lines[0], /socat is not installed/);
		assert.match(lines[0], /sudo apt install socat/);
	});

	it('survives an empty list rather than throwing', function () {
		assert.deepStrictEqual(describeMissing([]), []);
		assert.deepStrictEqual(describeMissing(null), []);
	});
});

describe('the install hint', function () {

	// `sudo apt install dosemu2` is what INSTALL.md used to say, and it fails on
	// a stock Ubuntu with "Unable to locate package". A hint that does not work
	// is worse than no hint, because the reader concludes the package is gone.
	it('adds the repository for a tool that is not in the archive', function () {
		var dosemu = OPTIONAL_TOOLS.find(function (t) { return t.command === 'dosemu'; });
		assert.strictEqual(dosemu.ppa, 'ppa:dosemu2/ppa');
		assert.match(installHint(dosemu), /add-apt-repository ppa:dosemu2\/ppa/);
		assert.match(installHint(dosemu), /apt install dosemu2/);
	});

	it('is a plain apt line for a tool that is in the archive', function () {
		var socat = OPTIONAL_TOOLS.find(function (t) { return t.command === 'socat'; });
		assert.strictEqual(installHint(socat), 'sudo apt install socat');
	});

	it('survives being asked about nothing', function () {
		assert.strictEqual(installHint(null), '');
	});
});

describe('what the documentation tells a sysop to install', function () {

	// The point of the whole file. A tool added to the list and not written down
	// is a tool a sysop finds out about from a door that will not start.
	it('names every declared tool and its package', function () {
		var install = fs.readFileSync(path.join(ROOT, 'docs', 'sysop', 'INSTALL.md'), 'utf8');
		for (var t of OPTIONAL_TOOLS) {
			assert.ok(install.indexOf(t.pkg) !== -1,
				'INSTALL.md never mentions the package ' + t.pkg + ', needed for ' + t.enables);
		}
	});

	it('gives the repository for anything not in the archive', function () {
		var install = fs.readFileSync(path.join(ROOT, 'docs', 'sysop', 'INSTALL.md'), 'utf8');
		for (var t of OPTIONAL_TOOLS) {
			if (!t.ppa) continue;
			assert.ok(install.indexOf(t.ppa) !== -1,
				'INSTALL.md says to install ' + t.pkg + ' but never says where it comes from');
		}
	});

	it('is echoed in the README, which is where most people look first', function () {
		var readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
		for (var name of ['dosemu2', 'socat']) {
			assert.ok(readme.indexOf(name) !== -1, 'the README never mentions ' + name);
		}
	});
});
