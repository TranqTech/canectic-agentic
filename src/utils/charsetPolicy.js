/**
 * What character set an area's outbound mail is written in.
 *
 * Three settings, on `message_areas.charset`:
 *
 *   auto    per message: CP437 when the body fits it losslessly, UTF-8 when
 *           it does not. The default, and right for nearly every echo.
 *   cp437   always CP437, whatever is lost. For an echo whose members run
 *           software that will not honour a CHRS kludge.
 *   utf8    always UTF-8. For a modern network that has agreed on it.
 *
 * Whichever is chosen, the message DECLARES what it carries with a CHRS
 * kludge. Writing undeclared UTF-8 is what caused the problem this exists to
 * fix: FTN's default is CP437, so an undeclared UTF-8 body is read through the
 * CP437 table and every multi-byte character becomes mojibake.
 *
 * Why the setting is per AREA rather than per link: the encoding of an echo is
 * a property of the echo, agreed by everyone carrying it. Per link, the same
 * message would go out in different encodings to different peers, and a
 * downlink relaying onward would have no idea which was intended.
 *
 * `auto` is not a dodge. Of 113,079 messages held here, 163 carry a CHRS at
 * all, so the ecosystem runs on the CP437 default and anything that fits CP437
 * should be sent that way. Only the content that genuinely cannot be is worth
 * the risk of a declaration the receiver may ignore.
 */

export const CHARSET_MODES = ['auto', 'cp437', 'utf8'];

export const CHARSET_MODE_LABELS = {
	auto:  'Automatic (CP437 where it fits)',
	cp437: 'Always CP437',
	utf8:  'Always UTF-8',
};

export function normaliseCharsetMode(value, fallback) {
	var mode = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
	if (CHARSET_MODES.indexOf(mode) !== -1) return mode;
	return fallback || 'auto';
}

export function isCharsetMode(value) {
	if (value === undefined || value === null) return false;
	return CHARSET_MODES.indexOf(String(value).trim().toLowerCase()) !== -1;
}

export function charsetModeLabel(value) {
	return CHARSET_MODE_LABELS[normaliseCharsetMode(value)];
}

/**
 * Can this text be written in CP437 without losing anything?
 *
 * utf8ToCp437 substitutes '?' for characters it has no mapping for, so the
 * honest test is a round trip: encode, decode, compare. Anything that does not
 * come back identical would have been quietly degraded.
 *
 * @param {string} text
 * @param {object} cp - the codepageConversions module (injected so this stays
 *                      pure and testable)
 */
export function fitsCp437(text, cp) {
	if (!text) return true;
	try {
		var bytes = cp.utf8ToCp437(text, true);
		return cp.cp437ToUtf8(bytes) === text;
	} catch (_) {
		return false;
	}
}

/**
 * The charset a message should actually be written in.
 *
 * `auto` asks whether the content fits CP437 and uses it when it does, because
 * a CP437 body is understood by everything on the network without relying on a
 * kludge almost nobody reads.
 */
export function charsetForMessage(mode, text, cp) {
	var m = normaliseCharsetMode(mode);
	if (m === 'cp437') return 'cp437';
	if (m === 'utf8') return 'utf8';
	return fitsCp437(text, cp) ? 'cp437' : 'utf8';
}

// ---------------------------------------------------------------------------
// Inbound: what a message we RECEIVE is written in (#57)
// ---------------------------------------------------------------------------
//
// A declared CHRS is believed. Without one, FTN's default is CP437, but plenty
// of software sends UTF-8 and declares nothing, and reading that through the
// CP437 table stores mojibake permanently (U+2019 as "ΓÇÖ", "Jörg" as
// "J├╢rg"): the hub held about 18,000 such messages. So an undeclared message
// is taken as UTF-8 when its bytes are valid UTF-8 and contain at least one
// multi-byte sequence, and as CP437 otherwise.
//
// Genuine CP437 text almost never passes: a lone accented letter (é is 0x82,
// a continuation byte with no lead) or a run of box drawing (═ is 0xCD, a lead
// byte followed by another lead) is invalid UTF-8, and it takes one invalid
// sequence anywhere in the message to fail it. That is why the test is on the
// whole message and never on a fragment: a pair such as █░ (0xDB 0xB0) is
// valid UTF-8 by itself, and art full of them would be misread fragment by
// fragment while the whole message still fails.

var strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether bytes are valid UTF-8 carrying at least one multi-byte character.
 * Pure ASCII answers false: it is the same in either reading.
 */
export function looksLikeUtf8(bytes) {
	if (!bytes || !bytes.length) return false;
	var multi = false;
	for (var i = 0; i < bytes.length; i++) {
		if (bytes[i] >= 0x80) { multi = true; break; }
	}
	if (!multi) return false;
	try {
		strictUtf8.decode(bytes);
		return true;
	} catch (_) {
		return false;
	}
}

/**
 * The charset to read a received message in.
 *
 * declared: 'utf8' | 'latin1' | 'cp437' from a CHRS kludge, or null for none
 * bytes:    every byte the charset applies to (header strings and body)
 */
export function inboundCharset(declared, bytes) {
	if (declared) return declared;
	return looksLikeUtf8(bytes) ? 'utf8' : 'cp437';
}
