// tests/fileWildcards.test.js — Unit tests for file wildcard glob matching
//
// Tests the pure _globMatch function. No DB, no Redis.

import assert from 'assert';
import { _globMatch } from '../src/models/fileWildcards.js';

describe('fileWildcards._globMatch', function () {

	describe('basic patterns', function () {
		it('should match exact filename (case-insensitive)', function () {
			assert.strictEqual(_globMatch('NODELIST.Z06', 'nodelist.z06'), true);
			assert.strictEqual(_globMatch('NODELIST.Z06', 'NODELIST.Z06'), true);
		});

		it('should not match different filenames', function () {
			assert.strictEqual(_globMatch('NODELIST.Z06', 'NODEDIFF.Z06'), false);
		});
	});

	describe('* wildcard', function () {
		it('should match * for any characters', function () {
			assert.strictEqual(_globMatch('LORD*.*', 'LORD01.PKT'), true);
			assert.strictEqual(_globMatch('LORD*.*', 'LORDDATA.ZIP'), true);
			assert.strictEqual(_globMatch('LORD*.*', 'LORD.TXT'), true);
		});

		it('should not match * when prefix differs', function () {
			assert.strictEqual(_globMatch('LORD*.*', 'TW2002.PKT'), false);
		});

		it('should match *.EXT for extension matching', function () {
			assert.strictEqual(_globMatch('*.TIC', 'MYFILE.TIC'), true);
			assert.strictEqual(_globMatch('*.TIC', 'ANYTHING.TIC'), true);
			assert.strictEqual(_globMatch('*.TIC', 'MYFILE.PKT'), false);
		});

		it('should match leading wildcard', function () {
			assert.strictEqual(_globMatch('*DIFF.*', 'NODEDIFF.Z06'), true);
			assert.strictEqual(_globMatch('*DIFF.*', 'DIFF.001'), true);
		});
	});

	describe('? wildcard', function () {
		it('should match ? for single character', function () {
			assert.strictEqual(_globMatch('NODELIST.Z??', 'NODELIST.Z06'), true);
			assert.strictEqual(_globMatch('NODELIST.Z??', 'NODELIST.Z99'), true);
			assert.strictEqual(_globMatch('NODELIST.Z??', 'NODELIST.ZAB'), true);
		});

		it('should not match ? for wrong length', function () {
			assert.strictEqual(_globMatch('NODELIST.Z??', 'NODELIST.Z1'), false);
			assert.strictEqual(_globMatch('NODELIST.Z??', 'NODELIST.Z123'), false);
		});
	});

	describe('case insensitivity', function () {
		it('should match regardless of case', function () {
			assert.strictEqual(_globMatch('lord*.*', 'LORD01.PKT'), true);
			assert.strictEqual(_globMatch('LORD*.*', 'lord01.pkt'), true);
			assert.strictEqual(_globMatch('*.tic', 'FILE.TIC'), true);
		});
	});

	describe('edge cases', function () {
		it('should handle pattern with no wildcards', function () {
			assert.strictEqual(_globMatch('exact.txt', 'exact.txt'), true);
			assert.strictEqual(_globMatch('exact.txt', 'other.txt'), false);
		});

		it('should handle empty pattern', function () {
			assert.strictEqual(_globMatch('', ''), true);
			assert.strictEqual(_globMatch('', 'something'), false);
		});

		it('should handle * matching empty string', function () {
			assert.strictEqual(_globMatch('LORD*', 'LORD'), true);
		});

		it('should handle multiple * wildcards', function () {
			assert.strictEqual(_globMatch('*LORD*', 'MYLORDGAME'), true);
			assert.strictEqual(_globMatch('*LORD*', 'LORD'), true);
			assert.strictEqual(_globMatch('*LORD*', 'SOMETHING'), false);
		});

		it('should handle special regex chars in pattern', function () {
			assert.strictEqual(_globMatch('file(1).txt', 'file(1).txt'), true);
			assert.strictEqual(_globMatch('file[0].txt', 'file[0].txt'), true);
		});
	});
});
