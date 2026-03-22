// tests/fileDescExtractor.test.js — Unit tests for fileDescExtractor.js
//
// Creates test ZIP files containing FILE_ID.DIZ, verifies extraction.
// Tests non-ZIP files, missing files, and applyDescriptions() logic.
// Run: npx mocha tests/fileDescExtractor.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import AdmZip from 'adm-zip';
import { extractDizFromZip, extractDescription, applyDescriptions } from '../src/utils/fileDescExtractor.js';

var __dirname = path.dirname(url.fileURLToPath(import.meta.url));
var TMP_DIR = path.join(__dirname, 'tmp');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTmpDir() {
	if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function makeZipWithDiz(zipPath, dizContent) {
	ensureTmpDir();
	var zip = new AdmZip();
	zip.addFile('FILE_ID.DIZ', Buffer.from(dizContent, 'utf8'));
	zip.writeZip(zipPath);
	return zipPath;
}

function makeZipWithoutDiz(zipPath) {
	ensureTmpDir();
	var zip = new AdmZip();
	zip.addFile('README.TXT', Buffer.from('No DIZ here', 'utf8'));
	zip.writeZip(zipPath);
	return zipPath;
}

function makeZipWithNestedDiz(zipPath, dizContent) {
	ensureTmpDir();
	var zip = new AdmZip();
	zip.addFile('docs/FILE_ID.DIZ', Buffer.from(dizContent, 'utf8'));
	zip.writeZip(zipPath);
	return zipPath;
}

function cleanup(filePath) {
	try { fs.unlinkSync(filePath); } catch (_) {}
}

// ---------------------------------------------------------------------------
// extractDizFromZip
// ---------------------------------------------------------------------------

describe('extractDizFromZip', function () {
	var tmpFiles = [];

	afterEach(function () {
		tmpFiles.forEach(cleanup);
		tmpFiles = [];
	});

	it('should extract FILE_ID.DIZ content from a ZIP', function () {
		var zipPath = path.join(TMP_DIR, 'test-diz.zip');
		makeZipWithDiz(zipPath, 'My cool BBS program v1.0\nLine two');
		tmpFiles.push(zipPath);

		var result = extractDizFromZip(zipPath);
		assert.notStrictEqual(result, null);
		assert.ok(result.includes('My cool BBS program'));
	});

	it('should return null when ZIP has no FILE_ID.DIZ', function () {
		var zipPath = path.join(TMP_DIR, 'no-diz.zip');
		makeZipWithoutDiz(zipPath);
		tmpFiles.push(zipPath);

		var result = extractDizFromZip(zipPath);
		assert.strictEqual(result, null);
	});

	it('should return null for a non-ZIP file (plain text)', function () {
		var txtPath = path.join(TMP_DIR, 'notazip.txt');
		ensureTmpDir();
		fs.writeFileSync(txtPath, 'just plain text content');
		tmpFiles.push(txtPath);

		var result = extractDizFromZip(txtPath);
		assert.strictEqual(result, null);
	});

	it('should return null for a non-existent file', function () {
		var result = extractDizFromZip('/tmp/nonexistent_file_xyz.zip');
		assert.strictEqual(result, null);
	});

	it('should find FILE_ID.DIZ case-insensitively', function () {
		// adm-zip normalizes entry names — DIZ extraction uses toUpperCase() comparison
		var zipPath = path.join(TMP_DIR, 'case-diz.zip');
		ensureTmpDir();
		var zip = new AdmZip();
		zip.addFile('file_id.diz', Buffer.from('lowercase diz', 'utf8'));
		zip.writeZip(zipPath);
		tmpFiles.push(zipPath);

		var result = extractDizFromZip(zipPath);
		assert.notStrictEqual(result, null);
		assert.ok(result.includes('lowercase diz'));
	});

	it('should find FILE_ID.DIZ in a subdirectory of the ZIP', function () {
		var zipPath = path.join(TMP_DIR, 'nested-diz.zip');
		makeZipWithNestedDiz(zipPath, 'Nested DIZ content');
		tmpFiles.push(zipPath);

		var result = extractDizFromZip(zipPath);
		assert.notStrictEqual(result, null);
		assert.ok(result.includes('Nested DIZ content'));
	});
});

// ---------------------------------------------------------------------------
// extractDescription
// ---------------------------------------------------------------------------

describe('extractDescription', function () {
	var tmpFiles = [];

	afterEach(function () {
		tmpFiles.forEach(cleanup);
		tmpFiles = [];
	});

	it('should return null fields for null filePath', function () {
		var r = extractDescription(null);
		assert.strictEqual(r.long_desc, null);
		assert.strictEqual(r.short_desc, null);
	});

	it('should return null fields for non-existent file', function () {
		var r = extractDescription('/tmp/nonexistent_xyz.zip');
		assert.strictEqual(r.long_desc, null);
	});

	it('should return null fields for file without FILE_ID.DIZ', function () {
		var zipPath = path.join(TMP_DIR, 'nodesc.zip');
		makeZipWithoutDiz(zipPath);
		tmpFiles.push(zipPath);

		var r = extractDescription(zipPath);
		assert.strictEqual(r.long_desc, null);
		assert.strictEqual(r.short_desc, null);
	});

	it('should extract long_desc from ZIP with FILE_ID.DIZ', function () {
		var zipPath = path.join(TMP_DIR, 'desc-full.zip');
		makeZipWithDiz(zipPath, 'SuperGame v2.0\nThe best game ever');
		tmpFiles.push(zipPath);

		var r = extractDescription(zipPath);
		assert.notStrictEqual(r.long_desc, null);
		assert.ok(r.long_desc.includes('SuperGame'));
	});

	it('should derive short_desc from first non-blank line', function () {
		var diz = '\nFirst real line\nSecond line';
		var zipPath = path.join(TMP_DIR, 'desc-short.zip');
		makeZipWithDiz(zipPath, diz);
		tmpFiles.push(zipPath);

		var r = extractDescription(zipPath);
		assert.strictEqual(r.short_desc, 'First real line');
	});

	it('should truncate short_desc at 255 chars with ellipsis', function () {
		var longFirstLine = 'A'.repeat(300);
		var zipPath = path.join(TMP_DIR, 'desc-trunc.zip');
		makeZipWithDiz(zipPath, longFirstLine);
		tmpFiles.push(zipPath);

		var r = extractDescription(zipPath);
		assert.notStrictEqual(r.short_desc, null);
		assert.ok(r.short_desc.length <= 255);
		assert.ok(r.short_desc.endsWith('...'));
	});

	it('should normalize CRLF to LF in long_desc', function () {
		var zipPath = path.join(TMP_DIR, 'desc-crlf.zip');
		makeZipWithDiz(zipPath, 'Line one\r\nLine two\r\n');
		tmpFiles.push(zipPath);

		var r = extractDescription(zipPath);
		assert.notStrictEqual(r.long_desc, null);
		assert.ok(!r.long_desc.includes('\r\n'), 'CRLF should be normalized to LF');
	});

	it('should populate long_desc_html', function () {
		var zipPath = path.join(TMP_DIR, 'desc-html.zip');
		makeZipWithDiz(zipPath, 'Plain text DIZ\nSecond line');
		tmpFiles.push(zipPath);

		var r = extractDescription(zipPath);
		// long_desc_html should be non-null (either from formatBodyHtml or fallback)
		assert.notStrictEqual(r.long_desc_html, null);
	});
});

// ---------------------------------------------------------------------------
// applyDescriptions
// ---------------------------------------------------------------------------

describe('applyDescriptions', function () {
	var tmpFiles = [];

	afterEach(function () {
		tmpFiles.forEach(cleanup);
		tmpFiles = [];
	});

	it('should populate empty entry object fields from ZIP', function () {
		var zipPath = path.join(TMP_DIR, 'apply-desc.zip');
		makeZipWithDiz(zipPath, 'MyTool v1.0\nA useful tool');
		tmpFiles.push(zipPath);

		var entry = { long_desc: null, long_desc_html: null, short_desc: null };
		var changed = applyDescriptions(entry, zipPath);

		assert.strictEqual(changed, true);
		assert.notStrictEqual(entry.long_desc, null);
		assert.notStrictEqual(entry.short_desc, null);
	});

	it('should NOT overwrite existing long_desc', function () {
		var zipPath = path.join(TMP_DIR, 'apply-no-overwrite.zip');
		makeZipWithDiz(zipPath, 'DIZ content here');
		tmpFiles.push(zipPath);

		var entry = { long_desc: 'Existing desc', long_desc_html: null, short_desc: null };
		applyDescriptions(entry, zipPath);

		assert.strictEqual(entry.long_desc, 'Existing desc');
	});

	it('should NOT overwrite existing short_desc', function () {
		var zipPath = path.join(TMP_DIR, 'apply-no-overwrite-short.zip');
		makeZipWithDiz(zipPath, 'DIZ content here');
		tmpFiles.push(zipPath);

		var entry = { long_desc: null, long_desc_html: null, short_desc: 'Existing short' };
		applyDescriptions(entry, zipPath);

		assert.strictEqual(entry.short_desc, 'Existing short');
	});

	it('should return false when no ZIP and nothing set', function () {
		var entry = { long_desc: null, long_desc_html: null, short_desc: null };
		var changed = applyDescriptions(entry, '/tmp/nonexistent_xyz.zip');
		assert.strictEqual(changed, false);
	});

	it('should return false when all fields already populated', function () {
		var zipPath = path.join(TMP_DIR, 'apply-all-set.zip');
		makeZipWithDiz(zipPath, 'DIZ content here');
		tmpFiles.push(zipPath);

		var entry = {
			long_desc:      'Already set',
			long_desc_html: '<p>Already set</p>',
			short_desc:     'Short already set'
		};
		var changed = applyDescriptions(entry, zipPath);
		assert.strictEqual(changed, false);
	});
});
