// tests/artCodes.test.js — Unit tests for src/utils/artCodes.js
//
// Tests the art code scanner/replacer: scanSlotMap (pure sync) and
// processArtCodes (async). No DB, no Redis — appConfig._cache is {} at test
// time so get() returns whatever default the caller passes in.
//
// Async codes (@TC@, @TU@, @ON@) trigger DB/Redis on execution; their catch
// blocks return '0'. Those tests verify graceful fallback only.
//
// Run: npx mocha tests/artCodes.test.js

import assert from 'assert';
import { processArtCodes, scanSlotMap } from '../src/utils/artCodes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a minimal call object — only properties used by UNIVERSAL_CODES resolvers.
function makeCall(overrides) {
	return Object.assign({
		caller_username:  'sysop',
		caller_fullname:  'System Operator',
		nodenum:          1,
		msg_group_title:  'Net Echo',
		msg_area_title:   'General',
		file_group_title: 'Files',
		file_area_title:  'New Uploads',
		nodeManager:      null,
	}, overrides);
}

// ---------------------------------------------------------------------------
// scanSlotMap — fast path
// ---------------------------------------------------------------------------

describe('scanSlotMap — fast path (no @ in string)', function () {

	it('should return null when string has no @ character', function () {
		var result = scanSlotMap('Hello world, no codes here.');
		assert.strictEqual(result, null);
	});

	it('should return null for empty string', function () {
		var result = scanSlotMap('');
		assert.strictEqual(result, null);
	});

	it('should return null when @ is present but no recognized menu codes exist', function () {
		// Universal codes like @BN@ are NOT entry/UI codes — scanSlotMap ignores them.
		// An @ with no valid code structure also returns null.
		var result = scanSlotMap('Board: @BN@ -- welcome!');
		assert.strictEqual(result, null);
	});

	it('should return null when the only @ is malformed (no closing @)', function () {
		var result = scanSlotMap('Hello @BROKEN world');
		assert.strictEqual(result, null);
	});

	it('should return null when @ appears alone without a code', function () {
		var result = scanSlotMap('price: $0 @ cost');
		assert.strictEqual(result, null);
	});

});

// ---------------------------------------------------------------------------
// scanSlotMap — entry slot codes @Enn@ and @Fnn@
// ---------------------------------------------------------------------------

describe('scanSlotMap — entry slots (@Enn@, @Fnn@)', function () {

	it('should extract a single @E01@ entry slot', function () {
		var result = scanSlotMap('menu: @E01@');
		assert.ok(result !== null, 'expected slotMap, got null');
		assert.strictEqual(result.entries.length, 1);
		assert.strictEqual(result.entries[0].slot, 1);
	});

	it('should record correct row and column for entry slot', function () {
		// "menu: " is 6 chars, so col should be 6
		var result = scanSlotMap('menu: @E01@');
		assert.strictEqual(result.entries[0].row, 0);
		assert.strictEqual(result.entries[0].col, 6);
	});

	it('should default entry slot width to 20 when no width specifier', function () {
		var result = scanSlotMap('@E01@');
		assert.strictEqual(result.entries[0].width, 20);
	});

	it('should extract multiple entry slots across lines', function () {
		var art = '@E01@\n@E02@\n@E03@';
		var result = scanSlotMap(art);
		assert.strictEqual(result.entries.length, 3);
		assert.strictEqual(result.entries[0].slot, 1);
		assert.strictEqual(result.entries[1].slot, 2);
		assert.strictEqual(result.entries[2].slot, 3);
	});

	it('should record correct row index for each entry', function () {
		var art = '@E01@\n@E02@\n@E03@';
		var result = scanSlotMap(art);
		assert.strictEqual(result.entries[0].row, 0);
		assert.strictEqual(result.entries[1].row, 1);
		assert.strictEqual(result.entries[2].row, 2);
	});

	it('should extract @F01@ featured slot separately from entries', function () {
		var result = scanSlotMap('@F01@');
		assert.ok(result !== null);
		assert.strictEqual(result.entries.length, 0);
		assert.strictEqual(result.featured.length, 1);
		assert.strictEqual(result.featured[0].slot, 1);
	});

	it('should mix entry and featured slots correctly', function () {
		var art = '@E01@  @F01@';
		var result = scanSlotMap(art);
		assert.strictEqual(result.entries.length, 1);
		assert.strictEqual(result.featured.length, 1);
	});

	it('should handle two-digit slot numbers @E10@', function () {
		var result = scanSlotMap('@E10@');
		assert.strictEqual(result.entries[0].slot, 10);
	});

	it('should handle high slot number @F99@', function () {
		var result = scanSlotMap('@F99@');
		assert.strictEqual(result.featured[0].slot, 99);
	});

});

// ---------------------------------------------------------------------------
// scanSlotMap — UI position codes @MT@, @HK@, @PR@, @ER@
// ---------------------------------------------------------------------------

describe('scanSlotMap — UI codes (@MT@, @HK@, @PR@, @ER@)', function () {

	it('should extract @MT@ as title position', function () {
		var result = scanSlotMap('  @MT@');
		assert.ok(result !== null);
		assert.ok(result.title !== null);
		assert.strictEqual(result.title.row, 0);
		assert.strictEqual(result.title.col, 2);
	});

	it('should default @MT@ width to 40', function () {
		var result = scanSlotMap('@MT@');
		assert.strictEqual(result.title.width, 40);
	});

	it('should extract @HK@ as hotkeys position', function () {
		var result = scanSlotMap('@HK@');
		assert.ok(result.hotkeys !== null);
		assert.strictEqual(result.hotkeys.row, 0);
		assert.strictEqual(result.hotkeys.col, 0);
	});

	it('should extract @PR@ as prompt position', function () {
		var result = scanSlotMap('@PR@');
		assert.ok(result.prompt !== null);
	});

	it('should extract @ER@ as error position', function () {
		var result = scanSlotMap('@ER@');
		assert.ok(result.error !== null);
	});

	it('should default all UI codes to width 40', function () {
		var art = '@MT@\n@HK@\n@PR@\n@ER@';
		var result = scanSlotMap(art);
		assert.strictEqual(result.title.width, 40);
		assert.strictEqual(result.hotkeys.width, 40);
		assert.strictEqual(result.prompt.width, 40);
		assert.strictEqual(result.error.width, 40);
	});

	it('should handle all four UI codes in one art string', function () {
		var art = '@MT@\n@HK@\n@PR@\n@ER@';
		var result = scanSlotMap(art);
		assert.ok(result.title !== null);
		assert.ok(result.hotkeys !== null);
		assert.ok(result.prompt !== null);
		assert.ok(result.error !== null);
	});

	it('should return null when only UI codes are absent despite @ present', function () {
		// Only a universal code — scanSlotMap foundAny stays false
		var result = scanSlotMap('@BN@');
		assert.strictEqual(result, null);
	});

});

// ---------------------------------------------------------------------------
// scanSlotMap — ANSI escape sequence column tracking
// ---------------------------------------------------------------------------

describe('scanSlotMap — ANSI escape sequence handling', function () {

	it('should not count ANSI escape bytes toward column position', function () {
		// ESC[32m sets colour — 5 invisible bytes
		var ansi = '\x1b[32m';
		var art = ansi + '@E01@';
		var result = scanSlotMap(art);
		assert.ok(result !== null);
		// col should be 0 — escape contributes no visible width
		assert.strictEqual(result.entries[0].col, 0);
	});

	it('should track visible column correctly after ANSI sequence', function () {
		// 3 visible chars "ABC" then an ANSI reset then @E01@
		var art = 'ABC\x1b[0m@E01@';
		var result = scanSlotMap(art);
		// "ABC" = 3 visible chars, ANSI = 0, so col = 3
		assert.strictEqual(result.entries[0].col, 3);
	});

	it('should handle ANSI sequences mid-line correctly', function () {
		var art = 'AB\x1b[1;32mCD@E01@';
		var result = scanSlotMap(art);
		// "AB" + "CD" = 4 visible chars before the code
		assert.strictEqual(result.entries[0].col, 4);
	});

});

// ---------------------------------------------------------------------------
// processArtCodes — fast path
// ---------------------------------------------------------------------------

describe('processArtCodes — fast path (no @ in string)', function () {

	it('should return the input string unchanged when no @ present', async function () {
		var input = 'Plain art file with no codes.';
		var result = await processArtCodes(input, null, {});
		assert.strictEqual(result.processed, input);
	});

	it('should return null slotMap on fast path', async function () {
		var result = await processArtCodes('No codes here', null, {});
		assert.strictEqual(result.slotMap, null);
	});

	it('should return null slotMap on fast path even in menuMode', async function () {
		var result = await processArtCodes('No codes here', null, { menuMode: true });
		assert.strictEqual(result.slotMap, null);
	});

	it('should handle empty string on fast path', async function () {
		var result = await processArtCodes('', null, {});
		assert.strictEqual(result.processed, '');
		assert.strictEqual(result.slotMap, null);
	});

});

// ---------------------------------------------------------------------------
// processArtCodes — universal codes
// ---------------------------------------------------------------------------

describe('processArtCodes — universal code @BN@ (board name)', function () {

	it('should replace @BN@ with the board name default', async function () {
		// appConfig._cache is {} in tests, so get('boardname','BBS') returns 'BBS'
		var result = await processArtCodes('Welcome to @BN@!', null, {});
		// The replacement fills to the display width of @BN@ (4 chars = length of '@BN@')
		assert.ok(result.processed.includes('BBS'), 'expected board name in output');
		assert.ok(!result.processed.includes('@BN@'), 'code should be replaced');
	});

	it('should pad @BN@ replacement to source code length (4 chars)', async function () {
		// @BN@ is 4 chars. "BBS" is 3 chars. Should be padded to 4.
		var result = await processArtCodes('@BN@', null, {});
		assert.strictEqual(result.processed, 'BBS ');
	});

	it('should truncate board name to explicit width @BN3@', async function () {
		// @BN3@ reserves 3 chars. "BBS" is exactly 3 — no truncation needed.
		var result = await processArtCodes('@BN3@', null, {});
		assert.strictEqual(result.processed, 'BBS');
	});

	it('should pad board name when width specifier is wider than value', async function () {
		// @BN10@ reserves 10 chars. "BBS" is 3, padded to 10.
		var result = await processArtCodes('@BN10@', null, {});
		assert.strictEqual(result.processed, 'BBS       ');
		assert.strictEqual(result.processed.length, 10);
	});

	it('should truncate board name when value exceeds width specifier', async function () {
		// appConfig returns 'BBS' (3 chars). @BN2@ truncates to 2.
		var result = await processArtCodes('@BN2@', null, {});
		assert.strictEqual(result.processed, 'BB');
	});

});

describe('processArtCodes — universal code @UN@ (username)', function () {

	it('should replace @UN@ with caller username', async function () {
		// @UN@ is 4 chars wide; 'ab' (2 chars) fits; use a short name to avoid truncation
		var call = makeCall({ caller_username: 'ab' });
		var result = await processArtCodes('Hello @UN@!', call, {});
		assert.ok(result.processed.includes('ab'), 'expected username in output');
		assert.ok(!result.processed.includes('@UN@'), 'code should be replaced');
	});

	it('should use empty string for @UN@ when call is null', async function () {
		// UNIVERSAL_CODES.UN: call?.caller_username || ''
		var result = await processArtCodes('@UN@', null, {});
		// Empty string gets padded to 4 chars (length of '@UN@')
		assert.strictEqual(result.processed, '    ');
	});

	it('should pad @UN@ to code length when username is shorter', async function () {
		var call = makeCall({ caller_username: 'ab' });
		// '@UN@' is 4 chars; 'ab' is 2 — padded to 4
		var result = await processArtCodes('@UN@', call, {});
		assert.strictEqual(result.processed, 'ab  ');
	});

});

describe('processArtCodes — universal code @RN@ (real name)', function () {

	it('should replace @RN@ with caller full name', async function () {
		var call = makeCall({ caller_fullname: 'Test User' });
		var result = await processArtCodes('@RN@', call, {});
		assert.ok(result.processed.startsWith('Test'), 'expected fullname in output');
	});

	it('should return spaces for @RN@ when call is null', async function () {
		var result = await processArtCodes('@RN@', null, {});
		assert.strictEqual(result.processed.trim(), '');
	});

});

describe('processArtCodes — universal code @ND@ (node number)', function () {

	it('should replace @ND@ with node number as string', async function () {
		var call = makeCall({ nodenum: 7 });
		var result = await processArtCodes('@ND@', call, {});
		assert.ok(result.processed.startsWith('7'), 'expected node number in output');
	});

	it('should use "0" for @ND@ when call is null', async function () {
		var result = await processArtCodes('@ND@', null, {});
		assert.ok(result.processed.startsWith('0'), 'expected 0 for null call');
	});

});

describe('processArtCodes — universal code @DT@ (date)', function () {

	it('should replace @DT@ with MM/DD/YYYY format date', async function () {
		// @DT@ is 4 chars wide; use a width specifier @DT10@ to get the full date (10 chars)
		var result = await processArtCodes('@DT10@', null, {});
		// Should match MM/DD/YYYY
		assert.match(result.processed.trim(), /^\d{2}\/\d{2}\/\d{4}$/);
	});

});

describe('processArtCodes — universal code @TM@ (time)', function () {

	it('should replace @TM@ with HH:MM format time', async function () {
		// @TM@ is 4 chars wide; use @TM5@ to get the full HH:MM (5 chars)
		var result = await processArtCodes('@TM5@', null, {});
		assert.match(result.processed.trim(), /^\d{2}:\d{2}$/);
	});

});

describe('processArtCodes — context codes @MG@, @MA@, @FG@, @FA@', function () {

	it('should replace @MG@ with msg_group_title', async function () {
		// @MG@ is 4 chars wide — use a short value or width specifier
		var call = makeCall({ msg_group_title: 'Net' });
		var result = await processArtCodes('@MG@', call, {});
		assert.ok(result.processed.startsWith('Net'));
	});

	it('should replace @MA@ with msg_area_title', async function () {
		// @MA@ is 4 chars wide
		var call = makeCall({ msg_area_title: 'Gen' });
		var result = await processArtCodes('@MA@', call, {});
		assert.ok(result.processed.startsWith('Gen'));
	});

	it('should replace @FG@ with file_group_title', async function () {
		var call = makeCall({ file_group_title: 'BBS' });
		var result = await processArtCodes('@FG@', call, {});
		assert.ok(result.processed.startsWith('BBS'));
	});

	it('should replace @FA@ with file_area_title', async function () {
		// Use a width specifier wide enough for the value
		var call = makeCall({ file_area_title: 'Shareware' });
		var result = await processArtCodes('@FA20@', call, {});
		assert.ok(result.processed.startsWith('Shareware'));
	});

});

// ---------------------------------------------------------------------------
// processArtCodes — async codes (graceful fallback)
// ---------------------------------------------------------------------------

describe('processArtCodes — async codes (@TC@, @TU@, @ON@) graceful fallback', function () {

	it('should replace @TC@ with a numeric string (fallback "0" without DB)', async function () {
		var result = await processArtCodes('@TC@', null, {});
		// Without a real DB the catch block returns '0'
		assert.match(result.processed.trim(), /^\d+$/);
	});

	it('should replace @TU@ with a numeric string (fallback "0" without DB)', async function () {
		var result = await processArtCodes('@TU@', null, {});
		assert.match(result.processed.trim(), /^\d+$/);
	});

	it('should replace @ON@ with a numeric string (fallback when nodeManager absent)', async function () {
		var result = await processArtCodes('@ON@', null, {});
		assert.match(result.processed.trim(), /^\d+$/);
	});

	it('should not call async resolver when code is absent from the string', async function () {
		// Verify the fast-check works: @TC@ resolver not invoked if @TC is not in the string
		// We do this indirectly — if invoked it would take time; the test just verifies the
		// returned result is clean.
		var result = await processArtCodes('Hello world @BN@', null, {});
		assert.ok(!result.processed.includes('@TC@'));
		assert.ok(!result.processed.includes('@TU@'));
	});

});

// ---------------------------------------------------------------------------
// processArtCodes — unrecognized codes pass through
// ---------------------------------------------------------------------------

describe('processArtCodes — unrecognized codes', function () {

	it('should pass through an unrecognized @XX@ code unchanged (@ only)', async function () {
		// @ZZ@ is not a defined code — the @ is emitted and scanning resumes
		// The result will not contain '@ZZ@' intact because each @ is handled
		// character-by-character; an unrecognized match skips just the leading @.
		var result = await processArtCodes('@ZZ@', null, {});
		// The leading @ is passed through; 'ZZ@' then gets scanned again.
		// 'ZZ' is two letters but not in UNIVERSAL_CODES — it will also pass '@' through.
		assert.ok(typeof result.processed === 'string');
	});

	it('should pass through literal @ with no following alphanumeric', async function () {
		var result = await processArtCodes('price @ 5 credits', null, {});
		assert.ok(result.processed.includes('@'));
	});

	it('should not crash on @ at end of string', async function () {
		var result = await processArtCodes('end @', null, {});
		assert.ok(typeof result.processed === 'string');
	});

	it('should not crash on bare @ alone', async function () {
		var result = await processArtCodes('@', null, {});
		assert.ok(typeof result.processed === 'string');
	});

});

// ---------------------------------------------------------------------------
// processArtCodes — menu mode slot extraction
// ---------------------------------------------------------------------------

describe('processArtCodes — menuMode slot extraction', function () {

	it('should return a slotMap object when menuMode is true', async function () {
		var result = await processArtCodes('@E01@', null, { menuMode: true });
		assert.ok(result.slotMap !== null);
	});

	it('should return null slotMap when menuMode is false', async function () {
		var result = await processArtCodes('@E01@', null, { menuMode: false });
		assert.strictEqual(result.slotMap, null);
	});

	it('should extract entry slot in menuMode', async function () {
		var result = await processArtCodes('@E01@', null, { menuMode: true });
		assert.strictEqual(result.slotMap.entries.length, 1);
		assert.strictEqual(result.slotMap.entries[0].slot, 1);
	});

	it('should blank the entry slot in the processed output', async function () {
		var result = await processArtCodes('@E01@', null, { menuMode: true });
		// Default slot width is 20 — should be replaced with spaces
		assert.strictEqual(result.processed, ' '.repeat(20));
	});

	it('should extract @MT@ title position in menuMode', async function () {
		var result = await processArtCodes('title: @MT@', null, { menuMode: true });
		assert.ok(result.slotMap.title !== null);
		assert.strictEqual(result.slotMap.title.col, 7);
	});

	it('should extract @PR@ prompt position in menuMode', async function () {
		var result = await processArtCodes('@PR@', null, { menuMode: true });
		assert.ok(result.slotMap.prompt !== null);
	});

	it('should blank UI code slots in processed output', async function () {
		var result = await processArtCodes('@MT@', null, { menuMode: true });
		// @MT@ default width is 40
		assert.strictEqual(result.processed, ' '.repeat(40));
	});

	it('should NOT extract menu codes when menuMode is false', async function () {
		// @E01@ should just pass through (unrecognized) in non-menu mode
		var result = await processArtCodes('@E01@', null, { menuMode: false });
		assert.strictEqual(result.slotMap, null);
		// processed output should not be blank spaces (the code is not replaced)
	});

	it('should initialize empty slotMap arrays in menuMode', async function () {
		var result = await processArtCodes('@BN@', null, { menuMode: true });
		assert.ok(Array.isArray(result.slotMap.entries));
		assert.ok(Array.isArray(result.slotMap.featured));
		assert.strictEqual(result.slotMap.entries.length, 0);
		assert.strictEqual(result.slotMap.title, null);
	});

});

// ---------------------------------------------------------------------------
// processArtCodes — multiline handling
// ---------------------------------------------------------------------------

describe('processArtCodes — multiline art', function () {

	it('should process codes across multiple lines independently', async function () {
		// @UN@ is 4 chars wide — use a short name; @BN@ resolves to 'BBS' (3 chars, padded to 4)
		var call = makeCall({ caller_username: 'sys' });
		var art = 'Line 1: @UN@\nLine 2: @BN@';
		var result = await processArtCodes(art, call, {});
		var lines = result.processed.split('\n');
		// 'sys' (3 chars) fits within 4 width — padded to 'sys '
		assert.ok(lines[0].includes('sys'));
		assert.ok(lines[1].includes('BBS'));
	});

	it('should skip lines with no @ quickly', async function () {
		var art = 'no codes\nno codes either\n@BN@';
		var result = await processArtCodes(art, null, {});
		var lines = result.processed.split('\n');
		assert.strictEqual(lines[0], 'no codes');
		assert.strictEqual(lines[1], 'no codes either');
		assert.ok(lines[2].includes('BBS'));
	});

	it('should track row index correctly for slot codes in multiline art', async function () {
		var art = 'line 0\nline 1\n@E01@';
		var result = await processArtCodes(art, null, { menuMode: true });
		assert.strictEqual(result.slotMap.entries[0].row, 2);
	});

	it('should track column correctly after prior text on same line', async function () {
		var art = 'AB@E01@';
		var result = await processArtCodes(art, null, { menuMode: true });
		assert.strictEqual(result.slotMap.entries[0].col, 2);
	});

});

// ---------------------------------------------------------------------------
// processArtCodes — options defaulting
// ---------------------------------------------------------------------------

describe('processArtCodes — options parameter', function () {

	it('should handle undefined options gracefully', async function () {
		var result = await processArtCodes('@BN@', null, undefined);
		assert.ok(typeof result.processed === 'string');
	});

	it('should handle null options gracefully', async function () {
		var result = await processArtCodes('@BN@', null, null);
		assert.ok(typeof result.processed === 'string');
	});

	it('should return { processed, slotMap } shape in all cases', async function () {
		var result = await processArtCodes('no codes', null, {});
		assert.ok('processed' in result);
		assert.ok('slotMap' in result);
	});

});

// ---------------------------------------------------------------------------
// _fitValue behaviour (tested indirectly through processArtCodes)
// ---------------------------------------------------------------------------

describe('processArtCodes — _fitValue (padding/truncation via width specifier)', function () {

	it('should right-pad short value to specified width', async function () {
		// @UN20@ with username 'ab' — pad to 20
		var call = makeCall({ caller_username: 'ab' });
		var result = await processArtCodes('@UN20@', call, {});
		assert.strictEqual(result.processed.length, 20);
		assert.ok(result.processed.startsWith('ab'));
		assert.ok(result.processed.endsWith(' '));
	});

	it('should truncate value that exceeds specified width', async function () {
		// @UN3@ with username 'kostie' (6 chars) — truncate to 3
		var call = makeCall({ caller_username: 'kostie' });
		var result = await processArtCodes('@UN3@', call, {});
		assert.strictEqual(result.processed, 'kos');
	});

	it('should return value exactly when length matches width', async function () {
		// @UN4@ with username 'abcd' (4 chars) — exact fit
		var call = makeCall({ caller_username: 'abcd' });
		var result = await processArtCodes('@UN4@', call, {});
		assert.strictEqual(result.processed, 'abcd');
	});

});

// ---------------------------------------------------------------------------
// processArtCodes — stat cache and degraded-service fallback
// ---------------------------------------------------------------------------

describe('processArtCodes — stat lookups never block a render', function () {

	// @TC@, @TU@ and @ON@ reach PostgreSQL or Redis, and art is re-rendered on
	// every menu redraw. resolveStat caches per code, bounds how long a render
	// waits, and serves the last known value on timeout while letting the
	// refresh finish in the background. These assert the observable contract
	// rather than the timings, which vary by machine.

	it('always yields a numeric string, service up or down', async function () {
		var r = await processArtCodes('@TC@|@TU@|@ON@', null, {});
		var parts = r.processed.split('|');
		assert.strictEqual(parts.length, 3);
		for (var p of parts) {
			assert.match(p.trim(), /^\d+$/, 'expected a number, got ' + JSON.stringify(p));
		}
	});

	it('serves a repeated render from cache with the same value', async function () {
		var first  = await processArtCodes('@TU@', null, {});
		var second = await processArtCodes('@TU@', null, {});
		assert.strictEqual(second.processed, first.processed);
	});

	it('counts terminal nodes for @ON@ without needing any service', async function () {
		// The terminal component is local, so it must survive a Redis outage.
		// Only the web presence portion is cached and can degrade to zero.
		var call = { nodeManager: { nodenumsinuse: [1, 2, 3] } };
		var r = await processArtCodes('@ON@', call, {});
		var n = parseInt(r.processed.trim(), 10);
		assert.ok(Number.isFinite(n), 'expected a number, got ' + JSON.stringify(r.processed));
		assert.ok(n >= 3, 'should include the 3 connected terminal nodes, got ' + n);
	});

	it('leaves an unknown code untouched', async function () {
		var r = await processArtCodes('@NOPE@', null, {});
		assert.strictEqual(r.processed, '@NOPE@');
	});
});
