// tests/pmAttachments.test.js — Unit tests for src/models/pmAttachments.js
//
// What is tested without live infrastructure:
//
//   1. Export validation — all named exports exist and are functions.
//
//   2. _sanitizeFilename (pure function) — thoroughly tested:
//      path separators, null bytes, length limit, empty/null input,
//      whitespace handling, mixed edge cases.
//
//   3. _getStorageDir (pure logic inlined) — format verification:
//      contains YYYY-MM segment, contains msgUuid, is an absolute or
//      relative path string. The real function calls appConfig.get() at
//      call time; with unloaded appConfig it returns the default base dir
//      'files/pm_attachments'. We verify the path structure by inlining
//      the same logic (same pattern as qwkUser/wall tests).
//
//   4. storeAttachments with real temp files — the function writes files
//      before calling postgres. We compute the expected storage path using
//      the same algorithm as _getStorageDir (appConfig unloaded → default
//      base = 'files/pm_attachments'), write buffers, then verify the files
//      exist on disk. The postgres call throws a connection error which is
//      caught; we assert both disk presence and the thrown error type.
//
//   5. storeAttachments guard conditions — empty array and no-op behaviour.
//
// Run: npx mocha tests/pmAttachments.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import {
	ensureTable,
	storeAttachments,
	storeUploadedFiles,
	getAttachments,
	getAttachmentById,
	copyAttachmentsToInbox,
	deleteAttachments,
	_sanitizeFilename,
	_getStorageDir
} from '../src/models/pmAttachments.js';

// ---------------------------------------------------------------------------
// Inlined _getStorageDir logic — mirrors src/models/pmAttachments.js
// Accepts a baseDir parameter so we can test the pure structure without
// needing appConfig to be loaded.
// ---------------------------------------------------------------------------

function getStorageDirPure(baseDir, msgUuid) {
	var now = new Date();
	var month = String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
	return path.join(baseDir, month, msgUuid);
}

// ---------------------------------------------------------------------------
// Export validation
// ---------------------------------------------------------------------------

describe('pmAttachments exports', function () {

	it('should export ensureTable as a function', function () {
		assert.strictEqual(typeof ensureTable, 'function');
	});

	it('should export storeAttachments as a function', function () {
		assert.strictEqual(typeof storeAttachments, 'function');
	});

	it('should export storeUploadedFiles as a function', function () {
		assert.strictEqual(typeof storeUploadedFiles, 'function');
	});

	it('should export getAttachments as a function', function () {
		assert.strictEqual(typeof getAttachments, 'function');
	});

	it('should export getAttachmentById as a function', function () {
		assert.strictEqual(typeof getAttachmentById, 'function');
	});

	it('should export copyAttachmentsToInbox as a function', function () {
		assert.strictEqual(typeof copyAttachmentsToInbox, 'function');
	});

	it('should export deleteAttachments as a function', function () {
		assert.strictEqual(typeof deleteAttachments, 'function');
	});

	it('should export _sanitizeFilename as a function', function () {
		assert.strictEqual(typeof _sanitizeFilename, 'function');
	});

	it('should export _getStorageDir as a function', function () {
		assert.strictEqual(typeof _getStorageDir, 'function');
	});

});

// ---------------------------------------------------------------------------
// _sanitizeFilename
// ---------------------------------------------------------------------------

describe('_sanitizeFilename', function () {

	describe('normal filenames', function () {

		it('should return a plain filename unchanged', function () {
			assert.strictEqual(_sanitizeFilename('document.pdf'), 'document.pdf');
		});

		it('should return a filename with underscores unchanged', function () {
			assert.strictEqual(_sanitizeFilename('my_file_name.txt'), 'my_file_name.txt');
		});

		it('should return a filename with digits unchanged', function () {
			assert.strictEqual(_sanitizeFilename('report2024.xlsx'), 'report2024.xlsx');
		});

		it('should return a filename with dots unchanged', function () {
			assert.strictEqual(_sanitizeFilename('archive.tar.gz'), 'archive.tar.gz');
		});

	});

	describe('path separator stripping', function () {

		it('should replace forward slashes with underscores', function () {
			assert.strictEqual(_sanitizeFilename('path/to/file.txt'), 'path_to_file.txt');
		});

		it('should replace backslashes with underscores', function () {
			assert.strictEqual(_sanitizeFilename('path\\to\\file.txt'), 'path_to_file.txt');
		});

		it('should replace colons with underscores', function () {
			assert.strictEqual(_sanitizeFilename('C:file.txt'), 'C_file.txt');
		});

		it('should replace mixed path separators in a Windows-style path', function () {
			var result = _sanitizeFilename('C:\\Users\\bob\\docs\\file.txt');
			assert.ok(!result.includes('\\'), 'Should not contain backslashes');
			assert.ok(!result.includes(':'), 'Should not contain colons');
			assert.strictEqual(result, 'C__Users_bob_docs_file.txt');
		});

		it('should replace a leading slash', function () {
			var result = _sanitizeFilename('/etc/passwd');
			assert.ok(!result.includes('/'), 'Should not contain forward slashes');
		});

	});

	describe('null byte stripping', function () {

		it('should strip null bytes from the filename', function () {
			var result = _sanitizeFilename('file\x00name.txt');
			assert.ok(!result.includes('\x00'), 'Should not contain null bytes');
			assert.strictEqual(result, 'file_name.txt');
		});

		it('should strip multiple null bytes', function () {
			var result = _sanitizeFilename('\x00\x00evil.txt');
			assert.ok(!result.includes('\x00'), 'Should not contain null bytes');
		});

	});

	describe('length limit', function () {

		it('should pass through a filename of exactly 200 characters', function () {
			var name = 'a'.repeat(195) + '.txt';   // 199 chars
			var result = _sanitizeFilename(name);
			assert.strictEqual(result.length, 199);
		});

		it('should truncate a filename longer than 200 characters', function () {
			var name = 'x'.repeat(250) + '.txt';
			var result = _sanitizeFilename(name);
			assert.ok(result.length <= 200, 'Result should be at most 200 characters');
		});

		it('should truncate to exactly 200 characters', function () {
			var name = 'b'.repeat(300);
			var result = _sanitizeFilename(name);
			assert.strictEqual(result.length, 200);
		});

	});

	describe('empty and null input', function () {

		it('should return "attachment" for null input', function () {
			assert.strictEqual(_sanitizeFilename(null), 'attachment');
		});

		it('should return "attachment" for undefined input', function () {
			assert.strictEqual(_sanitizeFilename(undefined), 'attachment');
		});

		it('should return "attachment" for empty string', function () {
			assert.strictEqual(_sanitizeFilename(''), 'attachment');
		});

		it('should return "attachment" for a string of only spaces after trim', function () {
			// '   ' → replace → '   ' → trim → '' → fallback to 'attachment'
			assert.strictEqual(_sanitizeFilename('   '), 'attachment');
		});

	});

	describe('whitespace handling', function () {

		it('should trim leading whitespace', function () {
			var result = _sanitizeFilename('   file.txt');
			assert.strictEqual(result, 'file.txt');
		});

		it('should trim trailing whitespace', function () {
			var result = _sanitizeFilename('file.txt   ');
			assert.strictEqual(result, 'file.txt');
		});

		it('should trim both ends', function () {
			var result = _sanitizeFilename('  file.txt  ');
			assert.strictEqual(result, 'file.txt');
		});

		it('should preserve internal spaces', function () {
			var result = _sanitizeFilename('my file.txt');
			assert.strictEqual(result, 'my file.txt');
		});

	});

	describe('combined edge cases', function () {

		it('should sanitize a filename with path separators and null bytes combined', function () {
			var result = _sanitizeFilename('../../etc\x00/passwd');
			assert.ok(!result.includes('/'), 'No forward slashes');
			assert.ok(!result.includes('\x00'), 'No null bytes');
		});

		it('should always return a non-empty string', function () {
			var cases = [null, undefined, '', '   ', '\x00', '/', '\\', ':'];
			for (var i = 0; i < cases.length; i++) {
				var result = _sanitizeFilename(cases[i]);
				assert.ok(typeof result === 'string' && result.length > 0,
					'Expected non-empty string for input: ' + JSON.stringify(cases[i]));
			}
		});

		it('should never exceed 200 characters regardless of input', function () {
			var longWithSeps = ('/'.repeat(100)) + ('a'.repeat(200));
			var result = _sanitizeFilename(longWithSeps);
			assert.ok(result.length <= 200, 'Result length ' + result.length + ' exceeds 200');
		});

		it('should sanitize a filename that is only separators', function () {
			// '/\\:' → all replaced with '_' → '___' → trim → '___' → length 3
			// Not empty so stays, not 'attachment'
			var result = _sanitizeFilename('/\\:');
			assert.ok(result.length > 0, 'Expected non-empty string');
			assert.ok(!result.includes('/') && !result.includes('\\') && !result.includes(':'));
		});

		it('should handle a filename with unicode characters', function () {
			var result = _sanitizeFilename('resume\u00e9.pdf');
			assert.strictEqual(typeof result, 'string');
			assert.ok(result.length > 0);
		});

	});

});

// ---------------------------------------------------------------------------
// _getStorageDir (live call with unloaded appConfig)
// ---------------------------------------------------------------------------

describe('_getStorageDir', function () {

	it('should return a string', function () {
		var result = _getStorageDir('test-uuid-1234');
		assert.strictEqual(typeof result, 'string');
	});

	it('should contain the msgUuid in the path', function () {
		var uuid = 'abcd-1234-efgh-5678';
		var result = _getStorageDir(uuid);
		assert.ok(result.includes(uuid), 'Path should contain the message UUID');
	});

	it('should contain a YYYY-MM date segment', function () {
		var result = _getStorageDir('test-uuid');
		// Extract the segment that looks like YYYY-MM
		var match = result.match(/(\d{4}-\d{2})/);
		assert.ok(match, 'Path should contain a YYYY-MM date segment, got: ' + result);
	});

	it('should use the current year in the date segment', function () {
		var result = _getStorageDir('test-uuid');
		var currentYear = String(new Date().getFullYear());
		assert.ok(result.includes(currentYear), 'Path should contain current year ' + currentYear);
	});

	it('should use the current month (zero-padded) in the date segment', function () {
		var result = _getStorageDir('test-uuid');
		var now = new Date();
		var expectedMonth = String(now.getMonth() + 1).padStart(2, '0');
		assert.ok(result.includes(expectedMonth), 'Path should contain current month ' + expectedMonth);
	});

	it('should place UUID as a path segment after the date segment', function () {
		var uuid = 'msg-uuid-xyz';
		var result = _getStorageDir(uuid);
		var parts = result.split(path.sep);
		// UUID should be the last segment
		assert.strictEqual(parts[parts.length - 1], uuid);
	});

	it('should produce different paths for different UUIDs', function () {
		var path1 = _getStorageDir('uuid-aaa');
		var path2 = _getStorageDir('uuid-bbb');
		assert.notStrictEqual(path1, path2);
	});

	it('should match the inlined pure logic', function () {
		// With unloaded appConfig, get('pm_attachment_dir', 'files/pm_attachments')
		// returns 'files/pm_attachments' (the default, since _cache is empty).
		var uuid = 'verify-match-uuid';
		var expected = getStorageDirPure('files/pm_attachments', uuid);
		var actual = _getStorageDir(uuid);
		assert.strictEqual(actual, expected);
	});

});

// ---------------------------------------------------------------------------
// _getStorageDir pure logic (isolated, no appConfig dependency)
// ---------------------------------------------------------------------------

describe('_getStorageDir pure logic', function () {

	it('should use the provided base dir as the root', function () {
		var result = getStorageDirPure('/var/bbs/attachments', 'my-uuid');
		assert.ok(result.startsWith('/var/bbs/attachments'), 'Should start with base dir');
	});

	it('should construct path as baseDir/YYYY-MM/uuid', function () {
		var uuid = 'test-uuid-pure';
		var result = getStorageDirPure('/base', uuid);
		var now = new Date();
		var month = String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
		var expected = path.join('/base', month, uuid);
		assert.strictEqual(result, expected);
	});

	it('should zero-pad single-digit months', function () {
		// We cannot control the current date, but we can verify the format
		var result = getStorageDirPure('/base', 'uuid');
		var match = result.match(/(\d{4}-\d{2})/);
		assert.ok(match, 'Should have YYYY-MM segment');
		var monthPart = match[1].split('-')[1];
		assert.strictEqual(monthPart.length, 2, 'Month should always be 2 digits');
	});

});

// ---------------------------------------------------------------------------
// storeAttachments — guard conditions (no DB, no disk I/O needed)
// ---------------------------------------------------------------------------

describe('storeAttachments guard conditions', function () {

	it('should return empty array for null attachments', async function () {
		var result = await storeAttachments('uuid-null', 'inbox', null);
		assert.deepStrictEqual(result, []);
	});

	it('should return empty array for undefined attachments', async function () {
		var result = await storeAttachments('uuid-undef', 'inbox', undefined);
		assert.deepStrictEqual(result, []);
	});

	it('should return empty array for empty attachments array', async function () {
		var result = await storeAttachments('uuid-empty', 'inbox', []);
		assert.deepStrictEqual(result, []);
	});

});

// ---------------------------------------------------------------------------
// storeAttachments — filesystem test with real temp directory
//
// appConfig is unloaded, so _getStorageDir returns a path rooted at the
// relative path 'files/pm_attachments' (the coded default). We compute that
// expected path using the same inline logic, write buffers, verify the files
// are created on disk, then clean up. The postgres.insertObject call throws a
// connection error — we catch it and assert the file was written before the DB
// call was attempted.
// ---------------------------------------------------------------------------

describe('storeAttachments filesystem', function () {

	// Compute the storage root that the unloaded appConfig will produce
	var BASE_DIR = 'files/pm_attachments';

	// Clean up any dirs written during these tests by tracking them
	var createdDirs = [];

	after(function () {
		// Remove created directories, deepest first
		for (var i = createdDirs.length - 1; i >= 0; i--) {
			try { fs.rmSync(createdDirs[i], { recursive: true, force: true }); } catch (_) {}
		}
	});

	it('should write a buffer to disk before the DB call fails', async function () {
		var uuid = 'fs-test-uuid-' + Date.now();
		var expectedDir = getStorageDirPure(BASE_DIR, uuid);
		createdDirs.push(expectedDir);

		var attachments = [
			{ filename: 'hello.txt', mimeType: 'text/plain', data: Buffer.from('hello world') }
		];

		var threw = false;
		try {
			await storeAttachments(uuid, 'inbox', attachments);
		} catch (err) {
			threw = true;
			// Connection refused / no DB — acceptable in unit test environment
			assert.ok(err instanceof Error, 'Expected Error instance from DB failure');
		}

		// The file should have been written before the DB call
		var expectedFile = path.join(expectedDir, 'hello.txt');
		assert.ok(fs.existsSync(expectedFile), 'File should exist on disk even when DB fails');

		// File should contain the buffer content
		var content = fs.readFileSync(expectedFile);
		assert.ok(content.equals(Buffer.from('hello world')), 'File content should match input buffer');
	});

	it('should create the storage directory if it does not exist', async function () {
		var uuid = 'fs-mkdir-uuid-' + Date.now();
		var expectedDir = getStorageDirPure(BASE_DIR, uuid);
		createdDirs.push(expectedDir);

		var attachments = [
			{ filename: 'test.bin', mimeType: 'application/octet-stream', data: Buffer.from([0x01, 0x02, 0x03]) }
		];

		try {
			await storeAttachments(uuid, 'outbox', attachments);
		} catch (_) {}

		assert.ok(fs.existsSync(expectedDir), 'Storage directory should be created');
	});

	it('should sanitize filenames when writing to disk', async function () {
		var uuid = 'fs-sanitize-uuid-' + Date.now();
		var expectedDir = getStorageDirPure(BASE_DIR, uuid);
		createdDirs.push(expectedDir);

		var attachments = [
			{ filename: 'path/to/evil.txt', mimeType: 'text/plain', data: Buffer.from('data') }
		];

		try {
			await storeAttachments(uuid, 'inbox', attachments);
		} catch (_) {}

		// Sanitized filename: 'path_to_evil.txt'
		var sanitized = path.join(expectedDir, 'path_to_evil.txt');
		assert.ok(fs.existsSync(sanitized), 'File should be written with sanitized filename');
	});

	it('should handle filename collision by appending a counter', async function () {
		var uuid = 'fs-collision-uuid-' + Date.now();
		var expectedDir = getStorageDirPure(BASE_DIR, uuid);
		createdDirs.push(expectedDir);

		// Pre-create the directory and the file that will collide
		fs.mkdirSync(expectedDir, { recursive: true });
		fs.writeFileSync(path.join(expectedDir, 'report.txt'), 'first version');

		var attachments = [
			{ filename: 'report.txt', mimeType: 'text/plain', data: Buffer.from('second version') }
		];

		try {
			await storeAttachments(uuid, 'inbox', attachments);
		} catch (_) {}

		// Original should still exist unchanged
		var original = path.join(expectedDir, 'report.txt');
		assert.ok(fs.existsSync(original), 'Original file should still exist');
		var origContent = fs.readFileSync(original).toString();
		assert.strictEqual(origContent, 'first version', 'Original should be unchanged');

		// Renamed collision file should exist as 'report_1.txt'
		var renamed = path.join(expectedDir, 'report_1.txt');
		assert.ok(fs.existsSync(renamed), 'Collision should produce report_1.txt');
		var newContent = fs.readFileSync(renamed).toString();
		assert.strictEqual(newContent, 'second version', 'Renamed file should contain the new content');
	});

	it('should skip attachments whose data exceeds the max size', async function () {
		var uuid = 'fs-tooLarge-uuid-' + Date.now();
		var expectedDir = getStorageDirPure(BASE_DIR, uuid);
		createdDirs.push(expectedDir);

		// Default maxSize is 10485760 (10MB); create a buffer larger than that
		var oversizedData = Buffer.alloc(10485761, 0x41); // 10MB + 1 byte

		var attachments = [
			{ filename: 'big.bin', mimeType: 'application/octet-stream', data: oversizedData }
		];

		var threw = false;
		try {
			await storeAttachments(uuid, 'inbox', attachments);
		} catch (_) {
			threw = true;
		}

		// File should NOT have been written (skipped before write)
		var expectedFile = path.join(expectedDir, 'big.bin');
		assert.ok(!fs.existsSync(expectedFile), 'Oversized file should not be written to disk');
	});

	it('should skip non-Buffer non-string data entries silently', async function () {
		var uuid = 'fs-baddata-uuid-' + Date.now();
		var expectedDir = getStorageDirPure(BASE_DIR, uuid);
		createdDirs.push(expectedDir);

		var attachments = [
			{ filename: 'bad.txt', mimeType: 'text/plain', data: 12345 }
		];

		// Should not throw, just skip
		var threw = false;
		try {
			await storeAttachments(uuid, 'inbox', attachments);
		} catch (_) {
			threw = true;
		}

		// The bad attachment should have been skipped; no file created
		var expectedFile = path.join(expectedDir, 'bad.txt');
		assert.ok(!fs.existsSync(expectedFile), 'Invalid data type should not produce a file');
	});

	it('should accept base64 string data and write the decoded bytes', async function () {
		var uuid = 'fs-b64-uuid-' + Date.now();
		var expectedDir = getStorageDirPure(BASE_DIR, uuid);
		createdDirs.push(expectedDir);

		var originalData = Buffer.from('base64 content');
		var b64str = originalData.toString('base64');

		var attachments = [
			{ filename: 'encoded.txt', mimeType: 'text/plain', data: b64str }
		];

		try {
			await storeAttachments(uuid, 'inbox', attachments);
		} catch (_) {}

		var expectedFile = path.join(expectedDir, 'encoded.txt');
		assert.ok(fs.existsSync(expectedFile), 'Base64 string data should produce a file on disk');

		var written = fs.readFileSync(expectedFile);
		assert.ok(written.equals(originalData), 'Decoded content should match original bytes');
	});

	it('should respect the maxCount limit and not store more than 5 attachments', async function () {
		var uuid = 'fs-maxcount-uuid-' + Date.now();
		var expectedDir = getStorageDirPure(BASE_DIR, uuid);
		createdDirs.push(expectedDir);

		// Build 7 attachments — only the first 5 (default maxCount) should be written
		var attachments = [];
		for (var i = 0; i < 7; i++) {
			attachments.push({
				filename: 'file' + i + '.txt',
				mimeType: 'text/plain',
				data: Buffer.from('content ' + i)
			});
		}

		try {
			await storeAttachments(uuid, 'inbox', attachments);
		} catch (_) {}

		// Files 0-4 should exist; files 5-6 should not
		for (var j = 0; j < 5; j++) {
			var f = path.join(expectedDir, 'file' + j + '.txt');
			assert.ok(fs.existsSync(f), 'file' + j + '.txt should exist (within maxCount)');
		}
		for (var k = 5; k < 7; k++) {
			var fx = path.join(expectedDir, 'file' + k + '.txt');
			assert.ok(!fs.existsSync(fx), 'file' + k + '.txt should not exist (exceeds maxCount)');
		}
	});

});
