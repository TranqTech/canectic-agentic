// bsoPaths.js -- where BSO outbound files for an address live.
//
// The mailer reads each peer's flow files, packets and .req files from the
// zone outbound (`out` for zone 1, `out.NNN` in hex for any other zone), under
// MAILER_OUTBOUND_DIR when that is set and `ftnoutbound` otherwise. Anything
// that writes outbound for the mailer to pick up has to agree with that, or the
// file is written somewhere no session ever looks: outbound FREQ used to go to
// `ftnoutbound` for every zone, so a request to a zone 2 peer was never sent.

import * as path from 'path';
import appConfig from '../config/appConfig.js';

/**
 * The outbound base directory the mailer reads from.
 */
function mailerOutboundDir() {
	return appConfig.get('MAILER_OUTBOUND_DIR') || appConfig.get('ftnoutbound', 'ftn/out');
}

/**
 * The BSO outbound directory for a zone: the base itself for zone 1, the base
 * plus a 3-digit hex zone for any other.
 *
 * @param {number|string} zone
 * @param {string} [baseDir] defaults to mailerOutboundDir()
 */
function outboundDirForZone(zone, baseDir) {
	var base = baseDir || mailerOutboundDir();
	var z = parseInt(zone) || 1;
	if (z === 1) return base;
	return base + '.' + z.toString(16).padStart(3, '0');
}

/**
 * Parse "zone:net/node[.point][@domain]". Node 0 (a host or hub) is valid.
 *
 * @returns {object|null} { zone, net, node, point }
 */
function parseFtnAddress(addr) {
	var m = /^\s*(\d+):(\d+)\/(\d+)(?:\.(\d+))?(?:@\S+)?\s*$/.exec(String(addr || ''));
	if (!m) return null;
	return {
		zone: parseInt(m[1]),
		net: parseInt(m[2]),
		node: parseInt(m[3]),
		point: m[4] ? parseInt(m[4]) : 0
	};
}

/**
 * Path of the .req file the mailer sends to an address.
 */
function reqFilePath(zone, net, node, baseDir) {
	var hex = parseInt(net).toString(16).padStart(4, '0') + parseInt(node).toString(16).padStart(4, '0');
	return path.join(outboundDirForZone(zone, baseDir), hex + '.req');
}

export { mailerOutboundDir, outboundDirForZone, parseFtnAddress, reqFilePath };
