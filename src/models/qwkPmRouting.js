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

/**
 * The destination QWK ID a PM is addressed to, upper case, or ''.
 */
function destinationOf(pm) {
	var td = tdOf(pm);
	return String(td.destination || (pm && pm.to_address) || '').trim().toUpperCase();
}

/**
 * Pure. `connections` are the ACTIVE QWK connections.
 * @returns {{uuid: string|null, reason: string|null}}
 */
function routeQwkPm(pm, connections) {
	var dest = destinationOf(pm);
	var conns = (connections || []).slice().sort(function (a, b) { return Number(a.id) - Number(b.id); });

	var pinned = tdOf(pm).peer_connection_uuid;
	if (pinned) {
		var hit = conns.find(function (c) { return c.uuid === pinned; });
		if (hit && (!dest || qwkIdOf(hit) === dest)) return { uuid: hit.uuid, reason: null };
	}

	if (!dest) return { uuid: null, reason: 'no destination QWK ID' };
	// Our hub before our node, as Synchronet's qwk_route checks its hubs
	// before its nodes (#69). With IDs unique per role (#67) there is at most
	// one of each.
	var matches = conns.filter(function (c) { return qwkIdOf(c) === dest; });
	var match = matches.find(function (c) { return remoteRole(c.connection_data) === 'hub'; }) || matches[0];
	if (match) return { uuid: match.uuid, reason: null };
	return { uuid: null, reason: 'no QWK connection to ' + dest };
}

/**
 * The pending QWK PMs this connection should carry. PMs no connection can
 * carry are marked undeliverable here, and their senders told, so they stop
 * waiting for ever.
 */
async function pendingQwkPmsFor(connectionUUID) {
	var pending = await privateMessages.getPendingByTransport('QWK');
	if (!pending || pending.length === 0) return [];
	var conns = await peerConnections.getActiveConnectionsByNetworkType('QWK');

	var mine = [];
	for (var pm of pending) {
		var route = routeQwkPm(pm, conns);
		if (route.uuid === connectionUUID) {
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

export { routeQwkPm, destinationOf, pendingQwkPmsFor };
