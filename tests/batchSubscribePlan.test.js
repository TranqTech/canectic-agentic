// tests/batchSubscribePlan.test.js: the read-only pre-flight for batch subscribe.
//
// planBatch() decides which areatags a batch will create and what shortcode
// each one gets. It is exported separately from the job precisely so a preview
// and the real run cannot disagree, which makes it the piece worth pinning.
//
// The dedupe case below is a real bug caught by hand rather than by a test.
// Submitting the same areatag twice produced TWO areas, FSX_ADS and FSX_ADS_2,
// both mapped to the same tag, because the collision suffixing treated a
// repeated checkbox as a second area. An areatag is unique per network, so a
// repeat is always a duplicated form field.
//
// Both the echomail and filebone planners are covered. They are deliberately
// separate modules rather than a shared abstraction (mirroring how
// fileEcholist.js mirrors networkEcholist.js), so both need asserting.
//
// Needs a live database. Skips cleanly without one. Fixtures are namespaced
// ZZ / zz and removed afterwards.
// Run: npx mocha --spec tests/batchSubscribePlan.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

describe('batch subscribe planBatch', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, netEcholist = null, fileEcholist = null;
	var echoPlan = null, filePlan = null;
	var networkId = null;
	var echolistId = null, fileEcholistId = null;

	before(async function () {
		this.timeout(20000);
		try {
			available = await dbAvailable();
			if (!available) return;

			pg           = await import('../src/middleware/db/postgres.js');
			netEcholist  = await import('../src/models/networkEcholist.js');
			fileEcholist = await import('../src/models/fileEcholist.js');
			echoPlan     = (await import('../src/maintenance/echolistBatchSubscribe.js')).planBatch;
			filePlan     = (await import('../src/maintenance/fileboneBatchSubscribe.js')).planBatch;

			var net = await pg.queryOne('SELECT id FROM message_networks LIMIT 1');
			if (!net) { available = false; return; }
			networkId = net.id;

			var el = await netEcholist.createEcholist(networkId, 'ZZ Plan Test', 'temporary', false);
			if (!el.status) { available = false; return; }
			echolistId = el.insertId;

			var fl = await fileEcholist.createEcholist(networkId, 'ZZ File Plan Test', 'temporary', false);
			if (!fl.status) { available = false; return; }
			fileEcholistId = fl.insertId;
		} catch (_) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		this.timeout(20000);
		if (!pg) return;
		try {
			if (echolistId) {
				await pg.write('DELETE FROM network_echolist_areas WHERE echolist_id = $1', [echolistId]);
				await pg.write('DELETE FROM network_echolists WHERE id = $1', [echolistId]);
			}
			if (fileEcholistId) {
				await pg.write('DELETE FROM file_echolist_areas WHERE echolist_id = $1', [fileEcholistId]);
				await pg.write('DELETE FROM file_echolists WHERE id = $1', [fileEcholistId]);
			}
		} catch (_) {}
	});

	async function resetEcho() {
		await pg.write('DELETE FROM network_echolist_areas WHERE echolist_id = $1', [echolistId]);
	}
	async function resetFile() {
		await pg.write('DELETE FROM file_echolist_areas WHERE echolist_id = $1', [fileEcholistId]);
	}

	// Mark an entry as already carried locally, which is what a real subscribe
	// does by setting local_area_id.
	async function markCarried(table, areatag, fakeAreaId) {
		await pg.write('UPDATE ' + table + ' SET local_area_id = $1 WHERE areatag = $2',
			[fakeAreaId, areatag]);
	}

	function reasonFor(skipped, tag) {
		var hit = skipped.find(function (s) { return s.areatag === tag; });
		return hit ? hit.reason : null;
	}

	// -----------------------------------------------------------------------
	// echomail
	// -----------------------------------------------------------------------

	describe('echolist (message areas)', function () {

		it('plans one entry per selected areatag', async function () {
			await resetEcho();
			await netEcholist.addArea(echolistId, 'ZZ_ALPHA', 'Alpha area');
			await netEcholist.addArea(echolistId, 'ZZ_BETA', 'Beta area');

			var res = await echoPlan(networkId, ['ZZ_ALPHA', 'ZZ_BETA']);
			assert.strictEqual(res.plan.length, 2);
			assert.strictEqual(res.skipped.length, 0);
			assert.deepStrictEqual(res.plan.map(function (p) { return p.shortcode; }),
				['ZZ_ALPHA', 'ZZ_BETA']);
			assert.strictEqual(res.plan[0].description, 'Alpha area',
				'description should come from the echolist entry');
		});

		it('deduplicates a repeated areatag instead of creating a second area', async function () {
			await resetEcho();
			await netEcholist.addArea(echolistId, 'ZZ_DUPE', 'Dupe area');

			var res = await echoPlan(networkId, ['ZZ_DUPE', 'ZZ_DUPE', 'ZZ_DUPE']);
			assert.strictEqual(res.plan.length, 1,
				'a repeated areatag is a duplicated checkbox, not a second area');
			assert.strictEqual(res.plan[0].shortcode, 'ZZ_DUPE',
				'the repeat must not be suffixed into ZZ_DUPE_2');
		});

		it('deduplicates case-insensitively', async function () {
			await resetEcho();
			await netEcholist.addArea(echolistId, 'ZZ_CASE', 'Case area');

			var res = await echoPlan(networkId, ['ZZ_CASE', 'zz_case', 'Zz_CaSe']);
			assert.strictEqual(res.plan.length, 1);
		});

		it('skips an areatag that is not on any echolist for the network', async function () {
			await resetEcho();
			await netEcholist.addArea(echolistId, 'ZZ_REAL', 'Real area');

			var res = await echoPlan(networkId, ['ZZ_REAL', 'ZZ_NOT_A_REAL_TAG']);
			assert.strictEqual(res.plan.length, 1);
			assert.strictEqual(reasonFor(res.skipped, 'ZZ_NOT_A_REAL_TAG'),
				'not on any echolist for this network');
		});

		it('skips an area that is already carried', async function () {
			await resetEcho();
			await netEcholist.addArea(echolistId, 'ZZ_CARRIED', 'Already carried');
			await netEcholist.addArea(echolistId, 'ZZ_FREE', 'Not carried');
			await markCarried('network_echolist_areas', 'ZZ_CARRIED', 999999);

			var res = await echoPlan(networkId, ['ZZ_CARRIED', 'ZZ_FREE']);
			assert.strictEqual(res.plan.length, 1);
			assert.strictEqual(res.plan[0].areatag, 'ZZ_FREE');
			assert.strictEqual(reasonFor(res.skipped, 'ZZ_CARRIED'), 'already carried');
		});

		it('sanitises non-alphanumerics out of the derived shortcode', async function () {
			await resetEcho();
			await netEcholist.addArea(echolistId, 'ZZ.DOT-DASH', 'Punctuated');

			var res = await echoPlan(networkId, ['ZZ.DOT-DASH']);
			assert.strictEqual(res.plan[0].shortcode, 'ZZ_DOT_DASH');
		});

		it('suffixes a collision between two areatags that sanitise the same', async function () {
			await resetEcho();
			// Sanitising is lossy: both of these want ZZ_COLLIDE.
			await netEcholist.addArea(echolistId, 'ZZ.COLLIDE', 'dot form');
			await netEcholist.addArea(echolistId, 'ZZ-COLLIDE', 'dash form');

			var res = await echoPlan(networkId, ['ZZ.COLLIDE', 'ZZ-COLLIDE']);
			assert.strictEqual(res.plan.length, 2, 'both are distinct areatags and both should be planned');
			var codes = res.plan.map(function (p) { return p.shortcode; });
			assert.strictEqual(new Set(codes).size, 2, 'shortcodes must be unique: ' + codes.join(', '));
			assert.ok(codes.includes('ZZ_COLLIDE'));
			assert.ok(codes.some(function (c) { return /^ZZ_COLLIDE_\d+$/.test(c); }),
				'the loser of the collision should be suffixed, got ' + codes.join(', '));
		});

		it('flags a suffixed entry as renamed so the run can report it', async function () {
			await resetEcho();
			await netEcholist.addArea(echolistId, 'ZZ.RENAME', 'dot form');
			await netEcholist.addArea(echolistId, 'ZZ-RENAME', 'dash form');

			var res = await echoPlan(networkId, ['ZZ.RENAME', 'ZZ-RENAME']);
			var renamed = res.plan.filter(function (p) { return p.renamed; });
			assert.strictEqual(renamed.length, 1);
			assert.strictEqual(res.plan.filter(function (p) { return !p.renamed; }).length, 1);
		});

		it('ignores blank and whitespace-only entries', async function () {
			await resetEcho();
			await netEcholist.addArea(echolistId, 'ZZ_BLANKS', 'Blanks');

			var res = await echoPlan(networkId, ['', '   ', 'ZZ_BLANKS', null, undefined]);
			assert.strictEqual(res.plan.length, 1);
			assert.strictEqual(res.skipped.length, 0, 'blank entries are noise, not skips worth reporting');
		});

		it('returns empty for an empty selection', async function () {
			await resetEcho();
			var res = await echoPlan(networkId, []);
			assert.deepStrictEqual(res.plan, []);
			assert.deepStrictEqual(res.skipped, []);
		});
	});

	// -----------------------------------------------------------------------
	// filebones
	// -----------------------------------------------------------------------

	describe('filebone (file areas)', function () {

		it('plans one entry per selected areatag', async function () {
			await resetFile();
			await fileEcholist.addArea(fileEcholistId, 'ZZF_ALPHA', 'Alpha files');
			await fileEcholist.addArea(fileEcholistId, 'ZZF_BETA', 'Beta files');

			var res = await filePlan(networkId, ['ZZF_ALPHA', 'ZZF_BETA']);
			assert.strictEqual(res.plan.length, 2);
			assert.strictEqual(res.skipped.length, 0);
		});

		it('deduplicates a repeated areatag', async function () {
			await resetFile();
			await fileEcholist.addArea(fileEcholistId, 'ZZF_DUPE', 'Dupe files');

			var res = await filePlan(networkId, ['ZZF_DUPE', 'ZZF_DUPE']);
			assert.strictEqual(res.plan.length, 1);
			assert.strictEqual(res.plan[0].shortcode, 'ZZF_DUPE');
		});

		it('reports an unknown areatag against filebones, not echolists', async function () {
			await resetFile();
			await fileEcholist.addArea(fileEcholistId, 'ZZF_REAL', 'Real files');

			var res = await filePlan(networkId, ['ZZF_NOPE']);
			assert.strictEqual(res.plan.length, 0);
			assert.strictEqual(reasonFor(res.skipped, 'ZZF_NOPE'),
				'not on any filebone for this network');
		});

		it('skips an already carried file area', async function () {
			await resetFile();
			await fileEcholist.addArea(fileEcholistId, 'ZZF_CARRIED', 'Carried');
			await markCarried('file_echolist_areas', 'ZZF_CARRIED', 999999);

			var res = await filePlan(networkId, ['ZZF_CARRIED']);
			assert.strictEqual(res.plan.length, 0);
			assert.strictEqual(reasonFor(res.skipped, 'ZZF_CARRIED'), 'already carried');
		});

		it('checks shortcode uniqueness against file_areas, not message_areas', async function () {
			await resetFile();
			// A message area with this shortcode must not push the file planner
			// into suffixing: the two namespaces are separate tables.
			var existing = await pg.queryOne('SELECT shortcode FROM message_areas LIMIT 1');
			if (!existing) this.skip();

			await fileEcholist.addArea(fileEcholistId, existing.shortcode, 'same name as a message area');
			var res = await filePlan(networkId, [existing.shortcode]);
			assert.strictEqual(res.plan.length, 1);
			assert.strictEqual(res.plan[0].shortcode, existing.shortcode.toUpperCase(),
				'a message area of the same name is irrelevant to a file area shortcode');
			assert.strictEqual(res.plan[0].renamed, false);
		});
	});
});
