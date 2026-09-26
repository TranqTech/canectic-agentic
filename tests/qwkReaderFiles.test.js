// tests/qwkReaderFiles.test.js: offline-reader file features in personal QWK
// packets (#75), matching Synchronet (pack_qwk.cpp, qwk.cpp qwkcfgline):
//   1. NEWFILES.DAT, the new-files list (users.qwk_files, on by default)
//   2. the batch download queue packed into the packet
//   3. private mail attachments (users.qwk_attach, on by default)
//   4. REP control messages to SBBS: FILES, ATTACH and FREQ
//
// Fixture: a throwaway user (security 0, so no real message areas), a file
// group whose base_dir is a temp directory with an open area and one locked to
// security 999, files on disk, and a PM with an attachment; all removed.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbAvailable } from './helpers/dbAvailable.js';
import { parseControl } from '../src/models/qwkControl.js';
import { renderNewFilesList, sizeText } from '../src/models/qwkNewFiles.js';
import { plainName, PacketFileSet } from '../src/models/qwkPacketFiles.js';

describe('QWK control messages (parseControl)', function () {
	it('reads FILES and ATTACH the way Synchronet does ("ON " with its space, anything else is off)', function () {
		assert.deepStrictEqual(parseControl('FILES ON'), { command: 'FILES', on: true, raw: 'FILES ON' });
		assert.strictEqual(parseControl('files on').on, true);
		assert.strictEqual(parseControl('FILES OFF').on, false);
		assert.strictEqual(parseControl('FILES ONLY').on, false);
		assert.strictEqual(parseControl('ATTACH ON').on, true);
		assert.strictEqual(parseControl('ATTACH NO').on, false);
	});

	it('reads FILES MM/DD/YY as on, from that date', function () {
		var c = parseControl('FILES 09/20/26');
		assert.strictEqual(c.on, true);
		assert.strictEqual(c.since.getFullYear(), 2026);
		assert.strictEqual(c.since.getMonth(), 8);
		assert.strictEqual(c.since.getDate(), 20);
	});

	it('reads FREQ with the file name as given', function () {
		assert.strictEqual(parseControl('FREQ nodelist.z12').filename, 'nodelist.z12');
		assert.strictEqual(parseControl('RESET').command, 'UNKNOWN');
	});
});

describe('NEWFILES.DAT, as Synchronet writes it', function () {
	it('sizes files as Synchronet does', function () {
		assert.strictEqual(sizeText(512), '512');
		assert.strictEqual(sizeText(12595), '12.3K');
		assert.strictEqual(sizeText(1048576), '1M');
	});

	it('lays out headers, rules, files and the total with CRLF lines', function () {
		var text = renderNewFilesList(new Date(2026, 8, 20, 14, 5), [
			{ groupNum: 1, groupName: 'Main', areaNum: 2, areaName: 'Utilities', files: [
				{ filename: 'TOOL.ZIP', file_size: 12595, short_desc: 'A tool' },
				{ filename: 'OTHER.ZIP', file_size: 100, short_desc: '' }] }
		]);
		assert.strictEqual(text,
			'New files since: 09/20/26 14:05\r\n' +
			'\r\n(1) Main (2) Utilities\r\n----------------------\r\n' +
			'TOOL.ZIP       12.3K A tool\r\n' +
			'OTHER.ZIP        100 OTHER.ZIP\r\n' +
			'\r\n2 Files Listed.\r\n');
	});

	it('is nothing when there is nothing new', function () {
		assert.strictEqual(renderNewFilesList(new Date(), [{ groupNum: 1, groupName: 'G', areaNum: 1, areaName: 'A', files: [] }]), '');
	});
});

describe('naming files in a packet', function () {
	it('keeps names plain, off the packet\'s own members, and unique', function () {
		assert.strictEqual(plainName('../my file(1).zip'), 'my_file_1_.zip');
		var set = new PacketFileSet('/nonexistent');
		assert.strictEqual(set.nameFor('messages.dat'), 'messages_1.dat');
		set.names.add('TOOL.ZIP');
		assert.strictEqual(set.nameFor('tool.zip'), 'tool_1.zip');
		assert.notStrictEqual(set.nameFor('X.MSG').toUpperCase().slice(-4), '.MSG');
	});
});

describe('offline-reader files in personal packets (#75)', function () {
	this.timeout(60000);

	var available = false;
	var pg, qwkUser, qwkClasses;
	var tmp, userId, userUuid, pmUuid, entryIds = {};
	var USER = 'ZZQwkReader';

	async function cleanup() {
		var u = await pg.queryOne('SELECT id FROM users WHERE username = $1', [USER]);
		if (u) {
			await pg.write('DELETE FROM user_file_batch WHERE user_id = $1', [u.id]);
			await pg.write('DELETE FROM user_msg_pointers WHERE user_id = $1', [u.id]).catch(function () {});
			var inbox = await pg.query('SELECT uuid FROM pm_inbox WHERE user_id = $1', [u.id]);
			for (var m of inbox || []) await pg.write('DELETE FROM pm_attachments WHERE message_uuid = $1', [m.uuid]);
			await pg.write('DELETE FROM pm_inbox WHERE user_id = $1', [u.id]);
			await pg.write('DELETE FROM users WHERE id = $1', [u.id]);
		}
		await pg.write("DELETE FROM file_entries WHERE area_shortcode LIKE 'ZZQR%'");
		await pg.write("DELETE FROM file_areas WHERE shortcode LIKE 'ZZQR%'");
		await pg.write("DELETE FROM file_groups WHERE shortcode = 'ZZQRGRP'");
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	}

	async function packetNames(built) {
		var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzqr-x-'));
		qwkClasses.unzipQwkPacket(built.qwkPath, dir);
		var names = fs.readdirSync(dir).sort();
		var content = {};
		for (var n of names) content[n] = fs.readFileSync(path.join(dir, n));
		fs.rmSync(dir, { recursive: true, force: true });
		qwkUser.cleanupQwkPacket(built.qwkPath);
		return { names: names, content: content };
	}

	function repWith(subjects) {
		var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzqr-rep-'));
		var items = subjects.map(function (subj, i) {
			return { conferenceNum: 0, isPrivate: true, msg: { id: i + 1, from_user: USER, to_user: 'SBBS',
				subject: subj, body_text: 'x\r', system_time: new Date(), reply_ref: 0 } };
		});
		return qwkClasses.buildRepPacket(items, qwkUser.getQwkBbsId(), dir, qwkUser.getQwkBbsId());
	}

	before(async function () {
		try {
			available = await dbAvailable();
			if (!available) return;
			pg         = await import('../src/middleware/db/postgres.js');
			qwkUser    = await import('../src/models/qwkUser.js');
			qwkClasses = await import('../src/models/qwkClasses.js');
			await cleanup();
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zzqr-'));
			fs.mkdirSync(path.join(tmp, 'pub')); fs.mkdirSync(path.join(tmp, 'sec'));
			fs.writeFileSync(path.join(tmp, 'pub', 'NEWONE_1.ZIP'), 'new file bytes');
			fs.writeFileSync(path.join(tmp, 'pub', 'OLDONE.ZIP'), 'old');
			fs.writeFileSync(path.join(tmp, 'sec', 'SECRET.ZIP'), 'secret');
			fs.writeFileSync(path.join(tmp, 'NOTE.TXT'), 'attached note');

			await pg.write("INSERT INTO file_groups (name, shortcode, base_dir, active, read_security, browse_security) VALUES ('ZZ QR Group', 'ZZQRGRP', $1, true, 0, 0)", [tmp]);
			await pg.write("INSERT INTO file_areas (group_shortcode, group_id, name, shortcode, sub_dir, active, read_security, browse_security, newscan_default) VALUES ('ZZQRGRP', (SELECT id FROM file_groups WHERE shortcode = 'ZZQRGRP'), 'ZZ QR Public', 'ZZQRPUB', 'pub', true, 0, 0, true)");
			await pg.write("INSERT INTO file_areas (group_shortcode, group_id, name, shortcode, sub_dir, active, read_security, browse_security, newscan_default) VALUES ('ZZQRGRP', (SELECT id FROM file_groups WHERE shortcode = 'ZZQRGRP'), 'ZZ QR Locked', 'ZZQRSEC', 'sec', true, 999, 0, true)");
			var pub = await pg.queryOne("SELECT id FROM file_areas WHERE shortcode = 'ZZQRPUB'");
			var sec = await pg.queryOne("SELECT id FROM file_areas WHERE shortcode = 'ZZQRSEC'");
			var add = async function (area, code, name, disk, uploaded, desc) {
				var r = await pg.queryOne("INSERT INTO file_entries (uuid, area_id, area_shortcode, filename, disk_path, file_size, short_desc, upload_date, active) " +
					"VALUES (gen_random_uuid(), $1, $2, $3, $4, 14, $5, $6, true) RETURNING id", [area, code, name, disk, desc, uploaded]);
				entryIds[name] = r.id;
			};
			await add(pub.id, 'ZZQRPUB', 'NEWONE.ZIP', 'NEWONE_1.ZIP', new Date(), 'A new one');
			await add(pub.id, 'ZZQRPUB', 'OLDONE.ZIP', 'OLDONE.ZIP', new Date('2020-01-01'), 'An old one');
			await add(sec.id, 'ZZQRSEC', 'SECRET.ZIP', 'SECRET.ZIP', new Date(), 'Locked away');

			var u = await pg.queryOne("INSERT INTO users (uuid, username, security, active, last_qwk_download_at, created_at) " +
				"VALUES (gen_random_uuid(), $1, 0, true, '2026-01-01', '2025-01-01') RETURNING id, uuid", [USER]);
			userId = u.id; userUuid = u.uuid;
			var pm = await pg.queryOne("INSERT INTO pm_inbox (uuid, user_id, from_user, to_user, subject, body_text, transport_type, has_attachments, system_time) " +
				"VALUES (gen_random_uuid(), $1, 'Zed', $2, 'zz with a file', 'See attached', 'LOCAL', true, NOW()) RETURNING uuid", [userId, USER]);
			pmUuid = pm.uuid;
			await pg.write("INSERT INTO pm_attachments (message_uuid, message_table, filename, file_size, storage_path) VALUES ($1, 'inbox', 'NOTE.TXT', 13, $2)",
				[pmUuid, path.join(tmp, 'NOTE.TXT')]);
		} catch (err) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });
	after(async function () { if (pg && available) { try { await cleanup(); } catch (_) {} } });

	it('carries NEWFILES.DAT listing only files new since the last packet, and attachments named in their message', async function () {
		var built = await qwkUser.buildQwkForUser(userId);
		assert.ok(built.status && built.qwkPath, (built.errormessages || []).join('; '));
		var got = await packetNames(built);
		assert.ok(got.names.indexOf('NEWFILES.DAT') !== -1, got.names.join(','));
		var list = got.content['NEWFILES.DAT'].toString('latin1');
		assert.match(list, /^New files since: /);
		assert.match(list, /\(\d+\) ZZ QR Group \(\d+\) ZZ QR Public\r\n-+\r\nNEWONE\.ZIP\s+14 A new one\r\n/);
		assert.doesNotMatch(list, /OLDONE/);
		// SECRET.ZIP is new and its area is visible (browse 0), so it is listed;
		// only downloading it needs read access (FREQ, below).
		assert.match(list, /SECRET\.ZIP/);
		assert.ok(got.names.indexOf('NOTE.TXT') !== -1, 'the attachment is in the packet');
		assert.strictEqual(got.content['NOTE.TXT'].toString(), 'attached note');
	});

	it('applies FILES, ATTACH and FREQ from a REP, refusing a file the user may not download, and replies', async function () {
		var r = await qwkUser.importRepForUser(userId, repWith(['FREQ newone.zip', 'FREQ SECRET.ZIP', 'FILES OFF', 'ATTACH OFF']));
		assert.ok(r.status, (r.errormessages || []).join('; '));
		var batch = await pg.query('SELECT filename FROM user_file_batch WHERE user_id = $1', [userId]);
		assert.deepStrictEqual(batch.map(function (b) { return b.filename; }), ['NEWONE.ZIP']);
		var u = await pg.queryOne('SELECT qwk_files, qwk_attach FROM users WHERE id = $1', [userId]);
		assert.deepStrictEqual([u.qwk_files, u.qwk_attach], [false, false]);
		var reply = await pg.queryOne("SELECT body_text FROM pm_inbox WHERE user_id = $1 AND subject = 'QWK settings'", [userId]);
		assert.match(reply.body_text, /FREQ NEWONE\.ZIP: added to your download queue/);
		assert.match(reply.body_text, /FREQ SECRET\.ZIP: not found in any file area you can download from/);
		assert.match(reply.body_text, /FILES: the new-files list is off/);
		assert.match(reply.body_text, /ATTACH: private mail attachments are off/);
	});

	it('packs the download queue under the file\'s own name, counts it, and empties the queue', async function () {
		await pg.write('UPDATE pm_inbox SET read = false WHERE uuid = $1', [pmUuid]);
		var before = await pg.queryOne('SELECT download_count FROM file_entries WHERE id = $1', [entryIds['NEWONE.ZIP']]);
		var built = await qwkUser.buildQwkForUser(userId);
		assert.ok(built.qwkPath, (built.errormessages || []).join('; '));
		var got = await packetNames(built);
		assert.ok(got.names.indexOf('NEWONE.ZIP') !== -1, 'stored on disk as NEWONE_1.ZIP, packed as NEWONE.ZIP: ' + got.names.join(','));
		assert.strictEqual(got.content['NEWONE.ZIP'].toString(), 'new file bytes');
		assert.strictEqual(got.names.indexOf('NEWFILES.DAT'), -1, 'FILES OFF took effect');
		assert.strictEqual(got.names.indexOf('NOTE.TXT'), -1, 'ATTACH OFF took effect');
		var after = await pg.queryOne('SELECT download_count FROM file_entries WHERE id = $1', [entryIds['NEWONE.ZIP']]);
		assert.strictEqual(Number(after.download_count), Number(before.download_count) + 1);
		var left = await pg.queryOne('SELECT COUNT(*)::int AS n FROM user_file_batch WHERE user_id = $1', [userId]);
		assert.strictEqual(left.n, 0);
	});

	it('makes a packet when files are all there is to send', async function () {
		await pg.write('UPDATE users SET qwk_files = true, qwk_files_since = NULL, last_qwk_download_at = $2 WHERE id = $1', [userId, new Date('2026-01-01')]);
		await pg.write('UPDATE pm_inbox SET read = true WHERE user_id = $1', [userId]);
		var built = await qwkUser.buildQwkForUser(userId);
		assert.ok(built.qwkPath, 'a packet with only NEWFILES.DAT');
		var got = await packetNames(built);
		assert.ok(got.names.indexOf('NEWFILES.DAT') !== -1);
	});
});

describe('the QWK page shows the packet settings (#75)', function () {
	it('renders both switches, ticked as stored, and the queued downloads', async function () {
		var pug = (await import('pug')).default;
		var html = pug.renderFile('src/views/qwk/index.pug', {
			currentuser: { id: 1, username: 'x' }, bbsId: 'BBS', subscribedCount: 1, newMessageCount: 0,
			unreadPMCount: 0, queuedFiles: 2, qwkFiles: true, qwkAttach: false, flash: [],
			formatTimestamp: function () { return ''; }, timestampMs: function () { return 0; }
		});
		assert.match(html, /name="qwk_files" value="true" checked/);
		assert.doesNotMatch(html, /id="qwk_attach"[^>]*checked/);
		assert.match(html, /Queued downloads/);
		assert.match(html, /class="btn btn-primary" href="\/qwk\/download"/, 'queued files make the download button primary');
	});
});
