// tests/userActivity.test.js -- post and upload counts, and the template
// events they fire (#82).
//
// user_first_message_post, user_nth_post, user_first_file_upload and
// user_nth_upload were seeded but nothing fired them: users had no counters,
// and a local post never recorded its author (mb_*_msgs.user_id was 0 on every
// row). Posts now carry user_id and bump users.post_count, uploads bump
// users.upload_count, and migration 0009 starts both from what is held.
//
// Uses a throwaway user and a throwaway area, zz82test, whose backing tables
// are copied from an existing area's shape; all removed in after(). Events are
// captured through setFireForTests rather than run as real templates.

import assert from 'assert';
import * as fs from 'fs';
import { dbAvailable } from './helpers/dbAvailable.js';
import { backfillPostCounts } from '../src/models/userActivity.js';

describe('userActivity (#82)', function () {

	describe('backfillPostCounts', function () {
		it('credits a user by id, username and full name, each once', function () {
			var users = [{ id: 1, username: 'Underminer', fullname: 'Kostie Muirhead' },
				{ id: 2, username: 'Same', fullname: 'same' }];
			var out = backfillPostCounts(users, { 1: 5 }, { 'underminer': 11, 'kostie muirhead': 3, 'same': 4 });
			assert.deepStrictEqual(out, { 1: 19, 2: 4 });
		});

		it('gives a user with nothing held zero', function () {
			assert.deepStrictEqual(backfillPostCounts([{ id: 9, username: 'x' }], {}, {}), { 9: 0 });
		});
	});

	describe('against the database', function () {
		this.timeout(30000);
		var available = false, pg, messages, fileEntries, activity, migration;
		var user = null, fired = [];
		var AREA = 'zz82test', MSGS = 'mb_zz82test_msgs', THREADS = 'mb_zz82test_threads';

		before(async function () {
			available = await dbAvailable();
			if (!available) return;
			pg = await import('../src/middleware/db/postgres.js');
			messages = await import('../src/models/messages.js');
			fileEntries = await import('../src/models/fileEntries.js');
			activity = await import('../src/models/userActivity.js');
			migration = await import('../db/migrations/0009-user-activity-counts.js');
			await cleanup();
			var tpl = await pg.queryOne("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'mb\\_%\\_msgs' AND table_name <> $1 LIMIT 1", [MSGS]);
			var base = tpl.table_name.replace(/_msgs$/, '');
			await pg.write('CREATE TABLE ' + MSGS + ' (LIKE ' + base + '_msgs INCLUDING ALL)');
			await pg.write('CREATE TABLE ' + THREADS + ' (LIKE ' + base + '_threads INCLUDING ALL)');
			await pg.write("INSERT INTO message_areas (shortcode, name, active) VALUES ($1, 'ZZ 82 test', false)", [AREA.toUpperCase()]);
			user = await pg.queryOne("INSERT INTO users (uuid, username, fullname, post_count, upload_count) " +
				"VALUES (gen_random_uuid()::text, 'zz_act_82', 'Zz Activity', 0, 0) RETURNING id, uuid");
			activity.setFireForTests(function (code, uid, event) { fired.push({ code: code, uid: uid, event: event }); });
		});

		async function cleanup() {
			await pg.write('DROP TABLE IF EXISTS ' + MSGS);
			await pg.write('DROP TABLE IF EXISTS ' + THREADS);
			await pg.write('DELETE FROM message_areas WHERE lower(shortcode) = $1', [AREA]);
			await pg.write("DELETE FROM file_entries WHERE filename LIKE 'zz82-%'");
			await pg.write("DELETE FROM users WHERE username = 'zz_act_82'");
		}

		beforeEach(function () { if (!available) return this.skip(); fired = []; });

		after(async function () {
			if (!available) return;
			if (activity) activity.setFireForTests(null);
			await cleanup();
		});

		var count = async (col) => parseInt((await pg.queryOne('SELECT ' + col + ' AS n FROM users WHERE id = $1', [user.id])).n);

		it('records the author on a post, counts it and fires first and nth', async function () {
			var r = await messages.startNewThread({ from_user: 'zz_act_82', subject: 'first', body_text: 'hello', user_id: user.id }, AREA);
			assert.ok(r.status, JSON.stringify(r.errormessages));
			var row = await pg.queryOne('SELECT user_id FROM ' + MSGS + ' WHERE id = $1', [r.insertId]);
			assert.strictEqual(parseInt(row.user_id), user.id);
			assert.strictEqual(await count('post_count'), 1);
			assert.deepStrictEqual(fired.map(f => f.code), ['user_first_message_post', 'user_nth_post']);
			assert.strictEqual(fired[0].event.area_shortcode, AREA);
			assert.strictEqual(fired[0].event.subject, 'first');
			this.threaduuid = r.threaduuid;
			var reply = await messages.replyToThread({ from_user: 'zz_act_82', subject: 'Re: first', body_text: 'again', user_id: user.id }, AREA, r.threaduuid);
			assert.ok(reply.status, JSON.stringify(reply.errormessages));
			assert.strictEqual(await count('post_count'), 2);
			assert.deepStrictEqual(fired.map(f => f.code), ['user_first_message_post', 'user_nth_post', 'user_nth_post']);
			assert.strictEqual(fired[2].event.post_count, 2);
		});

		it('does not count a post with no local author', async function () {
			var before = await count('post_count');
			var r = await messages.startNewThread({ from_user: 'Someone', subject: 'x', body_text: 'y' }, AREA);
			assert.ok(r.status);
			assert.strictEqual(await count('post_count'), before);
			assert.strictEqual(fired.length, 0);
		});

		it('counts an upload and fires first and nth; an entry with no uploader is not counted', async function () {
			var r = await fileEntries.addFileEntry({ area_id: 987654, area_shortcode: 'ZZ82', filename: 'zz82-a.zip', uploader_uuid: user.uuid });
			assert.ok(r.status, JSON.stringify(r.errormessages));
			assert.strictEqual(await count('upload_count'), 1);
			assert.deepStrictEqual(fired.map(f => f.code), ['user_first_file_upload', 'user_nth_upload']);
			assert.strictEqual(fired[0].event.filename, 'zz82-a.zip');
			await fileEntries.addFileEntry({ area_id: 987654, area_shortcode: 'ZZ82', filename: 'zz82-tic.zip', source_type: 'tic' });
			assert.strictEqual(await count('upload_count'), 1);
		});

		it('backfills: by id, by name for older local posts, never a tossed message', async function () {
			// An older local post under the full name, with no author recorded.
			await pg.write('INSERT INTO ' + MSGS + " (uuid, from_user, subject, body_text, user_id) VALUES (gen_random_uuid()::text, 'Zz Activity', 'old', 'x', 0)");
			// The same name arriving from a network: not ours.
			await pg.write('INSERT INTO ' + MSGS + " (uuid, from_user, subject, body_text, user_id, tosser_id) VALUES (gen_random_uuid()::text, 'Zz Activity', 'far', 'x', 0, 1)");
			await pg.write('UPDATE users SET post_count = 0, upload_count = 0 WHERE id = $1', [user.id]);
			await migration.run({ postgres: pg, log: function () {} });
			assert.strictEqual(await count('post_count'), 3, 'two posts by id plus one old post by name');
			assert.strictEqual(await count('upload_count'), 1);
		});

		it('credits a web post to the session user, never to a user_id in the form', function () {
			var src = fs.readFileSync(new URL('../src/routes/index.js', import.meta.url), 'utf8');
			var sets = src.match(/formObj\.user_id = parseInt\(currentuser\.id\);/g) || [];
			assert.strictEqual(sets.length, 2, 'new thread and reply must both overwrite formObj.user_id');
		});
	});
});
