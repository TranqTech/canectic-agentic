// tests/ftnTosser.test.js — Unit tests for src/middleware/tossers/ftnTosser.js
//
// Currently covers isMailBundleFilename(), which gates whether the FTN
// tosser will extract an inbound archive. Mail bundles get extracted in
// place; anything else (TIC attachments, nodelist bundles, infopacks) must
// be left alone so other processors can handle it.
// Run: npx mocha tests/ftnTosser.test.js

import assert from 'assert';
import { isMailBundleFilename } from '../src/middleware/tossers/ftnTosser.js';

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
