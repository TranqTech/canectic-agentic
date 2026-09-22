// tests/migrationNetmailSeenbyText.test.js: 0007 widens the netmail SEEN-BY and
// PATH columns, and only those.
//
// The tosser now keeps every SEEN-BY line a message carries, which can run past
// the 255 characters netmail_in and netmail_out allowed. Pure: the database is
// a stand-in that answers the one question the migration asks.
//
// Run: npx mocha --no-config --exit tests/migrationNetmailSeenbyText.test.js

import assert from 'assert';
import * as m from '../db/migrations/0007-netmail-seenby-text.js';

function ctx(narrow) {
	var altered = [];
	return {
		altered: altered,
		log: function () {},
		postgres: {
			query: async function () { return narrow.slice(); },
			write: async function (sql) { altered.push(sql); return null; }
		}
	};
}

describe('migration 0007-netmail-seenby-text', function () {

	it('is needed while any of the four columns is not TEXT', async function () {
		assert.strictEqual(await m.isNeeded(ctx([{ table_name: 'netmail_in', column_name: 'seen_by' }])), true);
		assert.strictEqual(await m.isNeeded(ctx([])), false);
	});

	it('widens each narrow column to TEXT', async function () {
		var c = ctx([{ table_name: 'netmail_in', column_name: 'seen_by' }, { table_name: 'netmail_out', column_name: 'path' }]);
		await m.run(c);
		assert.deepStrictEqual(c.altered, [
			'ALTER TABLE netmail_in ALTER COLUMN seen_by TYPE TEXT',
			'ALTER TABLE netmail_out ALTER COLUMN path TYPE TEXT'
		]);
	});

	it('touches nothing outside its list, whatever the query returns', async function () {
		var c = ctx([{ table_name: 'users', column_name: 'path' }]);
		await m.run(c);
		assert.deepStrictEqual(c.altered, []);
	});

	it('fails loudly when an ALTER fails', async function () {
		var c = ctx([{ table_name: 'netmail_in', column_name: 'path' }]);
		c.postgres.write = async function () { return new Error('locked'); };
		await assert.rejects(m.run(c), /netmail_in\.path type change failed: locked/);
	});
});
