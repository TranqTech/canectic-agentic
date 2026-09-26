// qnetAuth.js — how a QWK node proves who it is to a Canectic hub over HTTP.
//
// HTTP Basic: the user is the node's QWK ID (the hub connection's
// remote_qwk_id), the password is the password set on that hub connection.
// Per connection rather than a user's API token, because a node is a peer
// system, not a person with an account.
//
// Pure: callers pass the header and the candidate connections.

import crypto from 'crypto';

/** { user, pass } from an Authorization header, or null. */
function parseBasic(header) {
	var m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header || ''));
	if (!m) return null;
	var decoded;
	try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) { return null; }
	var colon = decoded.indexOf(':');
	if (colon < 1) return null;
	return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

/** Constant-time string comparison (hashing first so lengths cannot leak). */
function sameSecret(a, b) {
	var ha = crypto.createHash('sha256').update(String(a)).digest();
	var hb = crypto.createHash('sha256').update(String(b)).digest();
	return crypto.timingSafeEqual(ha, hb);
}

/**
 * The hub connection a node's credentials open, or null.
 *
 * Only an active QWK connection on the hub transport qualifies, matched on
 * its remote QWK ID without regard to case. A connection with no password
 * set never matches: an empty password would open it to anyone who knew the
 * node's QWK ID, which is printed in every packet.
 */
function matchNode(creds, connections) {
	if (!creds || !creds.user) return null;
	var id = creds.user.trim().toUpperCase();
	for (var c of connections || []) {
		var cd = c.connection_data || {};
		if (!c.active || cd.transport !== 'hub') continue;
		if (String(cd.remote_qwk_id || '').trim().toUpperCase() !== id) continue;
		if (!cd.password) return null;
		return sameSecret(creds.pass, cd.password) ? c : null;
	}
	return null;
}

/** Does this look like a ZIP (QWK and REP packets are ZIP archives)? */
function looksLikeZip(buf) {
	return !!buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
		(buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06);
}

export { parseBasic, sameSecret, matchNode, looksLikeZip };
