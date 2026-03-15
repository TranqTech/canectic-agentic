// termMsgFormat.js — Terminal message body formatting utility.
//
// Handles:
//   - CP437 → UTF-8 conversion for UTF-8 terminals receiving CP437 text
//   - Pipe code (|XX) → ANSI escape sequence conversion
//   - Synchronet Ctrl-A attribute codes → ANSI escape sequence conversion
//   - Semantic line coloring (normal, quote, tear, origin)
//   - ANSI passthrough (existing escape codes are preserved, never stripped)
//
// Used by msgReader.js for message body display.

// CP437 extended character table (0x80-0xFF → Unicode)
const CP437_EXT = [
	// 0x80-0x8F
	'\u00C7', '\u00FC', '\u00E9', '\u00E2', '\u00E4', '\u00E0', '\u00E5', '\u00E7',
	'\u00EA', '\u00EB', '\u00E8', '\u00EF', '\u00EE', '\u00EC', '\u00C4', '\u00C5',
	// 0x90-0x9F
	'\u00C9', '\u00E6', '\u00C6', '\u00F4', '\u00F6', '\u00F2', '\u00FB', '\u00F9',
	'\u00FF', '\u00D6', '\u00DC', '\u00A2', '\u00A3', '\u00A5', '\u20A7', '\u0192',
	// 0xA0-0xAF
	'\u00E1', '\u00ED', '\u00F3', '\u00FA', '\u00F1', '\u00D1', '\u00AA', '\u00BA',
	'\u00BF', '\u2310', '\u00AC', '\u00BD', '\u00BC', '\u00A1', '\u00AB', '\u00BB',
	// 0xB0-0xBF
	'\u2591', '\u2592', '\u2593', '\u2502', '\u2524', '\u2561', '\u2562', '\u2556',
	'\u2555', '\u2563', '\u2551', '\u2557', '\u255D', '\u255C', '\u255B', '\u2510',
	// 0xC0-0xCF
	'\u2514', '\u2534', '\u252C', '\u251C', '\u2500', '\u253C', '\u255E', '\u255F',
	'\u255A', '\u2554', '\u2569', '\u2566', '\u2560', '\u2550', '\u256C', '\u2567',
	// 0xD0-0xDF
	'\u2568', '\u2564', '\u2565', '\u2559', '\u2558', '\u2552', '\u2553', '\u256B',
	'\u256A', '\u2518', '\u250C', '\u2588', '\u2584', '\u258C', '\u2590', '\u2580',
	// 0xE0-0xEF
	'\u03B1', '\u00DF', '\u0393', '\u03C0', '\u03A3', '\u03C3', '\u00B5', '\u03C4',
	'\u03A6', '\u0398', '\u03A9', '\u03B4', '\u221E', '\u03C6', '\u03B5', '\u2229',
	// 0xF0-0xFF
	'\u2261', '\u00B1', '\u2265', '\u2264', '\u2320', '\u2321', '\u00F7', '\u2248',
	'\u00B0', '\u2219', '\u00B7', '\u221A', '\u207F', '\u00B2', '\u25A0', '\u00A0',
];

// Reverse lookup: Unicode codepoint → CP437 byte (built from CP437_EXT at load time)
const UTF8_TO_CP437 = {};
for (var _i = 0; _i < CP437_EXT.length; _i++) {
	UTF8_TO_CP437[CP437_EXT[_i]] = 0x80 + _i;
}

// Pipe code color map (|00-|23)
// |00-|07: standard foreground, |08-|15: bright foreground, |16-|23: background
const PIPE_FG = [
	"\x1b[0;30m", "\x1b[0;34m", "\x1b[0;32m", "\x1b[0;36m",  // 00-03: black, blue, green, cyan
	"\x1b[0;31m", "\x1b[0;35m", "\x1b[0;33m", "\x1b[0;37m",  // 04-07: red, magenta, yellow/brown, white
	"\x1b[1;30m", "\x1b[1;34m", "\x1b[1;32m", "\x1b[1;36m",  // 08-11: bright variants
	"\x1b[1;31m", "\x1b[1;35m", "\x1b[1;33m", "\x1b[1;37m",  // 12-15: bright variants
];

const PIPE_BG = [
	"\x1b[40m", "\x1b[44m", "\x1b[42m", "\x1b[46m",  // 16-19: black, blue, green, cyan
	"\x1b[41m", "\x1b[45m", "\x1b[43m", "\x1b[47m",  // 20-23: red, magenta, yellow, white
];

// Synchronet Ctrl-A attribute code map
// Ctrl-A followed by a single character
const CTRLA_MAP = {
	'K': "\x1b[0;30m",    // Black
	'B': "\x1b[0;34m",    // Blue
	'G': "\x1b[0;32m",    // Green
	'C': "\x1b[0;36m",    // Cyan
	'R': "\x1b[0;31m",    // Red
	'M': "\x1b[0;35m",    // Magenta
	'Y': "\x1b[0;33m",    // Yellow/Brown
	'W': "\x1b[0;37m",    // White
	'k': "\x1b[0;30m",    // Black (lowercase aliases)
	'b': "\x1b[0;34m",
	'g': "\x1b[0;32m",
	'c': "\x1b[0;36m",
	'r': "\x1b[0;31m",
	'm': "\x1b[0;35m",
	'y': "\x1b[0;33m",
	'w': "\x1b[0;37m",
	'H': "\x1b[1m",       // High intensity (bold/bright)
	'I': "\x1b[5m",       // Blink
	'N': "\x1b[0m",       // Normal (reset)
	'-': "\x1b[0m",       // Normal (reset)
	'_': "\x1b[0m",       // Normal (reset)
	'0': "\x1b[40m",      // BG Black
	'1': "\x1b[44m",      // BG Blue
	'2': "\x1b[42m",      // BG Green
	'3': "\x1b[46m",      // BG Cyan
	'4': "\x1b[41m",      // BG Red
	'5': "\x1b[45m",      // BG Magenta
	'6': "\x1b[43m",      // BG Yellow
	'7': "\x1b[47m",      // BG White
};

// Default semantic colors (ANSI SGR numbers used with setfgcolor)
const DF_CLR_BODY = 11;      // Normal text — bright yellow
const DF_CLR_QUOTE = 14;     // Quote lines — bright cyan
const DF_CLR_TEAR = 15;      // Tear lines — bright white
const DF_CLR_TAGLINE = 10;   // Tagline separator lines — bright green
const DF_CLR_ORIGIN = 12;    // Origin lines — bright blue
const DF_CLR_KLUDGE = 8;     // Kludge/hidden lines — dark grey

// ---------------------------------------------------------------------------
// Detection: does the text contain color codes?
// ---------------------------------------------------------------------------

function hasAnsiCodes(text) {
	if (!text) return false;
	return text.includes("\x1b[");
}

function hasPipeCodes(text) {
	if (!text) return false;
	return /\|\d{2}/.test(text);
}

function hasCtrlACodes(text) {
	if (!text) return false;
	return text.includes("\x01");
}

function hasColorCodes(text) {
	return hasAnsiCodes(text) || hasPipeCodes(text) || hasCtrlACodes(text);
}

// Detect ANSI art vs. simple colored text.
// ANSI art uses cursor positioning (CSI sequences ending in A/B/C/D/H/f/J/K/s/u).
// Simple colored messages only use SGR (CSI sequences ending in 'm').
// Pipe codes and Ctrl-A codes are always simple color — never art.
function detectAnsiArt(text) {
	if (!text) return false;
	// Look for any CSI sequence that is NOT just SGR (color).
	// CSI = ESC [ <params> <final byte>
	// SGR final byte is 'm'. Cursor positioning uses A,B,C,D,H,f,J,K,s,u etc.
	return /\x1b\[\d*[ABCDHJKfsu]/.test(text) ||          // Single-param positioning
	       /\x1b\[\d+;\d+[Hf]/.test(text) ||               // Two-param cursor position
	       /\x1b\[2?[JK]/.test(text);                       // Screen/line clear
}

// ---------------------------------------------------------------------------
// CP437 → UTF-8 conversion for message body text
// Converts bytes in the 0x80-0xFF range to their Unicode equivalents.
// Preserves control codes that have meaning (ESC, CR, LF, TAB, BEL, etc.)
// and printable ASCII (0x20-0x7E) as-is.
// ---------------------------------------------------------------------------

function convertCP437toUTF8(text) {
	if (!text) return "";
	var result = "";
	for (var i = 0; i < text.length; i++) {
		var code = text.charCodeAt(i);
		if (code >= 0x80 && code <= 0xFF) {
			result += CP437_EXT[code - 0x80];
		} else {
			result += text.charAt(i);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// UTF-8 → CP437 conversion for CP437 terminals receiving Unicode text.
// Converts Unicode characters that have CP437 equivalents back to single bytes.
// Characters without a CP437 mapping are replaced with '?' to prevent
// multi-byte UTF-8 sequences from displaying as garbage.
// Preserves ASCII (0x20-0x7E) and control codes (ESC, CR, LF, etc.) as-is.
// Returns a Buffer since the output contains raw bytes, not valid UTF-8.
// ---------------------------------------------------------------------------

function convertUTF8toCP437(text) {
	if (!text) return Buffer.alloc(0);
	var bytes = [];
	for (var i = 0; i < text.length; i++) {
		var ch = text.charAt(i);
		var code = text.charCodeAt(i);

		// ASCII printable + standard control codes — pass through
		if (code <= 0x7F) {
			bytes.push(code);
			continue;
		}

		// Check reverse lookup table
		var cp437Byte = UTF8_TO_CP437[ch];
		if (cp437Byte !== undefined) {
			bytes.push(cp437Byte);
		} else {
			// No CP437 equivalent — substitute with '?'
			bytes.push(0x3F);
		}
	}
	return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Pipe codes (|XX) → ANSI escape sequences
// Replaces |00-|15 with foreground colors, |16-|23 with background colors.
// Other |XX patterns (outside 00-23) are left as-is.
// ---------------------------------------------------------------------------

function convertPipeCodes(text) {
	if (!text) return text;
	return text.replace(/\|(\d{2})/g, function(match, digits) {
		var num = parseInt(digits, 10);
		if (num >= 0 && num <= 15) {
			return PIPE_FG[num];
		} else if (num >= 16 && num <= 23) {
			return PIPE_BG[num - 16];
		}
		return match; // Leave unrecognized codes intact
	});
}

// ---------------------------------------------------------------------------
// Ctrl-A codes → ANSI escape sequences
// Replaces \x01X with the corresponding ANSI sequence.
// Unknown codes after \x01 are silently stripped.
// ---------------------------------------------------------------------------

function convertCtrlACodes(text) {
	if (!text) return text;
	var result = "";
	for (var i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 0x01 && i + 1 < text.length) {
			var attr = text.charAt(i + 1);
			if (CTRLA_MAP[attr]) {
				result += CTRLA_MAP[attr];
			}
			// Skip the attribute character either way
			i++;
		} else {
			result += text.charAt(i);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Semantic line classification
// ---------------------------------------------------------------------------

const LINE_NORMAL  = "normal";
const LINE_QUOTE   = "quote";
const LINE_TEAR    = "tear";
const LINE_TAGLINE = "tagline";
const LINE_ORIGIN  = "origin";
const LINE_KLUDGE  = "kludge";

function classifyLine(line) {
	if (!line || line.length === 0) return LINE_NORMAL;
	var trimmed = line.trimStart();

	// Kludge lines (FTN hidden lines starting with SOH)
	if (trimmed.charCodeAt(0) === 0x01) return LINE_KLUDGE;

	// Origin line: "* Origin: ..." or " * Origin: ..."
	if (/^\s*\* Origin:/i.test(trimmed)) return LINE_ORIGIN;

	// Tear line: "---" exactly, or "--- " followed by text (FTN tear + tagline)
	// Must check BEFORE tagline "--" to prevent "---" matching as "--" + extra dash
	if (/^---\s/.test(trimmed) || trimmed === "---") return LINE_TEAR;

	// Tagline separators:
	//   "--" — signature/tagline separator (exactly 2 dashes, NOT "---" which is tear)
	//   "-- " — email/usenet signature separator (RFC 3676)
	//   "===" or "====" etc — equals separator (3+ equals signs)
	if (trimmed === "--" || /^--\s*$/.test(trimmed)) return LINE_TAGLINE;
	if (/^={3,}\s*$/.test(trimmed)) return LINE_TAGLINE;

	// Quote line patterns:
	//   "> text", ">> text", " > text" — standard quote prefix
	//   "XX> text", "XX>> text" — username-initial prefix quotes
	//     (1-3 letters before >, e.g. "De>", "JD>", "Rob>")
	//   "-> text", "-=> text", "=> text" — arrow reply indicators
	//     (any mix of - and = characters before >, followed by space)
	if (/^\s*>/.test(trimmed)) return LINE_QUOTE;
	if (/^\s*[A-Za-z]{1,3}>{1,2}\s/.test(trimmed)) return LINE_QUOTE;
	if (/^\s*[-=]+>\s/.test(trimmed)) return LINE_QUOTE;

	return LINE_NORMAL;
}

// ---------------------------------------------------------------------------
// processMessageBody — main entry point for terminal message display.
//
// Takes a message object and options, returns an array of objects:
//   { text: "line content with ANSI codes", type: "normal"|"quote"|"tear"|"origin" }
//
// Options:
//   isUTF8:       boolean — is the terminal UTF-8?
//   wrapWidth:    number  — word-wrap width (0 = no wrap)
//   colors:       object  — override semantic colors { body, quote, tear, origin, kludge }
//
// The returned text strings may contain ANSI escape sequences and should
// be sent to the terminal with senddata(), not through setfgcolor().
// For lines without embedded color codes, a color prefix is prepended.
// For lines with embedded codes, color prefix is skipped (except tear/origin).
// ---------------------------------------------------------------------------

function processMessageBody(msg, options) {
	var opts = options || {};
	var isUTF8 = opts.isUTF8 || false;
	var wrapWidth = opts.wrapWidth || 0;
	var colors = opts.colors || {};

	// Resolve semantic colors (ANSI SGR color numbers)
	var clrBody    = colors.body    !== undefined ? colors.body    : DF_CLR_BODY;
	var clrQuote   = colors.quote   !== undefined ? colors.quote   : DF_CLR_QUOTE;
	var clrTear    = colors.tear    !== undefined ? colors.tear    : DF_CLR_TEAR;
	var clrTagline = colors.tagline !== undefined ? colors.tagline : DF_CLR_TAGLINE;
	var clrOrigin  = colors.origin  !== undefined ? colors.origin  : DF_CLR_ORIGIN;
	var clrKludge  = colors.kludge  !== undefined ? colors.kludge  : DF_CLR_KLUDGE;

	// Get raw text — prefer utf8 field if available
	var rawText = msg.utf8 || msg.body_text || "";

	// CP437 → UTF-8 conversion if terminal is UTF-8 and text is not already UTF-8
	// If msg.utf8 exists, it's already converted. Otherwise body_text may be CP437.
	if (isUTF8 && !msg.utf8 && msg.body_text) {
		rawText = convertCP437toUTF8(rawText);
	}

	// Detect what kind of color codes are present BEFORE conversion
	var hasPipe = hasPipeCodes(rawText);
	var hasCtrlA = hasCtrlACodes(rawText);
	var hasAnsi = hasAnsiCodes(rawText);
	var hasEmbeddedCodes = hasPipe || hasCtrlA || hasAnsi;
	var isAnsiArt = detectAnsiArt(rawText);

	// Convert pipe codes and Ctrl-A codes to ANSI escape sequences
	if (hasPipe) {
		rawText = convertPipeCodes(rawText);
	}
	if (hasCtrlA) {
		rawText = convertCtrlACodes(rawText);
	}

	// Normalize line endings
	rawText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	// Split into lines
	var sourceLines = rawText.split("\n");

	// Build output lines
	var result = [];
	// Two-level footer tracking:
	//   pastTagline = true after a tagline separator (-- or ===) → lines get tagline color
	//   pastTear = true after a tear line (---) → lines get origin color (overrides tagline)
	var pastTagline = false;
	var pastTear = false;

	for (var i = 0; i < sourceLines.length; i++) {
		var line = sourceLines[i];
		var lineType = classifyLine(line);

		// Skip kludge lines (FTN internal, not for display)
		if (lineType === LINE_KLUDGE) continue;

		// Apply footer color cascading:
		// Tear overrides tagline — once past tear, everything is origin.
		// Past tagline but before tear — everything is tagline.
		// The separator lines themselves (-- or ===) get tear color (bright white),
		// but content lines after the separator get tagline color (bright green).
		var colorType = lineType; // may differ from lineType for color purposes
		if (lineType === LINE_TEAR) {
			pastTear = true;
		} else if (lineType === LINE_TAGLINE) {
			pastTagline = true;
			colorType = LINE_TEAR; // separator itself renders as bright white
		} else if (pastTear) {
			lineType = LINE_ORIGIN;
			colorType = LINE_ORIGIN;
		} else if (pastTagline) {
			lineType = LINE_TAGLINE;
			colorType = LINE_TAGLINE;
		}

		// Word wrap plain lines — don't wrap if text has any embedded codes
		// (ANSI positioning, pipe conversions, etc. would break on wrap)
		// Don't wrap separator or origin lines either (structural)
		if (wrapWidth > 0 && !hasEmbeddedCodes &&
			lineType !== LINE_TEAR && lineType !== LINE_TAGLINE && lineType !== LINE_ORIGIN) {
			var wrapped = wordWrapLine(line, wrapWidth);
			for (var w = 0; w < wrapped.length; w++) {
				result.push({
					text: wrapped[w],
					type: lineType,
					colorPrefix: buildColorPrefix(colorType, clrBody, clrQuote, clrTear, clrTagline, clrOrigin, clrKludge)
				});
			}
		} else {
			// Always apply semantic color prefix at the start of the line
			// UNLESS this is ANSI art — art uses cursor positioning and
			// full-screen layout where a line-start color would interfere.
			var prefix = "";
			if (!isAnsiArt) {
				prefix = buildColorPrefix(colorType, clrBody, clrQuote, clrTear, clrTagline, clrOrigin, clrKludge);
			}

			result.push({
				text: line,
				type: lineType,
				colorPrefix: prefix
			});
		}
	}

	return result;
}

// Build ANSI SGR prefix for a line type
function buildColorPrefix(lineType, clrBody, clrQuote, clrTear, clrTagline, clrOrigin, clrKludge) {
	var clr;
	switch (lineType) {
		case LINE_QUOTE:   clr = clrQuote; break;
		case LINE_TEAR:    clr = clrTear; break;
		case LINE_TAGLINE: clr = clrTagline; break;
		case LINE_ORIGIN:  clr = clrOrigin; break;
		case LINE_KLUDGE:  clr = clrKludge; break;
		default:           clr = clrBody; break;
	}
	return fgColorToAnsi(clr);
}

// Convert a color number (0-15) to an ANSI SGR escape sequence.
// Uses color-only SGR (no reset) so it doesn't wipe attributes set by resetcolors().
// Colors 0-7: normal intensity, 8-15: bold/bright.
function fgColorToAnsi(num) {
	if (num > 7) {
		return "\x1b[1;" + (num + 30 - 8) + "m";
	} else {
		return "\x1b[" + (num + 30) + "m";
	}
}

// Simple word wrap (same logic as reader but returns array for a single line)
function wordWrapLine(line, maxWidth) {
	if (!line || line.length <= maxWidth) return [line || ""];
	var result = [];
	var remaining = line;
	while (remaining.length > maxWidth) {
		var breakAt = remaining.lastIndexOf(" ", maxWidth);
		if (breakAt <= 0) breakAt = maxWidth;
		result.push(remaining.substring(0, breakAt));
		remaining = remaining.substring(breakAt);
		if (remaining.charAt(0) === " ") remaining = remaining.substring(1);
	}
	result.push(remaining);
	return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	processMessageBody,
	convertCP437toUTF8,
	convertUTF8toCP437,
	convertPipeCodes,
	convertCtrlACodes,
	hasColorCodes,
	hasAnsiCodes,
	hasPipeCodes,
	hasCtrlACodes,
	detectAnsiArt,
	classifyLine,
	LINE_NORMAL,
	LINE_QUOTE,
	LINE_TEAR,
	LINE_TAGLINE,
	LINE_ORIGIN,
	LINE_KLUDGE,
	// Default colors for external reference
	DF_CLR_BODY,
	DF_CLR_QUOTE,
	DF_CLR_TEAR,
	DF_CLR_TAGLINE,
	DF_CLR_ORIGIN,
	DF_CLR_KLUDGE,
};
