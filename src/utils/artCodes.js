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
import { softwareVersion } from "./systeminfo.js";

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
	VR: function() { return softwareVersion(); },
};

// Async resolvers -- called once, values cached for the buffer
var ASYNC_CODES = {
	ON: async function(call) {
		var termCount = 0;
		if (call?.nodeManager) {
			termCount = call.nodeManager.nodenumsinuse.length;
		}
		var webUsers = [];
		try { webUsers = await getOnlineUsers(); } catch (_) {}
		return String(termCount + webUsers.length);
	},
	TC: async function() {
		try {
			var result = await postgres.queryOne("SELECT COUNT(*) AS cnt FROM calls");
			return String(result?.cnt || 0);
		} catch (_) { return '0'; }
	},
	TU: async function() {
		try {
			var result = await postgres.queryOne("SELECT COUNT(*) AS cnt FROM users");
			return String(result?.cnt || 0);
		} catch (_) { return '0'; }
	},
};

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

	// Pre-resolve async values that appear in the art
	var asyncCache = {};
	for (var code in ASYNC_CODES) {
		// Check if this code appears before doing the async work
		if (artString.indexOf('@' + code) !== -1) {
			asyncCache[code] = await ASYNC_CODES[code](call);
		}
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
