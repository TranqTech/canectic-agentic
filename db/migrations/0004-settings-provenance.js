// 0004-settings-provenance: work out which settings a person actually chose.
//
// configStore seeds every default from configDefaults into the settings table on
// first run, so a row exists for every key whether or not anyone touched it.
// That makes a deliberate choice indistinguishable from an untouched key, which
// is why allow_netmail_relay could not be deprecated in place: honouring false
// would pin every upgrade to the old behaviour, and honouring true would switch
// relay on for someone who had turned it off.
//
// Going forward configStore stamps `source` on write. This backfills it for rows
// that predate the column.
//
// Note this does NOT reopen the allow_netmail_relay decision. That was settled
// on separate grounds: relay was broken before 351114b, so there was no working
// configuration to preserve. Provenance is for the next deprecation, not that
// one.

export const description = 'Record which settings rows a sysop set, rather than which were seeded';

// Deliberately no isNeeded.
//
// The obvious predicate, "are there rows where source IS NULL", was wrong and
// the first run proved it: the column is declared DEFAULT 'default', so adding
// it stamps every existing row immediately and there are never any NULLs to
// find. The backfill reported itself unnecessary while 36 of 158 rows on a real
// install were mislabelled as untouched.
//
// So it corrects rather than fills, and the ledger is what makes it run once.
// That is exactly what the ledger is for, and reaching for a predicate here was
// reinventing it.

export async function run(ctx) {
	var pg = ctx.postgres;

	// Signal one, and the exact one: a row written after it was inserted. The
	// seed inserts with created_at and updated_at from the same NOW(), and
	// setValue bumps only updated_at, so a later write is unambiguous. Measured
	// on a real install before relying on it: 36 of 158 rows, and they were the
	// keys a sysop actually touches.
	var e1 = await pg.write(
		"UPDATE settings SET source = 'sysop' " +
		"WHERE source <> 'sysop' AND updated_at IS NOT NULL AND created_at IS NOT NULL " +
		"AND updated_at > created_at");
	if (e1) throw new Error('could not mark updated rows: ' + e1.message);

	// Signal two: a key that is not in configDefaults was never seeded, so
	// something other than the seed wrote it. This catches a custom key set
	// through the admin UI in one go, where both timestamps come from the same
	// insert and signal one cannot see it.
	var defaults = (await import('../../src/config/configDefaults.js'));
	var known = (defaults.CONFIG_DEFINITIONS || defaults.default || [])
		.map(function (d) { return d.key; })
		.filter(Boolean);

	if (known.length > 0) {
		var e2 = await pg.write(
			"UPDATE settings SET source = 'sysop' WHERE source <> 'sysop' AND key <> ALL($1)",
			[known]);
		if (e2) throw new Error('could not mark unknown keys: ' + e2.message);
	}

	// Anything left matches a shipped default and was never written after
	// seeding, so as far as any evidence goes it is untouched. It already reads
	// 'default' from the column default, so there is nothing to write.
	//
	// One case is genuinely unrecoverable and is not guessed at: a sysop who
	// deliberately set a key to exactly its default value. Nothing records that
	// it happened, and inventing evidence would be worse than the gap.
	var e3 = await pg.write("UPDATE settings SET source = 'default' WHERE source IS NULL");
	if (e3) throw new Error('could not mark seeded rows: ' + e3.message);

	var counts = await pg.queryOne(
		"SELECT COUNT(*) FILTER (WHERE source = 'sysop')::int AS sysop, " +
		"COUNT(*) FILTER (WHERE source = 'default')::int AS seeded FROM settings", []);
	ctx.log('  ' + counts.sysop + ' setting(s) set by a sysop, ' +
		counts.seeded + ' at their shipped default');
}
