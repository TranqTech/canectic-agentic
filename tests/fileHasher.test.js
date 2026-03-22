// tests/fileHasher.test.js — Unit tests for fileHasher.js
//
// Creates small temp files, computes hashes, verifies results against known values.
// Cleans up temp files in afterEach.
// Run: npx mocha tests/fileHasher.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as url from 'url';
import { computeCRC32, computeSHA256, computeHashes } from '../src/utils/fileHasher.js';

var __dirname = path.dirname(url.fileURLToPath(import.meta.url));
var TMP_DIR = path.join(__dirname, 'tmp');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTmpDir() {
	if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function writeTmpFile(name, content) {
	ensureTmpDir();
	var filePath = path.join(TMP_DIR, name);
	fs.writeFileSync(filePath, content);
	return filePath;
}

function removeTmpFile(filePath) {
	try { fs.unlinkSync(filePath); } catch (_) {}
}

// Compute expected SHA-256 inline for verification
function expectedSHA256(content) {
	return crypto.createHash('sha256').update(content).digest('hex');
}

// Compute expected CRC32 inline for verification
function expectedCRC32(content) {
	return (zlib.crc32(content) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// ---------------------------------------------------------------------------
// computeSHA256
// ---------------------------------------------------------------------------

describe('computeSHA256', function () {
	var tmpFiles = [];

	afterEach(function () {
		tmpFiles.forEach(removeTmpFile);
		tmpFiles = [];
	});

	it('should compute sha256 of a small ASCII file', function () {
		var content = Buffer.from('Hello, BBS!');
		var filePath = writeTmpFile('sha256-ascii.txt', content);
		tmpFiles.push(filePath);

		var got = computeSHA256(filePath);
		var want = expectedSHA256(content);
		assert.strictEqual(got, want);
	});

	it('should return a lowercase hex string of 64 characters', function () {
		var content = Buffer.from('test data');
		var filePath = writeTmpFile('sha256-format.txt', content);
		tmpFiles.push(filePath);

		var got = computeSHA256(filePath);
		assert.match(got, /^[0-9a-f]{64}$/);
	});

	it('should compute sha256 of a binary file', function () {
		var content = Buffer.alloc(256);
		for (var i = 0; i < 256; i++) content[i] = i;
		var filePath = writeTmpFile('sha256-binary.bin', content);
		tmpFiles.push(filePath);

		var got = computeSHA256(filePath);
		var want = expectedSHA256(content);
		assert.strictEqual(got, want);
	});

	it('should compute sha256 of an empty file', function () {
		var content = Buffer.alloc(0);
		var filePath = writeTmpFile('sha256-empty.txt', content);
		tmpFiles.push(filePath);

		var got = computeSHA256(filePath);
		// Known SHA-256 of empty string
		assert.strictEqual(got, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('should produce different hashes for different content', function () {
		var f1 = writeTmpFile('sha256-diff1.txt', Buffer.from('content one'));
		var f2 = writeTmpFile('sha256-diff2.txt', Buffer.from('content two'));
		tmpFiles.push(f1, f2);

		assert.notStrictEqual(computeSHA256(f1), computeSHA256(f2));
	});
});

// ---------------------------------------------------------------------------
// computeCRC32
// ---------------------------------------------------------------------------

describe('computeCRC32', function () {
	var tmpFiles = [];

	afterEach(function () {
		tmpFiles.forEach(removeTmpFile);
		tmpFiles = [];
	});

	it('should compute crc32 of a small ASCII file', function () {
		var content = Buffer.from('Hello, BBS!');
		var filePath = writeTmpFile('crc32-ascii.txt', content);
		tmpFiles.push(filePath);

		var got = computeCRC32(filePath);
		var want = expectedCRC32(content);
		assert.strictEqual(got, want);
	});

	it('should return an uppercase hex string of 8 characters', function () {
		var content = Buffer.from('test data');
		var filePath = writeTmpFile('crc32-format.txt', content);
		tmpFiles.push(filePath);

		var got = computeCRC32(filePath);
		assert.match(got, /^[0-9A-F]{8}$/);
	});

	it('should compute crc32 of an empty file', function () {
		var content = Buffer.alloc(0);
		var filePath = writeTmpFile('crc32-empty.txt', content);
		tmpFiles.push(filePath);

		var got = computeCRC32(filePath);
		// CRC-32 of empty data is 0x00000000
		assert.strictEqual(got, '00000000');
	});

	it('should produce different crc32 for different content', function () {
		var f1 = writeTmpFile('crc32-diff1.txt', Buffer.from('abc'));
		var f2 = writeTmpFile('crc32-diff2.txt', Buffer.from('xyz'));
		tmpFiles.push(f1, f2);

		assert.notStrictEqual(computeCRC32(f1), computeCRC32(f2));
	});
});

// ---------------------------------------------------------------------------
// computeHashes
// ---------------------------------------------------------------------------

describe('computeHashes', function () {
	var tmpFiles = [];

	afterEach(function () {
		tmpFiles.forEach(removeTmpFile);
		tmpFiles = [];
	});

	it('should return object with both crc32 and sha256 keys', function () {
		var content = Buffer.from('dual hash test');
		var filePath = writeTmpFile('hashes-both.txt', content);
		tmpFiles.push(filePath);

		var r = computeHashes(filePath);
		assert.ok('crc32' in r, 'should have crc32 key');
		assert.ok('sha256' in r, 'should have sha256 key');
	});

	it('should return consistent values matching individual functions', function () {
		var content = Buffer.from('consistency check');
		var filePath = writeTmpFile('hashes-consistent.txt', content);
		tmpFiles.push(filePath);

		var r = computeHashes(filePath);
		assert.strictEqual(r.crc32, computeCRC32(filePath));
		assert.strictEqual(r.sha256, computeSHA256(filePath));
	});

	it('should have crc32 matching expected format (8 uppercase hex)', function () {
		var content = Buffer.from('format check');
		var filePath = writeTmpFile('hashes-format.txt', content);
		tmpFiles.push(filePath);

		var r = computeHashes(filePath);
		assert.match(r.crc32, /^[0-9A-F]{8}$/);
	});

	it('should have sha256 matching expected format (64 lowercase hex)', function () {
		var content = Buffer.from('format check');
		var filePath = writeTmpFile('hashes-format2.txt', content);
		tmpFiles.push(filePath);

		var r = computeHashes(filePath);
		assert.match(r.sha256, /^[0-9a-f]{64}$/);
	});
});
