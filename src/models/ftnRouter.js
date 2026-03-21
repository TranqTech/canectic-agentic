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
import * as ftnNodelist from './ftnNodelist.js';
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
// nodelistRouteResult — build a routeResult from a nodelist entry
// ---------------------------------------------------------------------------
function nodelistRouteResult(entry, method, nextHopAddress) {
	return {
		nextHop:        nextHopAddress,
		connectionUUID: null,
		connectionId:   null,
		method:         method,
		flavour:        'Normal',
		ruleMatched:    null,
		nodelistData: {
			hostname:   entry.hostname,
			binkpPort:  entry.binkp_port,
			systemName: entry.system_name,
			isCM:       entry.is_cm
		}
	};
}

// ---------------------------------------------------------------------------
// isNodelistConnectable — check if a nodelist entry is dialable via binkp
// ---------------------------------------------------------------------------
function isNodelistConnectable(entry) {
	if (!entry) return false;
	if (!entry.is_ibn || !entry.hostname) return false;
	if (entry.keyword === 'Down' || entry.keyword === 'Hold' || entry.keyword === 'Pvt') return false;
	return true;
}

// ---------------------------------------------------------------------------
// inferNetworkId — determine the network_id for a zone from connections
// ---------------------------------------------------------------------------
function inferNetworkId(connlist, zone) {
	for (var conn of connlist) {
		var cd = conn.connection_data || {};
		if (cd.address) {
			var connParsed = parseFtnAddress(cd.address);
			if (connParsed && connParsed.zone === zone) {
				return conn.network_id;
			}
		}
	}
	// Fallback: return the first FTN connection's network_id
	if (connlist.length > 0) return connlist[0].network_id;
	return null;
}

// ---------------------------------------------------------------------------
// checkConnectionForAddress — check if any configured connection matches addr
// ---------------------------------------------------------------------------
function checkConnectionForAddress(connlist, zone, net, node) {
	var addr = zone + ':' + net + '/' + node;
	for (var conn of connlist) {
		var cd = conn.connection_data || {};
		if (cd.address && cd.address.trim() === addr) {
			return {
				nextHop:        addr,
				connectionUUID: conn.uuid,
				connectionId:   conn.id,
				method:         'coordinator',
				flavour:        flavourFromStatus(cd.status),
				ruleMatched:    null
			};
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// resolveRoute(destinationAddress, networkId)
//
// Main entry point. Returns routeResult or null.
// Optional networkId parameter for explicit network context.
// ---------------------------------------------------------------------------
async function resolveRoute(destinationAddress, networkId) {
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
	// Resolve network_id for nodelist lookups (steps 3 and 4)
	// -------------------------------------------------------------------
	var resolvedNetworkId = networkId || inferNetworkId(connlist, zone);
	if (!resolvedNetworkId) {
		alogger.writeAlog(4, 'ftnRouter: no route found for ' + destinationAddress + ' (no network_id for nodelist)', 'yellow');
		return null;
	}

	// -------------------------------------------------------------------
	// Step 3: Nodelist direct — destination found in nodelist and dialable
	// -------------------------------------------------------------------
	try {
		var directEntry = await ftnNodelist.findConnectable(resolvedNetworkId, zone, net, node);
		if (directEntry && isNodelistConnectable(directEntry)) {
			alogger.writeAlog(5,
				'ftnRouter: nodelist direct route to ' + destinationAddress +
				' via ' + directEntry.hostname + ':' + directEntry.binkp_port,
				'greenbright'
			);
			return nodelistRouteResult(directEntry, 'nodelist_direct', destinationAddress);
		}
	} catch (err) {
		alogger.writeAlog(3, 'ftnRouter: nodelist lookup error: ' + err.message, 'yellow');
	}

	// -------------------------------------------------------------------
	// Step 4: Coordinator walk — hub → host → region → zone
	// At each level, check connections first, then nodelist dialability.
	// -------------------------------------------------------------------
	try {
		// 4a: Check if node has a hub — try routing through the hub
		var destNode = await ftnNodelist.getNode(resolvedNetworkId, zone, net, node, 0);
		if (destNode && destNode.hub_node != null) {
			// Check connections for hub
			var hubConnResult = checkConnectionForAddress(connlist, zone, net, destNode.hub_node);
			if (hubConnResult) {
				alogger.writeAlog(5, 'ftnRouter: coordinator route via hub connection ' + zone + ':' + net + '/' + destNode.hub_node, 'greenbright');
				return hubConnResult;
			}
			// Check nodelist for hub
			var hubEntry = await ftnNodelist.findConnectable(resolvedNetworkId, zone, net, destNode.hub_node);
			if (hubEntry && isNodelistConnectable(hubEntry)) {
				var hubAddr = zone + ':' + net + '/' + destNode.hub_node;
				alogger.writeAlog(5, 'ftnRouter: coordinator route via hub ' + hubAddr, 'greenbright');
				return nodelistRouteResult(hubEntry, 'coordinator', hubAddr);
			}
		}

		// 4b: Net host (keyword='Host' for this net)
		var hostEntry = await ftnNodelist.getNetHost(resolvedNetworkId, zone, net);
		if (hostEntry) {
			// Check connections for host
			var hostConnResult = checkConnectionForAddress(connlist, zone, net, 0);
			if (hostConnResult) {
				alogger.writeAlog(5, 'ftnRouter: coordinator route via host connection ' + zone + ':' + net + '/0', 'greenbright');
				return hostConnResult;
			}
			// Check nodelist for host — host is at node 0 but look for connectable entry
			var hostConnectable = await ftnNodelist.findConnectable(resolvedNetworkId, zone, net, 0);
			if (hostConnectable && isNodelistConnectable(hostConnectable)) {
				var hostAddr = zone + ':' + net + '/0';
				alogger.writeAlog(5, 'ftnRouter: coordinator route via host ' + hostAddr, 'greenbright');
				return nodelistRouteResult(hostConnectable, 'coordinator', hostAddr);
			}
		}

		// 4c: Region coordinator
		if (destNode && destNode.region) {
			var regionEntry = await ftnNodelist.getRegionCoord(resolvedNetworkId, zone, destNode.region);
			if (regionEntry) {
				// Check connections for region coord
				var regionConnResult = checkConnectionForAddress(connlist, zone, destNode.region, 0);
				if (regionConnResult) {
					alogger.writeAlog(5, 'ftnRouter: coordinator route via region connection ' + zone + ':' + destNode.region + '/0', 'greenbright');
					return regionConnResult;
				}
				// Check nodelist for region coord
				var regionConnectable = await ftnNodelist.findConnectable(resolvedNetworkId, zone, destNode.region, 0);
				if (regionConnectable && isNodelistConnectable(regionConnectable)) {
					var regionAddr = zone + ':' + destNode.region + '/0';
					alogger.writeAlog(5, 'ftnRouter: coordinator route via region ' + regionAddr, 'greenbright');
					return nodelistRouteResult(regionConnectable, 'coordinator', regionAddr);
				}
			}
		}

		// 4d: Zone coordinator
		var zoneEntry = await ftnNodelist.getZoneCoord(resolvedNetworkId, zone);
		if (zoneEntry) {
			// Check connections for zone coord
			var zoneConnResult = checkConnectionForAddress(connlist, zone, zone, 0);
			if (zoneConnResult) {
				alogger.writeAlog(5, 'ftnRouter: coordinator route via zone connection ' + zone + ':' + zone + '/0', 'greenbright');
				return zoneConnResult;
			}
			// Check nodelist for zone coord
			var zoneConnectable = await ftnNodelist.findConnectable(resolvedNetworkId, zone, zone, 0);
			if (zoneConnectable && isNodelistConnectable(zoneConnectable)) {
				var zoneAddr = zone + ':' + zone + '/0';
				alogger.writeAlog(5, 'ftnRouter: coordinator route via zone ' + zoneAddr, 'greenbright');
				return nodelistRouteResult(zoneConnectable, 'coordinator', zoneAddr);
			}
		}
	} catch (err) {
		alogger.writeAlog(3, 'ftnRouter: coordinator walk error: ' + err.message, 'yellow');
	}

	alogger.writeAlog(4,
		'ftnRouter: no route found for ' + destinationAddress,
		'yellow'
	);
	return null;
}

export {
	resolveRoute,
	parseFtnAddress,
	matchesRule
};
