// tests/groupPushDefaults.test.js: pushing group defaults down onto member areas.
//
// Group settings seed new areas. pushDefaultsToAreas() is how they reach areas
// that already exist, and it overwrites, so the field selection has to be
// exact: pushing "security" must not quietly reset retention, and vice versa.
//
// The empty-list case below is a real trap that was caught by hand. The model
// treated `fields.length === 0` as "push everything", and the route fell back
// to ['all'] when the form posted no checkboxes. Since the form posts one entry
// per ticked box, unticking everything sent nothing, which meant unticking
// everything pushed everything. With retention in the list that could silently
// disable pruning across a whole group in one click.
//
// Both the message and file models are covered; they are parallel
// implementations over different tables, so a fix to one does not imply the
// other.
//
// Needs a live database. Skips cleanly without one. Fixtures are namespaced ZZ
// and removed afterwards.
// Run: npx mocha --spec tests/groupPushDefaults.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var GROUP = 'ZZPUSHGRP';
var AREA_A = 'ZZPUSHA';
var AREA_B = 'ZZPUSHB';

describe('pushDefaultsToAreas', function () {
	this.timeout(40000);

	var available = false;
	var pg = null, msgGroups = null, msgAreas = null, fileGroups = null;

	before(async function () {
		this.timeout(30000);
		try {
			available = await dbAvailable();
			if (!available) return;

			pg         = await import('../src/middleware/db/postgres.js');
			msgGroups  = await import('../src/models/msgGroups.js');
			msgAreas   = await import('../src/models/msgAreas.js');
			fileGroups = await import('../src/models/fileGroups.js');

			// Clean any wreckage from an interrupted earlier run.
			await msgAreas.removeArea(AREA_A, true).catch(function () {});
			await msgAreas.removeArea(AREA_B, true).catch(function () {});
			await msgGroups.removeGroup(GROUP, true).catch(function () {});

			var g = await msgGroups.newGroup({
				name: 'ZZ Push Test', description: 'temporary, created by groupPushDefaults.test.js',
				shortcode: GROUP, read_security: 10, post_security: 20,
				createdByName: 'groupPushDefaults.test.js'
			});
			if (!g || g.status !== true) { available = false; return; }

			for (var sc of [AREA_A, AREA_B]) {
				var a = await msgAreas.newArea({
					groupshortcode: GROUP, name: sc, description: sc, shortcode: sc,
					readsecurity: 50, postsecurity: 60, createdByName: 'groupPushDefaults.test.js'
				});
				if (!a.status) { available = false; return; }
			}
		} catch (_) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		this.timeout(30000);
		if (!pg) return;
		try {
			await msgAreas.removeArea(AREA_A, true).catch(function () {});
			await msgAreas.removeArea(AREA_B, true).catch(function () {});
			await msgGroups.removeGroup(GROUP, true).catch(function () {});
		} catch (_) {}
	});

	// -----------------------------------------------------------------------
	// helpers
	// -----------------------------------------------------------------------

	// Group carries values distinct from the areas', so a push is visible and
	// a non-push is equally visible.
	async function setGroup(fields) {
		await pg.write(
			'UPDATE message_groups SET read_security = $1, post_security = $2, ' +
			'post_as = $3, newscan_default = $4, max_age_days = $5, max_messages = $6 ' +
			'WHERE shortcode = $7',
			[fields.read_security, fields.post_security, fields.post_as,
			 fields.newscan_default, fields.max_age_days, fields.max_messages, GROUP]
		);
	}

	async function setAreas(fields) {
		await pg.write(
			'UPDATE message_areas SET read_security = $1, post_security = $2, ' +
			'post_as = $3, newscan_default = $4, max_age_days = $5, max_messages = $6 ' +
			'WHERE group_shortcode = $7',
			[fields.read_security, fields.post_security, fields.post_as,
			 fields.newscan_default, fields.max_age_days, fields.max_messages, GROUP]
		);
	}

	async function areas() {
		return await pg.query(
			'SELECT shortcode, read_security, post_security, post_as, newscan_default, ' +
			'max_age_days, max_messages FROM message_areas WHERE group_shortcode = $1 ORDER BY shortcode',
			[GROUP]
		);
	}

	// Group wants 11/22/realname/newscan on/90 days/5000 messages.
	// Areas start at 50/60/username/newscan off/no limits.
	async function baseline() {
		await setGroup({ read_security: 11, post_security: 22, post_as: 'realname',
			newscan_default: true, max_age_days: 90, max_messages: 5000 });
		await setAreas({ read_security: 50, post_security: 60, post_as: 'username',
			newscan_default: false, max_age_days: null, max_messages: null });
	}

	// -----------------------------------------------------------------------
	// the trap
	// -----------------------------------------------------------------------

	it('pushes nothing when given an explicitly empty field list', async function () {
		await baseline();
		var res = await msgGroups.pushDefaultsToAreas(GROUP, []);

		assert.strictEqual(res.status, false,
			'an empty selection is a request to push nothing, not everything');
		assert.strictEqual(res.updated, 0);

		for (var a of await areas()) {
			assert.strictEqual(a.read_security, 50, 'security must be untouched');
			assert.strictEqual(a.max_age_days, null, 'retention must be untouched');
			assert.strictEqual(a.post_as, 'username');
		}
	});

	it('still pushes everything for an omitted argument, for existing callers', async function () {
		await baseline();
		var res = await msgGroups.pushDefaultsToAreas(GROUP, undefined);
		assert.strictEqual(res.status, true);

		for (var a of await areas()) {
			assert.strictEqual(a.read_security, 11);
			assert.strictEqual(a.max_age_days, 90);
		}
	});

	it("still pushes everything for an explicit ['all']", async function () {
		await baseline();
		await msgGroups.pushDefaultsToAreas(GROUP, ['all']);

		for (var a of await areas()) {
			assert.strictEqual(a.read_security, 11);
			assert.strictEqual(a.post_security, 22);
			assert.strictEqual(a.post_as, 'realname');
			assert.strictEqual(a.newscan_default, true);
			assert.strictEqual(a.max_age_days, 90);
			assert.strictEqual(a.max_messages, 5000);
		}
	});

	// -----------------------------------------------------------------------
	// field selection
	// -----------------------------------------------------------------------

	it('pushes only security when only security is selected', async function () {
		await baseline();
		var res = await msgGroups.pushDefaultsToAreas(GROUP, ['security']);
		assert.strictEqual(res.status, true);
		assert.strictEqual(res.updated, 2);

		for (var a of await areas()) {
			assert.strictEqual(a.read_security, 11, 'security should be pushed');
			assert.strictEqual(a.post_security, 22);
			assert.strictEqual(a.max_age_days, null, 'retention must not ride along');
			assert.strictEqual(a.post_as, 'username', 'post_as must not ride along');
			assert.strictEqual(a.newscan_default, false);
		}
	});

	it('pushes only retention when only retention is selected', async function () {
		await baseline();
		await msgGroups.pushDefaultsToAreas(GROUP, ['retention']);

		for (var a of await areas()) {
			assert.strictEqual(a.max_age_days, 90, 'retention should be pushed');
			assert.strictEqual(a.max_messages, 5000);
			assert.strictEqual(a.read_security, 50, 'security must not ride along');
			assert.strictEqual(a.post_as, 'username');
		}
	});

	it('pushes post_as and newscan independently of each other', async function () {
		await baseline();
		await msgGroups.pushDefaultsToAreas(GROUP, ['post_as']);

		for (var a of await areas()) {
			assert.strictEqual(a.post_as, 'realname');
			assert.strictEqual(a.newscan_default, false, 'newscan must not ride along with post_as');
		}
	});

	it('can push several named fields at once', async function () {
		await baseline();
		await msgGroups.pushDefaultsToAreas(GROUP, ['security', 'retention']);

		for (var a of await areas()) {
			assert.strictEqual(a.read_security, 11);
			assert.strictEqual(a.max_age_days, 90);
			assert.strictEqual(a.post_as, 'username', 'unnamed fields stay put');
		}
	});

	// -----------------------------------------------------------------------
	// retention is nullable, and null means "no pruning"
	// -----------------------------------------------------------------------

	it('pushing retention from a group with no limits clears the areas', async function () {
		// This is the sharp edge that keeps the Retention tickbox unticked by
		// default in the UI: null is a real value meaning "never prune", so
		// pushing it turns pruning off everywhere in the group.
		await setGroup({ read_security: 11, post_security: 22, post_as: 'realname',
			newscan_default: true, max_age_days: null, max_messages: null });
		await setAreas({ read_security: 50, post_security: 60, post_as: 'username',
			newscan_default: false, max_age_days: 30, max_messages: 100 });

		await msgGroups.pushDefaultsToAreas(GROUP, ['retention']);

		for (var a of await areas()) {
			assert.strictEqual(a.max_age_days, null,
				'a group with no limits pushes "no limits", disabling pruning on its areas');
			assert.strictEqual(a.max_messages, null);
		}
	});

	// -----------------------------------------------------------------------
	// errors
	// -----------------------------------------------------------------------

	it('reports a missing group rather than throwing', async function () {
		var res = await msgGroups.pushDefaultsToAreas('ZZ_NO_SUCH_GROUP', ['security']);
		assert.strictEqual(res.status, false);
		assert.strictEqual(res.updated, 0);
		assert.ok((res.errormessages || []).length > 0);
	});

	it('reports an unrecognised field name as nothing to push', async function () {
		await baseline();
		var res = await msgGroups.pushDefaultsToAreas(GROUP, ['not_a_real_field']);
		assert.strictEqual(res.status, false);
		assert.strictEqual(res.updated, 0);

		for (var a of await areas()) {
			assert.strictEqual(a.read_security, 50, 'an unknown field must not push everything');
		}
	});

	// -----------------------------------------------------------------------
	// the file side carries the same guard
	// -----------------------------------------------------------------------

	describe('fileGroups', function () {
		it('also treats an explicitly empty field list as push-nothing', async function () {
			var grp = await pg.queryOne('SELECT shortcode FROM file_groups LIMIT 1');
			if (!grp) this.skip();

			var res = await fileGroups.pushDefaultsToAreas(grp.shortcode, []);
			assert.strictEqual(res.status, false,
				'the file model must not treat an empty list as ["all"] either');
			assert.strictEqual(res.updated, 0);
		});
	});
});
