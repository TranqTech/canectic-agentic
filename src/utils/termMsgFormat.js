// termMsgFormat.js — Message body formatting utility.
//
// Handles:
//   - CP437 → UTF-8 conversion for UTF-8 terminals receiving CP437 text
//   - UTF-8 → CP437 conversion for CP437 terminals receiving UTF-8 text
//   - Pipe code (|XX) → ANSI escape sequence conversion
//   - Synchronet Ctrl-A attribute codes → ANSI escape sequence conversion
//   - Semantic line coloring (normal, quote, tear, origin, tagline)
//   - Paragraph reflow for text from wider editors
//   - ANSI-aware word wrapping
//   - ANSI art detection
//   - ANSI passthrough (existing escape codes are preserved, never stripped)
//   - HTML body formatting for web display (shared by all tossers)
//
// Used by:
//   - msgReader.js (terminal message display)
//   - echomail.js, qwkTosser.js, nntpTosser.js (HTML body generation at import time)

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

// Box drawing (U+2500-U+257F) and block elements (U+2580-U+259F), which is
// what CP437 0xB0-0xDF becomes after convertCP437toUTF8.
var ART_GLYPH = /[\u2500-\u259F]/g;
var ART_GLYPH_RUN = /[\u2500-\u259F]{2,}/g;

// A line is art-like if it is built substantially out of box/block glyphs:
// either a run of several together, or glyphs making up a third of it.
var ART_MIN_RUN = 8;
var ART_MIN_DENSITY = 0.30;

// ...and the message is art if at least two such lines exist and at least one
// of them spans a real width. The width test is what separates a drawing from
// a signature rule: `----` under a sig is two narrow art-like lines, a drawn
// header and footer are two wide ones.
var ART_MIN_LINES = 2;
var ART_MIN_WIDTH = 40;

// Visible width of a line, with escape sequences removed.
function _bareLine(line) {
	return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Widths of the art-like lines in a message, in the order they appear.
 * Exported so a test can say WHY a verdict came out as it did rather than
 * only that it did.
 */
function artLineWidths(text) {
	var widths = [];
	if (!text) return widths;

	for (var line of String(text).split(/\r\n|\r|\n/)) {
		var bare = _bareLine(line).trim();
		if (!bare) continue;

		var glyphs = (bare.match(ART_GLYPH) || []).length;
		if (glyphs === 0) continue;

		var longestRun = 0;
		for (var run of (bare.match(ART_GLYPH_RUN) || [])) {
			if (run.length > longestRun) longestRun = run.length;
		}

		if (longestRun >= ART_MIN_RUN || (glyphs / bare.length) >= ART_MIN_DENSITY) {
			widths.push(bare.length);
		}
	}
	return widths;
}

// Detect ANSI art vs. simple colored text.
//
// Two independent signals, because art is drawn two different ways:
//
//   1. Cursor positioning (CSI ending in A/B/C/D/H/f/J/K/s/u). Classic .ANS.
//   2. SGR colour plus CP437 block glyphs, which contains no cursor movement
//      at all and so read as ordinary coloured text under signal 1 alone.
//
// Signal 2 was missing, and its absence is not cosmetic. The caller uses this
// answer to decide whether to run paragraph reflow, and reflow JOINS any
// consecutive line at or above 80% of the wrap width — which every 78-to-80
// column art row is. Three rows of block art became one line, in a way no
// later stage could undo, and body_html is written once at toss time.
//
// Signal 2 is deliberately a whole-message test rather than a per-line one.
// Protecting only the glyph-dense lines leaves the text laid out BETWEEN a
// drawn header and footer still being joined to itself and to the footer,
// which is the same damage one row down.
//
// Known limit: prose carrying two or more full-width rules reads as art and
// loses paragraph reflow. That is the deliberate trade — reflow currently
// merges such a rule onto the end of the preceding sentence, so treating it as
// art is not obviously the worse answer, and no shape test separates the two.
//
// Pipe codes and Ctrl-A codes are always simple color — never art.
function detectAnsiArt(text) {
	if (!text) return false;

	// Signal 1: any CSI sequence that is NOT just SGR (color).
	// CSI = ESC [ <params> <final byte>
	// SGR final byte is 'm'. Cursor positioning uses A,B,C,D,H,f,J,K,s,u etc.
	if (/\x1b\[\d*[ABCDHJKfsu]/.test(text) ||          // Single-param positioning
	    /\x1b\[\d+;\d+[Hf]/.test(text) ||               // Two-param cursor position
	    /\x1b\[2?[JK]/.test(text)) {                     // Screen/line clear
		return true;
	}

	// Signal 2: drawn with block glyphs.
	var widths = artLineWidths(text);
	if (widths.length < ART_MIN_LINES) return false;
	for (var w of widths) {
		if (w >= ART_MIN_WIDTH) return true;
	}
	return false;
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

	// body_text is canonical Unicode for every source (migration 0006). There
	// is nothing left to convert here, and the conversion that used to happen
	// was wrong: it fired whenever utf8 was null, which is every NNTP message,
	// and ran already-decoded text through the CP437 table.
	var rawText = msg.body_text || "";

	// Detect what kind of color codes are present BEFORE conversion
	var hasPipe = hasPipeCodes(rawText);
	var hasCtrlA = hasCtrlACodes(rawText);
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

	// Paragraph reflow pass — join consecutive normal body lines that appear
	// to be soft-wrapped by a wider editor (>65 visible chars) into full
	// paragraphs so our wrapper can re-wrap them cleanly at our width.
	//
	// Without this, text written at 90 cols and hard-wrapped would produce
	// orphan words ("and", "on") when re-wrapped at 78 cols.
	//
	// Rules:
	//   JOIN current line with next line if ALL are true:
	//     - Current line is normal text (not quote, structural, blank)
	//     - Next line is normal text and non-blank
	//     - Current line's visual width >= REFLOW_THRESHOLD
	//     - Next line doesn't start with whitespace (preserves indentation)
	//   NEVER JOIN across:
	//     - Blank lines (paragraph separators)
	//     - Quote lines, structural lines (tear, tagline, origin, kludge)
	//     - Short lines (intentionally formatted — list items, etc.)
	//     - Lines where the next starts with space/tab (preformatted)
	if (wrapWidth > 0 && !isAnsiArt) {
		sourceLines = reflowParagraphs(sourceLines, wrapWidth);
	}

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

		// Word wrap. Skip wrapping for:
		//   - ANSI art (cursor positioning — whole message flag)
		//   - Structural lines (tear, tagline, origin)
		// For lines with ANSI escape sequences (from pipe/ctrl-a conversion),
		// use the ANSI-aware wrapper that tracks visual width.
		if (wrapWidth > 0 && !isAnsiArt &&
			lineType !== LINE_TEAR && lineType !== LINE_TAGLINE && lineType !== LINE_ORIGIN) {
			var lineHasAnsi = line.includes("\x1b[");
			var wrapped = lineHasAnsi ? wordWrapLineAnsi(line, wrapWidth) : wordWrapLine(line, wrapWidth);
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

// ---------------------------------------------------------------------------
// Paragraph reflow — join soft-wrapped lines from wider editors
// ---------------------------------------------------------------------------

// Minimum visual width for a line to be considered "soft-wrapped by a wider
// editor." Lines shorter than this are assumed intentionally short (list items,
// signatures, short paragraphs) and won't be joined to the next line.
// Set relative to wrapWidth: if we're wrapping at 78, a line at 65+ was likely
// wrapped at 80+ and should be reflowed. This avoids reflowing genuinely short
// lines while catching the common 80/90/100-col editor outputs.
var REFLOW_MIN_RATIO = 0.80; // line must be at least 80% of wrapWidth

// A line that is laid out rather than written: never join it, or anything onto
// it. Any of these is enough:
//   - two or more gaps of 3+ spaces, which is columns;
//   - one gap of 4+ spaces, which is alignment (`Recipe By     : ...`);
//   - mostly punctuation rather than letters and digits, which is drawing:
//     `| \ / |`, `--==[ ]==--`, `+-----+`.
// A single gap of exactly three spaces is left to prose: across eight busy
// areas on the dev board it was an accidental extra space in real sentences
// seven times out of eight. Erring that way costs less anyway: an unjoined
// prose line only breaks its paragraph early, a joined layout line is destroyed.
// ASCII art is neither cursor movement nor block glyphs, so detectAnsiArt
// does not see it and the message is reflowed. Every row of 64 characters or
// more was joined to the next, so a 72-column drawing came out as 148-column
// lines that then wrapped: broken rows with extra lines between them. Found on
// ALTBBSADS, reading at 80 columns on a phone (#54).
var LAYOUT_MIN_INK = 20;
var LAYOUT_MAX_WORD_SHARE = 0.5;

function isLaidOut(line) {
	var bare = _bareLine(String(line || '')).trim();
	if (!bare) return false;
	var gaps = bare.match(/ {3,}/g) || [];
	if (gaps.length >= 2) return true;
	if (gaps.length === 1 && gaps[0].length >= 4) return true;
	var ink = bare.replace(/\s+/g, '');
	if (ink.length < LAYOUT_MIN_INK) return false;
	var word = (ink.match(/[\p{L}\p{N}]/gu) || []).length;
	return word / ink.length < LAYOUT_MAX_WORD_SHARE;
}

function reflowParagraphs(lines, wrapWidth) {
	var threshold = Math.floor(wrapWidth * REFLOW_MIN_RATIO);
	if (threshold < 40) threshold = 40;

	var result = [];
	var i = 0;

	while (i < lines.length) {
		var line = lines[i];
		var lineType = classifyLine(line);

		// Non-normal lines pass through unchanged
		if (lineType !== LINE_NORMAL || line.trim().length === 0) {
			result.push(line);
			i++;
			continue;
		}

		// Normal non-blank line — check if we should join with subsequent lines
		var visWidth = measureVisualWidth(line);

		// If this line is short, or laid out, it's intentionally formatted — don't join
		if (visWidth < threshold || isLaidOut(line)) {
			result.push(line);
			i++;
			continue;
		}

		// Line is long enough to be a candidate for reflow.
		// Accumulate lines into a paragraph until we hit a break condition.
		var para = line;
		i++;

		while (i < lines.length) {
			var nextLine = lines[i];
			var nextType = classifyLine(nextLine);
			var nextTrimmed = nextLine.trim();

			// Stop joining at:
			//   - Blank lines (paragraph boundary)
			//   - Non-normal lines (quotes, structural, kludge)
			//   - Lines starting with whitespace (preformatted/indented)
			if (nextTrimmed.length === 0 ||
				nextType !== LINE_NORMAL ||
				nextLine.charAt(0) === " " ||
				nextLine.charAt(0) === "\t" ||
				isLaidOut(nextLine)) {
				break;
			}

			// Join — add a space between the lines
			// (the previous line's trailing space, if any, is already there)
			if (para.charAt(para.length - 1) === " ") {
				para += nextTrimmed;
			} else {
				para += " " + nextTrimmed;
			}
			i++;

			// Check if the newly joined paragraph's last source line was short
			// (meaning the original author ended the paragraph here).
			// We measure the visual width of the line we just consumed.
			var consumedWidth = measureVisualWidth(nextLine);
			if (consumedWidth < threshold) {
				// This was likely the last line of the paragraph — stop joining
				break;
			}
		}

		result.push(para);
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

// ANSI-aware word wrap. ANSI escape sequences (ESC [ ... final_byte) contribute
// zero visual width but take up string space. This function tracks visual column
// position separately from string position to wrap at the correct visual boundary.
//
// Walk the string measuring visual width. When it exceeds maxWidth, find the
// nearest space boundary (by string position near the visual break point) and
// split. ANSI sequences stay attached to the text around them.
//
// Safe assumption: our ANSI sequences are all SGR (digits, semicolons, 'm').
// Space (0x20) never appears inside them, so any space found is a valid break.
function wordWrapLineAnsi(line, maxWidth) {
	if (!line) return [""];

	// Quick check — if visual width fits, no wrap needed
	if (measureVisualWidth(line) <= maxWidth) return [line];

	var result = [];
	var remaining = line;

	while (remaining.length > 0) {
		var rvis = measureVisualWidth(remaining);
		if (rvis <= maxWidth) {
			result.push(remaining);
			break;
		}

		// Find the string index where visual column reaches maxWidth
		var breakStringIdx = findStringIndexAtVisualCol(remaining, maxWidth);

		// Search backward for a space to break on
		var spaceIdx = -1;
		for (var s = breakStringIdx; s >= 0; s--) {
			if (remaining.charAt(s) === " ") {
				spaceIdx = s;
				break;
			}
		}

		if (spaceIdx <= 0) {
			// No good break point — hard break at visual width boundary
			spaceIdx = breakStringIdx;
		}

		result.push(remaining.substring(0, spaceIdx));
		remaining = remaining.substring(spaceIdx);
		if (remaining.charAt(0) === " ") remaining = remaining.substring(1);
	}

	if (result.length === 0) result.push("");
	return result;
}

// Measure the visual (column) width of a string, skipping ANSI CSI sequences.
// CSI = ESC [ <params> <final_byte> where final byte is 0x40-0x7E (@-~).
function measureVisualWidth(str) {
	var width = 0;
	var inEsc = false;
	for (var i = 0; i < str.length; i++) {
		var ch = str.charCodeAt(i);
		if (inEsc) {
			if (ch >= 0x40 && ch <= 0x7E) inEsc = false;
		} else if (ch === 0x1B && i + 1 < str.length && str.charCodeAt(i + 1) === 0x5B) {
			inEsc = true;
			i++; // skip the [
		} else {
			width++;
		}
	}
	return width;
}

// Find the string index where the visual column reaches targetCol.
// Returns the string position just past the character at that visual column.
function findStringIndexAtVisualCol(str, targetCol) {
	var vis = 0;
	var inEsc = false;
	for (var i = 0; i < str.length; i++) {
		var ch = str.charCodeAt(i);
		if (inEsc) {
			if (ch >= 0x40 && ch <= 0x7E) inEsc = false;
		} else if (ch === 0x1B && i + 1 < str.length && str.charCodeAt(i + 1) === 0x5B) {
			inEsc = true;
			i++; // skip the [
		} else {
			vis++;
			if (vis >= targetCol) return i + 1;
		}
	}
	return str.length;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// Convenience: reflow a raw text string and return the reflowed string.
// Used by tossers to pre-process message text before HTML formatting.
// Joins with \r because VirtualTerminal uses \r for line breaks (FTN convention).
function reflowText(text, wrapWidth) {
	if (!text) return text;
	var normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	var lines = normalized.split("\n");
	var reflowed = reflowParagraphs(lines, wrapWidth || 80);
	return reflowed.join("\r");
}

export {
	isLaidOut,
	artLineWidths,
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
	reflowText,
	reflowParagraphs,
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
