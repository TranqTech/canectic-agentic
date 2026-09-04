// tests/msgBaseScan.test.js — Unit tests for msgBaseScan.js
//
// Covers scanDirectory, which is synchronous and DB-free. autoMatchAreas needs
// a live database and is not covered here.
// Run: npx mocha tests/msgBaseScan.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { scanDirectory } from '../src/maintenance/msgBaseScan.js';

var __dirname = path.dirname(url.fileURLToPath(import.meta.url));
var TMP_ROOT = path.join(__dirname, 'tmp');

var JAM_SIG = Buffer.from([0x4A, 0x41, 0x4D, 0x00]); // "JAM\0"
var SMB_SIG = Buffer.from([0x53, 0x4D, 0x42, 0x1A]); // "SMB\x1A"

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function jamInfo(activeMsgs) {
	var b = Buffer.alloc(1024);
	JAM_SIG.copy(b, 0);
	b.writeUInt32LE(activeMsgs, 12);
	return b;
}

function smbStatus(totalMsgs) {
	var b = Buffer.alloc(256);
	SMB_SIG.copy(b, 0);
	b.writeUInt32LE(totalMsgs, 12);
	b.writeUInt32LE(256, 16);
	return b;
}

var dirCounter = 0;
var createdDirs = [];

function makeDir(files) {
	dirCounter++;
	var dir = path.join(TMP_ROOT, 'scan-' + dirCounter);
	fs.mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);
	for (var name in files) {
		fs.writeFileSync(path.join(dir, name), files[name]);
	}
	return dir;
}

function cleanupDirs() {
	for (var i = 0; i < createdDirs.length; i++) {
		try { fs.rmSync(createdDirs[i], { recursive: true, force: true }); } catch (e) { /* gone */ }
	}
	createdDirs = [];
}

function byName(scan, name) {
	return scan.bases.find(function (b) { return b.name === name; });
}

// ---------------------------------------------------------------------------

describe('scanDirectory', function () {

	afterEach(function () {
		cleanupDirs();
	});

	describe('input handling', function () {

		it('rejects an unknown format', function () {
			var r = scanDirectory(makeDir({}), 'squish');
			assert.strictEqual(r.status, false);
			assert.ok(/Unknown message base format/.test(r.error));
		});

		it('reports a missing directory', function () {
			var r = scanDirectory(path.join(TMP_ROOT, 'definitely-not-here'), 'jam');
			assert.strictEqual(r.status, false);
			assert.ok(/Directory not found/.test(r.error));
		});

		it('reports an empty directory path', function () {
			var r = scanDirectory('', 'jam');
			assert.strictEqual(r.status, false);
			assert.ok(/No directory given/.test(r.error));
		});

		it('returns an empty list for a directory with no bases', function () {
			var r = scanDirectory(makeDir({ 'readme.txt': 'nothing here' }), 'jam');
			assert.strictEqual(r.status, true);
			assert.deepStrictEqual(r.bases, []);
		});

		it('resolves the directory to an absolute path', function () {
			var dir = makeDir({});
			var r = scanDirectory(dir, 'jam');
			assert.ok(path.isAbsolute(r.dir));
		});
	});

	describe('JAM discovery', function () {

		it('finds a base from its header and data files', function () {
			var r = scanDirectory(makeDir({
				'echo_dev.jhr': jamInfo(5),
				'echo_dev.jdt': Buffer.alloc(16),
			}), 'jam');

			assert.strictEqual(r.bases.length, 1);
			assert.strictEqual(r.bases[0].name, 'echo_dev');
			assert.strictEqual(r.bases[0].format, 'jam');
			assert.strictEqual(r.bases[0].error, null);
		});

		it('reads the message count from the info block', function () {
			var r = scanDirectory(makeDir({
				'a.jhr': jamInfo(1234),
				'a.jdt': Buffer.alloc(4),
			}), 'jam');
			assert.strictEqual(r.bases[0].totalMsgs, 1234);
		});

		it('detects an optional index file', function () {
			var r = scanDirectory(makeDir({
				'a.jhr': jamInfo(1), 'a.jdt': Buffer.alloc(4), 'a.jdx': Buffer.alloc(8),
				'b.jhr': jamInfo(1), 'b.jdt': Buffer.alloc(4),
			}), 'jam');

			assert.ok(byName(r, 'a').indexPath.length > 0);
			assert.strictEqual(byName(r, 'b').indexPath, '');
		});

		it('matches companion files whose case differs', function () {
			// DOS-era tools leave mixed case behind
			var r = scanDirectory(makeDir({
				'ECHO_DEV.jhr': jamInfo(2),
				'ECHO_DEV.JDT': Buffer.alloc(8),
				'ECHO_DEV.JDX': Buffer.alloc(8),
			}), 'jam');

			assert.strictEqual(r.bases.length, 1);
			assert.strictEqual(r.bases[0].error, null);
			assert.ok(r.bases[0].dataPath.length > 0);
			assert.ok(r.bases[0].indexPath.length > 0);
		});

		it('finds a base whose header extension is uppercase', function () {
			var r = scanDirectory(makeDir({
				'UPPER.JHR': jamInfo(3),
				'UPPER.JDT': Buffer.alloc(4),
			}), 'jam');
			assert.strictEqual(r.bases.length, 1);
			assert.strictEqual(r.bases[0].totalMsgs, 3);
		});

		it('reports a base with no data file rather than dropping it', function () {
			var r = scanDirectory(makeDir({ 'orphan.jhr': jamInfo(0) }), 'jam');
			assert.strictEqual(r.bases.length, 1);
			assert.ok(/Missing \.jdt file/.test(r.bases[0].error));
		});

		it('reports a header with a bad signature', function () {
			var r = scanDirectory(makeDir({
				'broken.jhr': Buffer.alloc(1024),
				'broken.jdt': Buffer.alloc(4),
			}), 'jam');
			assert.ok(/bad signature/.test(r.bases[0].error));
		});

		it('reports a header that is too short to be an info block', function () {
			var r = scanDirectory(makeDir({
				'stub.jhr': JAM_SIG,
				'stub.jdt': Buffer.alloc(4),
			}), 'jam');
			assert.ok(r.bases[0].error);
		});

		it('records the combined size of header and data', function () {
			var r = scanDirectory(makeDir({
				'a.jhr': jamInfo(1),
				'a.jdt': Buffer.alloc(500),
			}), 'jam');
			assert.strictEqual(r.bases[0].bytes, 1024 + 500);
		});
	});

	describe('SMB discovery', function () {

		it('finds a base from its header and data files', function () {
			var r = scanDirectory(makeDir({
				'general.shd': smbStatus(42),
				'general.sdt': Buffer.alloc(16),
			}), 'smb');

			assert.strictEqual(r.bases.length, 1);
			assert.strictEqual(r.bases[0].name, 'general');
			assert.strictEqual(r.bases[0].totalMsgs, 42);
			assert.strictEqual(r.bases[0].error, null);
		});

		it('detects the optional .sid index', function () {
			var r = scanDirectory(makeDir({
				'g.shd': smbStatus(1), 'g.sdt': Buffer.alloc(4), 'g.sid': Buffer.alloc(20),
			}), 'smb');
			assert.ok(r.bases[0].indexPath.length > 0);
		});

		it('reports a missing .sdt', function () {
			var r = scanDirectory(makeDir({ 'g.shd': smbStatus(1) }), 'smb');
			assert.ok(/Missing \.sdt file/.test(r.bases[0].error));
		});
	});

	describe('format isolation and ordering', function () {

		it('ignores bases of the other format', function () {
			var files = {
				'j.jhr': jamInfo(1), 'j.jdt': Buffer.alloc(4),
				's.shd': smbStatus(1), 's.sdt': Buffer.alloc(4),
			};
			var dir = makeDir(files);

			var jam = scanDirectory(dir, 'jam');
			var smb = scanDirectory(dir, 'smb');

			assert.deepStrictEqual(jam.bases.map(function (b) { return b.name; }), ['j']);
			assert.deepStrictEqual(smb.bases.map(function (b) { return b.name; }), ['s']);
		});

		it('sorts bases case-insensitively by name', function () {
			var r = scanDirectory(makeDir({
				'zebra.jhr': jamInfo(1), 'zebra.jdt': Buffer.alloc(4),
				'Alpha.jhr': jamInfo(1), 'Alpha.jdt': Buffer.alloc(4),
				'middle.jhr': jamInfo(1), 'middle.jdt': Buffer.alloc(4),
			}), 'jam');

			assert.deepStrictEqual(
				r.bases.map(function (b) { return b.name; }),
				['Alpha', 'middle', 'zebra']
			);
		});

		it('does not recurse into subdirectories', function () {
			var dir = makeDir({ 'top.jhr': jamInfo(1), 'top.jdt': Buffer.alloc(4) });
			var sub = path.join(dir, 'nested');
			fs.mkdirSync(sub);
			fs.writeFileSync(path.join(sub, 'deep.jhr'), jamInfo(1));
			fs.writeFileSync(path.join(sub, 'deep.jdt'), Buffer.alloc(4));

			var r = scanDirectory(dir, 'jam');
			assert.deepStrictEqual(r.bases.map(function (b) { return b.name; }), ['top']);
		});

		it('keeps usable and unusable bases in the same result list', function () {
			var r = scanDirectory(makeDir({
				'good.jhr': jamInfo(4), 'good.jdt': Buffer.alloc(4),
				'bad.jhr': jamInfo(0),
			}), 'jam');

			assert.strictEqual(r.bases.length, 2);
			assert.strictEqual(r.bases.filter(function (b) { return !b.error; }).length, 1);
			assert.strictEqual(r.bases.filter(function (b) { return b.error; }).length, 1);
		});
	});
});

// ---------------------------------------------------------------------------
// Truncated header regression
// ---------------------------------------------------------------------------

describe('scanDirectory truncated headers', function () {

	afterEach(function () {
		cleanupDirs();
	});

	// The stat functions read into a pre-zeroed fixed buffer. If they hand the
	// whole allocation to the parser rather than the bytes actually read, a
	// truncated file passes the signature check and reports zero messages,
	// which would silently import nothing instead of flagging a bad file.

	it('rejects a JAM header shorter than the info block', function () {
		var r = scanDirectory(makeDir({
			'stub.jhr': Buffer.concat([JAM_SIG, Buffer.alloc(100)]),
			'stub.jdt': Buffer.alloc(4),
		}), 'jam');
		assert.ok(r.bases[0].error, 'expected a truncated JAM header to be reported');
	});

	it('rejects a JAM header that is only the signature', function () {
		var r = scanDirectory(makeDir({
			'sig.jhr': JAM_SIG,
			'sig.jdt': Buffer.alloc(4),
		}), 'jam');
		assert.ok(r.bases[0].error);
	});

	it('rejects an SMB header shorter than the status fields', function () {
		var r = scanDirectory(makeDir({
			'stub.shd': Buffer.concat([SMB_SIG, Buffer.alloc(10)]),
			'stub.sdt': Buffer.alloc(4),
		}), 'smb');
		assert.ok(r.bases[0].error, 'expected a truncated SMB header to be reported');
	});

	it('still accepts an SMB header of exactly the minimum size', function () {
		var buf = Buffer.alloc(32);
		SMB_SIG.copy(buf, 0);
		buf.writeUInt32LE(7, 12);
		var r = scanDirectory(makeDir({
			'min.shd': buf,
			'min.sdt': Buffer.alloc(4),
		}), 'smb');
		assert.strictEqual(r.bases[0].error, null);
		assert.strictEqual(r.bases[0].totalMsgs, 7);
	});
});
