// tests/notificationsWeb.test.js -- which notifications the web shows.
//
// A new PM raises a `pm_received` notification, which the terminal's
// notification reader relies on. On the web it duplicated the mail envelope
// and its own unread counter in the nav bar, so the web leaves that type out
// everywhere: the bell count, the dropdown, live pushes and /notifications.
// Opening the web bell marks everything read, and that must not reach the
// hidden type either, or the terminal would lose it without it ever having
// been shown.
//
// Rows for a user id no account holds (notifications.user_id has no foreign
// key), removed in after().

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var UID = 987654321;

describe('notifications on the web leave out pm_received', function () {
	this.timeout(15000);
	var available = false, pg, notif;

	before(async function () {
		available = await dbAvailable();
		if (!available) return;
		pg = await import('../src/middleware/db/postgres.js');
		notif = await import('../src/models/notifications.js');
	});

	beforeEach(async function () {
		if (!available) return this.skip();
		await pg.write('DELETE FROM notifications WHERE user_id = $1', [UID]);
		await pg.write("INSERT INTO notifications (user_id, type, title, read, created_at) VALUES " +
			"($1, 'pm_received', 'New PM from Someone', false, now()), " +
			"($1, 'tic_error', 'Bad TIC', false, now())", [UID]);
	});

	after(async function () {
		if (available) await pg.write('DELETE FROM notifications WHERE user_id = $1', [UID]);
	});

	it('counts and lists it for the terminal, not for the web', async function () {
		assert.strictEqual(await notif.getUnreadCount(UID, false), 2);
		assert.strictEqual(await notif.getUnreadCount(UID, false, { web: true }), 1);
		assert.deepStrictEqual((await notif.getUnread(UID, false, 10, { web: true })).map(n => n.type), ['tic_error']);
		assert.deepStrictEqual((await notif.getAll(UID, false, 50, 0, { web: true })).map(n => n.type), ['tic_error']);
		assert.strictEqual((await notif.getUnread(UID, false, 10)).length, 2);
	});

	it('leaves it unread for the terminal when the web bell marks all read', async function () {
		await notif.markAllRead(UID, false, { web: true });
		var left = await notif.getUnread(UID, false, 10);
		assert.deepStrictEqual(left.map(n => n.type), ['pm_received']);
	});

	it('is still marked read by the terminal', async function () {
		await notif.markAllRead(UID, false);
		assert.strictEqual(await notif.getUnreadCount(UID, false), 0);
	});

	it('is not pushed to the web bell when created', async function () {
		var pushed = [];
		notif.setPresenceServer({ _sendToUser: function (uid, msg) { pushed.push(msg.notifType); } });
		try {
			await notif.create(UID, 'pm_received', 'New PM', 'subject');
			await notif.create(UID, 'tic_error', 'Bad TIC', 'x');
		} finally {
			notif.setPresenceServer(null);
		}
		assert.deepStrictEqual(pushed, ['tic_error']);
	});
});
