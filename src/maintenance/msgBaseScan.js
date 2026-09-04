// msgBaseScan.js - Discover message bases on disk and match them to areas.
//
// Migrating a hub means importing hundreds of message bases, which is not
// practical through a per-base upload form. This scans a directory, groups the
// files into bases, reads each base's fixed header for a message count, and
// suggests a local area for each one.
//
// The scan is flat: one directory, no recursion. Mystic, Synchronet and the
// husky tools all keep their bases in a single directory, and a recursive walk
// would make base name collisions possible for no real gain.

import { readdirSync, statSync, existsSync } from 'fs';
import * as path from 'path';
import * as postgres from '../middleware/db/postgres.js';
import { statSMB } from '../utils/smbParser.js';
import { statJAM } from '../utils/jamParser.js';
import { substitute } from '../utils/configvars.js';
import * as alogger from '../utils/alogger.js';

// Resolve a sysop-supplied scan directory. %X substitution (which also expands
// ~) then plain resolution against the process working directory. Deliberately
// not resolveFileboxPath: that defaults relative paths under filebox_base_dir,
// which is the wrong base for a message base directory.
function resolveScanDir(dir) {
	var expanded = substitute(String(dir || '').trim());
	if (!expanded) return '';
	return path.resolve(expanded);
}

// Per-format file layout. `header` is the file that defines a base, `data`
// must also be present, `index` is optional.
var FORMAT_FILES = {
	smb: { header: '.shd', data: '.sdt', index: '.sid', stat: statSMB },
	jam: { header: '.jhr', data: '.jdt', index: '.jdx', stat: statJAM },
};

// --- Scan a directory for message bases of a given format ---
//
// Returns { status, dir, bases[], error }
// Each base: { name, format, headerPath, dataPath, indexPath, totalMsgs,
//              bytes, error }
//
// A base whose header parses but whose data file is missing is reported with
// an error rather than silently dropped, so a half-copied migration is visible.

function scanDirectory(dir, format) {
	var result = { status: false, dir: dir, bases: [], error: null };

	var spec = FORMAT_FILES[format];
	if (!spec) {
		result.error = 'Unknown message base format: ' + format;
		return result;
	}

	var resolved;
	try {
		resolved = resolveScanDir(dir);
	} catch (err) {
		result.error = 'Could not resolve directory: ' + err.message;
		return result;
	}
	result.dir = resolved;

	if (!resolved) {
		result.error = 'No directory given';
		return result;
	}

	if (!existsSync(resolved)) {
		result.error = 'Directory not found: ' + resolved;
		return result;
	}

	var entries;
	try {
		entries = readdirSync(resolved);
	} catch (err) {
		result.error = 'Could not read directory: ' + err.message;
		return result;
	}

	// Index every filename by lowercase name so companion lookups survive the
	// mixed case that DOS-era tools leave behind (FOO.JHR next to foo.jdt).
	var byLower = new Map();
	for (var i = 0; i < entries.length; i++) {
		byLower.set(entries[i].toLowerCase(), entries[i]);
	}

	function actualPath(lowerName) {
		var real = byLower.get(lowerName);
		return real ? path.join(resolved, real) : null;
	}

	for (var j = 0; j < entries.length; j++) {
		var entry = entries[j];
		var lower = entry.toLowerCase();
		if (!lower.endsWith(spec.header)) continue;

		var baseName = entry.slice(0, entry.length - spec.header.length);
		var baseLower = baseName.toLowerCase();

		var headerPath = path.join(resolved, entry);
		var dataPath   = actualPath(baseLower + spec.data);
		var indexPath  = actualPath(baseLower + spec.index);

		var base = {
			name:       baseName,
			format:     format,
			headerPath: headerPath,
			dataPath:   dataPath || '',
			indexPath:  indexPath || '',
			totalMsgs:  0,
			bytes:      0,
			error:      null,
		};

		if (!dataPath) {
			base.error = 'Missing ' + spec.data + ' file';
			result.bases.push(base);
			continue;
		}

		try {
			base.bytes = statSync(headerPath).size + statSync(dataPath).size;
		} catch (_) { /* size is informational */ }

		var stat = spec.stat(headerPath);
		if (!stat.status) {
			base.error = stat.error;
		} else {
			base.totalMsgs = stat.totalMsgs;
		}

		result.bases.push(base);
	}

	result.bases.sort(function (a, b) {
		return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
	});

	result.status = true;
	return result;
}

// --- Suggest a local area for each discovered base ---
//
// Matching runs in confidence order and stops at the first hit:
//   1. areatag on network_areas matches the base name
//   2. area shortcode matches the base name
//   3. area shortcode matches the base name with non-alphanumerics stripped
//
// Mystic names its files after the base's filename setting, which sysops
// usually keep equal to the areatag, so 1 carries most of the load. Anything
// unmatched is left for the sysop to map by hand.

async function autoMatchAreas(bases) {
	var areaRows = await postgres.query(
		'SELECT id, shortcode, name FROM message_areas WHERE active ORDER BY shortcode'
	);
	var tagRows = await postgres.query(
		`SELECT na.areatag, ma.shortcode
		 FROM network_areas na
		 JOIN message_areas ma ON ma.id = na.area_id
		 WHERE na.active = true`
	);

	var byTag       = new Map();
	var byShortcode = new Map();
	var bySlug      = new Map();

	function slug(s) {
		return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	}

	for (var t of tagRows) {
		if (t.areatag) byTag.set(t.areatag.toLowerCase(), t.shortcode);
	}
	for (var a of areaRows) {
		byShortcode.set(a.shortcode.toLowerCase(), a.shortcode);
		var s = slug(a.shortcode);
		// First shortcode wins a slug, so an ambiguous slug never silently
		// retargets an import at the wrong area.
		if (s && !bySlug.has(s)) bySlug.set(s, a.shortcode);
	}

	for (var b of bases) {
		var lower = b.name.toLowerCase();
		b.suggestedArea = null;
		b.matchedBy     = null;

		if (byTag.has(lower)) {
			b.suggestedArea = byTag.get(lower);
			b.matchedBy     = 'areatag';
		} else if (byShortcode.has(lower)) {
			b.suggestedArea = byShortcode.get(lower);
			b.matchedBy     = 'shortcode';
		} else {
			var sl = slug(b.name);
			if (sl && bySlug.has(sl)) {
				b.suggestedArea = bySlug.get(sl);
				b.matchedBy     = 'shortcode (normalised)';
			}
		}
	}

	return bases;
}

// --- Scan plus match in one call ---

async function scanAndMatch(dir, format) {
	var scan = scanDirectory(dir, format);
	if (!scan.status) return scan;

	await autoMatchAreas(scan.bases);

	var matched = scan.bases.filter(function (b) { return b.suggestedArea; }).length;
	alogger.writeAlog(4,
		'[MsgBaseScan] ' + scan.dir + ': found ' + scan.bases.length + ' ' +
		format.toUpperCase() + ' base(s), matched ' + matched + ' to existing areas',
		'cyan');

	return scan;
}

export { scanDirectory, autoMatchAreas, scanAndMatch, FORMAT_FILES };
