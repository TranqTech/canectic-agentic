// 0002-msgid-tuple-split: repair legacy full-string MSGIDs.
//
// Message bases written before msg_id and msg_orig_addr were separate columns
// store the whole "address serial" string in msg_id. Those rows do not match
// new-format ones for dupe checking or threading, so an unrepaired system stays
// quietly broken.
//
// Manual on purpose. The predicate is `msg_id LIKE '% %'`, which no index helps,
// so it full scans every per-area message table. That is minutes of work on a
// hub with hundreds of areas, and it can only ever find something once. It was
// removed from the migration path in 372d523 for exactly that reason.
//
// This entry replaces the msgid_tuple_split_completed_at marker row in
// settings, which was a private ledger of one, invented because there was no
// general one. The tool that performs the work records the completion here.

export const description = 'Split legacy "address serial" MSGIDs into the msg_id / msg_orig_addr tuple';
export const automatic = false;

export const instructions = [
	'node src/tools/maintenance.js --fix-msgids --dry-run   (report only)',
	'node src/tools/maintenance.js --fix-msgids             (repair)'
].join('\n');

// Two ways this is already answered.
//
// A system that ran the repair before the ledger existed recorded it as
// msgid_tuple_split_completed_at in settings, which was a private ledger of one.
// Honouring it here is the bridge: such a system records as skipped on its next
// migration run and the general ledger takes over from there. Without this it
// would be told to do work it has already done, and the instruction is
// expensive to follow.
//
// A system with no per-area message tables has nothing to repair. That case is
// normally caught by the fresh-database check before a migration is considered
// at all; this covers one that has Canectic tables but no message areas yet.
//
// Once this migration is recorded as applied, the runner never consults this
// function again, so completion is the ledger's job rather than this
// predicate's.
export async function isNeeded(ctx) {
	var marker = await ctx.postgres.queryOne(
		"SELECT value FROM settings WHERE key = 'msgid_tuple_split_completed_at'", []);
	if (marker && marker.value) return false;

	var rows = await ctx.postgres.query(
		"SELECT 1 FROM information_schema.tables " +
		"WHERE table_schema = 'public' AND table_name LIKE 'mb\\_%\\_msgs' LIMIT 1", []);
	return rows.length > 0;
}
