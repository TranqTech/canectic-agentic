// 0005-refresh-stale-version: correct a currentversion row that never moved.
//
// configStore seeds defaults with ON CONFLICT DO NOTHING, so a seeded row is
// written once on first run and never refreshed. For most keys that is exactly
// right: a default the sysop is happy with should not change under them.
//
// currentversion is not like the others. It is derived from package.json rather
// than chosen, so a row seeded when the software was 0.1a still says 0.1a after
// the code has moved on. On the development box it was seeded on 2026-03-20 and
// was still 0.1a six months later at 0.9.5a, which is what every install that
// has been upgraded rather than freshly installed will look like.
//
// softwareVersion() now reads package.json first so nothing depends on this row
// being right. This corrects it anyway, because /admin/config displays it and a
// settings page showing a version the system is not running is its own problem.
//
// Only touches a row the sysop never set. If someone deliberately overrode it,
// that is their business and the provenance column is how we can tell, which is
// the first use of the answer 0004 made available.

export const description = 'Refresh a stale seeded currentversion to match package.json';

export async function isNeeded(ctx) {
	var row = await ctx.postgres.queryOne(
		"SELECT value, source FROM settings WHERE key = 'currentversion'", []);
	if (!row) return false;
	if (row.source === 'sysop') return false;

	var systeminfo = await import('../../src/utils/systeminfo.js');
	return row.value !== systeminfo.softwareVersion();
}

export async function run(ctx) {
	var systeminfo = await import('../../src/utils/systeminfo.js');
	var actual = systeminfo.softwareVersion();

	var before = await ctx.postgres.queryOne(
		"SELECT value FROM settings WHERE key = 'currentversion'", []);

	// Written directly rather than through configStore.setValue, which would
	// stamp source = 'sysop' and claim a person chose this. Nobody did; it is
	// being brought back in line with what shipped.
	var err = await ctx.postgres.write(
		"UPDATE settings SET value = $1, updated_at = NOW() " +
		"WHERE key = 'currentversion' AND source <> 'sysop'", [actual]);
	if (err) throw new Error('could not refresh currentversion: ' + err.message);

	ctx.log('  currentversion ' + (before ? before.value : 'unset') + ' -> ' + actual);
}
