// 0007-netmail-seenby-text: widen netmail_in and netmail_out seen_by and path
// to TEXT.
//
// The echomail tables made this change long ago (messageMaint's legacy
// widening); the two netmail tables were left at VARCHAR(255). That fitted
// while the tosser kept only the last SEEN-BY line it read. It now keeps every
// line, as FTS-0004 means it to, and a netmail carrying a full SEEN-BY would
// fail its insert at 255 characters rather than be truncated.
//
// The declarative schema now says TEXT for a new table, but it adds missing
// columns and never changes the type of one that exists, so an existing table
// needs this. Widening VARCHAR to TEXT rewrites nothing in PostgreSQL.

export const description = 'Widen netmail_in/netmail_out seen_by and path to TEXT';

var TARGETS = [
	['netmail_in', 'seen_by'], ['netmail_in', 'path'],
	['netmail_out', 'seen_by'], ['netmail_out', 'path']
];

async function narrowColumns(pg) {
	var rows = await pg.query(
		"SELECT table_name, column_name FROM information_schema.columns " +
		"WHERE table_name IN ('netmail_in', 'netmail_out') AND column_name IN ('seen_by', 'path') " +
		"AND data_type <> 'text'", []);
	return (rows || []).filter(function (r) {
		return TARGETS.some(function (t) { return t[0] === r.table_name && t[1] === r.column_name; });
	});
}

export async function isNeeded(ctx) {
	return (await narrowColumns(ctx.postgres)).length > 0;
}

export async function run(ctx) {
	for (var r of await narrowColumns(ctx.postgres)) {
		ctx.log('  ' + r.table_name + '.' + r.column_name + ': to TEXT');
		// Both names come from the fixed list above, never from input.
		var err = await ctx.postgres.write(
			'ALTER TABLE ' + r.table_name + ' ALTER COLUMN ' + r.column_name + ' TYPE TEXT');
		if (err) throw new Error(r.table_name + '.' + r.column_name + ' type change failed: ' + err.message);
	}
}
