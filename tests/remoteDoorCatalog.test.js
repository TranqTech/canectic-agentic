// tests/remoteDoorCatalog.test.js -- door lists for door providers (#89,
// part 3): the list format, the shipped lists, the catalog diff, the rule
// that keeps a truncated list from switching a provider's doors off, list
// files arriving in a file area (plain or zipped), and the daily check.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { dbAvailable } from './helpers/dbAvailable.js';
import {
	parseDoorList, shippedLists, loadShippedList, globToRegExp, diffCatalog, safeToApply, readListFile, loadListFor
} from '../src/models/remoteDoorCatalog.js';
import { validateRemote } from '../src/models/doorserverRemotes.js';

function list(codes) { return codes.map(function (c) { return { code: c, name: c.toUpperCase(), category: '' }; }); }
function rows(codes, inactive) {
	return codes.map(function (c) { return { code: c, name: c.toUpperCase(), category: '', active: !(inactive || []).includes(c) }; });
}

describe('door lists for door providers (#89, part 3)', function () {

	describe('the list format', function () {
		it('reads the JSON format and reports what it skips', function () {
			var p = parseDoorList(JSON.stringify({ format: 'canectic-doorlist-v1', list: 'x', title: 'X', updated: '2026-09-29',
				doors: [{ code: 'lord', name: 'LORD', category: 'RPG' }, { code: 'bad code', name: 'no' }, { code: 'LORD', name: 'dup' }] }));
			assert.strictEqual(p.ok, true);
			assert.deepStrictEqual(p.list.doors, [{ code: 'lord', name: 'LORD', category: 'RPG' }]);
			assert.strictEqual(p.list.updated, '2026-09-29');
			assert.strictEqual(p.errors.length, 1, 'the bad code is reported; the duplicate is dropped quietly');
		});

		it('reads a plain text list: code, name, optional tab and category', function () {
			var p = parseDoorList('# my list\nlord  Legend of the Red Dragon\tRPG\n\nstackem!   Stack Em\ntw\n', 'MYLIST.TXT');
			assert.deepStrictEqual(p.list.doors, [
				{ code: 'lord', name: 'Legend of the Red Dragon', category: 'RPG' },
				{ code: 'stackem!', name: 'Stack Em', category: '' },
				{ code: 'tw', name: 'tw', category: '' }
			]);
			assert.strictEqual(p.list.name, 'mylist');
		});

		it('refuses an empty list and anything that is not a list', function () {
			assert.strictEqual(parseDoorList('# nothing\n').ok, false);
			assert.strictEqual(parseDoorList('{"doors": 1}').ok, false);
			assert.strictEqual(parseDoorList('{not json').ok, false);
		});

		it('ships DoorParty and BBSLink lists that parse without a problem', function () {
			var names = shippedLists().map(function (l) { return l.name; });
			assert.ok(names.includes('doorparty') && names.includes('bbslink'), names.join());
			var dp = loadShippedList('doorparty');
			assert.deepStrictEqual(dp.errors, []);
			assert.ok(dp.list.doors.length >= 150, 'DoorParty lists about 170 doors');
			assert.ok(dp.list.doors.some(function (d) { return d.code === 'lord'; }));
			var bl = loadShippedList('bbslink');
			assert.deepStrictEqual(bl.errors, []);
			assert.ok(bl.list.doors.some(function (d) { return d.code === 'menu'; }), 'BBSLink\'s menu code is listed');
			assert.ok(!bl.list.doors.some(function (d) { return d.code === 'test'; }), 'the sysop test code is not a door');
			assert.strictEqual(loadShippedList('../etc/passwd').ok, false);
		});

		it('matches a file name pattern case-insensitively', function () {
			assert.ok(globToRegExp('DPLIST*.ZIP').test('dplist0929.zip'));
			assert.ok(!globToRegExp('DPLIST?.ZIP').test('DPLIST10.ZIP'));
			assert.ok(!globToRegExp('a.b').test('axb'), 'a dot is a dot');
		});
	});

	describe('the catalog diff', function () {
		it('tells new, changed, removed, returning and unchanged apart', function () {
			var current = rows(['lord', 'bre', 'tw', 'old'], ['old']);
			current[1].name = 'Barren Realms';
			var d = diffCatalog(current, list(['lord', 'bre', 'old', 'new']));
			assert.deepStrictEqual(d.added.map(function (x) { return x.code; }), ['new']);
			assert.deepStrictEqual(d.changed.map(function (x) { return x.code; }), ['bre']);
			assert.deepStrictEqual(d.removed, ['tw']);
			assert.deepStrictEqual(d.returning, ['old']);
			assert.deepStrictEqual(d.unchanged, ['lord']);
		});

		it('matches codes whatever their case', function () {
			var d = diffCatalog(rows(['LORD']), list(['lord']));
			assert.strictEqual(d.added.length, 0);
			assert.strictEqual(d.removed.length, 0);
		});

		it('refuses an automatic update that removes more than half, or brings nothing', function () {
			var current = rows(['a', 'b', 'c', 'd', 'e', 'f']);
			var half = list(['a', 'b', 'c']);
			assert.strictEqual(safeToApply(current, half, diffCatalog(current, half)).ok, true, 'exactly half is allowed');
			var most = list(['a', 'b']);
			var r = safeToApply(current, most, diffCatalog(current, most));
			assert.strictEqual(r.ok, false);
			assert.match(r.reason, /remove 4 of 6/);
			assert.strictEqual(safeToApply(current, [], diffCatalog(current, [])).ok, false);
			var tiny = rows(['a', 'b', 'c']);
			assert.strictEqual(safeToApply(tiny, list(['a']), diffCatalog(tiny, list(['a']))).ok, true, 'a very small list may shrink');
		});
	});

	describe('list files', function () {
		var dir;
		before(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-doorlist-')); });
		after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

		it('reads a list file directly or from inside a zip', function () {
			var txt = path.join(dir, 'DPLIST.TXT');
			fs.writeFileSync(txt, 'lord LORD\nbre BRE\n');
			assert.deepStrictEqual(readListFile(txt).list.doors.map(function (d) { return d.code; }), ['lord', 'bre']);
			var zip = path.join(dir, 'DPLIST.ZIP');
			execFileSync('zip', ['-j', '-q', zip, txt]);
			assert.deepStrictEqual(readListFile(zip).list.doors.map(function (d) { return d.code; }), ['lord', 'bre']);
			var empty = path.join(dir, 'EMPTY.ZIP');
			var other = path.join(dir, 'README.MD');
			fs.writeFileSync(other, 'x');
			execFileSync('zip', ['-j', '-q', empty, other]);
			assert.match(readListFile(empty).errors[0], /holds no \.json or \.txt/);
		});

		it('loads the list a provider names, from wherever it names', async function () {
			var shipped = await loadListFor({ name: 'dp', kind: 'rlogin' }, { list_source: 'shipped', list_name: 'bbslink' });
			assert.ok(shipped.ok);
			assert.match(shipped.from, /shipped with Canectic/);
			var f = path.join(dir, 'LIST.TXT');
			fs.writeFileSync(f, 'lord LORD\n');
			var fromFile = await loadListFor({ name: 'dp', kind: 'rlogin' }, { list_source: 'file', list_area: 'ZZ', list_file: 'LIST.*' },
				{ files: async function (area, glob) { assert.strictEqual(area, 'ZZ'); assert.strictEqual(glob, 'LIST.*'); return { ok: true, path: f, name: 'LIST.TXT', date: new Date() }; } });
			assert.deepStrictEqual(fromFile.list.doors.map(function (d) { return d.code; }), ['lord']);
			var fromBoard = await loadListFor({ name: 'hub', kind: 'canectic', url: 'wss://x' }, { list_source: 'remote' },
				{ listRemoteDoors: async function () { return { ok: true, doors: [{ slug: 'lord', name: 'LORD' }] }; } });
			assert.deepStrictEqual(fromBoard.list.doors, [{ code: 'lord', name: 'LORD', category: '' }]);
			var wrong = await loadListFor({ name: 'dp', kind: 'rlogin' }, { list_source: 'remote' });
			assert.strictEqual(wrong.ok, false, 'only a Canectic board sends its own list');
		});

		it('checks the list settings on a provider', function () {
			var base = { name: 'dp', kind: 'rlogin', rl_host: 'h', rl_username_template: '{alias}', rl_terminal_template: '{door}' };
			assert.ok(validateRemote(Object.assign({ list_source: 'shipped' }, base), { creating: true }).errors.some(function (e) { return /shipped door list/.test(e); }));
			assert.ok(validateRemote(Object.assign({ list_source: 'file', list_area: 'X' }, base), { creating: true }).errors.some(function (e) { return /file area and the file name/.test(e); }));
			assert.ok(validateRemote(Object.assign({ list_source: 'remote' }, base), { creating: true }).errors.some(function (e) { return /Only a Canectic/.test(e); }));
			var ok = validateRemote(Object.assign({ list_source: 'shipped', list_name: 'doorparty', list_auto: 'true' }, base), { creating: true });
			assert.deepStrictEqual(ok.errors, []);
			var st = JSON.parse(ok.values.settings);
			assert.strictEqual(st.list_name, 'doorparty');
			assert.strictEqual(st.list_auto, true);
			assert.strictEqual(st.host, 'h', 'the list settings sit beside the kind\'s own');
		});
	});

	describe('against the database', function () {
		this.timeout(20000);
		var available = false, pg, remotes, catalog, doors;
		before(async function () {
			available = await dbAvailable();
			if (!available) return;
			pg = await import('../src/middleware/db/postgres.js');
			remotes = await import('../src/models/doorserverRemotes.js');
			catalog = await import('../src/models/remoteDoorCatalog.js');
			doors = await import('../src/models/doors.js');
		});
		async function cleanup() {
			await pg.write("DELETE FROM remote_door_catalog WHERE remote_id IN (SELECT id FROM doorserver_remotes WHERE name LIKE 'zz89%')");
			await pg.write("DELETE FROM door_collection_entries WHERE door_id IN (SELECT id FROM doors WHERE slug LIKE 'zz89%')");
			await pg.write("DELETE FROM doors WHERE slug LIKE 'zz89%'");
			await pg.write("DELETE FROM doorserver_remotes WHERE name LIKE 'zz89%'");
		}
		beforeEach(async function () { if (!available) return this.skip(); await cleanup(); });
		after(async function () { if (available) await cleanup(); });

		async function provider(extra) {
			var r = await remotes.createRemote(Object.assign({ name: 'zz89cat', kind: 'rlogin', rl_host: 'h', rl_username_template: '{alias}', rl_terminal_template: '{door}' }, extra || {}));
			assert.ok(r.status, r.errors.join());
			return r.remote;
		}

		it('suggests the list that fits a provider, and sets a source keeping the other settings', async function () {
			assert.deepStrictEqual(remotes.suggestedList({ kind: 'bbslink' }), { source: 'shipped', name: 'bbslink' });
			assert.deepStrictEqual(remotes.suggestedList({ kind: 'canectic' }), { source: 'remote', name: '' });
			assert.deepStrictEqual(remotes.suggestedList({ kind: 'rlogin', settings: { host: 'dp.throwbackbbs.com' } }), { source: 'shipped', name: 'doorparty' });
			assert.strictEqual(remotes.suggestedList({ kind: 'rlogin', settings: { host: 'games.example' } }), null);
			var p = await provider({ rl_tag: 'ZZ' });
			assert.ok(await remotes.setListSource(p.uuid, 'shipped', 'doorparty'));
			var st = remotes.settingsOf(await remotes.getByUuid(p.uuid));
			assert.strictEqual(st.list_source, 'shipped');
			assert.strictEqual(st.list_name, 'doorparty');
			assert.strictEqual(st.host, 'h', 'the rest of the settings are kept');
		});

		it('deletes a door that is in a collection (its entries first)', async function () {
			await provider();
			var d = await doors.createRemoteDoor({ provider: 'zz89cat', code: 'lord', name: 'LORD' });
			var coll = await pg.queryOne('SELECT id FROM door_collections ORDER BY id LIMIT 1');
			if (coll) await pg.write('INSERT INTO door_collection_entries (collection_id, door_id) VALUES ($1, $2)', [coll.id, d.doorId]);
			var r = await doors.deleteDoor(d.doorId);
			assert.strictEqual(r.status, true, (r.errormessages || []).join());
			assert.strictEqual(await pg.queryOne('SELECT id FROM doors WHERE id = $1', [d.doorId]), null, 'the door is gone, not just reported gone');
		});

		it('applies a list, keeps removed doors, and makes their door entries inactive', async function () {
			var p = await provider();
			var first = await catalog.applyList(p, list(['lord', 'bre', 'tw', 'usurper']), {});
			assert.strictEqual(first.diff.added.length, 4);
			assert.ok((await doors.createRemoteDoor({ provider: 'zz89cat', code: 'tw', name: 'TW' })).status);
			var second = await catalog.applyList(p, list(['lord', 'bre', 'usurper', 'new']), {});
			assert.deepStrictEqual(second.diff.removed, ['tw']);
			assert.deepStrictEqual(second.deactivatedDoors, ['zz89cat-tw']);
			var cat = await catalog.getCatalog(p.id);
			var tw = cat.find(function (c) { return c.code === 'tw'; });
			assert.strictEqual(tw.active, false, 'kept, marked removed');
			assert.ok(tw.removed_at);
			assert.strictEqual(cat.length, 5);
			assert.strictEqual((await doors.getDoorConfig('zz89cat-tw')).active, false);
			var back = await catalog.applyList(p, list(['lord', 'bre', 'usurper', 'new', 'tw']), {});
			assert.deepStrictEqual(back.diff.returning, ['tw']);
			assert.strictEqual((await catalog.getCatalog(p.id)).find(function (c) { return c.code === 'tw'; }).active, true);
		});

		it('lets the daily check refuse a truncated list and tell the sysop', async function () {
			var p = await provider({ list_source: 'shipped', list_name: 'bbslink', list_auto: 'true' });
			await catalog.applyList(p, list(['a', 'b', 'c', 'd', 'e', 'f']), {});
			var notes = [];
			var fakeRemotes = { getAll: async function () { return [await remotes.getByUuid(p.uuid)]; }, settingsOf: remotes.settingsOf };
			// The shipped BBSLink list shares no codes with a..f: all six would go
			var res = await catalog.checkAll({ remotes: fakeRemotes, notify: async function (t, b) { notes.push(t + ': ' + b); } });
			assert.strictEqual(res[0].ok, false);
			assert.match(notes[0], /was not applied/);
			assert.strictEqual((await catalog.getCatalog(p.id)).filter(function (c) { return c.active; }).length, 6, 'nothing switched off');
			assert.strictEqual(res[0].reason.indexOf('more than half') !== -1, true);
		});

		it('applies a daily check that is safe, and reports what changed', async function () {
			var p = await provider({ list_source: 'shipped', list_name: 'bbslink', list_auto: 'true' });
			var notes = [];
			var fakeRemotes = { getAll: async function () { return [await remotes.getByUuid(p.uuid)]; }, settingsOf: remotes.settingsOf };
			var res = await catalog.checkAll({ remotes: fakeRemotes, notify: async function (t, b) { notes.push(t + ': ' + b); } });
			assert.strictEqual(res[0].ok, true);
			assert.match(notes[0], /changed: \d+ new/);
			var again = await catalog.checkAll({ remotes: fakeRemotes, notify: async function (t, b) { notes.push(t); } });
			assert.strictEqual(again[0].ok, true);
			assert.strictEqual(notes.length, 1, 'nothing to say when nothing changed');
		});
	});
});
