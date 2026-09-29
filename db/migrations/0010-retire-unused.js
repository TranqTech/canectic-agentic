// 0010-retire-unused: drop the netmail_in / netmail_out tables and the
// tic_auto_forward setting (#84).
//
// netmail_in / netmail_out belonged to the original netmail model, which
// nothing has imported since netmail moved into pm_inbox / pm_outbox; the
// model is gone and the tables are no longer in the schema. They are dropped
// only when EMPTY: a board carrying rows from before the move keeps its table,
// and this says so, since a drop cannot be undone. Both were empty on the dev
// board and the hub.
//
// tic_auto_forward was read by nothing (TIC forwarding to subscribed peers is
// unconditional), so a seeded row for it only offered a setting that did
// nothing. Removed whoever set it: no value of it ever had an effect.

export const description = 'Drop the empty legacy netmail_in/netmail_out tables and the unused tic_auto_forward setting';
export const phase = 'post';

var TABLES = ['netmail_in', 'netmail_out'];

export async function run(ctx) {
	var pg = ctx.postgres;
	var log = ctx.log || function () {};
	var dropped = [], kept = [];

	for (var t of TABLES) {
		var exists = await pg.queryOne('SELECT to_regclass($1) AS t', [t]);
		if (!exists || !exists.t) continue;
		var row = await pg.queryOne('SELECT count(*)::int AS n FROM ' + t);
		if (row && row.n > 0) {
			kept.push(t + ' (' + row.n + ' rows)');
			continue;
		}
		var err = await pg.write('DROP TABLE ' + t);
		if (err) throw new Error('could not drop ' + t + ': ' + err.message);
		dropped.push(t);
	}

	var serr = await pg.write("DELETE FROM settings WHERE key = 'tic_auto_forward'");
	if (serr) throw new Error('could not remove tic_auto_forward: ' + serr.message);

	if (dropped.length) log('  dropped ' + dropped.join(', '));
	if (kept.length) log('  kept, not empty: ' + kept.join(', ') + '. Nothing reads them; drop them by hand once you no longer need the rows.');
	return { dropped: dropped, kept: kept };
}
