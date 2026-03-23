// transfers/crc.js — CRC-16 (CCITT/XMODEM) and CRC-32 routines.
//
// Pure JavaScript, table-driven implementations. No npm dependencies.
// CRC-16: polynomial 0x1021, init 0x0000 — used by XMODEM-CRC and ZMODEM hex headers.
// CRC-32: polynomial 0xEDB88320 (reflected) — used by ZMODEM data subpackets.

// --- CRC-16 lookup table (polynomial 0x1021) ---

var crc16Table = new Uint16Array(256);
(function() {
	for (var i = 0; i < 256; i++) {
		var crc = i << 8;
		for (var j = 0; j < 8; j++) {
			if (crc & 0x8000) {
				crc = (crc << 1) ^ 0x1021;
			} else {
				crc = crc << 1;
			}
		}
		crc16Table[i] = crc & 0xFFFF;
	}
})();

/**
 * Compute CRC-16 (CCITT, polynomial 0x1021, init 0).
 * Used by XMODEM-CRC, YMODEM, and ZMODEM hex headers.
 * @param {Buffer} buf
 * @param {number} [init=0] — initial CRC value
 * @returns {number} — 16-bit CRC
 */
function crc16(buf, init) {
	var crc = (init !== undefined ? init : 0) & 0xFFFF;
	for (var i = 0; i < buf.length; i++) {
		crc = ((crc << 8) ^ crc16Table[((crc >>> 8) ^ buf[i]) & 0xFF]) & 0xFFFF;
	}
	return crc;
}

/**
 * Compute CRC-16 using the lrzsz/ZMODEM data subpacket variant.
 * Formula: table[(crc>>8) & 0xFF] ^ (crc<<8) ^ byte
 * This differs from standard CCITT by applying the byte AFTER the table lookup.
 * Used by ZMODEM data subpackets. Must be augmented with two zero bytes.
 * @param {Buffer} buf
 * @param {number} [init=0]
 * @returns {number} — 16-bit CRC
 */
function crc16zmodem(buf, init) {
	var crc = (init !== undefined ? init : 0) & 0xFFFF;
	for (var i = 0; i < buf.length; i++) {
		crc = (crc16Table[(crc >>> 8) & 0xFF] ^ (crc << 8) ^ buf[i]) & 0xFFFF;
	}
	return crc;
}

// --- CRC-32 lookup table (polynomial 0xEDB88320, reflected) ---

var crc32Table = new Uint32Array(256);
(function() {
	for (var i = 0; i < 256; i++) {
		var crc = i;
		for (var j = 0; j < 8; j++) {
			if (crc & 1) {
				crc = (crc >>> 1) ^ 0xEDB88320;
			} else {
				crc = crc >>> 1;
			}
		}
		crc32Table[i] = crc >>> 0;
	}
})();

/**
 * Compute CRC-32 (standard, polynomial 0xEDB88320 reflected).
 * Used by ZMODEM data subpackets and ZBIN32 headers.
 * @param {Buffer} buf
 * @param {number} [init=0xFFFFFFFF] — initial CRC value
 * @returns {number} — 32-bit CRC (unsigned)
 */
function crc32(buf, init) {
	var crc = (init !== undefined ? init : 0xFFFFFFFF) >>> 0;
	for (var i = 0; i < buf.length; i++) {
		crc = (crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Update CRC-32 without finalizing (XOR). Used for incremental computation
 * across multiple buffers in streaming ZMODEM.
 * @param {Buffer} buf
 * @param {number} [running=0xFFFFFFFF]
 * @returns {number} — running CRC (not finalized)
 */
function crc32update(buf, running) {
	var crc = (running !== undefined ? running : 0xFFFFFFFF) >>> 0;
	for (var i = 0; i < buf.length; i++) {
		crc = (crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
	}
	return crc;
}

/**
 * Finalize a running CRC-32.
 * @param {number} running
 * @returns {number}
 */
function crc32finalize(running) {
	return (running ^ 0xFFFFFFFF) >>> 0;
}

export { crc16, crc16zmodem, crc32, crc32update, crc32finalize };
