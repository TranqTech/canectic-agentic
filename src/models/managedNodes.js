// managedNodes.js — Managed nodes for network coordinator segments.
//
// Nodes in the coordinator's segment, edited directly by the sysop.
// Independent of the imported ftn_nodelist table. Used to generate
// nodelist stubs/segments in standard FTN format.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// Standard FTN nodelist keywords
var VALID_KEYWORDS = ['', 'Hub', 'Host', 'Region', 'Zone', 'Pvt', 'Hold', 'Down'];

// Common FTN flags for the admin UI
var COMMON_FLAGS = [
	'CM',       // Continuous Mail (always available)
	'MO',       // Modem Only (no internet)
	'LO',       // Listed Only
	'MN',       // Mailer Not Running
	'IBN',      // Binkp capable
	'ITN',      // Telnet capable
	'IFC',      // IFCico capable
	'IP',       // Has IP connectivity
	'PING',     // Responds to ICMP ping
	'IPv6',     // Has IPv6 connectivity
];

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

var NODE_ORDER = `CASE keyword WHEN 'Zone' THEN 0 WHEN 'Region' THEN 1 WHEN 'Host' THEN 2 WHEN 'Hub' THEN 3 ELSE 4 END, hub_node ASC, node ASC`;

async function getByNetwork(networkId) {
	return await postgres.query(
		'SELECT * FROM managed_nodes WHERE network_id = $1 ORDER BY ' + NODE_ORDER,
		[parseInt(networkId)]
	) || [];
}

async function getBySegment(segmentId) {
	return await postgres.query(
		'SELECT * FROM managed_nodes WHERE segment_id = $1 ORDER BY ' + NODE_ORDER,
		[parseInt(segmentId)]
	) || [];
}

async function getActiveByNetwork(networkId) {
	return await postgres.query(
		'SELECT * FROM managed_nodes WHERE network_id = $1 AND active = true ORDER BY ' + NODE_ORDER,
		[parseInt(networkId)]
	) || [];
}

async function getActiveBySegment(segmentId) {
	return await postgres.query(
		'SELECT * FROM managed_nodes WHERE segment_id = $1 AND active = true ORDER BY ' + NODE_ORDER,
		[parseInt(segmentId)]
	) || [];
}

async function getById(id) {
	return await postgres.queryOne('SELECT * FROM managed_nodes WHERE id = $1', [parseInt(id)]);
}

async function create(formObj) {
	var returnObj = { status: false, errormessages: [], insertId: 0 };

	if (!formObj.network_id) returnObj.errormessages.push('Network is required');
	if (formObj.node === undefined || formObj.node === '') returnObj.errormessages.push('Node number is required');
	if (formObj.net === undefined || formObj.net === '') returnObj.errormessages.push('Net number is required');
	if (returnObj.errormessages.length > 0) return returnObj;

	var keyword = (formObj.keyword || '').trim();
	if (keyword && !VALID_KEYWORDS.includes(keyword)) {
		returnObj.errormessages.push('Invalid keyword: ' + keyword);
		return returnObj;
	}

	var flags = formObj.flags;
	if (typeof flags === 'string') {
		try { flags = JSON.parse(flags); } catch (_) {
			flags = flags.split(',').map(function(f) { return f.trim(); }).filter(Boolean);
		}
	}
	if (!Array.isArray(flags)) flags = [];

	// Build INA/IBN/ITN flags from hostname/port if not already present
	var hostname = (formObj.hostname || '').trim();
	var binkpPort = formObj.binkp_port ? parseInt(formObj.binkp_port) : null;
	var telnetPort = formObj.telnet_port ? parseInt(formObj.telnet_port) : null;

	var dbObj = {
		network_id:  parseInt(formObj.network_id),
		segment_id:  formObj.segment_id ? parseInt(formObj.segment_id) : null,
		zone:        parseInt(formObj.zone) || 1,
		region:      parseInt(formObj.region) || 0,
		net:         parseInt(formObj.net),
		node:        parseInt(formObj.node),
		keyword:     keyword,
		hub_node:    parseInt(formObj.hub_node) || 0,
		system_name: (formObj.system_name || '').trim(),
		location:    (formObj.location || '').trim(),
		sysop_name:  (formObj.sysop_name || '').trim(),
		phone:       (formObj.phone || '-Unpublished-').trim(),
		baud:        parseInt(formObj.baud) || 300,
		hostname:    hostname || null,
		binkp_port:  binkpPort,
		telnet_port: telnetPort,
		flags:       JSON.stringify(flags),
		notes:       (formObj.notes || '').trim() || null,
		active:      formObj.active !== 'false' && formObj.active !== false,
		joined_at:   new Date(),
		updated_at:  null
	};

	var dbres = await postgres.insertObject(dbObj, 'managed_nodes');
	if (!dbres.status || !dbres.insertId) {
		returnObj.errormessages = returnObj.errormessages.concat(dbres.errormessages);
		return returnObj;
	}

	returnObj.status = true;
	returnObj.insertId = dbres.insertId;
	alogger.writeAlog(5, 'Managed node created: ' + formObj.zone + ':' + formObj.net + '/' + formObj.node, 'greenbright');
	return returnObj;
}

async function update(id, formObj) {
	var returnObj = { status: false, errormessages: [] };
	var existing = await getById(id);
	if (!existing) { returnObj.errormessages.push('Node not found'); return returnObj; }

	var updateObj = { updated_at: new Date() };

	if (formObj.segment_id !== undefined) updateObj.segment_id = formObj.segment_id ? parseInt(formObj.segment_id) : null;
	if (formObj.zone !== undefined) updateObj.zone = parseInt(formObj.zone);
	if (formObj.region !== undefined) updateObj.region = parseInt(formObj.region) || 0;
	if (formObj.net !== undefined) updateObj.net = parseInt(formObj.net);
	if (formObj.node !== undefined) updateObj.node = parseInt(formObj.node);
	if (formObj.keyword !== undefined) {
		var kw = (formObj.keyword || '').trim();
		if (kw && !VALID_KEYWORDS.includes(kw)) { returnObj.errormessages.push('Invalid keyword'); return returnObj; }
		updateObj.keyword = kw;
	}
	if (formObj.hub_node !== undefined) updateObj.hub_node = parseInt(formObj.hub_node) || 0;
	if (formObj.system_name !== undefined) updateObj.system_name = formObj.system_name.trim();
	if (formObj.location !== undefined) updateObj.location = formObj.location.trim();
	if (formObj.sysop_name !== undefined) updateObj.sysop_name = formObj.sysop_name.trim();
	if (formObj.phone !== undefined) updateObj.phone = formObj.phone.trim() || '-Unpublished-';
	if (formObj.baud !== undefined) updateObj.baud = parseInt(formObj.baud) || 300;
	if (formObj.hostname !== undefined) updateObj.hostname = formObj.hostname.trim() || null;
	if (formObj.binkp_port !== undefined) updateObj.binkp_port = formObj.binkp_port ? parseInt(formObj.binkp_port) : null;
	if (formObj.telnet_port !== undefined) updateObj.telnet_port = formObj.telnet_port ? parseInt(formObj.telnet_port) : null;
	if (formObj.active !== undefined) updateObj.active = formObj.active !== 'false' && formObj.active !== false;
	if (formObj.notes !== undefined) updateObj.notes = formObj.notes.trim() || null;

	if (formObj.flags !== undefined) {
		var flags = formObj.flags;
		if (typeof flags === 'string') {
			try { flags = JSON.parse(flags); } catch (_) {
				flags = flags.split(',').map(function(f) { return f.trim(); }).filter(Boolean);
			}
		}
		if (Array.isArray(flags)) updateObj.flags = JSON.stringify(flags);
	}

	var count = await postgres.updateById(parseInt(id), updateObj, 'managed_nodes');
	if (count === 0) { returnObj.errormessages.push('No rows updated'); return returnObj; }

	returnObj.status = true;
	alogger.writeAlog(5, 'Managed node updated: id=' + id, 'greenbright');
	return returnObj;
}

async function remove(id) {
	var returnObj = { status: false, errormessages: [] };
	var err = await postgres.write('DELETE FROM managed_nodes WHERE id = $1', [parseInt(id)]);
	if (err) { returnObj.errormessages.push('Delete failed: ' + err.message); return returnObj; }
	returnObj.status = true;
	return returnObj;
}

// ---------------------------------------------------------------------------
// Stub generation
// ---------------------------------------------------------------------------

/**
 * Generate a nodelist segment/stub in standard FTN format.
 * Returns the segment as a string.
 */
async function generateStub(networkId, segmentId) {
	var nodes = segmentId ? await getActiveBySegment(segmentId) : await getActiveByNetwork(networkId);
	if (!nodes || nodes.length === 0) return '';

	var lines = [];
	var now = new Date();
	var dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
	var dayStr = String(dayOfYear).padStart(3, '0');
	var dateStr = now.toDateString();

	lines.push('; Segment generated by Canectic BBS');
	lines.push('; Day ' + dayStr + ', ' + dateStr);
	lines.push(';');

	for (var node of nodes) {
		var parts = [];

		// Keyword (empty for normal nodes)
		parts.push(node.keyword || '');

		// Node number
		parts.push(String(node.node));

		// System name (underscores for spaces)
		parts.push((node.system_name || 'Unknown').replace(/ /g, '_'));

		// Location
		parts.push((node.location || 'Unknown').replace(/ /g, '_'));

		// Sysop name
		parts.push((node.sysop_name || 'Unknown').replace(/ /g, '_'));

		// Phone
		parts.push(node.phone || '-Unpublished-');

		// Baud
		parts.push(String(node.baud || 300));

		// Flags
		var flags = node.flags;
		if (typeof flags === 'string') { try { flags = JSON.parse(flags); } catch (_) { flags = []; } }
		if (!Array.isArray(flags)) flags = [];

		// Auto-generate INA/IBN/ITN from hostname/port if not in flags
		if (node.hostname) {
			var hasINA = flags.some(function(f) { return f.startsWith('INA:'); });
			if (!hasINA) flags.push('INA:' + node.hostname);

			if (node.binkp_port) {
				var hasIBN = flags.includes('IBN');
				if (!hasIBN) flags.push('IBN');
				if (node.binkp_port !== 24554) {
					var hasIBNPort = flags.some(function(f) { return f.startsWith('IBN:'); });
					if (!hasIBNPort) {
						// Replace IBN with IBN:port
						flags = flags.map(function(f) { return f === 'IBN' ? 'IBN:' + node.binkp_port : f; });
					}
				}
			}

			if (node.telnet_port) {
				var hasITN = flags.includes('ITN');
				if (!hasITN) flags.push('ITN');
			}
		}

		if (flags.length > 0) {
			parts.push(flags.join(','));
		}

		lines.push(parts.join(','));
	}

	return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function getStats(networkId, segmentId) {
	var where = segmentId ? 'segment_id = $1' : 'network_id = $1';
	var param = segmentId ? parseInt(segmentId) : parseInt(networkId);
	var row = await postgres.queryOne(
		`SELECT COUNT(*) AS total,
		        COUNT(*) FILTER (WHERE active = true) AS active_count,
		        COUNT(*) FILTER (WHERE keyword = 'Hub') AS hub_count,
		        COUNT(*) FILTER (WHERE keyword = 'Down') AS down_count,
		        COUNT(*) FILTER (WHERE keyword = 'Hold') AS hold_count
		 FROM managed_nodes WHERE ${where}`,
		[param]
	);
	return row || { total: 0, active_count: 0, hub_count: 0, down_count: 0, hold_count: 0 };
}

export {
	VALID_KEYWORDS,
	COMMON_FLAGS,
	getByNetwork,
	getBySegment,
	getActiveByNetwork,
	getActiveBySegment,
	getById,
	create,
	update,
	remove,
	generateStub,
	getStats
};
