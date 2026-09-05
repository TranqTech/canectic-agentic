// Art code scanner/replacer for ANSI/ASCII art files.
//
// Two-pass system:
//   Pass 1 (universal codes): Replace @XX@ tokens with resolved values inline.
//   Pass 2 (menu codes):      Extract @Enn@, @Fnn@, @MT@, @HK@, @PR@, @ER@ positions
//                              into a slot map and blank them.
//
// Universal codes work in ALL art files. Menu codes only when options.menuMode is true.
//
// Width specifier: @BN20@ reserves 20 characters. Without specifier, the code's own
// character width (4 for @XX@) is used.

import appConfig from "../config/appConfig.js";
import * as postgres from "../middleware/db/postgres.js";
import { getOnlineUsers } from "../middleware/webActivity.js";

// --- Universal code definitions ---
// Each resolver receives the call object and returns a string value.
// Async resolvers are supported -- the main function awaits them.

var UNIVERSAL_CODES = {
	BN: function(call) { return appConfig.get('boardname', 'BBS'); },
	SN: function(call) { return appConfig.get('system_name', ''); },
	UN: function(call) { return call?.caller_username || ''; },
	RN: function(call) { return call?.caller_fullname || ''; },
	ND: function(call) { return String(call?.nodenum || 0); },
	DT: function() {
		var d = new Date();
		var mm = String(d.getMonth() + 1).padStart(2, '0');
		var dd = String(d.getDate()).padStart(2, '0');
		var yy = String(d.getFullYear());
		return mm + '/' + dd + '/' + yy;
	},
	TM: function() {
		var d = new Date();
		var hh = String(d.getHours()).padStart(2, '0');
		var mi = String(d.getMinutes()).padStart(2, '0');
		return hh + ':' + mi;
	},
	MG: function(call) { return call?.msg_group_title || ''; },
	MA: function(call) { return call?.msg_area_title || ''; },
	FG: function(call) { return call?.file_group_title || ''; },
	FA: function(call) { return call?.file_area_title || ''; },
	VR: function() { return appConfig.get('currentversion', '0.0.0'); },
};

// Async resolvers.
//
// These reach Redis or PostgreSQL, and art is rendered on every menu redraw, so
// they must never hold up a render. Each returns only the portion that needs a
// service; anything already known locally is added at substitution time so it
// cannot go stale. See resolveStat below for the caching and timeout policy.
//
// Deliberately no try/catch here. A rejection has to stay distinguishable from
// a real result, otherwise a failed lookup caches '0' as though it were true.
var ASYNC_CODES = {
	// Web presence only. The terminal node count is local and instant, and is
	// added in localComponent() rather than cached.
	ON: async function() {
		var webUsers = await getOnlineUsers();
		return String((webUsers || []).length);
	},
	TC: async function() {
		var result = await postgres.queryOne("SELECT COUNT(*) AS cnt FROM calls");
		return String(result?.cnt || 0);
	},
	TU: async function() {
		var result = await postgres.queryOne("SELECT COUNT(*) AS cnt FROM users");
		return String(result?.cnt || 0);
	},
};

// How long a resolved value stays usable. @ON@ moves constantly; the two counts
// barely move, and running COUNT(*) on calls and users for every menu redraw is
// wasteful even when everything is healthy.
var STAT_TTL_MS = { ON: 10000, TC: 60000, TU: 60000 };
var DEFAULT_TTL_MS = 30000;

// code -> { value, expires, inflight }
var statCache = {};

// The component of a code that is known locally and needs no service. Kept out
// of the cache so it is never stale, and so a value refreshed on behalf of one
// session is safe to serve to another.
function localComponent(code, call) {
	if (code === 'ON') {
		return call?.nodeManager ? call.nodeManager.nodenumsinuse.length : 0;
	}
	return 0;
}

// Resolve one async code without letting a slow service block the render.
//
//   fresh cache      return immediately, nothing is awaited
//   stale or missing start a refresh unless one is already running, then race
//                    it against art_stat_timeout_ms
//   timed out        return the last known value, or the static fallback, and
//                    LEAVE THE REFRESH RUNNING so it fills the cache for the
//                    next render
//
// The refresh is never abandoned, which is what makes one slightly stale render
// the worst case rather than a repeated wait. Once a render has given up
// waiting on a particular refresh, later renders do not wait on it again: they
// return the last known value immediately and let it keep running. Without that
// every render during an outage would pay the timeout over again, since a
// client that retries internally leaves the lookup pending indefinitely.
//
// When the service recovers the pending lookup settles on its own, the cache
// fills, and the next render is fresh.
//
// A failed lookup deliberately leaves the previous value in place rather than
// overwriting good data with a fallback.
async function resolveStat(code) {
	var entry = statCache[code];
	if (!entry) {
		entry = statCache[code] = { value: null, expires: 0, inflight: null, gaveUp: false };
	}

	if (entry.value !== null && Date.now() < entry.expires) {
		return entry.value;
	}

	// A refresh is running and we already timed out on it once. Do not wait
	// again; serve what we have and let it finish in the background.
	if (entry.inflight && entry.gaveUp) {
		return entry.value !== null ? entry.value : '0';
	}

	if (!entry.inflight) {
		entry.gaveUp = false;
		entry.inflight = Promise.resolve()
			.then(function() { return ASYNC_CODES[code](); })
			.then(function(v) {
				entry.value = String(v);
				entry.expires = Date.now() + (STAT_TTL_MS[code] || DEFAULT_TTL_MS);
				return entry.value;
			})
			.catch(function() { return null; })
			.finally(function() { entry.inflight = null; });
	}

	// Capture the promise: .finally clears the slot once it settles.
	var pending = entry.inflight;
	var TIMED_OUT = {};
	var timer = null;

	var raced = await Promise.race([
		pending,
		new Promise(function(resolve) {
			timer = setTimeout(function() { resolve(TIMED_OUT); }, appConfig.getNumber('art_stat_timeout_ms', 1500));
		}),
	]);
	if (timer) clearTimeout(timer);

	if (raced !== TIMED_OUT && raced !== null && raced !== undefined) {
		return raced;
	}

	// Remember that this refresh outlived our patience, so concurrent and
	// subsequent renders skip the wait entirely while it is still pending.
	if (raced === TIMED_OUT) entry.gaveUp = true;

	return entry.value !== null ? entry.value : '0';
}

// Menu entry code pattern: @E01@, @E0120@ (with width), @F01@, @F0120@
// UI position codes: @MT@, @HK@, @PR@, @ER@ (with optional width: @MT30@)
var ENTRY_CODE_RE = /^([EF])(\d{2})(\d+)?$/;
var UI_CODE_RE = /^(MT|HK|PR|ER)(\d+)?$/;

// --- Main processor ---

// Parse art content string for @ codes. Returns positions and replacement info.
// Works on the string representation of the art (after SAUCE strip, before send).
//
// Returns: { processed: string, slotMap: object|null }
//   slotMap is only populated when options.menuMode is true.

async function processArtCodes(artString, call, options) {
	options = options || {};
	var menuMode = options.menuMode || false;

	// Fast path: no @ sign means no codes to process
	if (artString.indexOf('@') === -1) {
		return { processed: artString, slotMap: null };
	}

	// Pre-resolve async values that appear in the art. Resolved in parallel so
	// art using several codes waits once rather than once per code.
	var asyncCache = {};
	var wanted = Object.keys(ASYNC_CODES).filter(function(code) {
		return artString.indexOf('@' + code) !== -1;
	});
	if (wanted.length > 0) {
		var resolved = await Promise.all(wanted.map(function(code) {
			return resolveStat(code);
		}));
		wanted.forEach(function(code, i) {
			var base = parseInt(resolved[i], 10);
			if (!Number.isFinite(base)) base = 0;
			asyncCache[code] = String(base + localComponent(code, call));
		});
	}

	// Build slot map for menu mode
	var slotMap = null;
	if (menuMode) {
		slotMap = {
			entries: [],    // { slot: nn, row: r, col: c, width: w }
			featured: [],   // { slot: nn, row: r, col: c, width: w }
			title: null,    // { row: r, col: c, width: w }
			prompt: null,
			hotkeys: null,
			error: null,
		};
	}

	// Process line by line to track row/col positions for menu codes
	var lines = artString.split('\n');
	var resultLines = [];

	for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		var line = lines[lineIdx];
		if (line.indexOf('@') === -1) {
			resultLines.push(line);
			continue;
		}

		// Scan for @ codes in this line
		var result = '';
		var i = 0;
		// Track visible column position (skip ANSI escape sequences)
		var visCol = 0;

		while (i < line.length) {
			// Skip ANSI escape sequences for column tracking
			if (line[i] === '\x1b' && i + 1 < line.length && line[i + 1] === '[') {
				var escStart = i;
				i += 2; // skip ESC [
				while (i < line.length && !((line.charCodeAt(i) >= 0x40 && line.charCodeAt(i) <= 0x7E))) {
					i++;
				}
				if (i < line.length) i++; // skip terminator
				result += line.substring(escStart, i);
				continue;
			}

			if (line[i] !== '@') {
				result += line[i];
				visCol++;
				i++;
				continue;
			}

			// Found @, try to match a code
			var codeMatch = _matchCode(line, i);
			if (!codeMatch) {
				result += '@';
				visCol++;
				i++;
				continue;
			}

			var codeName = codeMatch.name;
			var codeWidth = codeMatch.width;    // explicit width or null
			var codeLen = codeMatch.length;      // chars consumed in source
			var displayWidth = codeWidth || codeLen;  // width for padding

			// Universal code?
			if (UNIVERSAL_CODES[codeName]) {
				var val = UNIVERSAL_CODES[codeName](call);
				result += _fitValue(val, displayWidth);
				visCol += displayWidth;
				i += codeLen;
				continue;
			}

			// Async universal code?
			if (asyncCache[codeName] !== undefined) {
				result += _fitValue(asyncCache[codeName], displayWidth);
				visCol += displayWidth;
				i += codeLen;
				continue;
			}

			// Menu codes (only in menu mode)
			if (menuMode) {
				var entryMatch = codeName.match(ENTRY_CODE_RE);
				if (entryMatch) {
					var slotType = entryMatch[1]; // E or F
					var slotNum = parseInt(entryMatch[2]);
					var slotWidth = codeWidth || parseInt(entryMatch[3] || '0') || 20;
					var slotInfo = { slot: slotNum, row: lineIdx, col: visCol, width: slotWidth };

					if (slotType === 'E') {
						slotMap.entries.push(slotInfo);
					} else {
						slotMap.featured.push(slotInfo);
					}

					// Blank the slot -- use slotWidth so the rendered blank
					// matches the space the menu handler will fill
					result += ' '.repeat(slotWidth);
					visCol += slotWidth;
					i += codeLen;
					continue;
				}

				var uiMatch = codeName.match(UI_CODE_RE);
				if (uiMatch) {
					var uiType = uiMatch[1];
					var uiWidth = codeWidth || parseInt(uiMatch[2] || '0') || 40;
					var uiInfo = { row: lineIdx, col: visCol, width: uiWidth };

					switch (uiType) {
						case 'MT': slotMap.title = uiInfo; break;
						case 'HK': slotMap.hotkeys = uiInfo; break;
						case 'PR': slotMap.prompt = uiInfo; break;
						case 'ER': slotMap.error = uiInfo; break;
					}

					// Blank the slot -- use uiWidth for consistent sizing
					result += ' '.repeat(uiWidth);
					visCol += uiWidth;
					i += codeLen;
					continue;
				}
			}

			// Not a recognized code -- pass through
			result += '@';
			visCol++;
			i++;
		}

		resultLines.push(result);
	}

	return { processed: resultLines.join('\n'), slotMap: slotMap };
}

// --- Scan-only mode for sixel overlay ---
// Reads an .ans file purely for positional codes (menu slots + UI elements).
// Does NOT process universal codes. Returns just the slotMap.

function scanSlotMap(artString) {
	if (artString.indexOf('@') === -1) return null;

	var slotMap = {
		entries: [],
		featured: [],
		title: null,
		prompt: null,
		hotkeys: null,
		error: null,
	};

	var lines = artString.split('\n');
	var foundAny = false;

	for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		var line = lines[lineIdx];
		if (line.indexOf('@') === -1) continue;

		var i = 0;
		var visCol = 0;

		while (i < line.length) {
			if (line[i] === '\x1b' && i + 1 < line.length && line[i + 1] === '[') {
				i += 2;
				while (i < line.length && !((line.charCodeAt(i) >= 0x40 && line.charCodeAt(i) <= 0x7E))) {
					i++;
				}
				if (i < line.length) i++;
				continue;
			}

			if (line[i] !== '@') {
				visCol++;
				i++;
				continue;
			}

			var codeMatch = _matchCode(line, i);
			if (!codeMatch) {
				visCol++;
				i++;
				continue;
			}

			var codeName = codeMatch.name;
			var codeWidth = codeMatch.width;
			var codeLen = codeMatch.length;
			var displayWidth = codeWidth || codeLen;

			var entryMatch = codeName.match(ENTRY_CODE_RE);
			if (entryMatch) {
				var slotType = entryMatch[1];
				var slotNum = parseInt(entryMatch[2]);
				var slotWidth = codeWidth || parseInt(entryMatch[3] || '0') || 20;
				var slotInfo = { slot: slotNum, row: lineIdx, col: visCol, width: slotWidth };

				if (slotType === 'E') {
					slotMap.entries.push(slotInfo);
				} else {
					slotMap.featured.push(slotInfo);
				}
				foundAny = true;
				visCol += slotWidth;
				i += codeLen;
				continue;
			}

			var uiMatch = codeName.match(UI_CODE_RE);
			if (uiMatch) {
				var uiType = uiMatch[1];
				var uiWidth = codeWidth || parseInt(uiMatch[2] || '0') || 40;
				var uiInfo = { row: lineIdx, col: visCol, width: uiWidth };

				switch (uiType) {
					case 'MT': slotMap.title = uiInfo; break;
					case 'HK': slotMap.hotkeys = uiInfo; break;
					case 'PR': slotMap.prompt = uiInfo; break;
					case 'ER': slotMap.error = uiInfo; break;
				}
				foundAny = true;
				visCol += uiWidth;
				i += codeLen;
				continue;
			}

			// Not a menu code -- skip past this code
			visCol += codeLen;
			i += codeLen;
		}
	}

	return foundAny ? slotMap : null;
}


// --- Internal helpers ---

// Match an @ code starting at position pos in the string.
// Returns { name, width, length } or null.
// Supports: @XX@, @XX99@, @XXnn@, @XXnnWW@ patterns.
// The "name" includes the full inner content for menu code regex matching.

function _matchCode(str, pos) {
	if (str[pos] !== '@') return null;

	// Find the closing @
	var maxLen = 12; // @XX@ to @XXNNWWW@ -- reasonable max
	var end = -1;
	for (var j = pos + 1; j < str.length && j <= pos + maxLen; j++) {
		if (str[j] === '@') {
			end = j;
			break;
		}
		// Bail on non-alphanumeric (codes are letters + digits only)
		var ch = str.charCodeAt(j);
		if (!((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A))) {
			return null;
		}
	}

	if (end === -1) return null;

	var inner = str.substring(pos + 1, end);
	if (inner.length < 2) return null;

	var totalLen = end - pos + 1; // includes both @ delimiters

	// Try to parse as a two-letter code with optional width: XX, XXnn
	var letters = inner.substring(0, 2).toUpperCase();
	var trailing = inner.substring(2);

	// Check if first 2 chars are letters
	if (!(/^[A-Z]{2}$/.test(letters))) {
		// Could be entry code: E01, F02, E0120
		if (/^[EF]\d{2,}$/.test(inner.toUpperCase())) {
			return { name: inner.toUpperCase(), width: null, length: totalLen };
		}
		return null;
	}

	// Two-letter code
	if (trailing === '') {
		// @XX@ -- no width
		return { name: letters, width: null, length: totalLen };
	}

	// @XXnn@ -- trailing digits are width specifier
	if (/^\d+$/.test(trailing)) {
		// For universal codes, the number is the width
		// For entry codes (name matched later), pass through as-is
		return { name: letters, width: parseInt(trailing), length: totalLen };
	}

	return null;
}

// Fit a value into a fixed width: truncate or right-pad with spaces.
function _fitValue(val, width) {
	if (val.length > width) {
		return val.substring(0, width);
	}
	if (val.length < width) {
		return val + ' '.repeat(width - val.length);
	}
	return val;
}


export { processArtCodes, scanSlotMap };
