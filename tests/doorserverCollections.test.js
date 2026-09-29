// tests/doorserverCollections.test.js -- door-server availability through
// collections (#89): a collection's audience (local, door server, both), the
// per-entry offered flag, the two-level door menu, and migration 0011 that
// carries the 0.9.13a per-door setting over.

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';
import { createDoorMenu } from '../bin/doorclient.js';
import { plan } from '../db/migrations/0011-doorserver-collections.js';
import { normaliseAudience, offersToDoorserver, showsLocally, checkboxValue, flattenOffered } from '../src/models/doorCollections.js';

function menuFor(doors, collections, opts) {
	var out = [], picked = [], quit = 0;
	var m = createDoorMenu(Object.assign({
		doors: doors, collections: collections,
		write: function (t) { out.push(t); },
		onPick: function (s) { picked.push(s); },
		onQuit: function () { quit++; }
	}, opts || {}));
	var type = function (keys) { for (var ch of keys) m.key(ch); };
	return { m: m, type: type, text: function () { return out.join(''); }, clear: function () { out.length = 0; }, picked: picked, quits: function () { return quit; } };
}

var DOORS = [{ slug: 'lord', name: 'LORD' }, { slug: 'bre', name: 'BRE' }, { slug: 'tw', name: 'TW2002' }];

describe('door server availability by collection (#89)', function () {

	describe('vocabulary', function () {
		it('knows three audiences and falls back for anything else', function () {
			assert.strictEqual(normaliseAudience('Both'), 'both');
			assert.strictEqual(normaliseAudience('doorserver'), 'doorserver');
			assert.strictEqual(normaliseAudience('nonsense'), 'local');
			assert.strictEqual(normaliseAudience('nonsense', null), null);
			assert.deepStrictEqual(['local', 'doorserver', 'both'].map(offersToDoorserver), [false, true, true]);
			assert.deepStrictEqual(['local', 'doorserver', 'both'].map(showsLocally), [true, false, true]);
		});

		it('reads an unticked checkbox (nothing sent) as false', function () {
			assert.strictEqual(checkboxValue(undefined), false);
			assert.strictEqual(checkboxValue('true'), true);
			assert.strictEqual(checkboxValue('on'), true);
			assert.strictEqual(checkboxValue('false'), false);
		});

		it('flattens offered collections to each door once, in order', function () {
			var flat = flattenOffered([{ doors: [DOORS[0], DOORS[1]] }, { doors: [DOORS[1], DOORS[2]] }]);
			assert.deepStrictEqual(flat.map(function (d) { return d.slug; }), ['lord', 'bre', 'tw']);
		});
	});

	describe('the door menu', function () {
		it('is the plain door list with one collection or none', function () {
			var t = menuFor(DOORS, [{ name: 'All', doors: ['lord', 'bre', 'tw'] }]);
			t.m.start();
			assert.match(t.text(), /Doors on this server:/);
			assert.doesNotMatch(t.text(), /collections/i);
			t.type('2\r');
			assert.deepStrictEqual(t.picked, ['bre']);

			var t2 = menuFor(DOORS, undefined);
			t2.m.start();
			t2.type('3\r');
			assert.deepStrictEqual(t2.picked, ['tw'], 'a 0.9.13a server sends no collections');
		});

		it('offers collections first when there are several, and Q goes back', function () {
			var t = menuFor(DOORS, [{ name: 'Classics', doors: ['lord', 'bre'] }, { name: 'Space', doors: ['tw'] }], { title: 'Hub' });
			t.m.start();
			assert.match(t.text(), /Door collections on Hub:/);
			assert.match(t.text(), /1\) Classics \(2\)/);
			assert.match(t.text(), /2\) Space \(1\)/);
			t.clear();
			t.type('1\r');
			assert.match(t.text(), /Classics:/);
			assert.match(t.text(), /2\) BRE/);
			assert.match(t.text(), /Q to go back/);
			t.clear();
			t.type('q');
			assert.match(t.text(), /Door collections on Hub:/, 'back to the collections');
			assert.strictEqual(t.quits(), 0);
			t.type('2\r1\r');
			assert.deepStrictEqual(t.picked, ['tw']);
		});

		it('asks again for a number that is not listed, and quits from the top', function () {
			var t = menuFor(DOORS, [{ name: 'A', doors: ['lord'] }, { name: 'B', doors: ['bre'] }], { quitWord: 'go back' });
			t.m.start();
			assert.match(t.text(), /Q to go back/);
			t.clear();
			t.type('9\r');
			assert.match(t.text(), /Choose a number/);
			assert.strictEqual(t.picked.length, 0);
			t.type('Q');
			assert.strictEqual(t.quits(), 1);
		});

		it('drops a collection whose doors the list does not carry', function () {
			var t = menuFor(DOORS, [{ name: 'Ghost', doors: ['gone'] }, { name: 'Real', doors: ['lord'] }]);
			t.m.start();
			assert.doesNotMatch(t.text(), /Ghost/);
			assert.match(t.text(), /Doors on this server:/, 'one real collection left, so the plain list');
		});
	});

	describe('migration 0011 plan', function () {
		var colls = [{ id: 1, slug: 'classic', audience: 'local' }, { id: 2, slug: 'ds', audience: 'doorserver' }, { id: 3, slug: 'door-server', audience: 'local' }];

		it('ticks each entry of an available door and widens local collections to both', function () {
			var p = plan([10], [{ collection_id: 1, door_id: 10 }, { collection_id: 2, door_id: 10 }, { collection_id: 1, door_id: 11 }], colls);
			assert.deepStrictEqual(p.tick, [{ collection_id: 1, door_id: 10 }, { collection_id: 2, door_id: 10 }]);
			assert.deepStrictEqual(p.widen, [1], 'the door-server-only collection keeps its audience');
			assert.strictEqual(p.newCollection, null);
		});

		it('puts an available door that is in no collection into a new one with a free slug', function () {
			var p = plan([10, 12], [{ collection_id: 1, door_id: 10 }], colls);
			assert.deepStrictEqual(p.newCollection, { slug: 'door-server-2', doorIds: [12] });
		});

		it('changes nothing when no door was available', function () {
			assert.deepStrictEqual(plan([], [{ collection_id: 1, door_id: 10 }], colls), { tick: [], widen: [], newCollection: null });
		});
	});

	describe('against the database', function () {
		this.timeout(20000);
		var available = false, pg, dc, doors;
		var ids = {};

		before(async function () {
			available = await dbAvailable();
			if (!available) return;
			pg = await import('../src/middleware/db/postgres.js');
			dc = await import('../src/models/doorCollections.js');
			doors = await import('../src/models/doors.js');
		});
		async function cleanup() {
			await pg.write("DELETE FROM door_collection_entries WHERE collection_id IN (SELECT id FROM door_collections WHERE slug LIKE 'zz89-%') OR door_id IN (SELECT id FROM doors WHERE slug LIKE 'zz89-%')");
			await pg.write("DELETE FROM door_collections WHERE slug LIKE 'zz89-%'");
			await pg.write("DELETE FROM doors WHERE slug LIKE 'zz89-%'");
		}
		async function door(slug, launchType) {
			var r = await pg.queryOne("INSERT INTO doors (slug, name, launch_type, active) VALUES ($1, $2, $3, true) RETURNING id", [slug, slug.toUpperCase(), launchType || 'NativeShell']);
			return r.id;
		}
		async function coll(slug, audience) {
			var r = await dc.createCollection({ slug: slug, name: slug, audience: audience, active: 'true' });
			return r.collectionId;
		}
		function offeredSlugs(list) {
			return list.filter(function (c) { return c.slug.startsWith('zz89-'); });
		}

		beforeEach(async function () {
			if (!available) return this.skip();
			await cleanup();
			ids.lord = await door('zz89-lord');
			ids.bre = await door('zz89-bre');
			ids.remote = await door('zz89-remote', 'Remote');
			ids.local = await coll('zz89-local', 'local');
			ids.both = await coll('zz89-both', 'both');
			ids.ds = await coll('zz89-ds', 'doorserver');
		});
		after(async function () { if (available) await cleanup(); });

		it('offers a door added to a collection the door server sees, and not one added to a local collection', async function () {
			await dc.addDoorToCollection(ids.both, ids.lord);
			await dc.addDoorToCollection(ids.local, ids.bre);
			var offered = offeredSlugs(await dc.offeredCollections());
			assert.deepStrictEqual(offered.map(function (c) { return [c.slug, c.doors.map(function (d) { return d.slug; })]; }), [['zz89-both', ['zz89-lord']]]);
			assert.strictEqual((await doors.getDoorConfig('zz89-lord')).doorserverAvailable, true);
			assert.strictEqual((await doors.getDoorConfig('zz89-bre')).doorserverAvailable, false);
		});

		it('stops offering a door that is unticked, and never offers one while the collection is inactive', async function () {
			await dc.addDoorToCollection(ids.both, ids.lord);
			await dc.setEntryOffered(ids.both, ids.lord, false);
			assert.strictEqual(await dc.isDoorOffered(ids.lord), false);
			await dc.setEntryOffered(ids.both, ids.lord, true);
			assert.strictEqual(await dc.isDoorOffered(ids.lord), true);
			await dc.updateCollection(ids.both, { name: 'zz89-both', audience: 'both' });   // Active unticked: nothing sent
			assert.strictEqual((await dc.getCollectionById(ids.both)).active, false, 'an unticked Active box switches a collection off');
			assert.strictEqual(await dc.isDoorOffered(ids.lord), false);
		});

		it('never offers a door on another system, whatever the collection says', async function () {
			await dc.addDoorToCollection(ids.ds, ids.remote);
			await pg.write('UPDATE door_collection_entries SET doorserver = true WHERE door_id = $1', [ids.remote]);
			assert.strictEqual(await dc.isDoorOffered(ids.remote), false);
			assert.strictEqual(offeredSlugs(await dc.offeredCollections()).length, 0);
		});

		it('does not offer a duplicated door until the sysop says so', async function () {
			await dc.addDoorToCollection(ids.both, ids.lord, 0, { offered: false });
			assert.strictEqual(await dc.isDoorOffered(ids.lord), false);
		});

		it('hides a door-server-only collection, and its doors, from local callers', async function () {
			await dc.addDoorToCollection(ids.ds, ids.lord);
			await dc.addDoorToCollection(ids.ds, ids.bre);
			await dc.addDoorToCollection(ids.local, ids.bre);
			var local = (await dc.getLocalCollections()).map(function (c) { return c.slug; });
			assert.ok(local.includes('zz89-local') && local.includes('zz89-both'));
			assert.ok(!local.includes('zz89-ds'));
			var hidden = await dc.doorIdsHiddenLocally();
			assert.ok(hidden.has(ids.lord), 'only in the door-server collection');
			assert.ok(!hidden.has(ids.bre), 'also in a local collection');
		});

		it('holds a change to a door-server audience until the doors are confirmed', async function () {
			await dc.addDoorToCollection(ids.local, ids.lord);
			await dc.addDoorToCollection(ids.local, ids.bre);
			var r = await dc.updateCollection(ids.local, { name: 'zz89-local', audience: 'both', active: 'true' });
			assert.strictEqual(r.pendingAudience, 'both');
			assert.strictEqual((await dc.getCollectionById(ids.local)).audience, 'local', 'not changed yet');
			await dc.setAudience(ids.local, 'both', [String(ids.bre)]);
			assert.strictEqual((await dc.getCollectionById(ids.local)).audience, 'both');
			assert.strictEqual(await dc.isDoorOffered(ids.bre), true);
			assert.strictEqual(await dc.isDoorOffered(ids.lord), false, 'unticked on the confirm page');
			var back = await dc.updateCollection(ids.local, { name: 'zz89-local', audience: 'local', active: 'true' });
			assert.strictEqual(back.pendingAudience, null, 'narrowing needs no confirmation');
			assert.strictEqual(await dc.isDoorOffered(ids.bre), false);
		});
	});
});
