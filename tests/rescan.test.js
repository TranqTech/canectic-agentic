// tests/rescan.test.js: the %RESCAN command shared by AreaFix and FileFix.
//
// Two things are worth pinning here.
//
// The grammar, because it is what downlinks type and a parse slip either does
// nothing or does far too much. Bare %RESCAN meaning "all areas" is the form
// SBBSecho, Mystic and Squish implement, so it has to keep working.
//
// The pointer computation, because it repeats a trap that has already bitten
// this codebase twice. msg_idx is a message id; the rescan window is a date;
// the two do not move together. An imported message can carry a high id and a
// very old date, so anchoring on "the newest thing older than the cutoff" can
// land above messages inside the window and silently skip exactly the mail the
// rescan was asked for. The fixture below builds that shape deliberately.
//
// Parser tests are pure. Pointer tests need a database and skip cleanly
// without one.
// Run: npx mocha --spec tests/rescan.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var rescan = null;
try {
	rescan = await import('../src/models/rescan.js');
} catch (_) { rescan = null; }

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

describe('rescan.parseRescanRequest', function () {
	before(function () { if (!rescan) this.skip(); });

	function parse(line) { return rescan.parseRescanRequest(line, 60); }

	it('treats a bare %RESCAN as every area at the default window', function () {
		var r = parse('%RESCAN');
		assert.strictEqual(r.areatag, null);
		assert.strictEqual(r.full, false);
		assert.strictEqual(r.days, 60);
		assert.strictEqual(r.error, null);
	});

	it('accepts ALL and * as the same thing as bare', function () {
		assert.strictEqual(parse('%RESCAN ALL').areatag, null);
		assert.strictEqual(parse('%RESCAN *').areatag, null);
		assert.strictEqual(parse('%RESCAN all').areatag, null);
	});

	it('picks up a single areatag and upper-cases it', function () {
		assert.strictEqual(parse('%RESCAN fsx_gen').areatag, 'FSX_GEN');
	});

	it('accepts a day count override', function () {
		var r = parse('%RESCAN FSX_GEN 30');
		assert.strictEqual(r.areatag, 'FSX_GEN');
		assert.strictEqual(r.days, 30);
		assert.strictEqual(r.full, false);
	});

	it('accepts a day count without an areatag', function () {
		var r = parse('%RESCAN 90');
		assert.strictEqual(r.areatag, null);
		assert.strictEqual(r.days, 90);
	});

	it('accepts /FULL, the documented flag spelling', function () {
		var r = parse('%RESCAN ALL /FULL');
		assert.strictEqual(r.full, true);
		assert.strictEqual(r.areatag, null);
	});

	it('accepts -FULL as well, since it is a natural thing to type', function () {
		// Note a leading dash means unsubscribe in the AreaFix grammar, so this
		// spelling is only safe on the same line as %RESCAN. The slash form has
		// no such ambiguity, which is why it is the documented one.
		assert.strictEqual(parse('%RESCAN FSX_GEN -FULL').full, true);
	});

	it('is case-insensitive about the flag', function () {
		assert.strictEqual(parse('%RESCAN all /full').full, true);
	});

	it('rejects a zero or negative day count rather than replaying everything', function () {
		var r = parse('%RESCAN FSX_GEN 0');
		assert.ok(r.error, 'a zero window must be an error, not an accidental full rescan');
		assert.strictEqual(r.full, false);
	});

	it('reports an unrecognised argument instead of guessing', function () {
		var r = parse('%RESCAN FSX_GEN junk!');
		assert.ok(r.error);
		assert.ok(r.error.includes('junk!'));
	});

	it('tolerates extra whitespace', function () {
		var r = parse('  %RESCAN    FSX_GEN    30   /FULL  ');
		assert.strictEqual(r.areatag, 'FSX_GEN');
		assert.strictEqual(r.days, 30);
		assert.strictEqual(r.full, true);
	});

	it('uses the caller-supplied default when no count is given', function () {
		assert.strictEqual(rescan.parseRescanRequest('%RESCAN', 14).days, 14);
	});
});

// ---------------------------------------------------------------------------
// Pointer computation
// ---------------------------------------------------------------------------

describe('rescan.pointerForWindow', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, msgAreas = null;
	var SHORTCODE = 'ZZRESCANTEST';
	var MSGTABLE = 'mb_zzrescantest_msgs';

	before(async function () {
		this.timeout(20000);
		try {
			available = await dbAvailable();
			if (!available || !rescan) { available = false; return; }
			pg       = await import('../src/middleware/db/postgres.js');
			msgAreas = await import('../src/models/msgAreas.js');

			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			if (!grp) { available = false; return; }

			await msgAreas.removeArea(SHORTCODE, true).catch(function () {});
			var created = await msgAreas.newArea({
				groupshortcode: grp.shortcode,
				name: 'Rescan test', description: 'temporary, created by rescan.test.js',
				shortcode: SHORTCODE, readsecurity: 50, postsecurity: 60,
				createdByName: 'rescan.test.js'
			});
			if (!created.status) { available = false; return; }
		} catch (_) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		this.timeout(20000);
		if (!available || !msgAreas) return;
		try { await msgAreas.removeArea(SHORTCODE, true); } catch (_) {}
	});

	function daysAgo(n) { return new Date(Date.now() - n * 86400000); }

	async function addMsg(systemDaysAgo) {
		var r = await pg.insertObject({
			uuid: crypto.randomUUID(), subject: 's', from_user: 'a', to_user: 'All',
			body_text: 'x', system_time: daysAgo(systemDaysAgo), created_at: new Date()
		}, MSGTABLE);
		return parseInt(r.insertId);
	}

	async function reset() { await pg.write('DELETE FROM ' + MSGTABLE); }

	it('returns a pointer below every message inside the window', async function () {
		await reset();
		var old1 = await addMsg(200);
		var old2 = await addMsg(150);
		var inWindow1 = await addMsg(30);
		var inWindow2 = await addMsg(10);

		var ptr = await rescan.pointerForWindow(MSGTABLE, 60);
		assert.ok(ptr < inWindow1, 'pointer ' + ptr + ' must sit below the first in-window id ' + inWindow1);
		assert.strictEqual(ptr, inWindow1 - 1);
		assert.ok(ptr >= old2, 'and should not rewind further than it has to');
		assert.ok(old1 < ptr + 1);
		assert.ok(inWindow2 > ptr);
	});

	it('does not skip in-window mail that has a lower id than older mail', async function () {
		// The trap. Ids are insertion order, dates are message dates, and an
		// import writes old-dated messages with high ids. Anchoring on the
		// newest thing older than the cutoff would land above the recent
		// message here and silently skip it.
		await reset();
		var recent = await addMsg(5);      // low id, inside the window
		var imported = await addMsg(500);  // high id, far outside it

		var ptr = await rescan.pointerForWindow(MSGTABLE, 60);
		assert.ok(ptr < recent,
			'pointer ' + ptr + ' skipped in-window message ' + recent +
			' because an imported message at id ' + imported + ' has a higher id');
		assert.strictEqual(ptr, recent - 1);
	});

	it('returns the head when nothing falls inside the window', async function () {
		await reset();
		await addMsg(400);
		var last = await addMsg(300);

		var ptr = await rescan.pointerForWindow(MSGTABLE, 60);
		assert.strictEqual(ptr, last,
			'with nothing in the window the rescan should be a no-op, not a full replay');
	});

	it('rewinds below the whole set when every message is inside the window', async function () {
		await reset();
		var first = await addMsg(5);
		await addMsg(2);

		var ptr = await rescan.pointerForWindow(MSGTABLE, 60);
		assert.strictEqual(ptr, first - 1,
			'with everything in window the pointer sits below the oldest row, replaying all of it');
		// Not 0: ids are serial and do not restart, so a reused table starts
		// well above 1. Anything asserting 0 here is asserting the sequence.
	});

	it('returns 0 for an empty area', async function () {
		await reset();
		assert.strictEqual(await rescan.pointerForWindow(MSGTABLE, 60), 0);
	});

	it('widens with the window', async function () {
		await reset();
		await addMsg(300);
		var mid = await addMsg(100);
		var recent = await addMsg(10);

		var narrow = await rescan.pointerForWindow(MSGTABLE, 60);
		var wide   = await rescan.pointerForWindow(MSGTABLE, 200);
		assert.strictEqual(narrow, recent - 1);
		assert.strictEqual(wide, mid - 1);
		assert.ok(wide < narrow, 'a wider window must rewind at least as far');
	});
});
