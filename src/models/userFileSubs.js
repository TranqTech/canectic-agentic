// src/models/userFileSubs.js
// User file area subscription management.
// Same pattern as userAreaSubs.js: user override > area newscan_default.

import * as postgres from '../middleware/db/postgres.js';

// Check if a user is subscribed to a file area.
// Resolution: explicit override > area newscan_default.
async function isSubscribed(userId, areaShortcode) {
	var override = await postgres.queryOne(
		'SELECT subscribed FROM user_file_subscriptions WHERE user_id = $1 AND area_shortcode = $2',
		[userId, areaShortcode]
	);
	if (override) return override.subscribed;

	// Fall back to area default
	var area = await postgres.queryOne(
		'SELECT newscan_default FROM file_areas WHERE shortcode = $1',
		[areaShortcode]
	);
	return area ? area.newscan_default : true;
}

// Set subscription state (upsert).
async function setSubscription(userId, areaShortcode, subscribed) {
	await postgres.write(
		`INSERT INTO user_file_subscriptions (user_id, area_shortcode, subscribed, updated_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (user_id, area_shortcode) DO UPDATE SET subscribed = $3, updated_at = NOW()`,
		[userId, areaShortcode, subscribed]
	);
}

// Toggle subscription, return new state.
async function toggleSubscription(userId, areaShortcode) {
	var current = await isSubscribed(userId, areaShortcode);
	var newState = !current;
	await setSubscription(userId, areaShortcode, newState);
	return newState;
}

// Get subscription map for a list of areas: { shortcode: true/false }
// areasWithDefaults: array of { shortcode, newscan_default } objects
async function getSubscriptionMap(userId, areasWithDefaults) {
	var overrides = await postgres.query(
		'SELECT area_shortcode, subscribed FROM user_file_subscriptions WHERE user_id = $1',
		[userId]
	);
	var overrideMap = {};
	if (overrides) {
		for (var i = 0; i < overrides.length; i++) {
			overrideMap[overrides[i].area_shortcode] = overrides[i].subscribed;
		}
	}

	var result = {};
	for (var j = 0; j < areasWithDefaults.length; j++) {
		var area = areasWithDefaults[j];
		if (overrideMap[area.shortcode] !== undefined) {
			result[area.shortcode] = overrideMap[area.shortcode];
		} else {
			result[area.shortcode] = area.newscan_default !== false;
		}
	}
	return result;
}

// Get array of subscribed area shortcodes.
async function getSubscribedAreas(userId, areasWithDefaults) {
	var map = await getSubscriptionMap(userId, areasWithDefaults);
	var result = [];
	for (var shortcode in map) {
		if (map[shortcode]) result.push(shortcode);
	}
	return result;
}

// Ensure unique constraint exists for upsert.
async function ensureConstraintsAndIndexes() {
	try {
		await postgres.write(
			`DO $$ BEGIN
			  IF NOT EXISTS (
			    SELECT 1 FROM pg_constraint WHERE conname = 'user_file_subscriptions_user_id_area_shortcode_key'
			  ) THEN
			    ALTER TABLE user_file_subscriptions ADD CONSTRAINT user_file_subscriptions_user_id_area_shortcode_key UNIQUE (user_id, area_shortcode);
			  END IF;
			END $$`
		);
	} catch (_) {}
}

export {
	isSubscribed,
	setSubscription,
	toggleSubscription,
	getSubscriptionMap,
	getSubscribedAreas,
	ensureConstraintsAndIndexes
};
