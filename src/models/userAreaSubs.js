// userAreaSubs.js — User message area subscription model.
//
// Controls which areas appear in a user's newscan.
// Resolution: user override > area default (message_areas.newscan_default).
//
// If no row in user_area_subscriptions for a user/area pair, the area's
// newscan_default value is used. This means:
//   - Sysop changes to newscan_default affect all users who haven't explicitly toggled
//   - Users who have explicitly subscribed/unsubscribed keep their choice
//   - No pre-population needed for new users — the fallback handles it

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

// Check if a user is subscribed to an area.
// Returns true/false based on: user override if exists, else area's newscan_default.
async function isSubscribed(userId, areaShortcode) {
	// Check user override first
	var row = await postgres.queryOne(
		"SELECT subscribed FROM user_area_subscriptions WHERE user_id = $1 AND area_shortcode = $2",
		[userId, areaShortcode]
	);
	if (row) return !!row.subscribed;

	// No override — fall back to area default
	var area = await postgres.queryOne(
		"SELECT newscan_default FROM message_areas WHERE shortcode = $1",
		[areaShortcode]
	);
	// If column doesn't exist yet (migration pending) or area not found, default to true
	if (!area || area.newscan_default === undefined || area.newscan_default === null) return true;
	return !!area.newscan_default;
}

// Set explicit subscription state for a user/area.
async function setSubscription(userId, areaShortcode, subscribed) {
	await postgres.write(
		`INSERT INTO user_area_subscriptions (user_id, area_shortcode, subscribed, updated_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (user_id, area_shortcode)
		 DO UPDATE SET subscribed = $3, updated_at = NOW()`,
		[userId, areaShortcode, subscribed]
	);
}

// Convenience wrappers
async function subscribe(userId, areaShortcode) {
	return setSubscription(userId, areaShortcode, true);
}

async function unsubscribe(userId, areaShortcode) {
	return setSubscription(userId, areaShortcode, false);
}

// Toggle subscription state. Returns the new state (true/false).
async function toggleSubscription(userId, areaShortcode) {
	var current = await isSubscribed(userId, areaShortcode);
	var newState = !current;
	await setSubscription(userId, areaShortcode, newState);
	return newState;
}

// Remove user's explicit override — revert to area default.
async function clearOverride(userId, areaShortcode) {
	await postgres.write(
		"DELETE FROM user_area_subscriptions WHERE user_id = $1 AND area_shortcode = $2",
		[userId, areaShortcode]
	);
}

// ---------------------------------------------------------------------------
// Batch queries (for newscan and area selector)
// ---------------------------------------------------------------------------

// Get subscribed area shortcodes for a user within a set of areas.
// Uses the resolution logic: user override > area default.
// areasWithDefaults: array of { shortcode, newscan_default }
// Returns array of shortcodes the user is subscribed to.
async function getSubscribedAreas(userId, areasWithDefaults) {
	if (!areasWithDefaults || areasWithDefaults.length === 0) return [];

	var shortcodes = areasWithDefaults.map(a => a.shortcode);

	// Get all user overrides in one query
	var overrides = await postgres.query(
		"SELECT area_shortcode, subscribed FROM user_area_subscriptions WHERE user_id = $1 AND area_shortcode = ANY($2)",
		[userId, shortcodes]
	);

	var overrideMap = {};
	if (overrides) {
		for (var row of overrides) {
			overrideMap[row.area_shortcode] = !!row.subscribed;
		}
	}

	// Resolve each area
	var result = [];
	for (var area of areasWithDefaults) {
		if (overrideMap[area.shortcode] !== undefined) {
			// User has explicit override
			if (overrideMap[area.shortcode]) result.push(area.shortcode);
		} else {
			// Fall back to area default
			var def = (area.newscan_default === undefined || area.newscan_default === null) ? true : !!area.newscan_default;
			if (def) result.push(area.shortcode);
		}
	}
	return result;
}

// Get subscription map for a list of areas for display in area selector.
// Returns { shortcode: true/false } for each area.
async function getSubscriptionMap(userId, areasWithDefaults) {
	if (!areasWithDefaults || areasWithDefaults.length === 0) return {};

	var shortcodes = areasWithDefaults.map(a => a.shortcode);

	var overrides = await postgres.query(
		"SELECT area_shortcode, subscribed FROM user_area_subscriptions WHERE user_id = $1 AND area_shortcode = ANY($2)",
		[userId, shortcodes]
	);

	var overrideMap = {};
	if (overrides) {
		for (var row of overrides) {
			overrideMap[row.area_shortcode] = !!row.subscribed;
		}
	}

	var result = {};
	for (var area of areasWithDefaults) {
		if (overrideMap[area.shortcode] !== undefined) {
			result[area.shortcode] = overrideMap[area.shortcode];
		} else {
			result[area.shortcode] = (area.newscan_default === undefined || area.newscan_default === null) ? true : !!area.newscan_default;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function removeSubsForUser(userId) {
	await postgres.write("DELETE FROM user_area_subscriptions WHERE user_id = $1", [userId]);
}

async function removeSubsForArea(areaShortcode) {
	await postgres.write("DELETE FROM user_area_subscriptions WHERE area_shortcode = $1", [areaShortcode]);
}

// ---------------------------------------------------------------------------
// Table bootstrap — unique constraint and indexes
// ---------------------------------------------------------------------------

async function ensureConstraintsAndIndexes() {
	await postgres.write(
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_area_subscriptions_user_area_key')
			THEN ALTER TABLE user_area_subscriptions ADD CONSTRAINT user_area_subscriptions_user_area_key UNIQUE (user_id, area_shortcode);
			END IF;
		END $$`
	);
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_uas_user ON user_area_subscriptions(user_id)");
	await postgres.write("CREATE INDEX IF NOT EXISTS idx_uas_user_area ON user_area_subscriptions(user_id, area_shortcode)");
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	isSubscribed,
	setSubscription,
	subscribe,
	unsubscribe,
	toggleSubscription,
	clearOverride,
	getSubscribedAreas,
	getSubscriptionMap,
	removeSubsForUser,
	removeSubsForArea,
	ensureConstraintsAndIndexes,
};
