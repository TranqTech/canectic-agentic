// 0001-menu-layout: convert the menus table to the margin layout model.
//
// Moved verbatim out of dbmigrations.js, where it lived as migrateMenuLayout()
// and was called unconditionally on every run. It guarded itself by sniffing the
// schema each time, which works for a change shaped like this one and does not
// generalise: you cannot ask the database whether QWK conferences have already
// been renumbered.
//
// It is a `pre` migration, and it is the reason that phase exists. Step 2 has to
// read entries_x_offset before the declarative schema drops that column. Run it
// after, and the data it converts is already gone.

export const description = 'Convert menus.display_entries to text and fold entry offsets into margins';
export const phase = 'pre';

// This has been running on every migration for months, so most systems have
// already had it applied. The predicate is the same one the old inline version
// used to decide whether to act; on a system where both steps are already done
// it records as skipped and is never asked again.
export async function isNeeded(ctx) {
	var pg = ctx.postgres;
	var boolRows = await pg.query(
		"SELECT data_type FROM information_schema.columns " +
		"WHERE table_name = 'menus' AND column_name = 'display_entries'", []);
	if (boolRows.length > 0 && boolRows[0].data_type === 'boolean') return true;

	var offsetRows = await pg.query(
		"SELECT data_type FROM information_schema.columns " +
		"WHERE table_name = 'menus' AND column_name = 'entries_x_offset'", []);
	if (offsetRows.length === 0) return false;

	var marginRows = await pg.query(
		"SELECT data_type FROM information_schema.columns " +
		"WHERE table_name = 'menus' AND column_name = 'margin_left'", []);
	return marginRows.length > 0;
}

export async function run(ctx) {
	var pg = ctx.postgres;
	var log = ctx.log;

	// Step 1: display_entries from BOOLEAN to VARCHAR(8).
	var typeRows = await pg.query(
		"SELECT data_type FROM information_schema.columns " +
		"WHERE table_name = 'menus' AND column_name = 'display_entries'", []);

	if (typeRows.length > 0 && typeRows[0].data_type === 'boolean') {
		log('  menus.display_entries: BOOLEAN to VARCHAR(8)');
		var err = await pg.write(
			"ALTER TABLE menus ALTER COLUMN display_entries TYPE VARCHAR(8) " +
			"USING CASE WHEN display_entries THEN 'auto' ELSE 'off' END");
		if (err) throw new Error('display_entries type change failed: ' + err.message);

		var err2 = await pg.write(
			"ALTER TABLE menus ALTER COLUMN display_entries SET DEFAULT 'auto'");
		if (err2) throw new Error('display_entries default failed: ' + err2.message);
	}

	// Step 2: offsets into margins, before the declarative pass drops the
	// offset columns.
	var offsetRows = await pg.query(
		"SELECT data_type FROM information_schema.columns " +
		"WHERE table_name = 'menus' AND column_name = 'entries_x_offset'", []);
	if (offsetRows.length === 0) return;

	var marginRows = await pg.query(
		"SELECT data_type FROM information_schema.columns " +
		"WHERE table_name = 'menus' AND column_name = 'margin_left'", []);
	if (marginRows.length === 0) return;

	log('  menus: entries_x_offset/entries_y_offset into margin_left/margin_top');
	var err3 = await pg.write(
		"UPDATE menus SET margin_left = COALESCE(entries_x_offset, 0) + 2, " +
		"margin_top = COALESCE(entries_y_offset, 0) + 3 " +
		"WHERE entries_x_offset IS NOT NULL AND entries_x_offset != 0 " +
		"OR entries_y_offset IS NOT NULL AND entries_y_offset != 0");
	if (err3) throw new Error('offset to margin conversion failed: ' + err3.message);
}
