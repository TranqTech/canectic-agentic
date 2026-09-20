// userFilePointers.js — Per-user per-area scan pointers for file areas
// Mirrors userMsgPointers.js pattern.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from "../utils/alogger.js";

var TABLE = 'user_file_pointers';

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

async function ensureConstraintsAndIndexes() {
	await postgres.write(
		"CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
		"  id SERIAL PRIMARY KEY," +
		"  user_id INTEGER," +
		"  area_shortcode VARCHAR(64)," +
		"  scan_pointer INTEGER DEFAULT 0," +
		"  last_read_at TIMESTAMP," +
		"  UNIQUE(user_id, area_shortcode)" +
		")"
	);
	// Ensure UNIQUE constraint exists (may be missing if table was created by schema system)
	await postgres.write(
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_file_pointers_user_id_area_shortcode_key')
			THEN ALTER TABLE user_file_pointers ADD CONSTRAINT user_file_pointers_user_id_area_shortcode_key UNIQUE (user_id, area_shortcode);
			END IF;
		END $$`
	);
	// Indexes (idempotent)
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_ufp_user ON " + TABLE + "(user_id)");
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_ufp_area ON " + TABLE + "(area_shortcode)");
}

// ---------------------------------------------------------------------------
// Pointer operations
// ---------------------------------------------------------------------------

/**
 * The highest file id in a set of entry rows, as a number.
 *
 * Exists because postgres hands `id` back as a STRING, and the obvious loop
 * over rows comparing `f.id > maxId` silently becomes a lexicographic string
 * comparison the moment maxId holds one of those strings.  '9' > '37' is true,
 * so an area whose ids have run into double digits advanced the pointer to 9
 * and then, because the write uses GREATEST, could never advance past it.  The
 * visible symptom was a new-file badge that viewing the area would not clear.
 *
 * Anything unparseable is ignored rather than poisoning the result with NaN,
 * since every comparison against NaN is false and the pointer would simply
 * stop moving again.
 */
function highestId(entries) {
	var max = 0;
	for (var entry of (entries || [])) {
		if (!entry) continue;
		var id = parseInt(entry.id, 10);
		if (Number.isFinite(id) && id > max) max = id;
	}
	return max;
}

/**
 * Advance the scan pointer for a user in an area.
 * Only moves forward (GREATEST).
 */
async function advancePointer(userId, areaShortcode, maxFileId) {
	// Coerce here as well as at the call sites: a string id reaching the SQL
	// casts cleanly to bigint, so a caller that forgot would not fail, it
	// would just be wrong somewhere else first.
	var target = parseInt(maxFileId, 10);
	if (!Number.isFinite(target)) return;
	maxFileId = target;

	await postgres.write(
		"INSERT INTO " + TABLE + " (user_id, area_shortcode, scan_pointer, last_read_at) " +
		"VALUES ($1, $2, $3, NOW()) " +
		"ON CONFLICT (user_id, area_shortcode) DO UPDATE SET " +
		"scan_pointer = GREATEST(" + TABLE + ".scan_pointer, $3), last_read_at = NOW()",
		[userId, areaShortcode.toUpperCase(), maxFileId]
	);
}

/**
 * Mark all files in an area as seen (jump pointer to current max).
 */
async function markAreaRead(userId, areaShortcode) {
	var fileEntries = await import('./fileEntries.js');
	var fileAreas = await import('./fileAreas.js');
	var dbarea = await fileAreas.getAreaByShortcode(areaShortcode);
	if (!dbarea) return;

	var maxId = await fileEntries.getMaxIdForArea(dbarea.id);

	await postgres.write(
		"INSERT INTO " + TABLE + " (user_id, area_shortcode, scan_pointer, last_read_at) " +
		"VALUES ($1, $2, $3, NOW()) " +
		"ON CONFLICT (user_id, area_shortcode) DO UPDATE SET " +
		"scan_pointer = $3, last_read_at = NOW()",
		[userId, areaShortcode.toUpperCase(), maxId]
	);
}

/**
 * Get the scan pointer for a user in an area.
 */
async function getPointer(userId, areaShortcode) {
	var row = await postgres.queryOne(
		"SELECT scan_pointer FROM " + TABLE + " WHERE user_id = $1 AND area_shortcode = $2",
		[userId, areaShortcode.toUpperCase()]
	);
	return row ? parseInt(row.scan_pointer) : 0;
}

/**
 * Get new file count for a user in an area.
 */
async function getNewCount(userId, areaShortcode, areaId) {
	var pointer = await getPointer(userId, areaShortcode);
	var fileEntries = await import('./fileEntries.js');
	return await fileEntries.getNewFileCount(areaId, pointer);
}

// ---------------------------------------------------------------------------
// Pre-population
// ---------------------------------------------------------------------------

/**
 * Create pointer rows for all active users when a new file area is created.
 * Pointer = 0 so all existing files appear as "new" (or set to max to hide history).
 */
async function initPointersForArea(areaShortcode) {
	var shorty = areaShortcode.toUpperCase();
	var users = await postgres.query("SELECT id FROM users WHERE active = true");
	if (!users || users.length === 0) return;

	for (var user of users) {
		await postgres.write(
			"INSERT INTO " + TABLE + " (user_id, area_shortcode, scan_pointer) " +
			"VALUES ($1, $2, 0) ON CONFLICT (user_id, area_shortcode) DO NOTHING",
			[user.id, shorty]
		);
	}

	alogger.writeAlog(5, "Initialized file pointers for area " + shorty + " (" + users.length + " users)", "cyan");
}

/**
 * Create pointer rows for all active file areas when a new user is created.
 * Sets pointer to current max file ID so history doesn't appear as "new".
 */
async function initPointersForUser(userId) {
	var areas = await postgres.query("SELECT id, shortcode FROM file_areas WHERE active = true");
	if (!areas || areas.length === 0) return;

	var fileEntries = await import('./fileEntries.js');

	for (var area of areas) {
		var maxId = await fileEntries.getMaxIdForArea(area.id);
		await postgres.write(
			"INSERT INTO " + TABLE + " (user_id, area_shortcode, scan_pointer) " +
			"VALUES ($1, $2, $3) ON CONFLICT (user_id, area_shortcode) DO NOTHING",
			[userId, area.shortcode, maxId]
		);
	}

	alogger.writeAlog(5, "Initialized file pointers for user " + userId + " (" + areas.length + " areas)", "cyan");
}

export {
	ensureConstraintsAndIndexes,
	highestId,
	advancePointer,
	markAreaRead,
	getPointer,
	getNewCount,
	initPointersForArea,
	initPointersForUser
};
