// ftnVia.js -- the Via kludge chain that records a netmail's route.
//
// Every system that passes a netmail on is expected to append one Via line, so
// the message carries its own path. Two things depend on that:
//
//   - a sysop, or a ping reply, can see where mail actually went
//   - a relay can tell whether it has already handled this message, which is
//     the only thing standing between two mutually-routing systems and a
//     message bouncing between them until someone notices
//
// This system parsed Via lines but truncated them to two tokens, dropping the
// timestamp and the software, and never wrote one at all. So a relay had no
// loop protection and left no trace.
//
// Format, per long-standing practice (FTS-0004 kludge framing, the Via
// convention itself is de facto rather than a numbered standard):
//
//   Via <address> <yyyymmdd>.<hhmmss>[.<precision>].UTC <product> <version>
//
// Real examples from the wild, all of which have to survive a round trip:
//
//   Via 2:5020/1042 @20240115.123456.UTC binkd/1.1a-115
//   Via 1:229/426@fidonet 20240115.123456.UTC Canectic BBS 0.9.5a
//   Via 21:1/100 @20240115.123456.12345.UTC HPT/lnx 1.9
//
// Implementations disagree about the '@' before the timestamp, so it is
// accepted on read and omitted on write.

const PRODUCT = 'Canectic';

/**
 * Build the Via line body for this system, without the leading kludge marker.
 *
 * @param {string} address  our FTN address, as it should appear in the chain
 * @param {Date}   when     defaults to now
 * @param {string} version  product version
 */
function buildViaLine(address, when, version) {
	var d = (when instanceof Date && !isNaN(when.getTime())) ? when : new Date();
	var stamp = d.getUTCFullYear() +
		pad2(d.getUTCMonth() + 1) +
		pad2(d.getUTCDate()) + '.' +
		pad2(d.getUTCHours()) +
		pad2(d.getUTCMinutes()) +
		pad2(d.getUTCSeconds()) + '.UTC';

	return [address || '', stamp, PRODUCT + (version ? ' ' + version : '')]
		.filter(Boolean).join(' ');
}

/**
 * Parse one Via line body into its parts.
 *
 * Returns the address, the timestamp as given, and everything after it as the
 * software string. The whole line is kept in `raw` so a caller can put back
 * exactly what it read: this has to survive a round trip through a relay, and
 * reconstructing from parsed parts would quietly normalise other systems'
 * lines.
 */
function parseViaLine(value) {
	var raw = String(value === null || value === undefined ? '' : value).trim();
	if (!raw) return null;

	var parts = raw.split(/\s+/);
	var address = parts[0] || '';
	var stamp = parts[1] || '';
	var softwareFrom = 2;

	// Some systems write "Via <addr> @<stamp> <sw>", some omit the '@'. A
	// token that is not a timestamp at all means there was none, and
	// everything after the address is software.
	if (stamp.charAt(0) === '@') stamp = stamp.substring(1);
	if (stamp && !/^\d{8}\./.test(stamp)) {
		stamp = '';
		softwareFrom = 1;
	}

	return {
		raw:      raw,
		address:  address,
		bare:     bareAddress(address),
		stamp:    stamp,
		software: parts.slice(softwareFrom).join(' ')
	};
}

/**
 * Every Via line on a message, oldest first, as parsed objects.
 *
 * @param {Array} optionalAttributes  the message's kludge list
 */
function viaChain(optionalAttributes) {
	var out = [];
	for (var attr of (optionalAttributes || [])) {
		if (!attr || !attr.attribute) continue;
		if (String(attr.attribute).toUpperCase() !== 'VIA') continue;
		var parsed = parseViaLine(attr.value);
		if (parsed) out.push(parsed);
	}
	return out;
}

/**
 * Has this message already passed through one of our addresses?
 *
 * Comparison is on the bare address, since a system may write itself into the
 * chain with a domain one hop and without it the next, and a loop check that
 * misses is worse than no loop check: it reads as protection.
 *
 * @param {Array} optionalAttributes
 * @param {Array} ourAddresses  strings, with or without @domain
 */
function hasPassedThrough(optionalAttributes, ourAddresses) {
	var ours = new Set();
	for (var a of (ourAddresses || [])) {
		var bare = bareAddress(a);
		if (bare) ours.add(bare.toLowerCase());
	}
	if (ours.size === 0) return false;

	for (var via of viaChain(optionalAttributes)) {
		if (via.bare && ours.has(via.bare.toLowerCase())) return true;
	}
	return false;
}

/**
 * Append our Via line to a message's kludge list, in place.
 *
 * Appended rather than inserted: the chain is chronological, and a reader
 * works backwards from the newest hop.
 */
function appendVia(optionalAttributes, address, when, version) {
	var list = Array.isArray(optionalAttributes) ? optionalAttributes : [];
	list.push({ attribute: 'Via', value: buildViaLine(address, when, version) });
	return list;
}

/**
 * The value half of a raw Via kludge line, given the line with its leading
 * control byte already stripped ("Via 2:5020/1042 @2024... binkd/1.1a-115").
 *
 * The tosser had its own copy of this that kept two tokens and dropped the
 * rest, so every Via line lost either its timestamp or its software depending
 * on whether the writer used the optional '@'. Sharing one implementation is
 * the point: the tosser's copy was the one that actually ran on inbound mail,
 * and the tested one was somewhere else entirely.
 */
function viaValueFromKludge(line) {
	if (!line) return '';
	var parts = String(line).trim().split(/\s+/);
	return parts.slice(1).join(' ');
}

function bareAddress(addr) {
	if (!addr) return '';
	var s = String(addr).trim();
	var at = s.indexOf('@');
	return at >= 0 ? s.substring(0, at) : s;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

export { buildViaLine, parseViaLine, viaChain, hasPassedThrough, appendVia,
	viaValueFromKludge, PRODUCT };
