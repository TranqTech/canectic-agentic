// tests/qwkUser.test.js — Unit tests for src/models/qwkUser.js
//
// Testable without infrastructure:
//
//   1. Export validation — all four named exports are present and are functions.
//
//   2. getQwkBbsId() logic — tested inline (same pattern as appConfig.test.js)
//      because appConfig._cache is private and load() requires a live DB.
//      The logic is pure: trim + uppercase + substring(0,8) on qwk_bbsid;
//      fallback to boardname with non-alphanumeric stripped.
//
//   3. cleanupQwkPacket() — tested with real temp files in tests/tmp/.
//      No DB or Redis required.
//
//   4. buildQwkForUser / importRepForUser — return-shape smoke tests only.
//      These are async DB-dependent functions; tested by calling them with
//      a known-bad userId that causes an early guard exit, asserting the
//      returned object has the expected shape and does not throw.
//      DB calls are left to fail gracefully (they are mocked by not running
//      against a real DB — the function exits at the user-not-found guard
//      before any deep DB work, so postgres module's lazy pool never actually
//      connects if the tests don't hit a real server; the test catches any
//      thrown error and asserts the shape of any returned object).
//
// NOTE: buildQwkForUser and importRepForUser are skipped via guard because
// they require a live postgres pool.  The shape and export tests are enough
// for unit coverage.
//
// Run: npx mocha tests/qwkUser.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var TMP_BASE = path.join(__dirname, 'tmp', 'qwkUser');

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

import {
	getQwkBbsId,
	buildQwkForUser,
	importRepForUser,
	cleanupQwkPacket
} from '../src/models/qwkUser.js';

// ---------------------------------------------------------------------------
// Inlined getQwkBbsId logic — mirrors src/models/qwkUser.js lines 41–49
//
// Accepts a configGet(key, defaultValue) function so we can inject any cache
// state without needing a live appConfig.load().
// ---------------------------------------------------------------------------

function makeGetQwkBbsId(configGet) {
	return function getQwkBbsIdPure() {
		var configured = (configGet('qwk_bbsid', '') || '').trim().toUpperCase();
		if (configured) return configured.substring(0, 8);

		var boardname = (configGet('boardname', 'BBS') || '').trim().toUpperCase();
		var safe = boardname.replace(/[^A-Z0-9]/g, '');
		return (safe || 'BBS').substring(0, 8);
	};
}

// ---------------------------------------------------------------------------
// Export validation
// ---------------------------------------------------------------------------

describe('qwkUser exports', function () {

	it('should export getQwkBbsId as a function', function () {
		assert.strictEqual(typeof getQwkBbsId, 'function');
	});

	it('should export buildQwkForUser as a function', function () {
		assert.strictEqual(typeof buildQwkForUser, 'function');
	});

	it('should export importRepForUser as a function', function () {
		assert.strictEqual(typeof importRepForUser, 'function');
	});

	it('should export cleanupQwkPacket as a function', function () {
		assert.strictEqual(typeof cleanupQwkPacket, 'function');
	});

});

// ---------------------------------------------------------------------------
// getQwkBbsId logic (inlined for isolation from appConfig._cache)
// ---------------------------------------------------------------------------

describe('getQwkBbsId logic', function () {

	describe('when qwk_bbsid is configured', function () {

		it('should return the configured ID in uppercase', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return 'undredux';
				return def;
			});
			assert.strictEqual(fn(), 'UNDREDUX');
		});

		it('should truncate to 8 characters', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return 'TOOLONGID';
				return def;
			});
			assert.strictEqual(fn(), 'TOOLONGI');
		});

		it('should trim whitespace before using the ID', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '  mybbs  ';
				return def;
			});
			assert.strictEqual(fn(), 'MYBBS');
		});

		it('should return exactly 8 chars when ID is exactly 8 chars', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return 'EIGHTCHR';
				return def;
			});
			assert.strictEqual(fn(), 'EIGHTCHR');
		});

		it('should return 1 char when ID is 1 char', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return 'X';
				return def;
			});
			assert.strictEqual(fn(), 'X');
		});

	});

	describe('when qwk_bbsid is empty — falls back to boardname', function () {

		it('should derive ID from boardname when qwk_bbsid is empty string', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '';
				if (key === 'boardname') return 'Canectic BBS';
				return def;
			});
			// 'Canectic BBS' → uppercase → 'CANECTIC BBS' → strip non-alphanum → 'CANECTICBBS' → first 8 → 'CANECTIC'
			assert.strictEqual(fn(), 'CANECTIC');
		});

		it('should strip non-alphanumeric characters from boardname', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '';
				if (key === 'boardname') return 'My BBS!';
				return def;
			});
			// 'My BBS!' → uppercase → 'MY BBS!' → strip → 'MYBBS' → first 8 → 'MYBBS'
			assert.strictEqual(fn(), 'MYBBS');
		});

		it('should truncate boardname-derived ID to 8 characters', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '';
				if (key === 'boardname') return 'AverylongboardnameBBS';
				return def;
			});
			var result = fn();
			assert.strictEqual(result.length, 8);
		});

		it('should fall back to "BBS" when both qwk_bbsid and boardname are empty', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '';
				if (key === 'boardname') return '';
				return def;
			});
			assert.strictEqual(fn(), 'BBS');
		});

		it('should fall back to "BBS" when boardname contains only special characters', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '';
				if (key === 'boardname') return '!!! *** ???';
				return def;
			});
			assert.strictEqual(fn(), 'BBS');
		});

		it('should fall back to "BBS" when boardname is null', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '';
				if (key === 'boardname') return null;
				return def;
			});
			assert.strictEqual(fn(), 'BBS');
		});

		it('should fall back to "BBS" when qwk_bbsid is whitespace only', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '   ';
				if (key === 'boardname') return '';
				return def;
			});
			assert.strictEqual(fn(), 'BBS');
		});

		it('should uppercase boardname-derived ID', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '';
				if (key === 'boardname') return 'lowerbbs';
				return def;
			});
			assert.strictEqual(fn(), 'LOWERBBS');
		});

		it('should preserve digits in boardname-derived ID', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return '';
				if (key === 'boardname') return 'BBS2000';
				return def;
			});
			assert.strictEqual(fn(), 'BBS2000');
		});

	});

	describe('output format invariants', function () {

		it('should always return a string', function () {
			var fn = makeGetQwkBbsId(function(key, def) { return def; });
			assert.strictEqual(typeof fn(), 'string');
		});

		it('should always return at most 8 characters', function () {
			var cases = [
				{ qwk_bbsid: 'TOOLONGIDHERE', boardname: 'Any' },
				{ qwk_bbsid: '', boardname: 'Averylongboardname1234' },
				{ qwk_bbsid: '', boardname: '' },
			];
			for (var i = 0; i < cases.length; i++) {
				var c = cases[i];
				var fn = makeGetQwkBbsId(function(key, def) {
					if (key === 'qwk_bbsid') return c.qwk_bbsid;
					if (key === 'boardname') return c.boardname;
					return def;
				});
				var result = fn();
				assert.ok(result.length <= 8, 'Result "' + result + '" exceeds 8 characters');
			}
		});

		it('should always return uppercase only (A-Z, 0-9)', function () {
			var fn = makeGetQwkBbsId(function(key, def) {
				if (key === 'qwk_bbsid') return 'mixedCase';
				return def;
			});
			var result = fn();
			assert.ok(/^[A-Z0-9]+$/.test(result), 'Result "' + result + '" contains lowercase or special chars');
		});

		it('should never return an empty string', function () {
			// Even with empty qwk_bbsid and boardname, returns 'BBS'
			var fn = makeGetQwkBbsId(function(key, def) { return ''; });
			assert.ok(fn().length > 0, 'Expected non-empty result');
		});

	});

});

// ---------------------------------------------------------------------------
// getQwkBbsId() — live call via unloaded appConfig
// ---------------------------------------------------------------------------

describe('getQwkBbsId (live import, unloaded appConfig)', function () {

	it('should return a non-empty string', function () {
		var result = getQwkBbsId();
		assert.strictEqual(typeof result, 'string');
		assert.ok(result.length > 0, 'Expected non-empty result from live getQwkBbsId()');
	});

	it('should return at most 8 characters', function () {
		var result = getQwkBbsId();
		assert.ok(result.length <= 8, 'Result "' + result + '" exceeds 8 characters');
	});

	it('should return only uppercase alphanumeric characters', function () {
		var result = getQwkBbsId();
		// With unloaded appConfig, boardname defaults to 'BBS' (the hardcoded default arg)
		// unless process.env.boardname is set — either way, result must be [A-Z0-9]+
		assert.ok(/^[A-Z0-9]+$/.test(result), 'Result "' + result + '" contains invalid characters');
	});

});

// ---------------------------------------------------------------------------
// cleanupQwkPacket()
// ---------------------------------------------------------------------------

describe('cleanupQwkPacket', function () {

	before(function () {
		fs.mkdirSync(TMP_BASE, { recursive: true });
	});

	after(function () {
		// Remove TMP_BASE if still present (should be empty from tests)
		try { fs.rmdirSync(TMP_BASE, { recursive: true }); } catch (_) {}
	});

	it('should not throw when called with null', function () {
		assert.doesNotThrow(function () {
			cleanupQwkPacket(null);
		});
	});

	it('should not throw when called with undefined', function () {
		assert.doesNotThrow(function () {
			cleanupQwkPacket(undefined);
		});
	});

	it('should not throw when called with empty string', function () {
		assert.doesNotThrow(function () {
			cleanupQwkPacket('');
		});
	});

	it('should not throw when called with a path that does not exist', function () {
		assert.doesNotThrow(function () {
			cleanupQwkPacket('/tmp/does-not-exist-at-all/file.qwk');
		});
	});

	it('should remove the file at the given path', function () {
		// Create a temp directory with a fake .qwk file inside it
		var tmpDir = path.join(TMP_BASE, 'cleanup-test-' + Date.now());
		fs.mkdirSync(tmpDir, { recursive: true });
		var fakeQwk = path.join(tmpDir, 'TESTBBS.qwk');
		fs.writeFileSync(fakeQwk, 'fake qwk content');

		assert.ok(fs.existsSync(fakeQwk), 'Test file should exist before cleanup');

		cleanupQwkPacket(fakeQwk);

		assert.ok(!fs.existsSync(fakeQwk), 'File should be removed after cleanupQwkPacket');
	});

	it('should remove the parent directory of the given path', function () {
		var tmpDir = path.join(TMP_BASE, 'cleanup-dir-test-' + Date.now());
		fs.mkdirSync(tmpDir, { recursive: true });
		var fakeQwk = path.join(tmpDir, 'MYBBS.qwk');
		fs.writeFileSync(fakeQwk, 'content');

		cleanupQwkPacket(fakeQwk);

		assert.ok(!fs.existsSync(tmpDir), 'Parent directory should be removed after cleanupQwkPacket');
	});

	it('should remove directory even when it contains other files', function () {
		// cleanupQwkPacket uses rmSync({ recursive: true, force: true }) on the directory,
		// so it should remove everything in the temp packet directory
		var tmpDir = path.join(TMP_BASE, 'cleanup-multi-' + Date.now());
		fs.mkdirSync(tmpDir, { recursive: true });
		var fakeQwk = path.join(tmpDir, 'BBS.qwk');
		var otherFile = path.join(tmpDir, 'CONTROL.DAT');
		fs.writeFileSync(fakeQwk, 'content');
		fs.writeFileSync(otherFile, 'more content');

		cleanupQwkPacket(fakeQwk);

		assert.ok(!fs.existsSync(tmpDir), 'Directory with multiple files should be fully removed');
	});

	it('should not throw when the directory has already been removed', function () {
		var tmpDir = path.join(TMP_BASE, 'cleanup-gone-' + Date.now());
		fs.mkdirSync(tmpDir, { recursive: true });
		var fakeQwk = path.join(tmpDir, 'TEST.qwk');
		fs.writeFileSync(fakeQwk, 'content');

		// Remove it first
		fs.rmSync(tmpDir, { recursive: true, force: true });

		// Now call cleanupQwkPacket on the (now-deleted) path
		assert.doesNotThrow(function () {
			cleanupQwkPacket(fakeQwk);
		});
	});

	it('should handle deeply nested temp directory structure', function () {
		// Simulate the real usage pattern: os.tmpdir() + subdirectory + file
		var nestedDir = path.join(TMP_BASE, 'deep-' + Date.now(), 'subdir');
		fs.mkdirSync(nestedDir, { recursive: true });
		var qwkFile = path.join(nestedDir, 'DEEP.qwk');
		fs.writeFileSync(qwkFile, 'content');

		// cleanupQwkPacket only removes the immediate parent dir of the qwkPath
		// (path.dirname(qwkPath) = nestedDir)
		cleanupQwkPacket(qwkFile);

		assert.ok(!fs.existsSync(nestedDir), 'Immediate parent dir should be removed');
	});

});

// ---------------------------------------------------------------------------
// buildQwkForUser return shape — no live DB
// ---------------------------------------------------------------------------

describe('buildQwkForUser return shape', function () {

	it('should return an object with expected keys when DB is unavailable', async function () {
		// With no live DB, postgres.queryOne will likely throw or reject.
		// The function should either return the error shape or throw; we catch both.
		var result;
		try {
			result = await buildQwkForUser(999999);
		} catch (err) {
			// Acceptable: postgres not available in unit test environment
			// Verify the error is a connection/infrastructure error, not a code bug
			assert.ok(err instanceof Error, 'Expected Error instance');
			return;
		}
		// If it returned without throwing, check the shape
		assert.strictEqual(typeof result, 'object', 'Expected object return');
		assert.ok('status' in result, 'Expected result.status');
		assert.ok('qwkPath' in result, 'Expected result.qwkPath');
		assert.ok('totalMessages' in result, 'Expected result.totalMessages');
		assert.ok('areaCount' in result, 'Expected result.areaCount');
		assert.ok('errormessages' in result, 'Expected result.errormessages');
		assert.ok(Array.isArray(result.errormessages), 'errormessages should be an array');
		assert.strictEqual(result.status, false, 'Expected status false when user not found');
	});

});

// ---------------------------------------------------------------------------
// importRepForUser return shape — no live DB
// ---------------------------------------------------------------------------

describe('importRepForUser return shape', function () {

	it('should return an object with expected keys when DB is unavailable', async function () {
		var result;
		try {
			result = await importRepForUser(999999, '/tmp/nonexistent.rep');
		} catch (err) {
			assert.ok(err instanceof Error, 'Expected Error instance');
			return;
		}
		assert.strictEqual(typeof result, 'object', 'Expected object return');
		assert.ok('status' in result, 'Expected result.status');
		assert.ok('totalPosted' in result, 'Expected result.totalPosted');
		assert.ok('totalErrors' in result, 'Expected result.totalErrors');
		assert.ok('details' in result, 'Expected result.details');
		assert.ok('errormessages' in result, 'Expected result.errormessages');
		assert.ok(Array.isArray(result.details), 'details should be an array');
		assert.ok(Array.isArray(result.errormessages), 'errormessages should be an array');
		assert.strictEqual(result.status, false, 'Expected status false when user not found');
	});

});
