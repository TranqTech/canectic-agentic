// src/utils/qwkVia.js: QWK sender paths, where a message may be sent next, and
// netmail addresses (#70). Pure.
//
// A QWKnet message records how it reached us as a path of QWK IDs, the way
// Synchronet stores it (qwktomsg.cpp, SENDERNETADDR): the system that handed
// it to us, then the @VIA path that system sent with it. "HUB/A/B" means HUB
// passed it to us, A passed it to HUB, and B wrote it; the ORIGIN is the LAST
// element. Stored in the message's `path` column.
//
// That path is what a hub needs to pass mail on. Both QWK exporters used to
// skip every message that arrived on the same network (source_network_id),
// so a Canectic hub never passed one node's messages to its other nodes, and
// a board that was a node upstream and a hub downstream never passed its own
// nodes' messages up. FTN had the same rule and the same result until
// 940b1be. Now a message goes to every system on the network except the ones
// already in its path.
//
// On the way out it carries `@VIA: <path>` (Synchronet msgtoqwk QM_VIA), so
// the next system learns where it came from and can route netmail replies.

var VIA_SPLIT = /[\/\s]+/;

function parseViaPath(value) {
	if (value === undefined || value === null) return [];
	return String(value).split(VIA_SPLIT).map(function (p) { return p.trim().toUpperCase(); }).filter(Boolean);
}

/** The stored path for a message `peerId` handed us with `via` (its @VIA). */
function senderPath(peerId, via) {
	var parts = [String(peerId || '').trim().toUpperCase()].filter(Boolean).concat(parseViaPath(via));
	return parts.join('/');
}

/** The system that wrote a message: the last element of its path, or ''. */
function originOf(path) {
	var parts = parseViaPath(path);
	return parts.length ? parts[parts.length - 1] : '';
}

/** Has a message already been through `qwkId`? (Synchronet route_circ) */
function pathContains(path, qwkId) {
	var id = String(qwkId || '').trim().toUpperCase();
	return !!id && parseViaPath(path).indexOf(id) !== -1;
}

/**
 * May this stored message go to the connection whose remote QWK ID is
 * `remoteId`, on network `networkId`?
 *   - From another network, or written here: yes, as before.
 *   - From this network with a path: yes, unless `remoteId` is in the path
 *     (it came from there, or already passed through there).
 *   - From this network with no path: no. Only rows imported before paths
 *     were recorded look like this, and the source cannot be told apart from
 *     the destination, so the old network-wide rule stays for them.
 * @returns {{send: boolean, via: string|null}} `via` is the @VIA to write
 */
function exportDecision(msg, networkId, remoteId) {
	var fromHere = msg && msg.source_network_id !== undefined && msg.source_network_id !== null &&
		Number(msg.source_network_id) === Number(networkId);
	if (!fromHere) return { send: true, via: null };
	var path = parseViaPath(msg.path).join('/');
	if (!path) return { send: false, via: null };
	if (pathContains(path, remoteId)) return { send: false, via: null };
	return { send: true, via: path };
}

/** A message body with its @VIA line first, where kludge lines belong. */
function withVia(bodyText, via) {
	if (!via) return bodyText || '';
	return '@VIA: ' + via + '\r' + (bodyText || '');
}

/**
 * The address of a conference-0 message written the netmail ways Synchronet
 * writes them (netmail.cpp qwktonetmail):
 *   To = "NETMAIL", with `user@address` as the first body line
 *   To = `user@address` (from the header, or HEADERS.DAT when longer)
 * Anything else is plain local mail and returns null.
 *
 * `kind` follows Synchronet: after the last '@', not starting with a digit and
 * with no '.' or ':' is QWKnet; starting with a digit is FidoNet; anything
 * else internet. For QWKnet, `path` is the hop list and `destination` its
 * last element.
 * @returns {null|{user: string, address: string, kind: string, path: string[],
 *   destination: string, firstLineUsed: boolean}}
 */
function parseNetmailAddress(to, bodyText) {
	var toField = String(to || '').trim();
	var raw = null, firstLineUsed = false;
	if (toField.toUpperCase() === 'NETMAIL') {
		var body = String(bodyText || '');
		var nl = body.search(/\r\n|\r|\n/);
		raw = (nl === -1 ? body : body.slice(0, nl)).trim();
		firstLineUsed = true;
	} else if (toField.indexOf('@') !== -1) {
		raw = toField;
	} else {
		return null;
	}
	var at = raw.lastIndexOf('@');
	if (at <= 0 || at === raw.length - 1) {
		return { user: raw, address: '', kind: 'invalid', path: [], destination: '', firstLineUsed: firstLineUsed };
	}
	var user = raw.slice(0, at).trim();
	var address = raw.slice(at + 1).trim();
	var kind = /^[0-9]/.test(address) ? 'fido' : (/[.:]/.test(address) ? 'internet' : 'qwk');
	var path = kind === 'qwk' ? parseViaPath(address) : [];
	return {
		user: user,
		address: address,
		kind: kind,
		path: path,
		destination: path.length ? path[path.length - 1] : '',
		firstLineUsed: firstLineUsed
	};
}

/** The body with the `user@address` line removed, for To = "NETMAIL". */
function stripFirstLine(bodyText) {
	var body = String(bodyText || '');
	var m = body.match(/\r\n|\r|\n/);
	return m ? body.slice(m.index + m[0].length) : '';
}

/**
 * What a sender path teaches about reaching the systems in it (Synchronet
 * update_qwkroute): for each system after the one that handed it to us, the
 * path up to and including it. The first system is a direct connection, so
 * it needs no route. Pure.
 * @returns {{id: string, path: string}[]}
 */
function routesFromSenderPath(path) {
	var parts = parseViaPath(path);
	var out = [];
	for (var i = 1; i < parts.length; i++) out.push({ id: parts[i], path: parts.slice(0, i + 1).join('/') });
	return out;
}

/**
 * Leading '@' kludge lines of a body, and the body without them. Netmail in the
 * NETMAIL form carries its @VIA on the line AFTER the address line, where the
 * packet parser, which reads kludges only at the very start, cannot see it.
 * @returns {{kludges: object, body: string}}
 */
function takeLeadingKludges(bodyText) {
	var body = String(bodyText || '');
	var kludges = {};
	for (;;) {
		var m = body.match(/^@([A-Za-z0-9_-]+):?\s+([^\r\n]*)(\r\n|\r|\n)/);
		if (!m) break;
		var key = m[1].toUpperCase();
		if (key === 'VIA') (kludges.VIA = kludges.VIA || []).push(m[2].trim());
		else kludges[key] = m[2].trim();
		body = body.slice(m[0].length);
	}
	return { kludges: kludges, body: body };
}

/**
 * The To field and body a private message goes out with, written as Synchronet
 * writes netmail (msgtoqwk QM_TO_QNET): on its last hop To is the user; with
 * hops still to go To is "NETMAIL" and the first body line is user@REST, where
 * REST is the path after the next hop. `via` (a relayed message's sender path)
 * goes as @VIA after that. Pure.
 */
function netmailWire(user, rest, bodyText, via) {
	var body = String(bodyText || '');
	var viaLine = via ? '@VIA: ' + via + '\r' : '';
	if (rest) return { to: 'NETMAIL', body: String(user || '') + '@' + rest + '\r' + viaLine + body };
	return { to: String(user || ''), body: viaLine + body };
}

export {
	routesFromSenderPath,
	takeLeadingKludges,
	netmailWire,
	parseViaPath,
	senderPath,
	originOf,
	pathContains,
	exportDecision,
	withVia,
	parseNetmailAddress,
	stripFirstLine
};
