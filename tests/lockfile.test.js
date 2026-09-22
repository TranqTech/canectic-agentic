// tests/lockfile.test.js: what npm may change in package-lock.json.
//
// Every install and update runs npm install, which rewrites the lockfile: it
// syncs the root version to package.json, and different npm versions record
// different metadata. The final check of an install or update compared the
// lockfile byte for byte, so the rehearsal on 2026-09-21 saw a clean 0.9.7a
// install and a clean update both reported FAILED at the last step, the install
// telling the sysop to delete a working board. The lockfile is now compared by
// what it pins. A change in what is pinned must still fail.
//
// Run: npx mocha --no-config --exit tests/lockfile.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as lf from '../src/release/lockfile.js';

function lock(version, extra) {
	var l = {
		name: 'canectic-bbs', version: version, lockfileVersion: 3, requires: true,
		packages: {
			'': { name: 'canectic-bbs', version: version, license: 'BSD-3-Clause', dependencies: { 'better-sqlite3': '^13.0.3' } },
			'node_modules/better-sqlite3': {
				version: '13.0.3',
				resolved: 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz',
				integrity: 'sha512-AAA', license: 'MIT'
			},
			'node_modules/bindings': {
				version: '1.5.0', resolved: 'https://registry.npmjs.org/bindings/-/bindings-1.5.0.tgz',
				integrity: 'sha512-BBB', license: 'MIT'
			}
		}
	};
	if (extra) extra(l);
	return JSON.stringify(l, null, 2) + '\n';
}

// Exactly what npm 11 did to the shipped 0.9.7a lockfile on the test box.
function npm11Rewrite(text, version) {
	var l = JSON.parse(text);
	l.version = version;
	l.packages[''].version = version;
	l.packages['node_modules/better-sqlite3'].hasInstallScript = true;
	return JSON.stringify(l, null, 2) + '\n';
}

describe('lockfile', function () {

	describe('stamping the version', function () {
		it('sets both root version fields and keeps npm\'s formatting', function () {
			var out = lf.stampLockfileVersion(lock('0.9.6a'), '0.9.7a');
			var l = JSON.parse(out);
			assert.strictEqual(l.version, '0.9.7a');
			assert.strictEqual(l.packages[''].version, '0.9.7a');
			assert.ok(out.endsWith('}\n'), 'npm ends the file with a newline');
			assert.ok(out.indexOf('\n  "version"') !== -1, 'two-space indent');
		});

		it('changes nothing else', function () {
			var before = lock('0.9.6a');
			var after = lf.stampLockfileVersion(before, '0.9.7a');
			assert.strictEqual(after, lock('0.9.7a'), 'only the version lines may differ');
		});

		it('leaves text it cannot parse alone', function () {
			assert.strictEqual(lf.stampLockfileVersion('not json', '1.0.0'), 'not json');
		});
	});

	describe('comparing by what is pinned', function () {
		it('sees no difference in npm syncing the version and adding its own metadata', function () {
			assert.deepStrictEqual(lf.lockfileDifferences(lock('0.9.6a'), npm11Rewrite(lock('0.9.6a'), '0.9.7a')), []);
		});

		it('reports a package pinned at a different version', function () {
			var changed = lock('0.9.7a', function (l) { l.packages['node_modules/bindings'].version = '1.6.0'; });
			var d = lf.lockfileDifferences(lock('0.9.7a'), changed);
			assert.strictEqual(d.length, 1);
			assert.ok(/node_modules\/bindings: version "1\.5\.0" -> "1\.6\.0"/.test(d[0]), d[0]);
		});

		it('reports a changed integrity hash, which is a different package', function () {
			var changed = lock('0.9.7a', function (l) { l.packages['node_modules/bindings'].integrity = 'sha512-EVIL'; });
			assert.ok(/integrity/.test(lf.lockfileDifferences(lock('0.9.7a'), changed)[0]));
		});

		it('reports packages added and removed', function () {
			var more = lock('0.9.7a', function (l) { l.packages['node_modules/extra'] = { version: '1.0.0' }; });
			var less = lock('0.9.7a', function (l) { delete l.packages['node_modules/bindings']; });
			assert.deepStrictEqual(lf.lockfileDifferences(lock('0.9.7a'), more), ['node_modules/extra: added']);
			assert.deepStrictEqual(lf.lockfileDifferences(lock('0.9.7a'), less), ['node_modules/bindings: removed']);
		});

		it('treats an unreadable lockfile as different', function () {
			assert.ok(lf.lockfileDifferences(lock('1'), '{broken').length > 0);
		});
	});

	describe('forgiving npm\'s rewrite in a verify result', function () {
		var dir, src, dst;
		beforeEach(function () {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-lockfile-'));
			src = path.join(dir, 'staged'); dst = path.join(dir, 'install');
			fs.mkdirSync(src); fs.mkdirSync(dst);
			fs.writeFileSync(path.join(src, 'package-lock.json'), lock('0.9.7a'));
		});
		afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

		it('drops the lockfile from bare-path results (the updater\'s shape)', function () {
			fs.writeFileSync(path.join(dst, 'package-lock.json'), npm11Rewrite(lock('0.9.7a'), '0.9.7a'));
			var r = lf.forgiveNormalisedLockfile({ ok: false, missing: [], mismatched: ['package-lock.json'] },
				{ targetRoot: dst, sourceRoot: src });
			assert.strictEqual(r.result.ok, true);
			assert.deepStrictEqual(r.result.mismatched, []);
			assert.ok(/rewritten by npm/.test(r.note));
		});

		it('drops the lockfile from {path} results (the installer\'s shape) and keeps the others', function () {
			fs.writeFileSync(path.join(dst, 'package-lock.json'), npm11Rewrite(lock('0.9.7a'), '0.9.7a'));
			var r = lf.forgiveNormalisedLockfile({ ok: false, missing: [],
				mismatched: [{ path: 'package-lock.json' }, { path: 'src/a.js' }] }, { targetRoot: dst, sourceRoot: src });
			assert.strictEqual(r.result.ok, false, 'another file that did not land is still a failure');
			assert.deepStrictEqual(r.result.mismatched, [{ path: 'src/a.js' }]);
		});

		it('does not forgive a lockfile that pins something different', function () {
			fs.writeFileSync(path.join(dst, 'package-lock.json'),
				lock('0.9.7a', function (l) { l.packages['node_modules/bindings'].version = '9.9.9'; }));
			var r = lf.forgiveNormalisedLockfile({ ok: false, missing: [], mismatched: ['package-lock.json'] },
				{ targetRoot: dst, sourceRoot: src });
			assert.strictEqual(r.result.ok, false);
			assert.ok(/pins different packages/.test(r.note), r.note);
		});

		it('passes a result without the lockfile straight through', function () {
			var input = { ok: false, missing: ['x'], mismatched: [] };
			var r = lf.forgiveNormalisedLockfile(input, { targetRoot: dst, sourceRoot: src });
			assert.strictEqual(r.result, input);
			assert.strictEqual(r.note, null);
		});
	});
});
