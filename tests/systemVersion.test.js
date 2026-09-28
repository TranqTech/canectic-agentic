// tests/systemVersion.test.js: one place the software says what it is.
//
// The version had six readers going three different ways. artCodes and
// messages.js each called appConfig directly rather than going through
// systeminfo, with different fallbacks ('0.0.0' and '0.1a'). dbmigrations read
// package.json itself, twice. And binkp and EMSI carried a hardcoded
// PRODUCT_VERSION of '0.1', so every FTN peer this system had ever called was
// told it was running version 0.1 while it was running 0.9.5a.
//
// Nothing failed visibly, which is why it lasted. The cost was borne by other
// sysops reading a banner that was wrong, and it would have been borne by the
// update system, which decides whether an upgrade exists by comparing this
// value.
//
// So the tests here are mostly about where the version comes from rather than
// what it is: a value assertion would pin the current release and have to be
// edited every time it changes, which is how a test stops meaning anything.
//
// Run: npx mocha

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import * as systeminfo from '../src/utils/systeminfo.js';
import { parseVersion, compareVersions } from '../src/utils/version.js';

describe('systeminfo version accessors', function () {

	it('reports a version that parses', function () {
		// The property everything downstream needs. currentversion is an
		// overridable config key, so this is reachable by a sysop typing
		// something into /admin/config, not only by a packaging mistake.
		var v = systeminfo.softwareVersion();
		assert.ok(parseVersion(v), 'softwareVersion() returned something unparseable: ' + v);
	});

	it('agrees with package.json', function () {
		// The chain is package.json -> currentversion default -> appConfig.
		// If these diverge, the running system and the release it came from
		// disagree about what it is.
		var pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
		assert.strictEqual(compareVersions(systeminfo.softwareVersion(), pkg), 0,
			'systeminfo says ' + systeminfo.softwareVersion() + ', package.json says ' + pkg);
	});

	it('works without appConfig having been loaded', function () {
		// This suite never calls appConfig.load(), so reaching a real version
		// here is the assertion: a CLI that never loads config still reports
		// the truth rather than a placeholder. It is what let dbmigrations stop
		// reading package.json for itself.
		assert.notStrictEqual(systeminfo.softwareVersion(), systeminfo.UNKNOWN_VERSION,
			'fell back to the unknown placeholder, so the package.json read failed');
	});

	it('builds the display string from the version rather than repeating it', function () {
		assert.strictEqual(systeminfo.versionMsg(),
			systeminfo.softwareName() + ' v' + systeminfo.softwareVersion());
	});

	it('parses to the same thing it reports', function () {
		assert.strictEqual(systeminfo.versionInfo().raw, systeminfo.softwareVersion());
	});

	it('canonicalises for anything sent to another system', function () {
		// A stray v prefix or a legacy spelling should not travel to a peer.
		var canon = systeminfo.canonicalVersion();
		assert.ok(!/^v/.test(canon), 'a v prefix must not reach the wire');
		assert.strictEqual(compareVersions(canon, systeminfo.softwareVersion()), 0);
	});
});

describe('nothing reads the version for itself', function () {

	function read(file) {
		try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
	}

	function sourceFiles(dir) {
		var out = [];
		var entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
		for (var e of entries) {
			var p = path.join(dir, e.name);
			if (e.isDirectory()) out = out.concat(sourceFiles(p));
			else if (e.name.endsWith('.js')) out.push(p);
		}
		return out;
	}

	// The two files allowed to know where the version physically lives.
	var ALLOWED = ['src/config/configDefaults.js', 'src/utils/systeminfo.js'];

	it('only configDefaults and systeminfo read currentversion', function () {
		// Each extra reader is a chance to pick a different fallback, which is
		// exactly what happened: '0.0.0' in one place, '0.1a' in another.
		var offenders = [];
		for (var f of sourceFiles('src').concat(sourceFiles('bin'))) {
			if (ALLOWED.indexOf(f.split(path.sep).join('/')) !== -1) continue;
			var body = read(f);
			if (body && /currentversion/.test(body)) offenders.push(f);
		}
		assert.deepStrictEqual(offenders, [],
			'these read currentversion directly instead of going through systeminfo');
	});

	it('only configDefaults and systeminfo read the version out of package.json', function () {
		var offenders = [];
		for (var f of sourceFiles('src').concat(sourceFiles('bin'))) {
			if (ALLOWED.indexOf(f.split(path.sep).join('/')) !== -1) continue;
			var body = read(f);
			if (body && /package\.json[^\n]*\)\)?\.version|\.version[^\n]*package\.json/.test(body)) {
				offenders.push(f);
			}
		}
		assert.deepStrictEqual(offenders, [],
			'these read package.json for the version instead of going through systeminfo');
	});

	it('nothing reads a version out of appConfig under another key', function () {
		// There is no 'version' key, so appConfig.get('version', '') is always
		// the fallback: the netmail relay stamped every Via line it added with
		// "Canectic" and no version at all.
		var offenders = [];
		for (var f of sourceFiles('src').concat(sourceFiles('bin'))) {
			if (ALLOWED.indexOf(f.split(path.sep).join('/')) !== -1) continue;
			var body = read(f);
			if (body && /appConfig\.get\(\s*['"][a-z_]*version['"]/i.test(body)) offenders.push(f);
		}
		assert.deepStrictEqual(offenders, [],
			'these read a version from appConfig instead of going through systeminfo');
	});

	it('the mailers do not carry a hardcoded product version', function () {
		// The one that was actually wrong on the wire. A literal here is a
		// number that will be right on the day it is written and wrong
		// afterwards, and nobody sees it but the peer.
		for (var f of ['src/mailer/protocols/binkp.js', 'src/mailer/protocols/emsi.js']) {
			var body = read(f);
			if (!body) continue;
			assert.ok(!/PRODUCT_VERSION\s*=\s*['"]/.test(body),
				f + ' has a hardcoded product version again');
			assert.ok(/systeminfo/.test(body),
				f + ' should take its version from systeminfo');
		}
	});
});

describe('what the mailer announces to a peer', function () {

	it('is the version this system is actually running', function () {
		// binkp M_NUL VER and the EMSI mailer code are read by other sysops and
		// logged by their software. Announcing 0.1 was not a private mistake.
		var announced = systeminfo.canonicalVersion();
		assert.strictEqual(compareVersions(announced, systeminfo.softwareVersion()), 0);
		assert.ok(parseVersion(announced));
	});

	it('contains no whitespace, which the binkp VER line cannot carry', function () {
		// VER is "<product>/<version> binkp/1.1", space separated, so a version
		// with a space in it would split the line.
		assert.ok(!/\s/.test(systeminfo.canonicalVersion()));
	});
});
