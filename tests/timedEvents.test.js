// tests/timedEvents.test.js — Unit tests for timed events constants
//
// Tests the pure exports that don't require DB.

import assert from 'assert';
import { VALID_LAUNCH_TYPES, LAUNCH_TYPE_LABELS } from '../src/models/timedEvents.js';

describe('timedEvents', function () {

	describe('VALID_LAUNCH_TYPES', function () {
		it('should be an array', function () {
			assert.ok(Array.isArray(VALID_LAUNCH_TYPES));
		});

		it('should include NativeCommand', function () {
			assert.ok(VALID_LAUNCH_TYPES.includes('NativeCommand'));
		});

		it('should include Dosemu', function () {
			assert.ok(VALID_LAUNCH_TYPES.includes('Dosemu'));
		});

		it('should not include PTY types (no terminal for timed events)', function () {
			assert.ok(!VALID_LAUNCH_TYPES.includes('NativeShell'));
			assert.ok(!VALID_LAUNCH_TYPES.includes('DosemuPty'));
		});
	});

	describe('LAUNCH_TYPE_LABELS', function () {
		it('should have labels for all valid types', function () {
			for (var type of VALID_LAUNCH_TYPES) {
				assert.ok(LAUNCH_TYPE_LABELS[type], 'should have label for ' + type);
			}
		});

		it('should be human-readable strings', function () {
			for (var key in LAUNCH_TYPE_LABELS) {
				assert.ok(typeof LAUNCH_TYPE_LABELS[key] === 'string');
				assert.ok(LAUNCH_TYPE_LABELS[key].length > 0);
			}
		});
	});
});
