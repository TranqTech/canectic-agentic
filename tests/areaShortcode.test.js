// tests/areaShortcode.test.js: which message area shortcodes can exist.
//
// A shortcode names the area's tables, mb_<shortcode>_msgs and
// mb_<shortcode>_threads, unquoted in SQL. Typing FOO-BAR into the Add Area
// form made the CREATE TABLE a syntax error; newArea rolled the area row back
// and the route rendered a page that never showed the reason, so the form
// appeared to do nothing. The shortcode is now checked before anything is
// written.
//
// The length limit is the quieter half: Postgres truncates identifiers to 63
// bytes without failing, and the two table names differ only at the end, so a
// long enough shortcode gave both tables the SAME name. Batch subscribe
// derived shortcodes up to 64 characters.

import assert from 'assert';
import { AREA_SHORTCODE_MAX, areaShortcodeProblem, shortcodeFromAreatag } from '../src/utils/areaShortcode.js';

describe('area shortcodes', function () {
	it('accepts letters, digits and underscores', function () {
		assert.strictEqual(areaShortcodeProblem('FSX_GEN'), null);
		assert.strictEqual(areaShortcodeProblem('fido2'), null);
		assert.strictEqual(areaShortcodeProblem('9TEST'), null);
	});

	it('refuses a hyphen, and suggests the underscore form', function () {
		var problem = areaShortcodeProblem('FOO-BAR');
		assert.ok(problem, 'FOO-BAR must be refused');
		assert.match(problem, /letters, digits and underscores/);
		assert.match(problem, /FOO_BAR/);
	});

	it('refuses anything else that is not an identifier character', function () {
		for (var bad of ['A.B', 'A B', 'A;DROP', 'ÄREA', 'a"b']) {
			assert.ok(areaShortcodeProblem(bad), bad + ' must be refused');
		}
	});

	it('refuses an empty shortcode', function () {
		assert.ok(areaShortcodeProblem(''));
		assert.ok(areaShortcodeProblem('   '));
		assert.ok(areaShortcodeProblem(undefined));
	});

	it('keeps both table names inside the 63 byte identifier limit', function () {
		var longest = 'A'.repeat(AREA_SHORTCODE_MAX);
		assert.strictEqual(areaShortcodeProblem(longest), null);
		assert.ok(('mb_' + longest + '_threads').length <= 63);
		assert.ok(areaShortcodeProblem(longest + 'A'), 'one past the limit must be refused');
	});

	it('derives a valid shortcode from any areatag', function () {
		assert.strictEqual(shortcodeFromAreatag('fsx-gen.ads'), 'FSX_GEN_ADS');
		var derived = shortcodeFromAreatag('X'.repeat(80));
		assert.strictEqual(derived.length, AREA_SHORTCODE_MAX);
		assert.strictEqual(areaShortcodeProblem(derived), null);
	});

	it('batch subscribe derives within the limit', async function () {
		var batch = await import('../src/maintenance/echolistBatchSubscribe.js');
		var derived = batch.baseShortcode('LONG.'.repeat(20));
		assert.strictEqual(areaShortcodeProblem(derived), null);
	});

	it('newArea refuses FOO-BAR before touching the database', async function () {
		var msgAreas = await import('../src/models/msgAreas.js');
		var result = await msgAreas.newArea({
			groupshortcode: 'ANYGROUP',
			name: 'Foo Bar',
			description: 'Foo Bar',
			shortcode: 'FOO-BAR'
		});
		assert.strictEqual(result.status, false);
		assert.ok(result.errormessages.some(function (m) { return /FOO_BAR/.test(m); }),
			'expected the shortcode message, got ' + JSON.stringify(result.errormessages));
	});
});
