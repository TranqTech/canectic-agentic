// 0011-doorserver-collections: carry the per-door "Available to Door Server"
// setting over to collections (#89).
//
// From this release a door is offered to the door server only through a
// collection whose audience includes the door server, and only when it is
// ticked there. So that no board's door server changes what it offers:
//
//   - every collection entry of a door that was available is ticked, and a
//     collection holding such a door, if it was shown only locally, becomes
//     shown to both (its other doors stay unticked, so nothing new is offered);
//   - an available door that is in no collection goes into a new collection,
//     "Door Server", shown to the door server only, so it stays out of local
//     listings exactly as before, where it was not in any collection either.
//
// doors.doorserver_available is left in place and no longer read, so this can
// be undone by hand; a later release drops it.

export const description = 'Offer door-server doors through collections instead of a per-door setting';
export const phase = 'post';

/**
 * Pure: what to change, given the doors that were available, their current
 * collection entries and the collections.
 *
 *   availableDoorIds  [id]
 *   entries           [{ collection_id, door_id }]
 *   collections       [{ id, slug, audience }]
 *
 * returns { tick: [{collection_id, door_id}], widen: [collection_id],
 *           newCollection: null | { slug, doorIds: [id] } }
 */
export function plan(availableDoorIds, entries, collections) {
	var available = new Set(availableDoorIds);
	var tick = [], widen = new Set(), placed = new Set();
	var audienceOf = {};
	for (var c of collections) audienceOf[c.id] = c.audience || 'local';
	for (var e of entries) {
		if (!available.has(e.door_id)) continue;
		tick.push({ collection_id: e.collection_id, door_id: e.door_id });
		placed.add(e.door_id);
		if (audienceOf[e.collection_id] === 'local') widen.add(e.collection_id);
	}
	var orphans = availableDoorIds.filter(function (id) { return !placed.has(id); });
	var newCollection = null;
	if (orphans.length) {
		var taken = new Set(collections.map(function (c) { return c.slug; }));
		var slug = 'door-server', n = 2;
		while (taken.has(slug)) slug = 'door-server-' + (n++);
		newCollection = { slug: slug, doorIds: orphans };
	}
	return { tick: tick, widen: Array.from(widen), newCollection: newCollection };
}

export async function run(ctx) {
	var pg = ctx.postgres;
	var log = ctx.log || function () {};

	var col = await pg.queryOne(
		"SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'doors' AND column_name = 'doorserver_available'");
	if (!col) { log('  doors.doorserver_available is not there; nothing to carry over'); return { ticked: 0, widened: 0, created: null }; }

	var doors = (await pg.query('SELECT id FROM doors WHERE doorserver_available = true ORDER BY id')) || [];
	if (!doors.length) { log('  no door was available to the door server'); return { ticked: 0, widened: 0, created: null }; }
	var entries = (await pg.query('SELECT collection_id, door_id FROM door_collection_entries')) || [];
	var collections = (await pg.query('SELECT id, slug, audience FROM door_collections')) || [];

	var p = plan(doors.map(function (d) { return d.id; }), entries, collections);
	var err;
	for (var t of p.tick) {
		err = await pg.write('UPDATE door_collection_entries SET doorserver = true WHERE collection_id = $1 AND door_id = $2', [t.collection_id, t.door_id]);
		if (err) throw new Error('could not tick door ' + t.door_id + ': ' + err.message);
	}
	for (var id of p.widen) {
		err = await pg.write("UPDATE door_collections SET audience = 'both', updated_at = NOW() WHERE id = $1", [id]);
		if (err) throw new Error('could not widen collection ' + id + ': ' + err.message);
	}
	var created = null;
	if (p.newCollection) {
		var sort = await pg.queryOne('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM door_collections');
		var row = await pg.queryOne(
			"INSERT INTO door_collections (slug, name, description, sort_order, active, audience, created_at, updated_at) " +
			"VALUES ($1, 'Door Server', 'Doors offered to other BBSes through the door server', $2, true, 'doorserver', NOW(), NOW()) RETURNING id",
			[p.newCollection.slug, (sort && sort.n) || 0]);
		if (!row) throw new Error('could not create the Door Server collection');
		var i = 0;
		for (var doorId of p.newCollection.doorIds) {
			err = await pg.write(
				'INSERT INTO door_collection_entries (collection_id, door_id, sort_order, doorserver, created_at) VALUES ($1, $2, $3, true, NOW())',
				[row.id, doorId, i++]);
			if (err) throw new Error('could not add door ' + doorId + ' to the Door Server collection: ' + err.message);
		}
		created = p.newCollection.slug;
	}

	log('  ' + doors.length + ' door(s) were available to the door server: ticked in ' + p.tick.length + ' collection entr' +
		(p.tick.length === 1 ? 'y' : 'ies') + (p.widen.length ? ', ' + p.widen.length + ' collection(s) now shown to both' : '') +
		(created ? ', ' + p.newCollection.doorIds.length + ' in a new "Door Server" collection' : ''));
	return { ticked: p.tick.length, widened: p.widen.length, created: created };
}
