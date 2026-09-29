// tests/fileAreaRelocation.test.js -- moving file area directories when the
// setting that places them changes (#28).
//
// Changing a group's base_dir, an area's sub_dir or the global file_base_dir
// used to leave every file at the old path. Files are now moved one at a time
// into the new directory after the change is saved; a name already at the
// destination is left in place and reported, never overwritten.
//
// Also here: an absolute sub_dir now stands on its own (it used to be joined
// under the group), and FREQ resolves a file entry's real path (it tested the
// bare filename against the working directory and never found one).

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dbAvailable } from './helpers/dbAvailable.js';
import { resolveAreaPath, hasAbsoluteSubDir } from '../src/models/fileAreas.js';
import { inspectMove, moveArea, executeMoves, movesToRun } from '../src/maintenance/fileAreaRelocation.js';

var tmp;
beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relocate-')); });
afterEach(function () { fs.rmSync(tmp, { recursive: true, force: true }); });

function put(dir, files) {
	fs.mkdirSync(dir, { recursive: true });
	for (var f of Object.keys(files)) fs.writeFileSync(path.join(dir, f), files[f]);
}

describe('file area relocation (#28)', function () {

	describe('resolveAreaPath', function () {
		it('hangs a relative sub_dir off the group', function () {
			assert.strictEqual(resolveAreaPath({ base_dir: '/srv/files/fido' }, { shortcode: 'X', sub_dir: 'nodelist' }), '/srv/files/fido/nodelist');
		});
		it('lets an absolute sub_dir stand on its own, which it used to be joined under the group', function () {
			var area = { shortcode: 'X', sub_dir: '/data/elsewhere' };
			assert.strictEqual(resolveAreaPath({ base_dir: '/srv/files/fido' }, area), '/data/elsewhere');
			assert.strictEqual(hasAbsoluteSubDir(area), true);
			assert.strictEqual(resolveAreaPath({ base_dir: '/srv' }, { shortcode: 'X', sub_dir: '~/mine' }), path.join(os.homedir(), 'mine'));
		});
		it('resolves against a given file_base_dir for planning', function () {
			assert.strictEqual(resolveAreaPath({ base_dir: 'fido' }, { shortcode: 'NODES' }, { globalBase: '/new/base' }), '/new/base/fido/nodes');
		});
	});

	describe('inspectMove', function () {
		it('says same, empty, move and conflict', function () {
			var from = path.join(tmp, 'old'), to = path.join(tmp, 'new');
			assert.strictEqual(inspectMove('A', from, from).status, 'same');
			assert.strictEqual(inspectMove('A', from, to).status, 'empty');
			put(from, { 'a.zip': 'a', 'b.zip': 'b' });
			var m = inspectMove('A', from, to);
			assert.strictEqual(m.status, 'move'); assert.strictEqual(m.entries, 2);
			put(to, { 'b.zip': 'already' });
			var c = inspectMove('A', from, to);
			assert.strictEqual(c.status, 'conflict'); assert.deepStrictEqual(c.conflicts, ['b.zip']);
		});
		it('does not count the destination when it sits inside the source', function () {
			var from = path.join(tmp, 'area');
			put(from, { 'a.zip': 'a' });
			fs.mkdirSync(path.join(from, 'sub'));
			assert.strictEqual(inspectMove('A', from, path.join(from, 'sub', 'deeper')).entries, 1);
		});
	});

	describe('moveArea', function () {
		it('moves files and sub-directories, keeps times, and removes the emptied old directory', function () {
			var from = path.join(tmp, 'old'), to = path.join(tmp, 'new');
			put(from, { 'a.zip': 'aaa' });
			put(path.join(from, 'extra'), { 'x.txt': 'x' });
			var when = new Date('2020-01-02T03:04:05Z');
			fs.utimesSync(path.join(from, 'a.zip'), when, when);
			var r = moveArea('A', from, to);
			assert.strictEqual(r.moved, 2);
			assert.strictEqual(fs.readFileSync(path.join(to, 'a.zip'), 'utf8'), 'aaa');
			assert.strictEqual(fs.readFileSync(path.join(to, 'extra', 'x.txt'), 'utf8'), 'x');
			assert.strictEqual(fs.statSync(path.join(to, 'a.zip')).mtimeMs, when.getTime());
			assert.strictEqual(fs.existsSync(from), false);
			assert.strictEqual(r.removedOld, true);
		});
		it('never overwrites: a clash stays behind, and so does the old directory', function () {
			var from = path.join(tmp, 'old'), to = path.join(tmp, 'new');
			put(from, { 'a.zip': 'mine', 'b.zip': 'b' });
			put(to, { 'a.zip': 'theirs' });
			var r = moveArea('A', from, to);
			assert.deepStrictEqual(r.conflicts, ['a.zip']);
			assert.strictEqual(fs.readFileSync(path.join(to, 'a.zip'), 'utf8'), 'theirs');
			assert.strictEqual(fs.readFileSync(path.join(from, 'a.zip'), 'utf8'), 'mine');
			assert.ok(fs.existsSync(path.join(to, 'b.zip')));
			assert.strictEqual(r.removedOld, false);
		});
		it('moves across filesystems by copying', function () {
			if (fs.statSync('/dev/shm').dev === fs.statSync(tmp).dev) this.skip();
			var from = fs.mkdtempSync('/dev/shm/relocate-');
			try {
				put(from, { 'c.zip': 'ccc' });
				var r = moveArea('A', from, path.join(tmp, 'dest'));
				assert.strictEqual(r.moved, 1, JSON.stringify(r.errors));
				assert.strictEqual(fs.readFileSync(path.join(tmp, 'dest', 'c.zip'), 'utf8'), 'ccc');
				assert.strictEqual(fs.existsSync(path.join(from, 'c.zip')), false);
			} finally { fs.rmSync(from, { recursive: true, force: true }); }
		});
	});

	describe('executeMoves', function () {
		it('skips an area that has since been pointed somewhere else', async function () {
			var from = path.join(tmp, 'old'), to = path.join(tmp, 'new');
			put(from, { 'a.zip': 'a' });
			var r = await executeMoves([{ shortcode: 'A', from: from, to: to }], { resolveNow: async function () { return path.join(tmp, 'other'); } });
			assert.strictEqual(r[0].moved, 0);
			assert.ok(/no longer resolves/.test(r[0].errors[0]));
			assert.ok(fs.existsSync(path.join(from, 'a.zip')));
		});
		it('moves when the area resolves to the planned destination', async function () {
			var from = path.join(tmp, 'old'), to = path.join(tmp, 'new');
			put(from, { 'a.zip': 'a' });
			var r = await executeMoves([{ shortcode: 'A', from: from, to: to }], { resolveNow: async function () { return to; } });
			assert.strictEqual(r[0].moved, 1);
		});
		it('queues only the areas that have something to move', function () {
			assert.deepStrictEqual(movesToRun({ moves: [
				{ shortcode: 'A', status: 'move', from: '/a', to: '/b', entries: 1, conflicts: [] },
				{ shortcode: 'B', status: 'same', from: '/c', to: '/c' },
				{ shortcode: 'C', status: 'empty', from: '/d', to: '/e' },
				{ shortcode: 'D', status: 'conflict', from: '/f', to: '/g', entries: 2, conflicts: ['x'] },
			] }), [{ shortcode: 'A', from: '/a', to: '/b' }, { shortcode: 'D', from: '/f', to: '/g' }]);
		});
	});

	describe('planning and FREQ against the database', function () {
		this.timeout(20000);
		var available = false, pg, relocation, freq;
		var G = 'ZZ28GRP';

		before(async function () {
			available = await dbAvailable();
			if (!available) return;
			pg = await import('../src/middleware/db/postgres.js');
			relocation = await import('../src/maintenance/fileAreaRelocation.js');
			freq = await import('../src/models/freq.js');
		});

		async function cleanup() {
			await pg.write("DELETE FROM file_peer_subscriptions WHERE peer_connection_id = 987654");
			await pg.write("DELETE FROM file_entries WHERE area_shortcode LIKE 'ZZ28%'");
			await pg.write("DELETE FROM file_areas WHERE shortcode LIKE 'ZZ28%'");
			await pg.write('DELETE FROM file_groups WHERE shortcode = $1', [G]);
		}

		beforeEach(async function () {
			if (!available) return this.skip();
			await cleanup();
			var g = await pg.queryOne("INSERT INTO file_groups (shortcode, name, base_dir) VALUES ($1, 'ZZ 28', $2) RETURNING id", [G, path.join(tmp, 'grp')]);
			this.gid = g.id;
			await pg.write("INSERT INTO file_areas (shortcode, name, group_id, group_shortcode, sub_dir) VALUES ('ZZ28REL', 'rel', $1, $2, 'rel'), ('ZZ28ABS', 'abs', $1, $2, $3)",
				[g.id, G, path.join(tmp, 'standalone')]);
			put(path.join(tmp, 'grp', 'rel'), { 'r.zip': 'r' });
			put(path.join(tmp, 'standalone'), { 's.zip': 's' });
		});
		after(async function () { if (available) await cleanup(); });

		it('plans a group move for its relative areas and leaves an absolute one alone', async function () {
			var plan = await relocation.planGroupChange(G, path.join(tmp, 'moved'));
			var byCode = {};
			for (var m of plan.moves) byCode[m.shortcode] = m;
			assert.strictEqual(byCode.ZZ28REL.status, 'move');
			assert.strictEqual(byCode.ZZ28REL.to, path.join(tmp, 'moved', 'rel'));
			assert.strictEqual(byCode.ZZ28ABS.status, 'same');
			assert.strictEqual(plan.needsMove, true);
			assert.strictEqual(plan.entries, 1);
		});

		it('plans an area sub_dir change', async function () {
			var plan = await relocation.planAreaChange('ZZ28REL', 'renamed');
			assert.strictEqual(plan.moves[0].to, path.join(tmp, 'grp', 'renamed'));
			assert.strictEqual(plan.moves[0].status, 'move');
		});

		it('plans a file_base_dir change for groups that hang off it', async function () {
			await pg.write('UPDATE file_groups SET base_dir = $1 WHERE shortcode = $2', ['grp', G]);
			var plan = await relocation.planGlobalChange(path.join(tmp, 'newbase'));
			var rel = plan.moves.find(function (m) { return m.shortcode === 'ZZ28REL'; });
			assert.strictEqual(rel.to, path.join(tmp, 'newbase', 'grp', 'rel'));
		});

		it('lets FREQ find a file entry in its area directory', async function () {
			var area = await pg.queryOne("SELECT id FROM file_areas WHERE shortcode = 'ZZ28REL'");
			await pg.write("INSERT INTO file_entries (uuid, area_id, area_shortcode, filename, disk_path, active) VALUES (gen_random_uuid()::text, $1, 'ZZ28REL', 'r.zip', 'r.zip', true)", [area.id]);
			await pg.write('INSERT INTO file_peer_subscriptions (peer_connection_id, file_area_id, allowed, enabled) VALUES (987654, $1, true, true)', [area.id]);
			var r = await freq.resolveFile('R.ZIP', 987654);
			assert.strictEqual(r.found, true);
			assert.strictEqual(r.filePath, path.join(tmp, 'grp', 'rel', 'r.zip'));
		});
	});
});
