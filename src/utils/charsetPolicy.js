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
