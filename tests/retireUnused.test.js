// tests/retireUnused.test.js -- the #84 clean-up: dead pieces removed, the
// half-wired ones wired.

import assert from 'assert';
import * as fs from 'fs';
import { processorKind } from '../src/models/ftnNetmailAdapter.js';
import { isAutomatedProcessor } from '../src/models/privateMessages.js';
import { unsignedOverSigned } from '../scripts/publish.mjs';
import { CONFIG_DEFINITIONS } from '../src/config/configDefaults.js';

describe('#84 clean-up', function () {

	describe('robot names', function () {
		it('sends RaidFix to FileFix, which it used to drop with no reply', function () {
			assert.strictEqual(processorKind('RaidFix'), 'filefix');
		});

		it('gives every accepted robot name a handler', function () {
			for (var n of ['areafix', 'areamgr', 'filefix', 'filemgr', 'tic', 'raidfix', 'ping']) {
				assert.strictEqual(isAutomatedProcessor(n), true, n);
				assert.ok(processorKind(n), n + ' is accepted but nothing answers it');
			}
		});
	});

	describe('publish', function () {
		it('refuses an unsigned SHA256SUMS over a signed one on the host', function () {
			assert.ok(/Sign it/.test(unsignedOverSigned(false, { status: 200 })));
		});
		it('refuses when it cannot tell what the host has', function () {
			assert.ok(unsignedOverSigned(false, { status: 0, error: 'ECONNREFUSED' }));
		});
		it('lets a signed list through, and an unsigned one where none was signed', function () {
			assert.strictEqual(unsignedOverSigned(true, { status: 200 }), null);
			assert.strictEqual(unsignedOverSigned(false, { status: 404 }), null);
		});
	});

	describe('removed', function () {
		it('no longer offers tic_auto_forward, which nothing read', function () {
			assert.ok(!CONFIG_DEFINITIONS.some(function (d) { return d.key === 'tic_auto_forward'; }));
		});
		it('no longer declares netmail_in / netmail_out or ships netmail.js', function () {
			var tables = fs.readFileSync(new URL('../db/schema/tables/tablenames.conf', import.meta.url), 'utf8').split('\n').map(s => s.trim());
			assert.ok(tables.indexOf('netmail_in') === -1 && tables.indexOf('netmail_out') === -1);
			assert.ok(!fs.existsSync(new URL('../src/models/netmail.js', import.meta.url)));
		});
	});

	describe('migration 0010', function () {
		function ctx(counts) {
			var sql = [];
			return {
				sql: sql, log: function () {},
				postgres: {
					queryOne: async function (q, p) {
						if (/to_regclass/.test(q)) return { t: counts[p[0]] === undefined ? null : p[0] };
						var t = /FROM (\w+)/.exec(q)[1];
						return { n: counts[t] };
					},
					write: async function (q) { sql.push(q); return null; }
				}
			};
		}

		it('drops an empty table and keeps one with rows', async function () {
			var m = await import('../db/migrations/0010-retire-unused.js');
			var c = ctx({ netmail_in: 0, netmail_out: 3 });
			var r = await m.run(c);
			assert.deepStrictEqual(r.dropped, ['netmail_in']);
			assert.deepStrictEqual(r.kept, ['netmail_out (3 rows)']);
			assert.ok(c.sql.includes('DROP TABLE netmail_in'));
			assert.ok(!c.sql.some(q => /DROP TABLE netmail_out/.test(q)));
			assert.ok(c.sql.some(q => /tic_auto_forward/.test(q)));
		});

		it('does nothing to a table that is already gone', async function () {
			var m = await import('../db/migrations/0010-retire-unused.js');
			var c = ctx({});
			var r = await m.run(c);
			assert.deepStrictEqual(r.dropped, []);
			assert.ok(!c.sql.some(q => /DROP/.test(q)));
		});
	});
});
