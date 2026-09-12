// tests/echolistAreaLinks.test.js: echolist entries must not point at areas
// that no longer exist.
//
// network_echolist_areas.local_area_id is what makes an areatag read as
// "locally carried" everywhere in the admin UI. removeArea cleaned up the area
// record, its two backing tables, its peer subscriptions and its network_areas
// mapping, and left that pointer alone.
//
// The daily reconciliation would eventually clear it, but only for active
// entries and only by matching areatag, so an inactive entry kept the pointer
// for ever and every entry kept it until the next daily run.
//
// That window is the part that bites. Area ids come from a sequence, so a stale
// pointer does not stay visibly broken: create enough areas and one takes the
// id, at which point the echolist quietly reports an unrelated area as carried,
// and nothing in the UI can tell that from the truth.
//
// Both sides are covered because networkEcholist and fileEcholist are parallel
// implementations, and a fix to one has twice now not implied the other.
//
// Needs a live database. Skips cleanly without one. Everything is created under
// a ZZ shortcode and removed afterwards.
//
// Run: npx mocha

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var MSG_SHORTCODE  = 'ZZELINK';
var FILE_SHORTCODE = 'ZZFLINK';

describe('echolist local_area_id cleanup', function () {
	this.timeout(40000);

	var available = false;
	var pg = null, msgAreas = null, fileAreas = null;
	var networkEcholist = null, fileEcholist = null;
	var msgGroupShort = null, fileGroupShort = null, networkId = null;
	var echolistId = null, fileEcholistId = null;

	before(async function () {
		this.timeout(30000);
		try {
			available = await dbAvailable();
			if (!available) return;
			pg              = await import('../src/middleware/db/postgres.js');
			msgAreas        = await import('../src/models/msgAreas.js');
			fileAreas       = await import('../src/models/fileAreas.js');
			networkEcholist = await import('../src/models/networkEcholist.js');
			fileEcholist    = await import('../src/models/fileEcholist.js');

			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			var fgrp = await pg.queryOne('SELECT shortcode FROM file_groups LIMIT 1');
			var net = await pg.queryOne('SELECT id FROM message_networks LIMIT 1');
			if (!grp || !fgrp || !net) { available = false; return; }
			msgGroupShort  = grp.shortcode;
			fileGroupShort = fgrp.shortcode;
			networkId      = net.id;

			var el = await networkEcholist.createEcholist(networkId, 'ZZ Link Test',
				'temporary, created by echolistAreaLinks.test.js', false);
			echolistId = el.insertId || el.id;
			var fel = await fileEcholist.createEcholist(networkId, 'ZZ File Link Test',
				'temporary, created by echolistAreaLinks.test.js', false);
			fileEcholistId = fel.insertId || fel.id;
			if (!echolistId || !fileEcholistId) { available = false; return; }
		} catch (_) {
			available = false;
		}
	});

	beforeEach(async function () {
		if (!available) return this.skip();
		await pg.write('DELETE FROM network_echolist_areas WHERE echolist_id = $1', [echolistId]);
		await pg.write('DELETE FROM file_echolist_areas WHERE echolist_id = $1', [fileEcholistId]);
		await pg.write("DELETE FROM network_areas WHERE areatag LIKE 'ZZ.LINK.%'");
		await msgAreas.removeArea(MSG_SHORTCODE, true).catch(function () {});
		await fileAreas.removeArea(FILE_SHORTCODE, false).catch(function () {});
	});

	after(async function () {
		this.timeout(30000);
		if (!available || !pg) return;
		try {
			await pg.write('DELETE FROM network_echolist_areas WHERE echolist_id = $1', [echolistId]);
			await pg.write('DELETE FROM file_echolist_areas WHERE echolist_id = $1', [fileEcholistId]);
			await pg.write("DELETE FROM network_areas WHERE areatag LIKE 'ZZ.LINK.%'");
			await pg.write('DELETE FROM network_echolists WHERE id = $1', [echolistId]);
			await pg.write('DELETE FROM file_echolists WHERE id = $1', [fileEcholistId]);
			await msgAreas.removeArea(MSG_SHORTCODE, true).catch(function () {});
			await fileAreas.removeArea(FILE_SHORTCODE, false).catch(function () {});
		} catch (_) {}
	});

	// -----------------------------------------------------------------------
	// helpers
	// -----------------------------------------------------------------------

	async function makeMsgArea() {
		var created = await msgAreas.newArea({
			groupshortcode: msgGroupShort,
			name: 'Echolist link test',
			description: 'temporary, created by echolistAreaLinks.test.js',
			shortcode: MSG_SHORTCODE, readsecurity: 50, postsecurity: 60,
			createdByName: 'echolistAreaLinks.test.js'
		});
		assert.ok(created.status, 'could not create the test message area: ' +
			(created.errormessages || []).join(', '));
		return (await msgAreas.getAreaByShortcode(MSG_SHORTCODE)).id;
	}

	async function makeFileArea() {
		var created = await fileAreas.newArea({
			groupshortcode: fileGroupShort,
			name: 'Filebone link test',
			description: 'temporary, created by echolistAreaLinks.test.js',
			shortcode: FILE_SHORTCODE
		});
		assert.ok(created.status, 'could not create the test file area: ' +
			(created.errormessages || []).join(', '));
		return (await fileAreas.getAreaByShortcode(FILE_SHORTCODE)).id;
	}

	async function addEcholistEntry(areatag, localAreaId, active) {
		await pg.insertObject({
			echolist_id: echolistId, areatag: areatag,
			description: 'test entry', active: active !== false,
			local_area_id: localAreaId
		}, 'network_echolist_areas');
		return (await pg.queryOne(
			'SELECT id FROM network_echolist_areas WHERE echolist_id = $1 AND areatag = $2',
			[echolistId, areatag])).id;
	}

	async function addFileEcholistEntry(areatag, localAreaId, active) {
		await pg.insertObject({
			echolist_id: fileEcholistId, areatag: areatag,
			description: 'test entry', active: active !== false,
			local_area_id: localAreaId
		}, 'file_echolist_areas');
		return (await pg.queryOne(
			'SELECT id FROM file_echolist_areas WHERE echolist_id = $1 AND areatag = $2',
			[fileEcholistId, areatag])).id;
	}

	async function localAreaIdOf(table, id) {
		var row = await pg.queryOne('SELECT local_area_id FROM ' + table + ' WHERE id = $1', [id]);
		return row ? row.local_area_id : 'ROW GONE';
	}

	// -----------------------------------------------------------------------
	// removeArea clears the pointer at the point of deletion
	// -----------------------------------------------------------------------

	it('clears local_area_id when the message area is removed', async function () {
		var areaId = await makeMsgArea();
		var entry  = await addEcholistEntry('ZZ.LINK.TEST', areaId);

		assert.strictEqual(Number(await localAreaIdOf('network_echolist_areas', entry)), Number(areaId),
			'the entry should start out pointing at the area');

		var res = await msgAreas.removeArea(MSG_SHORTCODE, true);
		assert.ok(res.status, 'removeArea failed: ' + (res.errormessages || []).join(', '));

		assert.strictEqual(await localAreaIdOf('network_echolist_areas', entry), null,
			'the echolist entry still points at an area that no longer exists');
	});

	it('clears the pointer even when the entry is inactive', async function () {
		// The daily reconciliation is scoped to active entries, so this one
		// would never have been corrected by anything at all.
		var areaId = await makeMsgArea();
		var entry  = await addEcholistEntry('ZZ.LINK.GONE', areaId, false);

		await msgAreas.removeArea(MSG_SHORTCODE, true);

		assert.strictEqual(await localAreaIdOf('network_echolist_areas', entry), null);
	});

	it('clears the pointer regardless of whether the areatag matches', async function () {
		// syncLocalAreaId matches on areatag. An area mapped to the network
		// under one tag and listed in the echolist under another is unusual but
		// possible, and clearing by id does not care.
		var areaId = await makeMsgArea();
		var entry  = await addEcholistEntry('ZZ.SOME.OTHER.TAG', areaId);

		await msgAreas.removeArea(MSG_SHORTCODE, true);

		assert.strictEqual(await localAreaIdOf('network_echolist_areas', entry), null);
	});

	it('leaves entries pointing at other areas alone', async function () {
		var areaId = await makeMsgArea();
		var mine   = await addEcholistEntry('ZZ.LINK.MINE', areaId);
		// A pointer at some other area id, which must survive untouched.
		var other  = await pg.queryOne(
			'SELECT id FROM message_areas WHERE id != $1 LIMIT 1', [areaId]);
		var theirs = other ? await addEcholistEntry('ZZ.LINK.THEIRS', other.id) : null;

		await msgAreas.removeArea(MSG_SHORTCODE, true);

		assert.strictEqual(await localAreaIdOf('network_echolist_areas', mine), null);
		if (theirs) {
			assert.strictEqual(Number(await localAreaIdOf('network_echolist_areas', theirs)),
				Number(other.id), 'an unrelated entry was cleared');
		}
	});

	it('clears local_area_id when the file area is removed', async function () {
		var areaId = await makeFileArea();
		var entry  = await addFileEcholistEntry('ZZ.FLINK.TEST', areaId);

		var res = await fileAreas.removeArea(FILE_SHORTCODE, false);
		assert.ok(res.status, 'removeArea failed: ' + (res.errormessages || []).join(', '));

		assert.strictEqual(await localAreaIdOf('file_echolist_areas', entry), null,
			'the filebone entry still points at an area that no longer exists');
	});

	// -----------------------------------------------------------------------
	// reconciliation repairs dangles a database already carries
	// -----------------------------------------------------------------------

	it('reconciliation clears a pointer at an area id that does not exist', async function () {
		// The state an existing install is in: rows written before removeArea
		// learned to clear them. An id far above any real one stands in for a
		// deleted area.
		var ghost = 2000000000;
		var entry = await addEcholistEntry('ZZ.LINK.GHOST', ghost);

		await networkEcholist.reconcileLocalAreaIds();

		assert.strictEqual(await localAreaIdOf('network_echolist_areas', entry), null);
	});

	it('reconciliation clears a dangling pointer on an inactive entry too', async function () {
		var ghost = 2000000001;
		var entry = await addEcholistEntry('ZZ.LINK.GHOST.OLD', ghost, false);

		await networkEcholist.reconcileLocalAreaIds();

		assert.strictEqual(await localAreaIdOf('network_echolist_areas', entry), null,
			'the pre-existing clear is scoped to active rows, so this needs its own rule');
	});

	it('reconciliation clears a dangling filebone pointer', async function () {
		var ghost = 2000000002;
		var entry = await addFileEcholistEntry('ZZ.FLINK.GHOST', ghost, false);

		await fileEcholist.reconcileLocalAreaIds();

		assert.strictEqual(await localAreaIdOf('file_echolist_areas', entry), null);
	});

	it('reconciliation leaves a pointer at a real area alone', async function () {
		// The reconciliation deletes data, so the property that matters as much
		// as the clearing is that it does not clear a live link.
		//
		// "Carried" means there is a network_areas mapping, not merely that the
		// area exists: the pre-existing clear is written against that mapping.
		// An earlier draft of this test set local_area_id without one and the
		// test failed, correctly, which is worth leaving recorded here.
		var areaId = await makeMsgArea();
		var entry  = await addEcholistEntry('ZZ.LINK.LIVE', areaId);
		await pg.insertObject({
			network_id: networkId, area_id: areaId, areatag: 'ZZ.LINK.LIVE', active: true
		}, 'network_areas');

		await networkEcholist.reconcileLocalAreaIds();

		assert.strictEqual(Number(await localAreaIdOf('network_echolist_areas', entry)), Number(areaId),
			'reconciliation cleared a pointer at an area that exists');
	});

	// -----------------------------------------------------------------------
	// the invariant itself
	// -----------------------------------------------------------------------

	it('no echolist entry anywhere points at a missing area once reconciled', async function () {
		await networkEcholist.reconcileLocalAreaIds();
		await fileEcholist.reconcileLocalAreaIds();

		var msgDangles = await pg.queryOne(
			'SELECT COUNT(*)::int AS n FROM network_echolist_areas ea ' +
			'WHERE ea.local_area_id IS NOT NULL ' +
			'AND NOT EXISTS (SELECT 1 FROM message_areas ma WHERE ma.id = ea.local_area_id)');
		var fileDangles = await pg.queryOne(
			'SELECT COUNT(*)::int AS n FROM file_echolist_areas ea ' +
			'WHERE ea.local_area_id IS NOT NULL ' +
			'AND NOT EXISTS (SELECT 1 FROM file_areas fa WHERE fa.id = ea.local_area_id)');

		assert.strictEqual(msgDangles.n, 0, 'echolist entries point at missing message areas');
		assert.strictEqual(fileDangles.n, 0, 'filebone entries point at missing file areas');
	});
});
