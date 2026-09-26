// src/models/qwkPmRouting.js: which QWK connection carries a private message.
//
// QWK private mail travels as conference 0 of one packet to one system. Both
// packet builders (the client REP in qwkTosser.pushToQwkPeer and the hub
// packet in qwkPacketBuilder.buildQwkForNode) used to take EVERY pending QWK
// PM, so with more than one QWK connection whichever one packed first carried
// all of them, most to the wrong system (#65).
//
// The rule, in order:
//   1. A reply pinned to the connection its original arrived on
//      (transport_data.peer_connection_uuid), while that connection is active
//      and still names the same system.
//   2. The active connection whose remote QWK ID is the destination
//      (transport_data.destination, else to_address), case-insensitively. A
//      board can reach one system over two connections (as its node and as
//      its hub); the one where it is our hub wins, as in Synchronet's
//      qwk_route (#69).
//   3. Nothing: the PM is undeliverable and the sender is told. Relaying via
//      a hub to a system it knows (Synchronet's user@QWKID convention) is not
//      done, and guessing an upstream would hand the hub mail addressed to
//      none of its users.

import * as peerConnections from './peerConnections.js';
import * as privateMessages from './privateMessages.js';
import * as alogger from '../utils/alogger.js';
import { remoteRole } from '../utils/qwkId.js';
import { parseViaPath, netmailWire } from '../utils/qwkVia.js';
import * as qwkRoutes from './qwkRoutes.js';

function tdOf(pm) {
	var td = pm && pm.transport_data;
	if (typeof td === 'string') {
		try { td = JSON.parse(td); } catch (_) { td = {}; }
	}
	return td || {};
}

function qwkIdOf(conn) {
	return String(((conn && conn.connection_data) || {}).remote_qwk_id || '').trim().toUpperCase();
}

/** The hops a PM is addressed to (`DEST` or `HUB/NODE/DEST`), upper case. */
function addressPathOf(pm) {
	var td = tdOf(pm);
	return parseViaPath(td.destination || (pm && pm.to_address) || '');
}

/** The destination QWK ID a PM is addressed to (the last hop), or ''. */
function destinationOf(pm) {
	var p = addressPathOf(pm);
	return p.length ? p[p.length - 1] : '';
}

// Our hub before our node, as Synchronet's qwk_route checks its hubs before
// its nodes (#69). With IDs unique per role (#67) there is at most one of each.
function pickConnection(conns, id) {
	var matches = conns.filter(function (c) { return qwkIdOf(c) === id; });
	return matches.find(function (c) { return remoteRole(c.connection_data) === 'hub'; }) || matches[0] || null;
}

/**
 * Pure. `connections` are the ACTIVE QWK connections; `routes` the learned
 * routes (qwkRoutes.fresh()). In Synchronet's order (qwk.cpp qwk_route):
 *   1. a reply, back over the connection its original came in on, along the
 *      path it came by (transport_data.route_path, else straight to it);
 *   2. the destination itself, when it is a direct connection;
 *   3. an explicit path whose first hop is a direct connection;
 *   4. a learned route whose first hop is a direct connection on the route's
 *      own network;
 *   5. nowhere, with the reason.
 * A PM whose transport_data.network_id is set (relayed mail, or a network the
 * sender chose) is held to that network. A destination learned on more than one
 * network is ambiguous until one is chosen.
 * @returns {{uuid: string|null, rest: string, method: string|null, reason: string|null}}
 */
function routeQwkPm(pm, connections, routes) {
	var td = tdOf(pm);
	var path = addressPathOf(pm);
	var dest = path.length ? path[path.length - 1] : '';
	var netId = td.network_id !== undefined && td.network_id !== null && td.network_id !== '' ? Number(td.network_id) : null;
	var conns = (connections || []).slice()
		.filter(function (c) { return netId === null || Number(c.network_id) === netId; })
		.sort(function (a, b) { return Number(a.id) - Number(b.id); });
	var none = function (reason) { return { uuid: null, rest: '', method: null, reason: reason }; };

	var pinned = td.peer_connection_uuid;
	if (pinned) {
		var hit = conns.find(function (c) { return c.uuid === pinned; });
		if (hit) {
			if (qwkIdOf(hit) === dest) return { uuid: hit.uuid, rest: '', method: 'reply', reason: null };
			var back = parseViaPath(td.route_path);
			if (back.length > 1 && back[0] === qwkIdOf(hit) && back[back.length - 1] === dest) {
				return { uuid: hit.uuid, rest: back.slice(1).join('/'), method: 'reply', reason: null };
			}
		}
	}

	if (!dest) return none('no destination QWK ID');

	var direct = pickConnection(conns, dest);
	if (direct) return { uuid: direct.uuid, rest: '', method: 'direct', reason: null };

	if (path.length > 1) {
		var first = pickConnection(conns, path[0]);
		if (first) return { uuid: first.uuid, rest: path.slice(1).join('/'), method: 'explicit', reason: null };
	}

	var found = [];
	for (var r of routes || []) {
		if (String(r.qwk_id || '').toUpperCase() !== dest) continue;
		if (netId !== null && Number(r.network_id) !== netId) continue;
		var hops = parseViaPath(r.path);
		var via = pickConnection(conns.filter(function (c) { return Number(c.network_id) === Number(r.network_id); }), hops[0]);
		if (via) found.push({ uuid: via.uuid, rest: hops.slice(1).join('/'), network_id: Number(r.network_id) });
	}
	var nets = Array.from(new Set(found.map(function (f) { return f.network_id; })));
	if (nets.length > 1) {
		var names = nets.map(function (n) {
			var c = (connections || []).find(function (x) { return Number(x.network_id) === n; });
			return (c && c.network_name) || ('network ' + n);
		});
		return none(dest + ' is known on more than one network (' + names.join(', ') + '), so one has to be chosen');
	}
	if (found.length) return { uuid: found[0].uuid, rest: found[0].rest, method: 'learned', reason: null };

	return none('no QWK connection or known route to ' + dest);
}

/**
 * The pending QWK PMs this connection should carry, each with `_qwkRest` (the
 * hops after this one, '' on the last hop). PMs no connection can carry are
 * marked undeliverable here, and their senders told, so they stop waiting.
 */
async function pendingQwkPmsFor(connectionUUID) {
	var pending = await privateMessages.getPendingByTransport('QWK');
	if (!pending || pending.length === 0) return [];
	var conns = await peerConnections.getActiveConnectionsByNetworkType('QWK');
	var routes = await qwkRoutes.fresh();

	var mine = [];
	for (var pm of pending) {
		var route = routeQwkPm(pm, conns, routes);
		if (route.uuid === connectionUUID) {
			pm._qwkRest = route.rest;
			mine.push(pm);
		} else if (!route.uuid) {
			alogger.writeClog(3, 'QWK PM ' + pm.id + ' to ' + (pm.to_user || '?') + ' is undeliverable: ' +
				route.reason, 'tosser', 'yellow', false, false);
			try {
				await privateMessages.markOutboxUndeliverable(pm.id, 'There is ' + route.reason +
					' on this system, so the message has nowhere to go.');
			} catch (err) {
				alogger.writeClog(2, 'QWK PM ' + pm.id + ': could not mark undeliverable: ' + err.message,
					'tosser', 'redbright', false, false);
			}
		}
	}
	return mine;
}

/**
 * The To field and body a PM goes out with on this hop (qwkVia.netmailWire),
 * with a relayed PM's sender path as @VIA.
 */
function wireFor(pm) {
	var td = tdOf(pm);
	return netmailWire(pm.to_user || '', pm._qwkRest || '', pm.body_text || '', td.relay ? td.source_path : null);
}

export { routeQwkPm, destinationOf, addressPathOf, pendingQwkPmsFor, wireFor };
