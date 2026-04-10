// tests/ftnTosser.test.js — Unit tests for src/middleware/tossers/ftnTosser.js
//
// Currently covers isMailBundleFilename(), which gates whether the FTN
// tosser will extract an inbound archive. Mail bundles get extracted in
// place; anything else (TIC attachments, nodelist bundles, infopacks) must
// be left alone so other processors can handle it.
// Run: npx mocha tests/ftnTosser.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { isMailBundleFilename, formatKludge, extractMailBundle } from '../src/middleware/tossers/ftnTosser.js';

describe('isMailBundleFilename', function () {

	it('recognises standard day-of-week bundle extensions', function () {
		assert.strictEqual(isMailBundleFilename('00010001.mo0'), true);
		assert.strictEqual(isMailBundleFilename('00010001.tu0'), true);
		assert.strictEqual(isMailBundleFilename('00010001.we0'), true);
		assert.strictEqual(isMailBundleFilename('00010001.th0'), true);
		assert.strictEqual(isMailBundleFilename('00010001.fr0'), true);
		assert.strictEqual(isMailBundleFilename('00010001.sa0'), true);
		assert.strictEqual(isMailBundleFilename('00010001.su0'), true);
	});

	it('recognises hex-like counter suffixes 0-9 a-z', function () {
		assert.strictEqual(isMailBundleFilename('abcd1234.mo5'), true);
		assert.strictEqual(isMailBundleFilename('abcd1234.tuz'), true);
		assert.strictEqual(isMailBundleFilename('abcd1234.moa'), true);
		assert.strictEqual(isMailBundleFilename('abcd1234.sua'), true);
	});

	it('is case insensitive', function () {
		assert.strictEqual(isMailBundleFilename('00010001.MO0'), true);
		assert.strictEqual(isMailBundleFilename('00010001.Tu5'), true);
		assert.strictEqual(isMailBundleFilename('00010001.sUz'), true);
	});

	it('rejects generic ZIP files (TIC attachments)', function () {
		assert.strictEqual(isMailBundleFilename('fsxnet_nodelist.zip'), false);
		assert.strictEqual(isMailBundleFilename('echolist.zip'), false);
		assert.strictEqual(isMailBundleFilename('infopack.zip'), false);
		assert.strictEqual(isMailBundleFilename('somefile.ZIP'), false);
	});

	it('rejects TIC descriptor files and .pkt files', function () {
		assert.strictEqual(isMailBundleFilename('descriptor.tic'), false);
		assert.strictEqual(isMailBundleFilename('00010001.pkt'), false);
	});

	it('rejects extensions that are two characters (no counter)', function () {
		assert.strictEqual(isMailBundleFilename('00010001.mo'), false);
		assert.strictEqual(isMailBundleFilename('00010001.su'), false);
	});

	it('rejects extensions that are four characters', function () {
		assert.strictEqual(isMailBundleFilename('00010001.mo01'), false);
		assert.strictEqual(isMailBundleFilename('00010001.suzz'), false);
	});

	it('rejects non-day-of-week prefixes', function () {
		assert.strictEqual(isMailBundleFilename('00010001.xx0'), false);
		assert.strictEqual(isMailBundleFilename('00010001.ab5'), false);
		assert.strictEqual(isMailBundleFilename('00010001.zz9'), false);
	});

	it('rejects files with no extension', function () {
		assert.strictEqual(isMailBundleFilename('README'), false);
		assert.strictEqual(isMailBundleFilename('mo0'), false);
	});

	it('handles empty and null input safely', function () {
		assert.strictEqual(isMailBundleFilename(''), false);
		assert.strictEqual(isMailBundleFilename(null), false);
		assert.strictEqual(isMailBundleFilename(undefined), false);
	});

	it('uses only the last path segment extension', function () {
		assert.strictEqual(isMailBundleFilename('/some/dir/00010001.mo0'), true);
		assert.strictEqual(isMailBundleFilename('ftn/in/abcd1234.tu5'), true);
		assert.strictEqual(isMailBundleFilename('some.mo0/not_a_bundle.zip'), false);
	});
});

describe('formatKludge', function () {

	it('emits colon-space separator for standard kludges', function () {
		assert.strictEqual(formatKludge('MSGID', '1:2/3 abcdef01'), '\x01MSGID: 1:2/3 abcdef01');
		assert.strictEqual(formatKludge('REPLY', '1:2/3 abcdef01'), '\x01REPLY: 1:2/3 abcdef01');
		assert.strictEqual(formatKludge('PID', 'Canectic 0.9'), '\x01PID: Canectic 0.9');
		assert.strictEqual(formatKludge('TID', 'Canectic Tosser 0.1'), '\x01TID: Canectic Tosser 0.1');
		assert.strictEqual(formatKludge('TZUTC', '-0600'), '\x01TZUTC: -0600');
		assert.strictEqual(formatKludge('CHRS', 'UTF-8 4'), '\x01CHRS: UTF-8 4');
		assert.strictEqual(formatKludge('CODEPAGE', '437'), '\x01CODEPAGE: 437');
		assert.strictEqual(formatKludge('FLAGS', 'CFM'), '\x01FLAGS: CFM');
	});

	it('always inserts a space after the colon (regression guard)', function () {
		var out = formatKludge('MSGID', '1:2/3 abcdef01');
		// Character after the colon must be a space, not a digit
		var colonIdx = out.indexOf(':');
		assert.ok(colonIdx > 0);
		assert.strictEqual(out[colonIdx + 1], ' ',
			'Expected space after colon in kludge output, got: ' + JSON.stringify(out));
	});

	it('emits bare space separator for INTL/TOPT/FMPT/Via', function () {
		assert.strictEqual(formatKludge('INTL', '2:250/1 1:134/107'), '\x01INTL 2:250/1 1:134/107');
		assert.strictEqual(formatKludge('TOPT', '5'), '\x01TOPT 5');
		assert.strictEqual(formatKludge('FMPT', '3'), '\x01FMPT 3');
		assert.strictEqual(formatKludge('Via', '1:2/3 @20260410.123456 Canectic'), '\x01Via 1:2/3 @20260410.123456 Canectic');
		assert.strictEqual(formatKludge('VIA', '1:2/3 @20260410.123456 Canectic'), '\x01VIA 1:2/3 @20260410.123456 Canectic');
	});

	it('handles empty or null values safely', function () {
		assert.strictEqual(formatKludge('MSGID', ''), '\x01MSGID: ');
		assert.strictEqual(formatKludge('MSGID', null), '\x01MSGID: ');
		assert.strictEqual(formatKludge('MSGID', undefined), '\x01MSGID: ');
	});

	it('starts with the control-A byte', function () {
		assert.strictEqual(formatKludge('MSGID', 'x')[0], '\x01');
		assert.strictEqual(formatKludge('INTL', 'x')[0], '\x01');
	});
});

describe('extractMailBundle', function () {
	var workDir;

	function makeTestZip(zipName, entries) {
		var zip = new AdmZip();
		for (var entryName in entries) {
			zip.addFile(entryName, Buffer.from(entries[entryName]));
		}
		var zipPath = path.join(workDir, zipName);
		zip.writeZip(zipPath);
		return zipPath;
	}

	beforeEach(function () {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-extract-test-'));
	});

	afterEach(function () {
		try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
	});

	it('extracts .pkt entries and removes the bundle', function () {
		var zipPath = makeTestZip('00010001.mo0', {
			'abcd1234.pkt': 'FAKE PKT CONTENTS'
		});

		var res = extractMailBundle(zipPath, workDir);

		assert.strictEqual(res.err, null);
		assert.strictEqual(res.extracted, 1);
		assert.strictEqual(fs.existsSync(zipPath), false, 'bundle should be removed after extraction');
		assert.strictEqual(fs.existsSync(path.join(workDir, 'abcd1234.pkt')), true);
		assert.strictEqual(fs.readFileSync(path.join(workDir, 'abcd1234.pkt'), 'utf8'), 'FAKE PKT CONTENTS');
	});

	it('extracts multiple .pkt entries in a single bundle', function () {
		var zipPath = makeTestZip('00010001.tu5', {
			'00000001.pkt': 'PKT ONE',
			'00000002.pkt': 'PKT TWO',
			'00000003.pkt': 'PKT THREE'
		});

		var res = extractMailBundle(zipPath, workDir);

		assert.strictEqual(res.extracted, 3);
		assert.strictEqual(fs.existsSync(path.join(workDir, '00000001.pkt')), true);
		assert.strictEqual(fs.existsSync(path.join(workDir, '00000002.pkt')), true);
		assert.strictEqual(fs.existsSync(path.join(workDir, '00000003.pkt')), true);
	});

	it('extracts every entry inside a bundle (no content filtering)', function () {
		// Mail bundles are normally pkt-only but we never filter. The decision
		// about whether to extract at all is made by the caller based on the
		// bundle filename -- once we start, we extract faithfully.
		var zipPath = makeTestZip('00010001.mo0', {
			'valid.pkt':  'OK',
			'readme.txt': 'not a packet'
		});

		var res = extractMailBundle(zipPath, workDir);

		assert.strictEqual(res.extracted, 2);
		assert.strictEqual(fs.existsSync(path.join(workDir, 'valid.pkt')), true);
		assert.strictEqual(fs.existsSync(path.join(workDir, 'readme.txt')), true);
	});

	it('flattens directory entries so basename is used for output path', function () {
		var zipPath = makeTestZip('00010001.sa9', {
			'subdir/inside.pkt': 'FLAT'
		});

		var res = extractMailBundle(zipPath, workDir);

		assert.strictEqual(res.extracted, 1);
		assert.strictEqual(fs.existsSync(path.join(workDir, 'inside.pkt')), true);
		// No subdir should be created in the inbound dir
		assert.strictEqual(fs.existsSync(path.join(workDir, 'subdir')), false);
	});

	it('returns an error when the file is not a valid zip', function () {
		var badPath = path.join(workDir, '00010001.mo0');
		fs.writeFileSync(badPath, 'NOT A ZIP FILE');

		var res = extractMailBundle(badPath, workDir);

		assert.ok(res.err, 'expected an error on non-zip input');
		assert.strictEqual(res.extracted, 0);
		assert.strictEqual(fs.existsSync(badPath), true, 'bad bundle should be left in place for investigation');
	});
});
