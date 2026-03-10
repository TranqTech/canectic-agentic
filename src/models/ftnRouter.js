// ftnRouter.js
// Resolves the next-hop peer_connection for an outbound FTN address.
//
// Cascade:
//   1. Direct connection  — connection_data.address exactly matches destination
//   2. Routing rule match — destination matches a wildcard in connection_data.routing_rules
//   3. Nodelist direct    — (future) destination found in ftn_nodelist with dialable flag
//   4. Coordinator walk   — (future) strip to hub → region → zone coord, check connections
//                           then nodelist at each level
//
// Returns a routeResult object, or null if no route found.
//
// routeResult shape:
// {
//   nextHop:          string,   // FTN address to send the packet to
//   connectionUUID:   string,   // uuid of the peer_connection to use (null if nodelist-only)
//   connectionId:     number,   // id of the peer_connection (null if nodelist-only)
//   method:           string,   // 'direct' | 'routing_rule' | 'nodelist_direct' | 'coordinator'
//   flavour:          string,   // 'Normal' | 'Crash' | 'Hold' — from connection status
//   ruleMatched:      string|null  // the rule pattern that matched (method=routing_rule only)
// }

import * as peerConnections from './peerConnections.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Wildcard rule matcher
//
// Rule format:  zone:net/node   — any component may be '*'
// Examples:     1:*            → any address in zone 1
//               2:234/*        → any node in net 234 of zone 2
//               3:512/100      → exact node (same as a direct match, but via rule)
// ---------------------------------------------------------------------------
function matchesRule(rule, zone, net, node) {
	var parts = rule.trim().split(':');
	if (parts.length !== 2) return false;
	var rZone = parts[0].trim();
	var nnPart = parts[1].trim();
	var nnSplit = nnPart.split('/');
	var rNet  = nnSplit[0].trim();
	var rNode = nnSplit.length > 1 ? nnSplit[1].trim() : '*';

	var zoneMatch = rZone === '*' || rZone === String(zone);
	var netMatch  = rNet  === '*' || rNet  === String(net);
	var nodeMatch = rNode === '*' || rNode === String(node);
	return zoneMatch && netMatch && nodeMatch;
}

// ---------------------------------------------------------------------------
// Parse a FTN address string into { zone, net, node, point }
// Accepts: zone:net/node.point  or  zone:net/node  or  net/node
// ---------------------------------------------------------------------------
function parseFtnAddress(address) {
	if (!address || typeof address !== 'string') return null;
	var addr = address.trim();

	var zone = 1, net = 0, node = 0, point = 0;

	try {
		if (addr.includes(':')) {
			var colonSplit = addr.split(':');
			zone = parseInt(colonSplit[0]) || 1;
			addr = colonSplit[1];
		}
		if (addr.includes('/')) {
			var slashSplit = addr.split('/');
			net = parseInt(slashSplit[0]) || 0;
			addr = slashSplit[1] || '0';
		}
		if (addr.includes('.')) {
			var dotSplit = addr.split('.');
			node  = parseInt(dotSplit[0]) || 0;
			point = parseInt(dotSplit[1]) || 0;
		} else {
			node = parseInt(addr) || 0;
		}
		return { zone, net, node, point };
	} catch (err) {
		return null;
	}
}

// ---------------------------------------------------------------------------
// flavourFromStatus — map connection_data.status → packet flavour string
// ---------------------------------------------------------------------------
function flavourFromStatus(status) {
	switch ((status || 'NORMAL').toUpperCase()) {
		case 'CRASH': return 'Crash';
		case 'HOLD':  return 'Hold';
		default:      return 'Normal';
	}
}

// ---------------------------------------------------------------------------
// resolveRoute(destinationAddress)
//
// Main entry point. Returns routeResult or null.
// ---------------------------------------------------------------------------
async function resolveRoute(destinationAddress) {
	var parsed = parseFtnAddress(destinationAddress);
	if (!parsed) {
		alogger.writeAlog(3, 'ftnRouter: cannot parse destination address: ' + destinationAddress, 'redbright');
		return null;
	}

	var { zone, net, node } = parsed;

	// Load all active FTN connections once
	var connlist = await peerConnections.getActiveConnectionsByNetworkType('FTN');
	if (!connlist || connlist.length === 0) {
		alogger.writeAlog(4, 'ftnRouter: no active FTN connections available for routing', 'yellow');
		return null;
	}

	// -------------------------------------------------------------------
	// Step 1: Direct connection — connection_data.address === destination
	// -------------------------------------------------------------------
	for (var conn of connlist) {
		var cd = conn.connection_data || {};
		if (cd.address && cd.address.trim() === destinationAddress.trim()) {
			alogger.writeAlog(5, 'ftnRouter: direct route to ' + destinationAddress + ' via conn ' + conn.uuid, 'greenbright');
			return {
				nextHop:        destinationAddress,
				connectionUUID: conn.uuid,
				connectionId:   conn.id,
				method:         'direct',
				flavour:        flavourFromStatus(cd.status),
				ruleMatched:    null
			};
		}
	}

	// -------------------------------------------------------------------
	// Step 2: Routing rule wildcard match on connection_data.routing_rules
	// First match wins — order connections are returned from the DB is
	// therefore the tie-break. Consider adding a priority column later.
	// -------------------------------------------------------------------
	for (var conn of connlist) {
		var cd = conn.connection_data || {};
		var rules = Array.isArray(cd.routing_rules) ? cd.routing_rules : [];
		for (var rule of rules) {
			if (matchesRule(rule, zone, net, node)) {
				var nextHop = cd.address || destinationAddress;
				alogger.writeAlog(5,
					'ftnRouter: routing rule "' + rule + '" matched ' + destinationAddress +
					' → ' + nextHop + ' via conn ' + conn.uuid,
					'greenbright'
				);
				return {
					nextHop:        nextHop,
					connectionUUID: conn.uuid,
					connectionId:   conn.id,
					method:         'routing_rule',
					flavour:        flavourFromStatus(cd.status),
					ruleMatched:    rule
				};
			}
		}
	}

	// -------------------------------------------------------------------
	// Step 3: Nodelist direct (stub — implement when ftn_nodelist exists)
	// -------------------------------------------------------------------
	// TODO: query ftn_nodelist for destination, check for CM/dialable flag
	// if found and dialable, return method: 'nodelist_direct'

	// -------------------------------------------------------------------
	// Step 4: Coordinator walk (stub — implement with nodelist)
	// -------------------------------------------------------------------
	// Walk order: point's node → node's hub → hub's region → zone coord
	// At each level: check connections first, then nodelist
	// TODO: implement when ftn_nodelist exists

	alogger.writeAlog(4,
		'ftnRouter: no route found for ' + destinationAddress +
		' (nodelist walk not yet implemented)',
		'yellow'
	);
	return null;
}

export {
	resolveRoute,
	parseFtnAddress,
	matchesRule
};
