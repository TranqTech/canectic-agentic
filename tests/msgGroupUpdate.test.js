// tests/msgGroupUpdate.test.js: saving a message group's own settings.
//
// updateGroup() writes only the fields the form actually posted, so a caller
// can update one setting without resetting the rest. That only holds if every
// field is tested on its own. The retention fields used to sit inside the
// newscan_default block because of a misplaced brace, so max_age_days and
// max_messages were silently dropped by any caller that did not also post
// newscan_default. The edit form always posts it, which is why nothing
// visible broke.
//
// Needs a live database. Skips cleanly without one. Fixtures are namespaced ZZ
// and removed afterwards.
// Run: npx mocha --spec tests/msgGroupUpdate.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var GROUP = 'ZZUPDGRP';

describe('msgGroups.updateGroup', function () {
	this.timeout(30000);

	var available = false;
	var pg = null, msgGroups = null;

	before(async function () {
		this.timeout(20000);
		try {
			available = await dbAvailable();
			if (!available) return;

			pg        = await import('../src/middleware/db/postgres.js');
			msgGroups = await import('../src/models/msgGroups.js');

			await msgGroups.removeGroup(GROUP, true).catch(function () {});
			var g = await msgGroups.newGroup({
				name: 'ZZ Update Test', description: 'temporary, created by msgGroupUpdate.test.js',
				shortcode: GROUP, read_security: 10, post_security: 20,
				createdByName: 'msgGroupUpdate.test.js'
			});
			if (!g || g.status !== true) available = false;
		} catch (_) {
			available = false;
		}
	});

	beforeEach(async function () {
		if (!available) this.skip();
		await pg.write(
			'UPDATE message_groups SET newscan_default = false, max_age_days = NULL, ' +
			'max_messages = NULL, thread_mode = $1 WHERE shortcode = $2',
			['standard', GROUP]
		);
	});

	after(async function () {
		if (!msgGroups) return;
		await msgGroups.removeGroup(GROUP, true).catch(function () {});
	});

	async function group() {
		return await pg.queryOne(
			'SELECT newscan_default, max_age_days, max_messages, thread_mode, updated_at ' +
			'FROM message_groups WHERE shortcode = $1',
			[GROUP]
		);
	}

	it('saves retention limits when newscan_default is not posted', async function () {
		var res = await msgGroups.updateGroup(GROUP, { max_age_days: '30', max_messages: '500' });
		assert.strictEqual(res.status, true, (res.errormessages || []).join(', '));

		var g = await group();
		assert.strictEqual(g.max_age_days, 30, 'max_age_days must not depend on newscan_default being posted');
		assert.strictEqual(g.max_messages, 500, 'max_messages must not depend on newscan_default being posted');
	});

	it('leaves retention alone when only newscan_default is posted', async function () {
		await pg.write('UPDATE message_groups SET max_age_days = 90, max_messages = 5000 WHERE shortcode = $1', [GROUP]);

		var res = await msgGroups.updateGroup(GROUP, { newscan_default: 'true' });
		assert.strictEqual(res.status, true, (res.errormessages || []).join(', '));

		var g = await group();
		assert.strictEqual(g.newscan_default, true);
		assert.strictEqual(g.max_age_days, 90, 'an unposted field keeps its stored value');
		assert.strictEqual(g.max_messages, 5000, 'an unposted field keeps its stored value');
	});

	it('still clears retention when the form posts the limits empty', async function () {
		await pg.write('UPDATE message_groups SET max_age_days = 90, max_messages = 5000 WHERE shortcode = $1', [GROUP]);

		var res = await msgGroups.updateGroup(GROUP, { newscan_default: 'false', max_age_days: '', max_messages: '' });
		assert.strictEqual(res.status, true, (res.errormessages || []).join(', '));

		var g = await group();
		assert.strictEqual(g.max_age_days, null, 'an empty box means no limit');
		assert.strictEqual(g.max_messages, null, 'an empty box means no limit');
	});

	it('saves thread_mode and stamps updated_at', async function () {
		var before = (await group()).updated_at;

		var res = await msgGroups.updateGroup(GROUP, { thread_mode: 'no_threads' });
		assert.strictEqual(res.status, true, (res.errormessages || []).join(', '));

		var g = await group();
		assert.strictEqual(g.thread_mode, 'no_threads');
		assert.ok(!before || g.updated_at > before,
			'a successful save stamps updated_at, which is how a save that never wrote is told apart');
	});
});
