// tests/bsoPaths.test.js -- where outbound files for an address live (#80).

import assert from 'assert';
import * as path from 'path';
import { outboundDirForZone, parseFtnAddress, reqFilePath } from '../src/utils/bsoPaths.js';

describe('bsoPaths', function () {

	describe('outboundDirForZone', function () {
		it('uses the base itself for zone 1', function () {
			assert.strictEqual(outboundDirForZone(1, '/bbs/ftn/out'), '/bbs/ftn/out');
		});
		it('appends a 3-digit hex zone for any other zone', function () {
			assert.strictEqual(outboundDirForZone(2, '/bbs/ftn/out'), '/bbs/ftn/out.002');
			assert.strictEqual(outboundDirForZone(21, '/bbs/ftn/out'), '/bbs/ftn/out.015');
		});
		it('treats a missing zone as zone 1', function () {
			assert.strictEqual(outboundDirForZone(undefined, '/o'), '/o');
		});
	});

	describe('parseFtnAddress', function () {
		it('accepts node 0, which a truthiness check refused', function () {
			assert.deepStrictEqual(parseFtnAddress('2:203/0'), { zone: 2, net: 203, node: 0, point: 0 });
		});
		it('reads a point and ignores a domain', function () {
			assert.deepStrictEqual(parseFtnAddress('1:2/3.4@fidonet'), { zone: 1, net: 2, node: 3, point: 4 });
		});
		it('refuses anything that is not an address', function () {
			assert.strictEqual(parseFtnAddress(''), null);
			assert.strictEqual(parseFtnAddress('2:203'), null);
			assert.strictEqual(parseFtnAddress(null), null);
		});
	});

	describe('reqFilePath', function () {
		it('names the file by hex net and node in the zone outbound', function () {
			assert.strictEqual(reqFilePath(2, 203, 0, '/o'), path.join('/o.002', '00cb0000.req'));
			assert.strictEqual(reqFilePath(1, 100, 200, '/o'), path.join('/o', '006400c8.req'));
		});
	});
});
