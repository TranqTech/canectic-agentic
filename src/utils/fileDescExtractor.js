// fileDescExtractor.js — Extract FILE_ID.DIZ from archives and populate descriptions
//
// Checks if a file is a supported archive, looks for FILE_ID.DIZ (case-insensitive),
// extracts its contents for long_desc, generates long_desc_html via formatBodyHtml,
// and derives short_desc from the first non-blank line if not already set.
//
// Supported archives: ZIP (via adm-zip)
// Future: RAR, 7z, ARJ, LHA if needed

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { formatBodyHtml } from './terminalText.js';
import * as alogger from './alogger.js';

/**
 * Extract description info from a file on disk.
 *
 * @param {string} filePath — absolute path to the file
 * @returns {{ long_desc: string|null, long_desc_html: string|null, short_desc: string|null }}
 */
function extractDescription(filePath) {
	var result = { long_desc: null, long_desc_html: null, short_desc: null };

	if (!filePath || !fs.existsSync(filePath)) return result;

	try {
		var dizText = extractDizFromZip(filePath);
		if (!dizText) return result;

		// Clean up: trim trailing whitespace/newlines, normalize line endings
		dizText = dizText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

		result.long_desc = dizText;

		// Generate HTML rendering (handles ANSI art, pipe codes, CP437)
		try {
			var html = formatBodyHtml(dizText);
			// formatBodyHtml may return {} for plain text — only store if it's a real string
			if (html && typeof html === 'string' && html.length > 0) {
				result.long_desc_html = html;
			} else {
				// Fall back to simple HTML: escape and convert newlines to <br>
				result.long_desc_html = dizText
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/\n/g, '<br>');
			}
		} catch (htmlErr) {
			alogger.writeAlog(4, "[fileDescExtractor] HTML render failed: " + htmlErr.message, "yellow");
		}

		// Derive short_desc from first non-blank line
		var lines = dizText.split('\n');
		for (var line of lines) {
			var trimmed = line.trim();
			if (trimmed.length > 0) {
				result.short_desc = trimmed.length > 255 ? trimmed.substring(0, 252) + '...' : trimmed;
				break;
			}
		}

	} catch (err) {
		alogger.writeAlog(4, "[fileDescExtractor] Error processing " + path.basename(filePath) + ": " + err.message, "yellow");
	}

	return result;
}

/**
 * Try to extract FILE_ID.DIZ from a ZIP archive.
 * Returns the text content or null if not found/not a ZIP.
 */
function extractDizFromZip(filePath) {
	try {
		var zip = new AdmZip(filePath);
		var entries = zip.getEntries();

		for (var entry of entries) {
			var entryName = entry.entryName || '';
			// Match FILE_ID.DIZ anywhere in the archive (case-insensitive)
			var basename = path.basename(entryName).toUpperCase();
			if (basename === 'FILE_ID.DIZ') {
				var buffer = entry.getData();
				if (buffer && buffer.length > 0) {
					return buffer.toString('utf8');
				}
			}
		}
	} catch (_) {
		// Not a ZIP or corrupt — that's fine, just return null
	}

	return null;
}

/**
 * Apply extracted descriptions to a file entry object.
 * Only fills in fields that are currently empty/null.
 *
 * @param {object} entryObj — file entry fields (mutated in place)
 * @param {string} filePath — absolute path to the file
 * @returns {boolean} — true if any descriptions were populated
 */
function applyDescriptions(entryObj, filePath) {
	var desc = extractDescription(filePath);
	var changed = false;

	if (desc.long_desc && !entryObj.long_desc) {
		entryObj.long_desc = desc.long_desc;
		changed = true;
	}
	if (desc.long_desc_html && !entryObj.long_desc_html) {
		entryObj.long_desc_html = desc.long_desc_html;
		changed = true;
	}
	if (desc.short_desc && !entryObj.short_desc) {
		entryObj.short_desc = desc.short_desc;
		changed = true;
	}

	return changed;
}

export { extractDescription, extractDizFromZip, applyDescriptions };
