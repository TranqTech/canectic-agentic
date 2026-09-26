// src/utils/qwkId.js: what a QWK ID may be, and when two of them clash (#67).
//
// Nothing validated a QWK ID before this: any string was accepted as a
// connection's Remote QWK ID or as our own address on a QWK network, and two
// connections could share one. The rules follow Synchronet, since most QWK
// peers are Synchronet boards and a stricter rule could refuse a real hub.
//
//   Characters: Synchronet's scfg code_ok(): not empty, and none of
//   ` \/|<>*?+[]:=";,`. Stored upper case. Printable ASCII only, since the ID
//   goes into fixed-width packet fields and file names.
//
//   Length: 8 (Synchronet LEN_QWKID). A network may allow up to 32 with its
//   "allow QWK IDs longer than 8 characters" setting (config.qwk_long_ids),
//   which says only that the network allows them, nothing about its members.
//
//   Warnings, not refusals: an ID starting with a digit, or containing '.' or
//   '@', cannot be addressed by netmail. Synchronet reads user@1... as a
//   FidoNet address and an ID with '.' as an internet one (netmail.cpp
//   qwktonetmail), and '@' splits user@ID in the wrong place.
//
//   Unique per role: at most one connection where an ID is our hub and at most
//   one where it is our node. Synchronet keeps hubs and nodes in separate
//   namespaces too, and a hub builds a single packet per node, so two
//   connections to one hub ID would fight over it.
//
// Pure: no imports, so it is safe anywhere, the installer's graph included.

var QWK_ID_MAX = 8;
var QWK_ID_LONG_MAX = 32;
var ILLEGAL_CHARS = ' \\/|<>*?+[]:=";,';

function normaliseQwkId(value) {
	return String(value === undefined || value === null ? '' : value).trim().toUpperCase();
}

function longIdsAllowed(network) {
	var cfg = network && network.config;
	if (typeof cfg === 'string') {
		try { cfg = JSON.parse(cfg); } catch (_) { cfg = null; }
	}
	return !!cfg && cfg.qwk_long_ids === true;
}

/**
 * @param {string} value
 * @param {{allowLong?: boolean}} [opts]
 * @returns {{id: string, errors: string[], warnings: string[]}}
 */
function checkQwkId(value, opts) {
	var id = normaliseQwkId(value);
	var max = opts && opts.allowLong ? QWK_ID_LONG_MAX : QWK_ID_MAX;
	var out = { id: id, errors: [], warnings: [] };

	if (!id) {
		out.errors.push('A QWK ID is required');
		return out;
	}
	var bad = [];
	for (var ch of id) {
		var code = ch.charCodeAt(0);
		// Synchronet's list first: a space is below 0x21 too, and must be named.
		if (ILLEGAL_CHARS.indexOf(ch) !== -1) {
			if (bad.indexOf(ch) === -1) bad.push(ch);
		} else if (code < 0x21 || code > 0x7e) {
			if (bad.indexOf('non-printable or non-ASCII characters') === -1) bad.push('non-printable or non-ASCII characters');
		}
	}
	if (bad.length > 0) {
		out.errors.push('QWK ID "' + id + '" may not contain ' + bad.map(function (b) {
			return b.length === 1 ? "'" + b + "'" : b;
		}).join(', '));
	}
	if (id.length > max) {
		out.errors.push('QWK ID "' + id + '" is ' + id.length + ' characters; the limit is ' + max +
			(max === QWK_ID_MAX ? ' unless the network allows longer QWK IDs' : ''));
	}
	if (/^[0-9]/.test(id)) {
		out.warnings.push('QWK ID "' + id + '" starts with a digit, so netmail cannot be addressed to it ' +
			'(Synchronet reads it as a FidoNet address)');
	}
	if (/[.@]/.test(id)) {
		out.warnings.push('QWK ID "' + id + '" contains \'.\' or \'@\', so netmail cannot be addressed to it');
	}
	return out;
}

/**
 * The role the REMOTE system plays for us: 'node' on a hub-transport
 * connection (it calls us), 'hub' on any other (we call it).
 */
function remoteRole(connectionData) {
	return (connectionData || {}).transport === 'hub' ? 'node' : 'hub';
}

/**
 * The connection that already uses this ID in this role, or null. Pure.
 * `connections` are rows with uuid and connection_data, inactive included,
 * since an inactive connection still owns its directory and can be turned
 * back on.
 */
function findIdClash(candidate, connections) {
	var id = normaliseQwkId(candidate.id);
	if (!id) return null;
	for (var c of connections || []) {
		if (candidate.uuid && c.uuid === candidate.uuid) continue;
		var cd = c.connection_data || {};
		if (normaliseQwkId(cd.remote_qwk_id) !== id) continue;
		if (remoteRole(cd) !== candidate.role) continue;
		return c;
	}
	return null;
}

/**
 * Every problem among existing QWK connections and addresses, for the
 * startup audit. Pure. `networks` maps network id to its row.
 * @returns {string[]} one line per problem
 */
function auditQwkIds(connections, addresses, networks) {
	var lines = [];
	var seen = new Map();
	var sorted = (connections || []).slice().sort(function (a, b) { return Number(a.id) - Number(b.id); });
	for (var c of sorted) {
		var cd = c.connection_data || {};
		var net = networks.get(String(c.network_id));
		var label = (c.peer_name || 'peer') + ' on ' + (net ? net.name : 'network ' + c.network_id);
		var check = checkQwkId(cd.remote_qwk_id, { allowLong: longIdsAllowed(net) });
		for (var e of check.errors) lines.push(label + ': ' + e);
		if (!check.id) continue;
		var key = check.id + '|' + remoteRole(cd);
		var first = seen.get(key);
		if (first) {
			lines.push(label + ': QWK ID ' + check.id + ' is also used by ' + first +
				' in the same role (' + (remoteRole(cd) === 'hub' ? 'our hub' : 'our node') + ')');
		} else {
			seen.set(key, label);
		}
	}
	for (var a of addresses || []) {
		var anet = networks.get(String(a.network_id));
		var acheck = checkQwkId(a.address, { allowLong: longIdsAllowed(anet) });
		for (var ae of acheck.errors) lines.push('Our address on ' + (anet ? anet.name : 'network ' + a.network_id) + ': ' + ae);
	}
	return lines;
}

export {
	QWK_ID_MAX,
	QWK_ID_LONG_MAX,
	ILLEGAL_CHARS,
	normaliseQwkId,
	longIdsAllowed,
	checkQwkId,
	remoteRole,
	findIdClash,
	auditQwkIds
};
