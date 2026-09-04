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
import { isMailBundleFilename, formatKludge, bareFtnAddress, extractMailBundle, processMessageText } from '../src/middleware/tossers/ftnTosser.js';

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

describe('bareFtnAddress', function () {
	it('strips a 5D domain suffix', function () {
		assert.strictEqual(bareFtnAddress('21:1/100@fsxnet'), '21:1/100');
		assert.strictEqual(bareFtnAddress('1:134/101@fidonet'), '1:134/101');
	});

	it('preserves the point when stripping the domain', function () {
		assert.strictEqual(bareFtnAddress('1:134/101.2@fidonet'), '1:134/101.2');
		assert.strictEqual(bareFtnAddress('21:1/100.2@fsxnet'), '21:1/100.2');
	});

	it('leaves bare 4D addresses untouched', function () {
		assert.strictEqual(bareFtnAddress('1:134/101'), '1:134/101');
		assert.strictEqual(bareFtnAddress('1:134/101.2'), '1:134/101.2');
	});

	it('handles empty or null values safely', function () {
		assert.strictEqual(bareFtnAddress(''), '');
		assert.strictEqual(bareFtnAddress(null), '');
		assert.strictEqual(bareFtnAddress(undefined), '');
	});

	it('trims surrounding whitespace', function () {
		assert.strictEqual(bareFtnAddress('  1:2/3@net  '), '1:2/3');
		assert.strictEqual(bareFtnAddress('  1:2/3  '), '1:2/3');
	});

	it('builds an INTL value free of domain suffixes', function () {
		var intl = bareFtnAddress('21:1/100@fsxnet') + ' ' + bareFtnAddress('21:1/2@fsxnet');
		assert.strictEqual(intl, '21:1/100 21:1/2');
		assert.strictEqual(formatKludge('INTL', intl), '\x01INTL 21:1/100 21:1/2');
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

// ---------------------------------------------------------------------------
// processMessageText — splits an FTS-0004 message body into kludges and text
// ---------------------------------------------------------------------------

describe('processMessageText', function () {

	// Minimal stand-in for the message object the packet reader builds.
	function msg(rawText, overrides) {
		var base = {
			RawText: rawText,
			OptionalAttributes: [],
			Source: '',
			Destination: '',
			SourceNet: 2,
			SourceNode: 3,
			DestinationNet: 5,
			DestinationNode: 6,
		};
		return Object.assign(base, overrides || {});
	}

	function attrValue(m, name) {
		var found = m.OptionalAttributes.find(function (a) { return a.attribute === name; });
		return found ? found.value : undefined;
	}

	describe('body extraction', function () {

		it('keeps plain text lines in the body', function () {
			var m = msg('line one\rline two\r');
			processMessageText(m);
			assert.strictEqual(m.BodyText, 'line one\rline two\r');
		});

		it('normalises CRLF to bare CR', function () {
			var m = msg('line one\r\nline two\r\n');
			processMessageText(m);
			assert.strictEqual(m.BodyText, 'line one\rline two\r');
		});

		it('normalises lone LF to bare CR', function () {
			var m = msg('line one\nline two\n');
			processMessageText(m);
			assert.strictEqual(m.BodyText, 'line one\rline two\r');
		});

		it('strips reverse-CR 0x8D soft wrap characters', function () {
			var m = msg('soft\x8Dwrap\r');
			processMessageText(m);
			assert.strictEqual(m.BodyText, 'softwrap\r');
		});

		it('mirrors the body into utf8', function () {
			var m = msg('body\r');
			processMessageText(m);
			assert.strictEqual(m.utf8, m.BodyText);
		});

		it('keeps kludge lines out of the body', function () {
			var m = msg('\x01MSGID: 1:2/3 abc\rvisible\r');
			processMessageText(m);
			assert.strictEqual(m.BodyText.indexOf('MSGID'), -1);
			assert.strictEqual(m.BodyText, 'visible\r');
		});
	});

	describe('kludge extraction', function () {

		it('extracts MSGID', function () {
			var m = msg('\x01MSGID: 1:2/3 5f2a1b3c\rbody\r');
			processMessageText(m);
			assert.strictEqual(m.MsgId, '1:2/3 5f2a1b3c');
		});

		it('extracts REPLY', function () {
			var m = msg('\x01REPLY: 1:2/4 aabbccdd\rbody\r');
			processMessageText(m);
			assert.strictEqual(m.ReplyTo, '1:2/4 aabbccdd');
		});

		it('extracts PID and TID as the tosser id', function () {
			var a = msg('\x01PID: Mystic/1.12\rbody\r');
			processMessageText(a);
			assert.strictEqual(a.TosserId, 'Mystic/1.12');

			var b = msg('\x01TID: hpt/1.9\rbody\r');
			processMessageText(b);
			assert.strictEqual(b.TosserId, 'hpt/1.9');
		});

		it('extracts TZUTC', function () {
			var m = msg('\x01TZUTC: -0500\rbody\r');
			processMessageText(m);
			assert.strictEqual(m.TZUTC, '-0500');
		});

		it('extracts PATH', function () {
			var m = msg('\x01PATH: 2/3 4\rbody\r');
			processMessageText(m);
			assert.strictEqual(m.Path, '2/3 4');
		});

		it('records unrecognised kludges as optional attributes', function () {
			var m = msg('\x01CHRS: CP437 2\rbody\r');
			processMessageText(m);
			assert.strictEqual(attrValue(m, 'CHRS'), 'CP437 2');
		});

		it('ignores a control line with no colon', function () {
			var m = msg('\x01FLAGS NPD\rbody\r');
			processMessageText(m);
			assert.strictEqual(m.BodyText, 'body\r');
			assert.strictEqual(m.OptionalAttributes.length, 0);
		});
	});

	describe('AREA and SEEN-BY', function () {

		it('marks a message with an AREA line as echomail', function () {
			var m = msg('AREA:TEST_ECHO\rbody\r');
			processMessageText(m);
			assert.strictEqual(m.Type, 'Echomail');
			assert.strictEqual(m.AreaTag, 'TEST_ECHO');
		});

		it('tolerates a space after AREA:', function () {
			var m = msg('AREA: TEST_ECHO\rbody\r');
			processMessageText(m);
			assert.strictEqual(m.AreaTag, 'TEST_ECHO');
		});

		it('extracts a space-separated SEEN-BY line', function () {
			var m = msg('body\rSEEN-BY 2/3 4 5\r');
			processMessageText(m);
			assert.strictEqual(m.SeenBy, '2/3 4 5');
			assert.strictEqual(m.BodyText.indexOf('SEEN-BY'), -1);
		});
	});

	describe('INTL kludge', function () {

		// FTS-0001 orders INTL as "<destination> <origin>".

		it('parses the colonless form', function () {
			var m = msg('\x01INTL 1:2/3 4:5/6\rbody\r');
			processMessageText(m);
			assert.strictEqual(m.Destination, '1:2/3');
			assert.strictEqual(m.Source, '4:5/6');
		});

		it('parses the colon form without throwing', function () {
			// This form previously reassigned two consts and threw, which
			// failed the whole packet read rather than one message.
			var m = msg('\x01INTL: 1:2/3 4:5/6\rbody\r');
			assert.doesNotThrow(function () { processMessageText(m); });
			assert.strictEqual(m.Destination, '1:2/3');
			assert.strictEqual(m.Source, '4:5/6');
		});

		it('produces the same result for both forms', function () {
			var a = msg('\x01INTL 1:2/3 4:5/6\rbody\r');
			var b = msg('\x01INTL: 1:2/3 4:5/6\rbody\r');
			processMessageText(a);
			processMessageText(b);
			assert.strictEqual(a.Source, b.Source);
			assert.strictEqual(a.Destination, b.Destination);
			assert.strictEqual(attrValue(a, 'INTL'), attrValue(b, 'INTL'));
		});

		it('records INTL as a single normalised optional attribute', function () {
			var m = msg('\x01INTL: 1:2/3 4:5/6\rbody\r');
			processMessageText(m);
			assert.strictEqual(attrValue(m, 'INTL'), '1:2/3 4:5/6');
		});

		it('keeps the body intact alongside an INTL kludge', function () {
			var m = msg('\x01INTL: 1:2/3 4:5/6\rreal body here\r');
			processMessageText(m);
			assert.strictEqual(m.BodyText, 'real body here\r');
		});
	});

	describe('address fallback', function () {

		it('synthesises Source and Destination when no kludge supplies them', function () {
			var m = msg('body\r');
			processMessageText(m);
			assert.strictEqual(m.Source, '1:2/3');
			assert.strictEqual(m.Destination, '1:5/6');
		});

		it('does not overwrite an address that is already set', function () {
			var m = msg('body\r', { Source: '9:9/9', Destination: '8:8/8' });
			processMessageText(m);
			assert.strictEqual(m.Source, '9:9/9');
			assert.strictEqual(m.Destination, '8:8/8');
		});
	});
});
