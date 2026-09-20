// 0006-normalise-body-text: make body_text mean one thing.
//
// Three importers wrote body_text and utf8 three different ways:
//
//   FTN    body_text = Unicode text, utf8 = the same string
//   QWK    body_text = raw CP437 bytes held as latin-1 chars, utf8 = converted
//   NNTP   body_text = decoded text, utf8 = null
//
// Every exporter then had to guess which it was looking at, and two guessed
// wrong. The QWK packer's test was "utf8 is set, therefore body_text is raw
// CP437" — true of a QWK message, false of an FTN one — so relaying an FTN
// message into a QWK packet took the low byte of each character and turned
// `Γöî` into `ô÷ε`. cf5bcdf stopped the corruption by routing every exporter
// through one function that knows the three shapes. This removes the need for
// that function by making the shapes one shape.
//
// After this runs, body_text is canonical Unicode in every row and utf8 is
// redundant. The column is deliberately NOT dropped here: it is the only copy
// of the decoded text for the rows being rewritten, so keeping it for a
// release is what makes this reversible if the rewrite is ever found wanting.
//
// Tables are discovered rather than listed. Every board has different message
// areas — this one has 32, another will have a different set entirely — so a
// hardcoded list would silently do nothing on somebody else's system, which is
// the failure mode that matters when a migration ships to boards nobody here
// can inspect.

export const description = 'Rewrite body_text as canonical Unicode so it means the same thing for every source';

export const phase = 'post';

export async function run(ctx) {
	var pg = ctx.postgres;
	var log = ctx.log || function () {};

	// Any table carrying both columns. mb_<area>_msgs plus the three PM
	// tables, whatever they happen to be called on this system.
	var tables = await pg.query(
		"SELECT c.table_name FROM information_schema.columns c " +
		"WHERE c.table_schema = 'public' AND c.column_name = 'utf8' " +
		"  AND EXISTS (SELECT 1 FROM information_schema.columns b " +
		"              WHERE b.table_schema = 'public' AND b.table_name = c.table_name " +
		"                AND b.column_name = 'body_text') " +
		"ORDER BY c.table_name");

	if (!tables || tables.length === 0) {
		log('no tables carry both body_text and utf8; nothing to normalise');
		return { tables: 0, rewritten: 0 };
	}

	var rewritten = 0;
	var touched = 0;

	for (var row of tables) {
		var table = row.table_name;

		// Guard the identifier. These names come from information_schema on
		// this database rather than from input, but a migration that
		// interpolates a table name should still say why it is allowed to.
		if (!/^[a-z0-9_]+$/.test(table)) {
			log('skipping table with an unexpected name: ' + table);
			continue;
		}

		// Only the rows where the two columns disagree, which is exactly the
		// QWK-convention set: body_text holds raw bytes and utf8 holds the
		// decoded text. Where they already agree the row is canonical and
		// rewriting it would be a no-op costing a table scan.
		//
		// IS DISTINCT FROM rather than <>, so a NULL body_text against a
		// non-null utf8 is caught too; <> would evaluate NULL and skip it.
		var counted = await pg.queryOne(
			'SELECT COUNT(*) AS n FROM ' + table +
			" WHERE utf8 IS NOT NULL AND utf8 <> '' AND body_text IS DISTINCT FROM utf8");
		var n = counted ? parseInt(counted.n, 10) || 0 : 0;
		if (n === 0) continue;

		var err = await pg.write(
			'UPDATE ' + table + ' SET body_text = utf8 ' +
			" WHERE utf8 IS NOT NULL AND utf8 <> '' AND body_text IS DISTINCT FROM utf8");
		if (err) throw new Error('could not normalise ' + table + ': ' + err.message);

		rewritten += n;
		touched++;
		log(table + ': ' + n + ' row(s) rewritten from utf8');
	}

	log('normalised ' + rewritten + ' row(s) across ' + touched + ' of ' + tables.length + ' table(s)');
	return { tables: tables.length, touched: touched, rewritten: rewritten };
}
