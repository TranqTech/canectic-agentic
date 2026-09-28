// tests/pmNotificationRead.test.js -- reading or deleting a PM clears its
// "New PM" notification, wherever it happened.
//
// The web hides pm_received (the mail icon counts new mail), but the terminal
// notification reader shows it, and reading the mail anywhere left it there
// unread until it was cleared in the terminal as well. Each notice now names
// its PM (ref 'pm:<id>'), and every read path clears the notices for the PMs
// it marked read: viewing (getMessage, which the web and terminal readers
// use), the mark read button, mark all read, IMAP \Seen (same helper, not
// driven here) and a committed QWK download; and deleting, from the web and
// terminal (deleteMessage) or a mail client (IMAP move to Trash).
//
// Uses a user id no account holds; pm_inbox and notifications have no foreign
// key to users. Rows removed in after().

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var UID = 987654322;

describe('reading a PM clears its notification', function () {
	this.timeout(20000);
	var available = false, pg, pm, notif, qwkUser;

	before(async function () {
		available = await dbAvailable();
		if (!available) return;
		pg = await import('../src/middleware/db/postgres.js');
		pm = await import('../src/models/privateMessages.js');
		notif = await import('../src/models/notifications.js');
		qwkUser = await import('../src/models/qwkUser.js');
		await notif.ensureTable();
	});

	async function clean() {
		await pg.write('DELETE FROM notifications WHERE user_id = $1', [UID]);
		await pg.write('DELETE FROM pm_inbox WHERE user_id = $1', [UID]);
	}

	beforeEach(async function () {
		if (!available) return this.skip();
		await clean();
	});

	after(async function () { if (available) await clean(); });

	async function deliver(subject) {
		var r = await pm.deliverMessage({ user_id: UID, from_user: 'ZZSender', to_user: 'ZZReader',
			subject: subject, body_text: 'hello', transport_type: 'LOCAL', transport_data: {} });
		assert.ok(r.status, 'delivery failed');
		return r;
	}

	async function unreadFor(r) {
		var row = await pg.queryOne("SELECT read FROM notifications WHERE user_id = $1 AND ref = $2", [UID, 'pm:' + r.insertId]);
		assert.ok(row, 'no notification carries ref pm:' + r.insertId);
		return !row.read;
	}

	it('names the PM on the notification it raises', async function () {
		var a = await deliver('one');
		assert.strictEqual(await unreadFor(a), true);
	});

	it('clears only the read PM\'s notification when it is opened', async function () {
		var a = await deliver('one');
		var b = await deliver('two');
		await pm.getMessage(UID, a.uuid);
		assert.strictEqual(await unreadFor(a), false);
		assert.strictEqual(await unreadFor(b), true);
	});

	it('clears it from the mark read button', async function () {
		var a = await deliver('one');
		await pm.markRead(UID, a.uuid);
		assert.strictEqual(await unreadFor(a), false);
	});

	it('clears them all from mark all read', async function () {
		var a = await deliver('one');
		var b = await deliver('two');
		await pm.markAllRead(UID);
		assert.strictEqual(await unreadFor(a), false);
		assert.strictEqual(await unreadFor(b), false);
	});

	it('clears it when a QWK download containing the PM is committed', async function () {
		var a = await deliver('one');
		await qwkUser.commitUserPacket({ commit: { userId: UID, pmIds: [a.insertId], builtAt: new Date() } });
		assert.strictEqual(await unreadFor(a), false);
	});

	it('clears only the deleted PM\'s notification on delete', async function () {
		var a = await deliver('one');
		var b = await deliver('two');
		await pm.deleteMessage(UID, a.uuid);
		assert.strictEqual(await unreadFor(a), false);
		assert.strictEqual(await unreadFor(b), true);
	});

	it('clears it when a mail client moves the PM to Trash', async function () {
		var a = await deliver('one');
		var imap = await import('../src/servers/imapServer.js');
		var session = {
			selectedMailbox: 'INBOX', userId: UID,
			_resolveTable: function () { return { table: 'pm_inbox', source: 'inbox' }; }
		};
		await imap.ImapSession.prototype._markDeleted.call(session, { id: a.insertId }, 1);
		assert.strictEqual(await unreadFor(a), false);
		var row = await pg.queryOne('SELECT deleted FROM pm_inbox WHERE id = $1', [a.insertId]);
		assert.strictEqual(row.deleted, true);
	});

	it('clears a notice from before refs only once no unread mail is left', async function () {
		var a = await deliver('one');
		var b = await deliver('two');
		await pg.write("INSERT INTO notifications (user_id, type, title, read, created_at) VALUES ($1, 'pm_received', 'old', false, now())", [UID]);
		var legacyUnread = async () => (await pg.queryOne(
			"SELECT count(*)::int n FROM notifications WHERE user_id = $1 AND ref IS NULL AND read = false", [UID])).n;

		await pm.getMessage(UID, a.uuid);
		assert.strictEqual(await legacyUnread(), 1, 'cleared while mail was still unread');
		await pm.getMessage(UID, b.uuid);
		assert.strictEqual(await legacyUnread(), 0);
	});
});
