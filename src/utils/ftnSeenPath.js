// ftnSeenPath.js -- SEEN-BY and PATH: reading them, adding to them, writing
// them back out.
//
// Both are lists of 2D net/node addresses in the compressed form FTS-0004
// describes: a bare number belongs to the net of the entry before it, so
// "134/100 101 153/757" is 134/100, 134/101 and 153/757. Both may span any
// number of lines, and every line is part of the one list.
//
// SEEN-BY answers "who has this message already", and is what stops a message
// being sent to a system that has it. PATH answers "which systems has it passed
// through, in order". Neither survived a pass through this system intact
// before this module: the parser kept only the LAST SEEN-BY line (six of the
// seven on a typical FidoNet message were dropped), kept the colon that
// follows "SEEN-BY" as an entry, re-emitted the old PATH as a kludge at the top
// of the message, and export replaced the PATH with our own address instead of
// adding it. A downlink then saw a PATH of one hop and a SEEN-BY missing most of
// the systems that already had the message, which is how dupes and loops start.
//
// So there is one definition here of what an entry is, used by the parser, the
// outbound eligibility check and the packet writers alike.
//
// The stored form, in the seen_by and path columns, is one compressed line:
// SEEN-BY sorted, PATH in order. The line length limit only applies on the
// wire, and seenByLines/pathLines apply it there.
//
// Pure.

// FTS-0004 lines stay under 80 characters.
var MAX_LINE = 79;

var FULL = /^(?:\d+:)?(\d+)\/(\d+)(?:\.\d+)?(?:@\S*)?$/;
var BARE = /^(\d+)(?:\.\d+)?$/;

/**
 * Every net/node in a SEEN-BY or PATH value, in the order written.
 *
 * Accepts what is stored, one line's worth, or several lines run together,
 * with or without their "SEEN-BY:" or "PATH:" labels. A zone prefix, a point
 * suffix or a domain is dropped, since both lists are 2D. Anything that is not
 * an address is skipped rather than taken as one: the old parser stored the
 * colon after "SEEN-BY" as an entry, and those values are still in databases.
 *
 * @returns {Array<{net:number, node:number}>}
 */
function parseNetNodes(value) {
	var out = [];
	if (value === null || value === undefined) return out;
	var net = null;
	var tokens = String(value).replace(/\x01/g, ' ').split(/\s+/);
	for (var t of tokens) {
		if (!t || /^(SEEN-BY|PATH):?$/i.test(t)) continue;
		var m = FULL.exec(t);
		if (m) {
			net = Number(m[1]);
			out.push({ net: net, node: Number(m[2]) });
			continue;
		}
		m = BARE.exec(t);
		if (m && net !== null) out.push({ net: net, node: Number(m[1]) });
	}
	return out;
}

/** Accepts "134/100", {net, node} with either numbers or strings. */
function toNetNode(a) {
	if (a && typeof a === 'object') return { net: Number(a.net), node: Number(a.node) };
	var parsed = parseNetNodes(a);
	return parsed.length ? parsed[0] : null;
}

function same(a, b) { return a.net === b.net && a.node === b.node; }

/** Whether a SEEN-BY or PATH value names this net/node. */
function hasNetNode(value, addr) {
	var want = toNetNode(addr);
	if (!want) return false;
	return parseNetNodes(value).some(function (e) { return same(e, want); });
}

/** Entries as one compressed line, in the order given. */
function compress(entries) {
	var parts = [];
	var net = null;
	for (var e of entries) {
		parts.push(e.net === net ? String(e.node) : e.net + '/' + e.node);
		net = e.net;
	}
	return parts.join(' ');
}

/**
 * Entries as wire lines, each under the limit. Every line starts with a full
 * net/node, since a reader is entitled to take each line on its own.
 */
function wrap(label, entries) {
	var lines = [];
	var line = '';
	var net = null;
	for (var e of entries) {
		var token = (line && e.net === net) ? String(e.node) : e.net + '/' + e.node;
		if (line && (label + line + ' ' + token).length > MAX_LINE) {
			lines.push(label + line);
			line = '';
			token = e.net + '/' + e.node;
		}
		line = line ? line + ' ' + token : token;
		net = e.net;
	}
	if (line) lines.push(label + line);
	return lines;
}

function sortedUnique(entries) {
	var seen = new Set();
	var out = [];
	for (var e of entries) {
		var k = e.net + '/' + e.node;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(e);
	}
	out.sort(function (a, b) { return a.net - b.net || a.node - b.node; });
	return out;
}

/**
 * A SEEN-BY value with some addresses added: deduplicated, sorted by net then
 * node as FTS-0004 asks, compressed, one line. Null when there is nothing in it.
 */
function mergeSeenBy(value, add) {
	var entries = parseNetNodes(value);
	for (var a of add || []) {
		var e = toNetNode(a);
		if (e && !isNaN(e.net) && !isNaN(e.node)) entries.push(e);
	}
	var merged = sortedUnique(entries);
	return merged.length ? compress(merged) : null;
}

/**
 * A PATH value with this system added at the end, unless it is already the
 * last hop: a message posted here carries our address already, and a message
 * sent to two downlinks passes through the same export twice.
 */
function appendPath(value, own) {
	var entries = parseNetNodes(value);
	var me = toNetNode(own);
	if (me && !(entries.length && same(entries[entries.length - 1], me))) entries.push(me);
	return entries.length ? compress(entries) : null;
}

/** A PATH value, compressed, order kept. Null when empty. */
function normalisePath(value) {
	var entries = parseNetNodes(value);
	return entries.length ? compress(entries) : null;
}

/** SEEN-BY lines for the wire, sorted, without the line ending. */
function seenByLines(value) {
	return wrap('SEEN-BY: ', sortedUnique(parseNetNodes(value)));
}

/** PATH kludge lines for the wire, in order, without the line ending. */
function pathLines(value) {
	return wrap('\x01PATH: ', parseNetNodes(value));
}

export {
	MAX_LINE,
	parseNetNodes,
	hasNetNode,
	mergeSeenBy,
	appendPath,
	normalisePath,
	seenByLines,
	pathLines
};
