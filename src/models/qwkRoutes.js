// src/models/qwkRoutes.js: QWK netmail routes learned from sender paths (#73).
//
// Synchronet keeps qnet/route.dat: every imported QWKnet message's @VIA teaches
// how to reach each system in it, entries older than 90 days are dropped, and
// netmail to a system with no direct link goes by that route (qwk.cpp
// update_qwkroute, qwk_route). Canectic keeps the same, PER NETWORK: a QWK ID
// is unique only within a network, and netmail is relayed only within the
// network it arrived on, as FTN nodelist mode does.
//
// Table qwk_routes: one row per (network, QWK ID), keyed route_key =
// "<network_id>:<ID>", the most recent path wins.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { routesFromSenderPath } from '../utils/qwkVia.js';

var MAX_AGE_DAYS = 90;

/**
 * Learn from the sender paths of messages imported from one network. Never
 * throws: a route not learned costs a bounce later, a throw here would cost
 * the import.
 */
async function learn(networkId, senderPaths) {
	var best = new Map();
	for (var p of senderPaths || []) {
		for (var r of routesFromSenderPath(p)) best.set(r.id, r.path);
	}
	if (best.size === 0) return 0;
	var n = 0;
	try {
		for (var [id, path] of best) {
			var err = await postgres.write(
				`INSERT INTO qwk_routes (route_key, network_id, qwk_id, path, updated_at)
				 VALUES ($1, $2, $3, $4, NOW())
				 ON CONFLICT (route_key) DO UPDATE SET path = EXCLUDED.path, updated_at = NOW()`,
				[networkId + ':' + id, networkId, id, path]);
			if (!err) n++;
		}
		await postgres.write(
			"DELETE FROM qwk_routes WHERE network_id = $1 AND updated_at < NOW() - ($2 || ' days')::interval",
			[networkId, String(MAX_AGE_DAYS)]);
	} catch (e) {
		alogger.writeClog(3, 'qwkRoutes.learn: ' + e.message, 'tosser', 'yellow', false, false);
	}
	return n;
}

/** Routes seen in the last 90 days, for the router. */
// Never throws: without its routes the router still reaches every direct
// connection and explicit path, which is better than delivering nothing.
async function fresh() {
	try {
		return (await postgres.query(
			"SELECT network_id, qwk_id, path, updated_at FROM qwk_routes WHERE updated_at >= NOW() - ($1 || ' days')::interval",
			[String(MAX_AGE_DAYS)])) || [];
	} catch (e) {
		alogger.writeClog(3, 'qwkRoutes.fresh: ' + e.message + ' (routing without learned routes)', 'tosser', 'yellow', false, false);
		return [];
	}
}

export { MAX_AGE_DAYS, learn, fresh };
