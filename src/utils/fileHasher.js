// fileHasher.js — Compute file hashes for dupe checking and integrity
//
// CRC-32: used by TIC standard, fast dupe check
// SHA-256: modern integrity check

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

/**
 * Compute CRC-32 of a file.  Returns uppercase hex string (e.g. "1A2B3C4D").
 */
function computeCRC32(filePath) {
	var data = fs.readFileSync(filePath);
	var crc = zlib.crc32(data);
	// crc32 returns a signed 32-bit int; convert to unsigned hex
	return (crc >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Compute SHA-256 of a file.  Returns lowercase hex string.
 */
function computeSHA256(filePath) {
	var data = fs.readFileSync(filePath);
	return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute both hashes.  Returns { crc32, sha256 }.
 */
function computeHashes(filePath) {
	var data = fs.readFileSync(filePath);
	var crc = zlib.crc32(data);
	var sha = crypto.createHash('sha256').update(data).digest('hex');
	return {
		crc32: (crc >>> 0).toString(16).toUpperCase().padStart(8, '0'),
		sha256: sha
	};
}

export { computeCRC32, computeSHA256, computeHashes };
