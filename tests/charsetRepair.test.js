// tests/charsetRepair.test.js -- repairing text stored as mojibake (#57).
//
// UTF-8 that was read as CP437 is exactly reversible (each character back to
// its CP437 byte, the bytes decoded as UTF-8); the danger is repairing text
// that was genuine CP437, above all ANSI art, where a fragment such as █░ is
// valid UTF-8 by itself. The rule is applied to whole values only, and a
// value mixing in characters CP437 cannot hold is left alone.
//
// The database half uses a throwaway table, mb_zz57test_msgs, copied from an
// existing area's shape, and removes it and its charset_repairs rows after.

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';
import { repairText } from '../src/maintenance/charsetRepair.js';
import { cp437BufferToUtf8 } from '../src/utils/codepageConversions.js';

// What the old tosser stored for a UTF-8 string.
var mangle = function (s) { return cp437BufferToUtf8(Buffer.from(s, 'utf8')); };

describe('charset repair (#57)', function () {

	describe('repairText', function () {
		it('reverses UTF-8 that was read as CP437', function () {
			for (var s of ['It’s 325ºF', 'Jörg Lorenz', 'Дуже груви', 'שלום', '▒▒ block']) {
				assert.strictEqual(repairText(mangle(s)), s, JSON.stringify(mangle(s)));
			}
		});

		it('leaves genuine CP437 alone, art included', function () {
			assert.strictEqual(repairText('café naïve'), null);
			assert.strictEqual(repairText('╔══╗\r║█░║\r╚══╝'), null,
				'art whose █░ pair would pass on its own');
			assert.strictEqual(repairText('plain ascii'), null);
		});

		it('leaves a value mixing damage with text CP437 cannot hold', function () {
			assert.strictEqual(repairText(mangle('Jörg') + ' €5'), null);
		});

		it('decodes a sender-destroyed value faithfully', function () {
			assert.strictEqual(repairText(mangle('�� ok')), '�� ok');
		});
	});

	describe('against the database', function () {
		this.timeout(30000);
		var available = false, pg, repair, maintenanceJobs, formatBodyHtml;
		var TABLE = 'mb_zz57test_msgs', ids = {};

		before(async function () {
			available = await dbAvailable();
			if (!available) return;
			pg = await import('../src/middleware/db/postgres.js');
			repair = await import('../src/maintenance/charsetRepair.js');
			maintenanceJobs = await import('../src/maintenance/maintenanceJobs.js');
			formatBodyHtml = (await import('../src/utils/terminalText.js')).formatBodyHtml;
		});

		beforeEach(async function () {
			if (!available) return this.skip();
			await cleanup();
			var tpl = await pg.queryOne("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'mb\\_%\\_msgs' AND table_name <> $1 LIMIT 1", [TABLE]);
			await pg.write('CREATE TABLE ' + TABLE + ' (LIKE ' + tpl.table_name + ' INCLUDING ALL)');
			async function add(key, row) {
				var r = await pg.queryOne('INSERT INTO ' + TABLE + " (uuid, from_user, to_user, subject, body_text, body_html) VALUES (gen_random_uuid()::text, $1, 'All', $2, $3, 'old html') RETURNING id",
					[row.from, row.subject, row.body]);
				ids[key] = r.id;
			}
			await add('damaged', { from: mangle('Jörg'), subject: mangle('Grüße'), body: mangle('It’s 325ºF.\r') });
			await add('art', { from: 'Artist', subject: 'Art', body: '╔══╗\r║█░║\r╚══╝\r' });
			await add('ascii', { from: 'Plain', subject: 'Plain', body: 'Nothing to see.\r' });
		});

		async function cleanup() {
			await pg.write('DROP TABLE IF EXISTS ' + TABLE);
			await pg.write('DELETE FROM charset_repairs WHERE table_name = $1', [TABLE]);
		}
		after(async function () { if (available) await cleanup(); });

		var row = async (key) => pg.queryOne('SELECT from_user, subject, body_text, body_html FROM ' + TABLE + ' WHERE id = $1', [ids[key]]);

		it('reports in a dry run and writes nothing', async function () {
			var r = await repair.repairTable(TABLE, { dryRun: true });
			assert.strictEqual(r.scanned, 3);
			assert.strictEqual(r.repaired, 1);
			assert.deepStrictEqual(r.fields, { body_text: 1, subject: 1, from_user: 1 });
			assert.deepStrictEqual(r.sampleIds, [ids.damaged]);
			assert.strictEqual((await row('damaged')).from_user, mangle('Jörg'));
			assert.strictEqual((await pg.queryOne('SELECT count(*)::int n FROM charset_repairs WHERE table_name = $1', [TABLE])).n, 0);
		});

		it('repairs the damaged row only, re-renders its HTML, and keeps the old text', async function () {
			var r = await repair.repairTable(TABLE, {});
			assert.strictEqual(r.repaired, 1);
			var d = await row('damaged');
			assert.strictEqual(d.from_user, 'Jörg');
			assert.strictEqual(d.subject, 'Grüße');
			assert.strictEqual(d.body_text, 'It’s 325ºF.\r');
			assert.strictEqual(d.body_html, await formatBodyHtml('It’s 325ºF.\r'));
			assert.strictEqual((await row('art')).body_html, 'old html', 'art must be untouched');
			var kept = await pg.query('SELECT field, old_value FROM charset_repairs WHERE table_name = $1 ORDER BY field', [TABLE]);
			assert.deepStrictEqual(kept.map(k => k.field), ['body_text', 'from_user', 'subject']);
			assert.strictEqual(kept[1].old_value, mangle('Jörg'));
			assert.strictEqual((await repair.repairTable(TABLE, {})).repaired, 0, 'a second run finds nothing');
		});

		it('reverts exactly', async function () {
			await repair.repairTable(TABLE, {});
			assert.strictEqual(await repair.revertTable(TABLE, {}), 3);
			var d = await row('damaged');
			assert.strictEqual(d.from_user, mangle('Jörg'));
			assert.strictEqual(d.body_text, mangle('It’s 325ºF.\r'));
			assert.strictEqual(await repair.revertTable(TABLE, {}), 0, 'nothing left to revert');
		});

		it('runs as the fix-charset job, reporting back', async function () {
			var result = null;
			var handled = await maintenanceJobs.runMaintenanceJob('fix-charset', { table: TABLE, dryRun: true },
				{ onResult: function (x) { result = x; } });
			assert.strictEqual(handled, true);
			assert.strictEqual(result.kind, 'charset');
			assert.strictEqual(result.repaired, 1);
			assert.strictEqual(result.dryRun, true);
		});

		it('stops when its job is told to', async function () {
			var c = new AbortController(); c.abort(new Error('limit'));
			await assert.rejects(repair.repairTable(TABLE, { signal: c.signal }), /limit/);
			assert.strictEqual((await row('damaged')).from_user, mangle('Jörg'));
		});

		it('refuses a table it has no business touching', async function () {
			await assert.rejects(repair.repairTable('users', {}), /not a table charset repair may touch/);
		});
	});
});
