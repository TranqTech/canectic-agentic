/**
 * What a stored message body actually says, whatever convention wrote it.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS A BRIDGE. It exists to be deleted. See issue on normalising
 * body_text, and the NORMALISATION note at the bottom.
 * ---------------------------------------------------------------------------
 *
 * `body_text` and `utf8` have no single agreed meaning. Three importers write
 * them three different ways, and every exporter has been guessing which one it
 * is looking at:
 *
 *   FTN    body_text = Unicode text, utf8 = the same string
 *   QWK    body_text = raw CP437 bytes held as latin-1 chars, utf8 = converted
 *   NNTP   body_text = decoded text, utf8 = null (except a CP437 crosspost)
 *
 * Measured over 7,818 sampled messages on a live board: 5,529 with
 * body_text === utf8, 2,289 with them different, and 590 whose body_text
 * contains characters above U+00FF — which is proof on its own that it is not
 * raw CP437, since raw bytes held as latin-1 cannot exceed U+00FF.
 *
 * The guessing is what corrupted outbound mail. The QWK packer assumed
 * "utf8 is set, therefore body_text is raw CP437", which is true of a QWK
 * message and false of an FTN one, so relaying an FTN message into a QWK
 * packet turned `Γöî` into `ô÷ε`.
 *
 * So the guess lives here, once, and every exporter asks instead of deciding.
 * That is the whole point: when body_text is normalised, there is exactly one
 * function to change rather than three exporters to re-derive.
 */

/**
 * The message body as Unicode text, ready to be encoded for any wire format.
 *
 * @param {object} msg - a row with body_text and (maybe) utf8
 * @returns {string}
 */
export function canonicalText(msg) {
	if (!msg) return '';

	var body = msg.body_text == null ? '' : String(msg.body_text);
	var utf8 = msg.utf8 == null ? null : String(msg.utf8);

	// No utf8 column: body_text is already text. NNTP and locally authored
	// messages land here.
	if (utf8 === null || utf8 === '') return body;

	// utf8 differs from body_text: body_text is the raw form and utf8 is the
	// decoded one. This is the QWK shape.
	if (utf8 !== body) return utf8;

	// Identical: both hold the same text, so either will do. The FTN shape.
	//
	// A pure-ASCII QWK message also lands here, because converting ASCII from
	// CP437 changes nothing — and that is harmless, since the two readings
	// agree for exactly the inputs where they are indistinguishable.
	return body;
}

/**
 * Does this body still look like raw bytes rather than text?
 *
 * Raw CP437 held as latin-1 cannot contain a character above U+00FF, so
 * anything that does is definitely text. Used by the exporters to refuse the
 * one assumption that silently corrupted mail, rather than trusting it.
 */
export function looksLikeRawBytes(text) {
	if (!text) return true;
	for (var ch of String(text)) {
		if (ch.codePointAt(0) > 0xFF) return false;
	}
	return true;
}

/*
 * NORMALISATION
 * -------------
 * When body_text becomes canonical Unicode for every source and the utf8
 * column is retired:
 *
 *   1. canonicalText collapses to `return msg.body_text || ''`
 *   2. Its callers can then read body_text directly and this file goes
 *   3. looksLikeRawBytes has no meaning once nothing stores raw bytes
 *
 * Callers, so the sweep is not a search: qwkClasses.buildRepPacket,
 * qwkPacketBuilder.buildMessagesDat, nntpTosser.formatNntpArticle.
 * The FTN tosser does not call it — echomail already hands it Unicode.
 */
