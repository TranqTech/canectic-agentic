// 0009-user-activity-counts: start users.post_count and users.upload_count
// from what the board already holds.
//
// The four post and upload template events (#82) fire from these counters.
// Started at zero, "first message post" would greet someone with years of
// posts on their next message, so they are backfilled once:
//
//   upload_count: file entries whose uploader_uuid is the user. Exact.
//   post_count:   messages posted on this board (no tosser_id and no
//                 source_network_id, and not brought in by a message base
//                 import), credited by user_id where set and otherwise by
//                 From name, since no local post recorded its author before
//                 #82. Best effort; the rule is userActivity.backfillPostCounts.
//
// Assigned, not added, so a rerun gives the same answer.

export const description = 'Backfill users.post_count and users.upload_count for the post and upload template events';
export const phase = 'post';

export async function run(ctx) {
	var pg = ctx.postgres;
	var log = ctx.log || function () {};
	var { backfillPostCounts } = await import('../../src/models/userActivity.js');

	var cols = await pg.query(
		"SELECT table_name, column_name FROM information_schema.columns " +
		"WHERE table_schema = 'public' AND table_name LIKE 'mb\\_%\\_msgs' " +
		"  AND column_name IN ('user_id', 'from_user', 'tosser_id', 'source_network_id', 'imported')") || [];
	var tables = {};
	for (var c of cols) (tables[c.table_name] = tables[c.table_name] || new Set()).add(c.column_name);

	var byId = {}, byName = {}, scanned = 0;
	for (var table of Object.keys(tables).sort()) {
		// From information_schema, not input, but interpolated all the same.
		if (!/^mb_[a-z0-9_]+_msgs$/.test(table)) { log('skipping unexpected table name: ' + table); continue; }
		var has = tables[table];
		if (!has.has('from_user')) continue;
		var local = [];
		if (has.has('tosser_id')) local.push('tosser_id IS NULL');
		if (has.has('source_network_id')) local.push('source_network_id IS NULL');
		if (has.has('imported')) local.push('imported IS NOT TRUE');
		var where = local.length ? ' WHERE ' + local.join(' AND ') : '';
		var idCol = has.has('user_id') ? 'NULLIF(user_id, 0)' : 'NULL';
		var rows = await pg.query(
			'SELECT ' + idCol + ' AS uid, lower(btrim(from_user)) AS name, count(*)::int AS n FROM ' + table +
			where + ' GROUP BY 1, 2') || [];
		scanned++;
		for (var r of rows) {
			if (r.uid) byId[r.uid] = (byId[r.uid] || 0) + r.n;
			else if (r.name) byName[r.name] = (byName[r.name] || 0) + r.n;
		}
	}

	var users = await pg.query('SELECT id, uuid, username, fullname FROM users') || [];
	var posts = backfillPostCounts(users, byId, byName);

	var uploads = {};
	for (var u of await pg.query(
		'SELECT uploader_uuid AS uuid, count(*)::int AS n FROM file_entries WHERE uploader_uuid IS NOT NULL GROUP BY 1') || []) {
		uploads[u.uuid] = u.n;
	}

	var withPosts = 0, withUploads = 0;
	for (var user of users) {
		var p = posts[user.id] || 0, f = uploads[user.uuid] || 0;
		if (p) withPosts++;
		if (f) withUploads++;
		var err = await pg.write('UPDATE users SET post_count = $1, upload_count = $2 WHERE id = $3', [p, f, user.id]);
		if (err) throw new Error('could not set counts for user ' + user.id + ': ' + err.message);
	}
	log('  ' + scanned + ' message table(s) read; ' + withPosts + ' user(s) with posts, ' + withUploads + ' with uploads');
	return { tables: scanned, users: users.length, withPosts: withPosts, withUploads: withUploads };
}
