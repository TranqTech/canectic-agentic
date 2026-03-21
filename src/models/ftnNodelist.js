// ftnNodelist.js — FTN nodelist database model.
//
// Provides table management, batch upsert import, lookup queries, and
// historical tracking for imported FTN nodelist data.
//
// All lookup functions filter active=true unless noted otherwise.
// All queries are parameterized.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Table management
// ---------------------------------------------------------------------------

async function ensureTable() {
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS ftn_nodelist (
			id              SERIAL PRIMARY KEY,
			network_id      INTEGER NOT NULL,
			zone            INTEGER NOT NULL,
			net             INTEGER NOT NULL,
			node            INTEGER NOT NULL,
			point           INTEGER NOT NULL DEFAULT 0,
			keyword         VARCHAR(10) NOT NULL DEFAULT '',
			hub_node        INTEGER,
			region          INTEGER,
			system_name     VARCHAR(255) NOT NULL DEFAULT '',
			location        VARCHAR(255) NOT NULL DEFAULT '',
			sysop_name      VARCHAR(255) NOT NULL DEFAULT '',
			phone           VARCHAR(60) NOT NULL DEFAULT '',
			baud            INTEGER NOT NULL DEFAULT 9600,
			hostname        VARCHAR(255),
			binkp_port      INTEGER,
			telnet_port     INTEGER,
			is_cm           BOOLEAN NOT NULL DEFAULT false,
			is_ip           BOOLEAN NOT NULL DEFAULT false,
			is_ibn          BOOLEAN NOT NULL DEFAULT false,
			flags           TEXT NOT NULL DEFAULT '',
			imported_at     TIMESTAMPTZ DEFAULT NOW(),
			updated_at      TIMESTAMPTZ,
			nodelist_date   VARCHAR(20),
			nodelist_number INTEGER,
			first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			removed_at      TIMESTAMPTZ,
			active          BOOLEAN NOT NULL DEFAULT true,
			UNIQUE (network_id, zone, net, node, point)
		)
	`);

	await ensureIndexes();
}

async function ensureIndexes() {
	// Unique constraint — needed for ON CONFLICT upsert. CREATE UNIQUE INDEX IF NOT EXISTS
	// is idempotent, unlike ALTER TABLE ADD CONSTRAINT.
	await postgres.write(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_ftn_nodelist_unique_addr
		ON ftn_nodelist (network_id, zone, net, node, point)
	`);
	await postgres.write(`
		CREATE INDEX IF NOT EXISTS idx_ftn_nodelist_network_zone_net
		ON ftn_nodelist (network_id, zone, net)
	`);
	await postgres.write(`
		CREATE INDEX IF NOT EXISTS idx_ftn_nodelist_network_zone_net_node
		ON ftn_nodelist (network_id, zone, net, node)
	`);
	await postgres.write(`
		CREATE INDEX IF NOT EXISTS idx_ftn_nodelist_network_active
		ON ftn_nodelist (network_id, active)
	`);
	await postgres.write(`
		CREATE INDEX IF NOT EXISTS idx_ftn_nodelist_keyword
		ON ftn_nodelist (network_id, keyword)
		WHERE keyword IN ('Zone', 'Region', 'Host', 'Hub')
	`);
}

// ---------------------------------------------------------------------------
// Import — batch upsert with historical tracking
// ---------------------------------------------------------------------------

async function importNodelist(networkId, parsedNodes, opts) {
	opts = opts || {};
	var nodelistNumber = opts.nodelistNumber || null;
	var nodelistDate   = opts.nodelistDate   || null;
	var batchSize      = opts.batchSize      || 500;

	var importTimestamp = new Date();
	var newNodes        = 0;
	var updatedNodes    = 0;

	// Process in batches
	for (var batchStart = 0; batchStart < parsedNodes.length; batchStart += batchSize) {
		var batch = parsedNodes.slice(batchStart, batchStart + batchSize);
		var result = await upsertBatch(networkId, batch, importTimestamp, nodelistNumber, nodelistDate);
		newNodes     += result.newNodes;
		updatedNodes += result.updatedNodes;
	}

	// Deactivate nodes not seen in this import
	var deactivateResult = await postgres.query(
		`UPDATE ftn_nodelist
		 SET active = false, removed_at = $2
		 WHERE network_id = $1 AND active = true AND last_seen < $2
		 RETURNING id`,
		[networkId, importTimestamp]
	);
	var deactivatedNodes = deactivateResult ? deactivateResult.length : 0;

	return { newNodes, updatedNodes, deactivatedNodes };
}

// Build and execute a multi-row upsert for one batch.
// Returns { newNodes, updatedNodes }.
async function upsertBatch(networkId, batch, importTimestamp, nodelistNumber, nodelistDate) {
	if (!batch || batch.length === 0) return { newNodes: 0, updatedNodes: 0 };

	// Each row has 21 columns (network_id + 20 from the parsed entry)
	var columnsPerRow = 21;
	var values = [];
	var placeholders = [];

	for (var i = 0; i < batch.length; i++) {
		var entry = batch[i];
		var offset = i * columnsPerRow;

		placeholders.push(
			'($' + (offset + 1)  + ',$' + (offset + 2)  + ',$' + (offset + 3)  +
			',$' + (offset + 4)  + ',$' + (offset + 5)  + ',$' + (offset + 6)  +
			',$' + (offset + 7)  + ',$' + (offset + 8)  + ',$' + (offset + 9)  +
			',$' + (offset + 10) + ',$' + (offset + 11) + ',$' + (offset + 12) +
			',$' + (offset + 13) + ',$' + (offset + 14) + ',$' + (offset + 15) +
			',$' + (offset + 16) + ',$' + (offset + 17) + ',$' + (offset + 18) +
			',$' + (offset + 19) + ',$' + (offset + 20) + ',$' + (offset + 21) + ')'
		);

		values.push(
			networkId,                         // 1: network_id
			entry.zone,                        // 2: zone
			entry.net,                         // 3: net
			entry.node,                        // 4: node
			entry.point || 0,                  // 5: point
			entry.keyword || '',               // 6: keyword
			entry.hub_node != null ? entry.hub_node : null,  // 7: hub_node
			entry.region != null ? entry.region : null,      // 8: region
			entry.system_name || '',           // 9: system_name
			entry.location || '',              // 10: location
			entry.sysop_name || '',            // 11: sysop_name
			entry.phone || '',                 // 12: phone
			entry.baud || 9600,                // 13: baud
			entry.hostname || null,            // 14: hostname
			entry.binkp_port || null,          // 15: binkp_port
			entry.telnet_port || null,         // 16: telnet_port
			entry.is_cm || false,              // 17: is_cm
			entry.is_ip || false,              // 18: is_ip
			entry.is_ibn || false,             // 19: is_ibn
			JSON.stringify(entry.connection_types || []),  // 20: connection_types
			entry.flags || ''                  // 21: flags
		);
	}

	// The upsert returns xmax = 0 for inserts, > 0 for updates
	var sql = `
		INSERT INTO ftn_nodelist (
			network_id, zone, net, node, point,
			keyword, hub_node, region,
			system_name, location, sysop_name, phone, baud,
			hostname, binkp_port, telnet_port,
			is_cm, is_ip, is_ibn, connection_types, flags
		) VALUES ${placeholders.join(', ')}
		ON CONFLICT (network_id, zone, net, node, point) DO UPDATE SET
			keyword      = EXCLUDED.keyword,
			hub_node     = EXCLUDED.hub_node,
			region       = EXCLUDED.region,
			system_name  = EXCLUDED.system_name,
			location     = EXCLUDED.location,
			sysop_name   = EXCLUDED.sysop_name,
			phone        = EXCLUDED.phone,
			baud         = EXCLUDED.baud,
			hostname     = EXCLUDED.hostname,
			binkp_port   = EXCLUDED.binkp_port,
			telnet_port  = EXCLUDED.telnet_port,
			is_cm        = EXCLUDED.is_cm,
			is_ip        = EXCLUDED.is_ip,
			is_ibn           = EXCLUDED.is_ibn,
			connection_types = EXCLUDED.connection_types,
			flags            = EXCLUDED.flags,
			last_seen    = $${values.length + 1},
			updated_at   = $${values.length + 1},
			active       = true,
			removed_at   = NULL,
			nodelist_number = $${values.length + 2},
			nodelist_date   = $${values.length + 3}
		RETURNING id, (xmax = 0) AS is_new
	`;

	values.push(importTimestamp, nodelistNumber, nodelistDate);

	var rows = await postgres.query(sql, values);

	var newNodes = 0;
	var updatedNodes = 0;
	if (rows) {
		for (var j = 0; j < rows.length; j++) {
			if (rows[j].is_new) {
				newNodes++;
			} else {
				updatedNodes++;
			}
		}
	}

	return { newNodes, updatedNodes };
}

// ---------------------------------------------------------------------------
// Lookups (active nodes only unless noted)
// ---------------------------------------------------------------------------

async function getNode(networkId, zone, net, node, point) {
	point = point || 0;
	return postgres.queryOne(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND zone = $2 AND net = $3 AND node = $4 AND point = $5 AND active = true`,
		[networkId, zone, net, node, point]
	);
}

async function getNetHost(networkId, zone, net) {
	return postgres.queryOne(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND zone = $2 AND net = $3 AND keyword = 'Host' AND active = true`,
		[networkId, zone, net]
	);
}

async function getNodeHub(networkId, zone, net, hubNode) {
	return postgres.queryOne(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND zone = $2 AND net = $3 AND node = $4 AND keyword = 'Hub' AND active = true`,
		[networkId, zone, net, hubNode]
	);
}

async function getRegionCoord(networkId, zone, region) {
	return postgres.queryOne(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND zone = $2 AND net = $3 AND keyword = 'Region' AND active = true`,
		[networkId, zone, region]
	);
}

async function getZoneCoord(networkId, zone) {
	return postgres.queryOne(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND zone = $2 AND keyword = 'Zone' AND active = true`,
		[networkId, zone]
	);
}

async function findConnectable(networkId, zone, net, node) {
	return postgres.queryOne(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND zone = $2 AND net = $3 AND node = $4
		   AND active = true AND is_ibn = true AND hostname IS NOT NULL
		   AND keyword NOT IN ('Down', 'Hold', 'Pvt')`,
		[networkId, zone, net, node]
	);
}

async function getNodesInNet(networkId, zone, net) {
	return postgres.query(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND zone = $2 AND net = $3 AND active = true
		 ORDER BY node`,
		[networkId, zone, net]
	);
}

async function searchNodes(networkId, searchTerm, limit) {
	limit = limit || 50;
	var pattern = '%' + searchTerm + '%';
	return postgres.query(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND active = true
		   AND (
		     system_name ILIKE $2
		     OR sysop_name ILIKE $2
		     OR CONCAT(zone, ':', net, '/', node) ILIKE $2
		   )
		 ORDER BY zone, net, node
		 LIMIT $3`,
		[networkId, pattern, limit]
	);
}

// ---------------------------------------------------------------------------
// Historical queries
// ---------------------------------------------------------------------------

async function getRecentlyAdded(networkId, days) {
	days = days || 7;
	return postgres.query(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND active = true
		   AND first_seen > NOW() - MAKE_INTERVAL(days => $2)
		 ORDER BY first_seen DESC`,
		[networkId, days]
	);
}

async function getRecentlyRemoved(networkId, days) {
	days = days || 7;
	return postgres.query(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND active = false
		   AND removed_at > NOW() - MAKE_INTERVAL(days => $2)
		 ORDER BY removed_at DESC`,
		[networkId, days]
	);
}

async function getNetworkStats(networkId) {
	var row = await postgres.queryOne(
		`SELECT
			COUNT(*) FILTER (WHERE active = true) AS total_active,
			COUNT(*) FILTER (WHERE active = false) AS total_inactive,
			COUNT(*) FILTER (WHERE active = true AND first_seen > NOW() - INTERVAL '7 days') AS added_this_week,
			COUNT(*) FILTER (WHERE active = false AND removed_at > NOW() - INTERVAL '7 days') AS removed_this_week
		 FROM ftn_nodelist
		 WHERE network_id = $1`,
		[networkId]
	);

	return {
		totalActive:     parseInt(row?.total_active || 0),
		totalInactive:   parseInt(row?.total_inactive || 0),
		addedThisWeek:   parseInt(row?.added_this_week || 0),
		removedThisWeek: parseInt(row?.removed_this_week || 0)
	};
}

async function getNodeHistory(networkId, zone, net, node) {
	return postgres.queryOne(
		`SELECT * FROM ftn_nodelist
		 WHERE network_id = $1 AND zone = $2 AND net = $3 AND node = $4 AND point = 0`,
		[networkId, zone, net, node]
	);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

async function getImportInfo(networkId) {
	return postgres.queryOne(
		`SELECT MAX(last_seen) AS last_import, MAX(nodelist_number) AS nodelist_number,
		        COUNT(*) FILTER (WHERE active = true) AS entry_count
		 FROM ftn_nodelist
		 WHERE network_id = $1`,
		[networkId]
	);
}

async function clearNetwork(networkId) {
	return postgres.write(
		`DELETE FROM ftn_nodelist WHERE network_id = $1`,
		[networkId]
	);
}

export {
	ensureTable,
	ensureIndexes,
	importNodelist,
	getNode,
	getNetHost,
	getNodeHub,
	getRegionCoord,
	getZoneCoord,
	findConnectable,
	getNodesInNet,
	searchNodes,
	getRecentlyAdded,
	getRecentlyRemoved,
	getNetworkStats,
	getNodeHistory,
	getImportInfo,
	clearNetwork
};
