// userMsgPointers.js — Message read tracking model.
//
// Two-tier pointer system:
//   user_msg_pointers    — one row per user per area (area-level scan pointer)
//   user_thread_pointers — one row per user per thread visited (thread-level pointer)
//
// The area pointer acts as a floor: any message with id <= area_pointer is
// considered read regardless of thread pointers. Thread pointers add
// per-thread granularity above the floor.
//
// Effective read threshold for a thread:
//   MAX(area_pointer, COALESCE(thread_pointer, 0))
//
// A message is unread if its id exceeds the effective threshold for its thread.
//
// Normal reading patterns:
//   - View a thread → advance that thread's pointer + area pointer if higher
//   - View flat → advance area pointer only
//   - Mark area read → advance area pointer to max (all threads appear read)
//
// The user_msg_reads exception table is retained for future mark-unread
// functionality but is not used in normal read tracking.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Table bootstrap — called at startup
// ---------------------------------------------------------------------------

async function ensureConstraintsAndIndexes() {
	// Create tables if migration tool hasn't run yet
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS user_msg_pointers (
			id SERIAL PRIMARY KEY,
			user_id INTEGER,
			area_shortcode VARCHAR(64),
			scan_pointer INTEGER DEFAULT 0,
			last_read_at TIMESTAMP
		)
	`);
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS user_thread_pointers (
			id SERIAL PRIMARY KEY,
			user_id INTEGER,
			area_shortcode VARCHAR(64),
			thread_id INTEGER,
			scan_pointer INTEGER DEFAULT 0,
			last_read_at TIMESTAMP
		)
	`);
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS user_msg_reads (
			id SERIAL PRIMARY KEY,
			user_id INTEGER,
			area_shortcode VARCHAR(64),
			msg_id INTEGER,
			is_read BOOLEAN,
			read_at TIMESTAMP
		)
	`);

	// Composite unique constraints
	await postgres.write(
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_msg_pointers_user_id_area_shortcode_key')
			THEN ALTER TABLE user_msg_pointers ADD CONSTRAINT user_msg_pointers_user_id_area_shortcode_key UNIQUE (user_id, area_shortcode);
			END IF;
		END $$`
	);
	await postgres.write(
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_thread_pointers_user_area_thread_key')
			THEN ALTER TABLE user_thread_pointers ADD CONSTRAINT user_thread_pointers_user_area_thread_key UNIQUE (user_id, area_shortcode, thread_id);
			END IF;
		END $$`
	);
	await postgres.write(
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_msg_reads_user_id_area_shortcode_msg_id_key')
			THEN ALTER TABLE user_msg_reads ADD CONSTRAINT user_msg_reads_user_id_area_shortcode_msg_id_key UNIQUE (user_id, area_shortcode, msg_id);
			END IF;
		END $$`
	);

	// Indexes
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_ump_user ON user_msg_pointers(user_id)");
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_ump_area ON user_msg_pointers(area_shortcode)");
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_utp_user ON user_thread_pointers(user_id)");
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_utp_user_area ON user_thread_pointers(user_id, area_shortcode)");
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_utp_user_area_thread ON user_thread_pointers(user_id, area_shortcode, thread_id)");
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_umr_user_area ON user_msg_reads(user_id, area_shortcode)");

	return true;
}

// ---------------------------------------------------------------------------
// Pre-population
// ---------------------------------------------------------------------------

// New user — create area pointer rows for all active areas.
// Pointer set to current max message ID so history doesn't appear as "new."
async function initPointersForUser(userId) {
	var areas = await postgres.query(
		"SELECT shortcode FROM message_areas WHERE active",
		[]
	);
	if (!areas || areas.length === 0) return;

	for (var area of areas) {
		var shorty = area.shortcode.toLowerCase();
		var msgtable = "mb_" + shorty + "_msgs";

		var maxRow = await postgres.queryOne(
			"SELECT COALESCE(MAX(id), 0) AS maxid FROM " + msgtable,
			[]
		);
		var maxId = maxRow ? parseInt(maxRow.maxid) : 0;

		await postgres.write(
			`INSERT INTO user_msg_pointers (user_id, area_shortcode, scan_pointer)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (user_id, area_shortcode) DO NOTHING`,
			[userId, area.shortcode, maxId]
		);
	}
}

// New area — create area pointer rows for all users.
// Pointer = 0 (all messages are new to existing users).
async function initPointersForArea(areaShortcode) {
	await postgres.write(
		`INSERT INTO user_msg_pointers (user_id, area_shortcode, scan_pointer)
		 SELECT id, $1, 0 FROM users
		 ON CONFLICT (user_id, area_shortcode) DO NOTHING`,
		[areaShortcode]
	);
}

// ---------------------------------------------------------------------------
// Area pointer
// ---------------------------------------------------------------------------

async function getPointer(userId, areaShortcode) {
	var row = await postgres.queryOne(
		"SELECT scan_pointer, last_read_at FROM user_msg_pointers WHERE user_id = $1 AND area_shortcode = $2",
		[userId, areaShortcode]
	);
	if (!row) {
		// Lazy-init
		await postgres.write(
			`INSERT INTO user_msg_pointers (user_id, area_shortcode, scan_pointer)
			 VALUES ($1, $2, 0)
			 ON CONFLICT (user_id, area_shortcode) DO NOTHING`,
			[userId, areaShortcode]
		);
		return { scan_pointer: 0, last_read_at: null };
	}
	return row;
}

// Advance area pointer — only moves forward, never backward.
// Used by flat view and QWK downloads.
async function advancePointer(userId, areaShortcode, newPointer) {
	await postgres.write(
		`UPDATE user_msg_pointers SET scan_pointer = GREATEST(scan_pointer, $1), last_read_at = NOW()
		 WHERE user_id = $2 AND area_shortcode = $3`,
		[newPointer, userId, areaShortcode]
	);
}

// Mark entire area as read — jumps area pointer to max message ID.
// Thread pointers don't need updating because the area pointer acts as a
// floor: effective threshold = MAX(area_pointer, thread_pointer).
async function markAreaRead(userId, areaShortcode) {
	var shorty = areaShortcode.toLowerCase();
	var msgtable = "mb_" + shorty + "_msgs";

	var maxRow = await postgres.queryOne(
		"SELECT COALESCE(MAX(id), 0) AS maxid FROM " + msgtable,
		[]
	);
	var maxId = maxRow ? parseInt(maxRow.maxid) : 0;

	await postgres.write(
		"UPDATE user_msg_pointers SET scan_pointer = $1, last_read_at = NOW() WHERE user_id = $2 AND area_shortcode = $3",
		[maxId, userId, areaShortcode]
	);
}

// ---------------------------------------------------------------------------
// Thread pointer
// ---------------------------------------------------------------------------

// Get pointer for a single thread. Returns 0 if no row exists.
async function getThreadPointer(userId, areaShortcode, threadId) {
	var row = await postgres.queryOne(
		"SELECT scan_pointer FROM user_thread_pointers WHERE user_id = $1 AND area_shortcode = $2 AND thread_id = $3",
		[userId, areaShortcode, threadId]
	);
	return row ? row.scan_pointer : 0;
}

// Advance a thread pointer AND the area pointer.
// Called when a user views a thread. One upsert for the thread pointer,
// one update for the area pointer. Both only move forward.
async function advanceThreadPointer(userId, areaShortcode, threadId, newPointer) {
	// Thread pointer — upsert, only advance
	await postgres.write(
		`INSERT INTO user_thread_pointers (user_id, area_shortcode, thread_id, scan_pointer, last_read_at)
		 VALUES ($1, $2, $3, $4, NOW())
		 ON CONFLICT (user_id, area_shortcode, thread_id)
		 DO UPDATE SET scan_pointer = GREATEST(user_thread_pointers.scan_pointer, $4), last_read_at = NOW()`,
		[userId, areaShortcode, threadId, newPointer]
	);

	// Area pointer — also advance if this thread's highest ID is beyond it
	await postgres.write(
		`UPDATE user_msg_pointers SET scan_pointer = GREATEST(scan_pointer, $1), last_read_at = NOW()
		 WHERE user_id = $2 AND area_shortcode = $3`,
		[newPointer, userId, areaShortcode]
	);
}

// ---------------------------------------------------------------------------
// Unread queries
// ---------------------------------------------------------------------------

// Per-thread unread count.
// Effective threshold = MAX(area_pointer, COALESCE(thread_pointer, 0))
async function getThreadUnreadCount(userId, areaShortcode, threadId) {
	var pointer = await getPointer(userId, areaShortcode);
	var areaPtr = pointer.scan_pointer;
	var threadPtr = await getThreadPointer(userId, areaShortcode, threadId);
	var effectivePtr = Math.max(areaPtr, threadPtr);

	var shorty = areaShortcode.toLowerCase();
	var msgtable = "mb_" + shorty + "_msgs";

	var result = await postgres.queryOne(
		"SELECT COUNT(*) AS cnt FROM " + msgtable + " WHERE thread_id = $1 AND id > $2",
		[threadId, effectivePtr]
	);
	return result ? parseInt(result.cnt) : 0;
}

// Batch unread counts for a list of threads — one query.
// Returns { threadId: unreadCount, ... }
async function getThreadUnreadCounts(userId, areaShortcode, threadIds) {
	if (!threadIds || threadIds.length === 0) return {};

	var pointer = await getPointer(userId, areaShortcode);
	var areaPtr = pointer.scan_pointer;
	var shorty = areaShortcode.toLowerCase();
	var msgtable = "mb_" + shorty + "_msgs";

	var rows = await postgres.query(
		`SELECT m.thread_id, COUNT(*) AS cnt
		 FROM ` + msgtable + ` m
		 LEFT JOIN user_thread_pointers utp
		   ON utp.user_id = $1 AND utp.area_shortcode = $2 AND utp.thread_id = m.thread_id
		 WHERE m.thread_id = ANY($3)
		   AND m.id > GREATEST($4, COALESCE(utp.scan_pointer, 0))
		 GROUP BY m.thread_id`,
		[userId, areaShortcode, threadIds, areaPtr]
	);

	var result = {};
	if (rows) {
		for (var row of rows) {
			result[row.thread_id] = parseInt(row.cnt);
		}
	}
	return result;
}

// Total unread message count for an area (across all threads).
async function getUnreadCount(userId, areaShortcode) {
	var pointer = await getPointer(userId, areaShortcode);
	var areaPtr = pointer.scan_pointer;
	var shorty = areaShortcode.toLowerCase();
	var msgtable = "mb_" + shorty + "_msgs";

	var result = await postgres.queryOne(
		`SELECT COUNT(*) AS cnt
		 FROM ` + msgtable + ` m
		 LEFT JOIN user_thread_pointers utp
		   ON utp.user_id = $1 AND utp.area_shortcode = $2 AND utp.thread_id = m.thread_id
		 WHERE m.id > GREATEST($3, COALESCE(utp.scan_pointer, 0))`,
		[userId, areaShortcode, areaPtr]
	);
	return result ? parseInt(result.cnt) : 0;
}

// Quick check: does this area have any unread messages?
async function hasNewMessages(userId, areaShortcode) {
	var pointer = await getPointer(userId, areaShortcode);
	var areaPtr = pointer.scan_pointer;
	var shorty = areaShortcode.toLowerCase();
	var msgtable = "mb_" + shorty + "_msgs";

	// Fast path: if area max <= area pointer, definitely nothing new
	var maxRow = await postgres.queryOne(
		"SELECT COALESCE(MAX(id), 0) AS maxid FROM " + msgtable, []
	);
	var maxId = maxRow ? parseInt(maxRow.maxid) : 0;
	if (maxId <= areaPtr) return false;

	// Slower path: check against per-thread pointers
	var result = await postgres.queryOne(
		`SELECT 1 AS found
		 FROM ` + msgtable + ` m
		 LEFT JOIN user_thread_pointers utp
		   ON utp.user_id = $1 AND utp.area_shortcode = $2 AND utp.thread_id = m.thread_id
		 WHERE m.id > GREATEST($3, COALESCE(utp.scan_pointer, 0))
		 LIMIT 1`,
		[userId, areaShortcode, areaPtr]
	);
	return !!result;
}

// Newscan summary — areas with unread messages.
async function getNewscanSummary(userId, areaShortcodes) {
	var areas = areaShortcodes;
	if (!areas) {
		var allAreas = await postgres.query(
			"SELECT shortcode FROM message_areas WHERE active", []
		);
		areas = (allAreas || []).map(a => a.shortcode);
	}

	var results = [];
	for (var sc of areas) {
		var hasNew = await hasNewMessages(userId, sc);
		if (hasNew) {
			var unread = await getUnreadCount(userId, sc);
			results.push({ area_shortcode: sc, unread_count: unread });
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// First unread in a thread — for scroll-to-unread positioning
// ---------------------------------------------------------------------------

async function getFirstUnreadInThread(userId, areaShortcode, threadId) {
	var pointer = await getPointer(userId, areaShortcode);
	var areaPtr = pointer.scan_pointer;
	var threadPtr = await getThreadPointer(userId, areaShortcode, threadId);
	var effectivePtr = Math.max(areaPtr, threadPtr);

	var shorty = areaShortcode.toLowerCase();
	var msgtable = "mb_" + shorty + "_msgs";

	var row = await postgres.queryOne(
		"SELECT id FROM " + msgtable + " WHERE thread_id = $1 AND id > $2 ORDER BY id ASC LIMIT 1",
		[threadId, effectivePtr]
	);
	return row ? row.id : 0;
}

// First unread in an area (flat view) — for scroll-to-unread positioning
async function getFirstUnreadInArea(userId, areaShortcode) {
	var pointer = await getPointer(userId, areaShortcode);
	var areaPtr = pointer.scan_pointer;
	var shorty = areaShortcode.toLowerCase();
	var msgtable = "mb_" + shorty + "_msgs";

	var row = await postgres.queryOne(
		"SELECT id FROM " + msgtable + " WHERE id > $1 ORDER BY id ASC LIMIT 1",
		[areaPtr]
	);
	return row ? row.id : 0;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function removePointersForArea(areaShortcode) {
	await postgres.write("DELETE FROM user_msg_reads WHERE area_shortcode = $1", [areaShortcode]);
	await postgres.write("DELETE FROM user_thread_pointers WHERE area_shortcode = $1", [areaShortcode]);
	await postgres.write("DELETE FROM user_msg_pointers WHERE area_shortcode = $1", [areaShortcode]);
}

async function removePointersForUser(userId) {
	await postgres.write("DELETE FROM user_msg_reads WHERE user_id = $1", [userId]);
	await postgres.write("DELETE FROM user_thread_pointers WHERE user_id = $1", [userId]);
	await postgres.write("DELETE FROM user_msg_pointers WHERE user_id = $1", [userId]);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	// Setup
	ensureConstraintsAndIndexes,

	// Pre-population hooks
	initPointersForUser,
	initPointersForArea,

	// Area pointer
	getPointer,
	advancePointer,
	markAreaRead,

	// Thread pointer
	getThreadPointer,
	advanceThreadPointer,

	// Unread queries
	getThreadUnreadCount,
	getThreadUnreadCounts,
	getUnreadCount,
	hasNewMessages,
	getNewscanSummary,

	// Scroll positioning
	getFirstUnreadInThread,
	getFirstUnreadInArea,

	// Cleanup
	removePointersForArea,
	removePointersForUser
};
