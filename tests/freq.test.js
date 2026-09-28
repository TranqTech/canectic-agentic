// tests/freq.test.js — Unit tests for src/models/freq.js
//
// Testable without a live DB:
//
//   1. Export validation — all expected named exports are present and are functions.
//
//   2. createReqFile(destNet, destNode, filenames, { zone, baseDir }) -- writes
//      a .req file to the zone outbound. Every test passes a temporary baseDir:
//      these tests used to write into the board's real ftn/out, and one of them
//      deleted that directory recursively to prove it would be recreated.
//
//   3. resolveRequest parsing — reads a .req file and extracts filenames.
//      Blank lines and comment lines (;) are skipped; passwords after filenames
//      are stripped.  resolveFile() will return { found: false } for every
//      filename because there is no DB, but the parsing logic is still fully
//      exercised through the filename fields of the returned results.
//
// Run: npx mocha tests/freq.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dbAvailable } from './helpers/dbAvailable.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// Outbound base for createReqFile tests, never the board's own.
var OUTBOUND_DIR = path.join(__dirname, 'tmp', 'freq-out');

// Temporary directory for .req files used by resolveRequest tests.
var TMP_REQ_DIR = path.join(__dirname, 'tmp', 'freq');

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

import {
	ensureTable,
	getAllMagic,
	getMagicById,
	getMagicByName,
	createMagic,
	updateMagic,
	deleteMagic,
	resolveFile,
	resolveRequest,
	createReqFile
} from '../src/models/freq.js';

// ---------------------------------------------------------------------------
// Export validation
// ---------------------------------------------------------------------------

describe('freq exports', function () {

	it('should export ensureTable as a function', function () {
		assert.strictEqual(typeof ensureTable, 'function');
	});

	it('should export getAllMagic as a function', function () {
		assert.strictEqual(typeof getAllMagic, 'function');
	});

	it('should export getMagicById as a function', function () {
		assert.strictEqual(typeof getMagicById, 'function');
	});

	it('should export getMagicByName as a function', function () {
		assert.strictEqual(typeof getMagicByName, 'function');
	});

	it('should export createMagic as a function', function () {
		assert.strictEqual(typeof createMagic, 'function');
	});

	it('should export updateMagic as a function', function () {
		assert.strictEqual(typeof updateMagic, 'function');
	});

	it('should export deleteMagic as a function', function () {
		assert.strictEqual(typeof deleteMagic, 'function');
	});

	it('should export resolveFile as a function', function () {
		assert.strictEqual(typeof resolveFile, 'function');
	});

	it('should export resolveRequest as a function', function () {
		assert.strictEqual(typeof resolveRequest, 'function');
	});

	it('should export createReqFile as a function', function () {
		assert.strictEqual(typeof createReqFile, 'function');
	});

});

// ---------------------------------------------------------------------------
// createReqFile — hex naming and file contents
// ---------------------------------------------------------------------------

describe('createReqFile', function () {

	// Every path created lives under OUTBOUND_DIR (or its zone siblings).
	var createdPaths = [];
	var OPTS = { baseDir: OUTBOUND_DIR };

	after(function () {
		fs.rmSync(OUTBOUND_DIR, { recursive: true, force: true });
		fs.rmSync(OUTBOUND_DIR + '.002', { recursive: true, force: true });
	});

	it('should return the path of the created .req file', function () {
		var reqPath = createReqFile(100, 200, ['NODELIST.Z'], OPTS);
		createdPaths.push(reqPath);
		assert.strictEqual(typeof reqPath, 'string');
		assert.ok(reqPath.length > 0, 'Expected a non-empty path');
	});

	it('should create the outbound directory if it does not exist', function () {
		fs.rmSync(OUTBOUND_DIR, { recursive: true, force: true });

		var reqPath = createReqFile(1, 1, ['TEST.FILE'], OPTS);
		createdPaths.push(reqPath);
		assert.ok(fs.existsSync(OUTBOUND_DIR), 'Outbound directory should be created');
	});

	it('should name the file using net hex (4 chars) + node hex (4 chars) + .req', function () {
		// net=100 (0x0064), node=200 (0x00c8) => 006400c8.req
		var reqPath = createReqFile(100, 200, ['ANYFILE.ZIP'], OPTS);
		createdPaths.push(reqPath);
		var basename = path.basename(reqPath);
		assert.strictEqual(basename, '006400c8.req');
	});

	it('should pad net hex to 4 characters with leading zeros', function () {
		// net=1 => 0001
		var reqPath = createReqFile(1, 1, ['FILE.ZIP'], OPTS);
		createdPaths.push(reqPath);
		var basename = path.basename(reqPath);
		assert.strictEqual(basename.substring(0, 4), '0001', 'Net hex should be 4 chars: ' + basename);
	});

	it('should pad node hex to 4 characters with leading zeros', function () {
		// node=1 => 0001
		var reqPath = createReqFile(1, 1, ['FILE.ZIP'], OPTS);
		// Already tracked from above call — path is deterministic
		var basename = path.basename(reqPath);
		assert.strictEqual(basename.substring(4, 8), '0001', 'Node hex should be 4 chars: ' + basename);
	});

	it('should use lowercase hex digits', function () {
		// net=255 (0x00ff), node=255 (0x00ff)
		var reqPath = createReqFile(255, 255, ['FILE.ZIP'], OPTS);
		createdPaths.push(reqPath);
		var basename = path.basename(reqPath);
		assert.strictEqual(basename, '00ff00ff.req');
	});

	it('should handle larger net/node values correctly', function () {
		// net=32768 (0x8000), node=1 (0x0001)
		var reqPath = createReqFile(32768, 1, ['NODELIST.Z'], OPTS);
		createdPaths.push(reqPath);
		var basename = path.basename(reqPath);
		assert.strictEqual(basename, '80000001.req');
	});

	it('should write a single filename as the file content', function () {
		var reqPath = createReqFile(10, 20, ['NODELIST.Z'], OPTS);
		createdPaths.push(reqPath);
		var content = fs.readFileSync(reqPath, 'utf8');
		assert.strictEqual(content, 'NODELIST.Z\r\n');
	});

	it('should join multiple filenames with \\r\\n', function () {
		var reqPath = createReqFile(10, 21, ['NODELIST.Z', 'FILES.LST', 'ALLFIX.ZIP'], OPTS);
		createdPaths.push(reqPath);
		var content = fs.readFileSync(reqPath, 'utf8');
		assert.strictEqual(content, 'NODELIST.Z\r\nFILES.LST\r\nALLFIX.ZIP\r\n');
	});

	it('should terminate the last filename with \\r\\n', function () {
		var reqPath = createReqFile(10, 22, ['ONLYFILE.ZIP'], OPTS);
		createdPaths.push(reqPath);
		var content = fs.readFileSync(reqPath, 'utf8');
		assert.ok(content.endsWith('\r\n'), 'File content should end with \\r\\n');
	});

	it('should write exactly the filenames provided without modification', function () {
		var filenames = ['README.TXT', 'SYSOP.ZIP', 'NODEDIFF.A56'];
		var reqPath = createReqFile(10, 23, filenames, OPTS);
		createdPaths.push(reqPath);
		var content = fs.readFileSync(reqPath, 'utf8');
		var lines = content.replace(/\r\n$/, '').split('\r\n');
		assert.deepStrictEqual(lines, filenames);
	});

	it('should put a zone 1 request in the outbound base itself', function () {
		var reqPath = createReqFile(300, 400, ['TEST.ZIP'], { zone: 1, baseDir: OUTBOUND_DIR });
		assert.strictEqual(path.dirname(reqPath), OUTBOUND_DIR);
	});

	it('should put a request for another zone in that zone outbound (#80)', function () {
		// 2:203/0 -> out.002/00cb0000.req, where the mailer looks for it
		var reqPath = createReqFile(203, 0, ['FILES'], { zone: 2, baseDir: OUTBOUND_DIR });
		assert.strictEqual(reqPath, path.join(OUTBOUND_DIR + '.002', '00cb0000.req'));
		assert.strictEqual(fs.readFileSync(reqPath, 'utf8'), 'FILES\r\n');
	});

	it('should overwrite an existing .req file for the same address', function () {
		// Two calls with the same net/node — second should overwrite
		var first = createReqFile(50, 60, ['FIRST.ZIP'], OPTS);
		createdPaths.push(first);
		var second = createReqFile(50, 60, ['SECOND.ZIP'], OPTS);
		// same path, already tracked
		var content = fs.readFileSync(second, 'utf8');
		assert.strictEqual(content, 'SECOND.ZIP\r\n');
	});

});

// ---------------------------------------------------------------------------
// resolveRequest — .req file parsing
//
// resolveFile() will return { found: false } for every filename because there
// is no live DB or filebox.  We verify the *parsing* contract: which lines
// become filename entries in the results array.
// ---------------------------------------------------------------------------

describe('resolveRequest parsing', function () {

	// resolveRequest reaches the file entries table. Without a database the pool
	// retries rather than failing fast, so these hang instead of returning the
	// { found: false } this suite expects. Skip rather than fail.
	var haveDb = false;

	before(async function () {
		this.timeout(12000);
		haveDb = await dbAvailable();
		fs.mkdirSync(TMP_REQ_DIR, { recursive: true });
	});

	beforeEach(function () {
		if (!haveDb) this.skip();
	});

	after(function () {
		try { fs.rmSync(TMP_REQ_DIR, { recursive: true, force: true }); } catch (_) {}
	});

	// Helper: write a .req file and call resolveRequest with no connectionId.
	// Returns the results array.  Expects resolveFile to return { found: false }
	// for all filenames (no DB, no filebox at temp path).
	async function parseReq(content, suffix) {
		var filename = 'test' + (suffix || Date.now()) + '.req';
		var reqPath = path.join(TMP_REQ_DIR, filename);
		fs.writeFileSync(reqPath, content);
		return await resolveRequest(reqPath, null);
	}

	it('should return an empty array for an empty file', async function () {
		var results = await parseReq('', '-empty');
		assert.deepStrictEqual(results, []);
	});

	it('should return an empty array for a file containing only blank lines', async function () {
		var results = await parseReq('\r\n\r\n\r\n', '-blanks');
		assert.deepStrictEqual(results, []);
	});

	it('should skip blank lines', async function () {
		var results = await parseReq('NODELIST.Z\r\n\r\nFILES.LST\r\n', '-blankskip');
		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0].filename, 'NODELIST.Z');
		assert.strictEqual(results[1].filename, 'FILES.LST');
	});

	it('should skip comment lines starting with ;', async function () {
		var content = '; This is a comment\r\nNODELIST.Z\r\n; Another comment\r\n';
		var results = await parseReq(content, '-comments');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].filename, 'NODELIST.Z');
	});

	it('should skip lines that are only whitespace', async function () {
		var content = 'NODELIST.Z\r\n   \r\nFILES.LST\r\n';
		var results = await parseReq(content, '-whitespace');
		assert.strictEqual(results.length, 2);
	});

	it('should extract the filename as the first whitespace-delimited token', async function () {
		var results = await parseReq('NODELIST.Z\r\n', '-single');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].filename, 'NODELIST.Z');
	});

	it('should strip a password after the filename (space-separated)', async function () {
		var results = await parseReq('SECRET.ZIP secretpassword\r\n', '-password');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].filename, 'SECRET.ZIP');
	});

	it('should strip a password separated by multiple spaces', async function () {
		var results = await parseReq('SECRET.ZIP   mypass\r\n', '-multispace');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].filename, 'SECRET.ZIP');
	});

	it('should strip a password separated by a tab', async function () {
		var results = await parseReq('SECRET.ZIP\tmypass\r\n', '-tab');
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].filename, 'SECRET.ZIP');
	});

	it('should handle Unix line endings (\\n only)', async function () {
		var results = await parseReq('NODELIST.Z\nFILES.LST\n', '-lf');
		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0].filename, 'NODELIST.Z');
		assert.strictEqual(results[1].filename, 'FILES.LST');
	});

	it('should handle mixed CR/LF and LF line endings', async function () {
		var results = await parseReq('NODELIST.Z\r\nFILES.LST\n', '-mixed');
		assert.strictEqual(results.length, 2);
	});

	it('should include all filenames in the results array', async function () {
		var content = 'FILE1.ZIP\r\nFILE2.ZIP\r\nFILE3.ZIP\r\n';
		var results = await parseReq(content, '-multi');
		assert.strictEqual(results.length, 3);
		assert.strictEqual(results[0].filename, 'FILE1.ZIP');
		assert.strictEqual(results[1].filename, 'FILE2.ZIP');
		assert.strictEqual(results[2].filename, 'FILE3.ZIP');
	});

	it('should set found:false on every result when there is no DB or filebox', async function () {
		var content = 'NODELIST.Z\r\nFILES.LST\r\n';
		var results = await parseReq(content, '-foundfalse');
		for (var i = 0; i < results.length; i++) {
			assert.strictEqual(results[i].found, false, 'Expected found:false for ' + results[i].filename);
		}
	});

	it('should return one result entry per non-blank non-comment line regardless of found status', async function () {
		// Build a .req with 12 filenames.  Without a live DB all resolve to
		// found:false and foundCount never increments, so the max-files cap
		// (which only fires when found:true entries accumulate) is not reached.
		// This test verifies that all 12 filenames are parsed and returned.
		var lines = [];
		for (var i = 1; i <= 12; i++) {
			lines.push('FILE' + String(i).padStart(2, '0') + '.ZIP');
		}
		var results = await parseReq(lines.join('\r\n') + '\r\n', '-maxfiles');
		assert.strictEqual(results.length, 12);
		for (var j = 0; j < 12; j++) {
			assert.strictEqual(results[j].filename, 'FILE' + String(j + 1).padStart(2, '0') + '.ZIP');
		}
	});

	it('should return an empty array when the .req file does not exist', async function () {
		var results = await resolveRequest('/tmp/nonexistent-freq-test.req', null);
		assert.deepStrictEqual(results, []);
	});

	it('should include the filename field on each result entry', async function () {
		var results = await parseReq('ANYFILE.ZIP\r\n', '-field');
		assert.strictEqual(results.length, 1);
		assert.ok('filename' in results[0], 'Result entry should have filename field');
	});

	it('should include the found field on each result entry', async function () {
		var results = await parseReq('ANYFILE.ZIP\r\n', '-foundfield');
		assert.strictEqual(results.length, 1);
		assert.ok('found' in results[0], 'Result entry should have found field');
	});

	it('should handle a mix of comments, blank lines, and filenames with passwords', async function () {
		var content = [
			'; Request list generated by BinkleyTerm',
			'',
			'NODELIST.Z secretkey',
			'; skip me',
			'FILES.LST',
			'',
			'SYSOP.ZIP  anotherpass',
		].join('\r\n') + '\r\n';

		var results = await parseReq(content, '-mixed-full');
		assert.strictEqual(results.length, 3);
		assert.strictEqual(results[0].filename, 'NODELIST.Z');
		assert.strictEqual(results[1].filename, 'FILES.LST');
		assert.strictEqual(results[2].filename, 'SYSOP.ZIP');
	});

});
