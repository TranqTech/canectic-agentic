// identity.js -- what a release archive says it is, to a machine and to a
// person.
//
// Three files ride in every archive and each has one job:
//
//   CANECTIC.ID      identification. Keyword per line, which is the idiom of
//                    the .TIC files this travels beside, readable by anything
//                    including a sysop running `unzip -p`.
//   canectic-<v>.json the full declaration: migrations, steps, notices. What
//                    the updater reads.
//   FILE_ID.DIZ      the description a BBS file area shows. For humans, on the
//                    45-column canvas the convention has used for thirty years.
//
// Keeping identification apart from the description is the same split this
// codebase has made twice already: changelog prose against pending.json, and
// the run record against the bytes. A DIZ is presentation and gets reworded;
// identification is a contract. Parsing a version out of free text works until
// somebody improves the wording.
//
// All three are GENERATED from the release metadata, which is what makes the
// duplication safe. Two hand-maintained statements of one fact is how the
// directory lists in install.sh and update.sh drifted.
//
// The metadata shipped inside omits the artifact's own checksum. A number
// inside the thing it verifies is worthless: you would be trusting the archive
// to vouch for the archive.
//
// Pure: no filesystem.

var IDENTITY_FILENAME = 'CANECTIC.ID';
var DIZ_FILENAME = 'FILE_ID.DIZ';

// FILE_ID.DIZ convention: at most 10 lines of at most 45 columns. Older file
// listers truncate without asking, so this generates within the limits rather
// than hoping.
var DIZ_WIDTH = 45;
var DIZ_LINES = 10;

/**
 * The metadata as it ships inside the archive.
 *
 * Everything except `sha256`, which describes the archive this is inside.
 */
function withoutSelfChecksum(meta) {
	var copy = JSON.parse(JSON.stringify(meta));
	delete copy.sha256;
	copy.sha256_note = 'published alongside the artifact, not inside it';
	return copy;
}

function pad(label) {
	var s = String(label);
	while (s.length < 12) s += ' ';
	return s;
}

/**
 * CANECTIC.ID, keyword per line.
 *
 * A key with no value still gets its line. A reader that has to tell "this
 * release has no base" from "this file predates the Base field" would otherwise
 * have to guess, and an empty value says the first unambiguously.
 */
function serialiseIdentity(meta) {
	var lines = [
		pad('Software') + 'Canectic BBS',
		pad('Version') + (meta.version || ''),
		pad('Channel') + (meta.channel || ''),
		pad('Codename') + (meta.codename || ''),
		pad('Released') + (meta.released || ''),
		pad('Delta') + (meta.delta ? 'yes' : 'no'),
		pad('Base') + (meta.base || ''),
		pad('NodeMin') + (meta.node_min || ''),
		pad('UpgradeFrom') + (meta.min_upgrade_from || ''),
		pad('Migrations') + ((meta.migrations || []).join(' ')),
		pad('Manifest') + 'MANIFEST',
		pad('Metadata') + 'canectic-' + (meta.version || '') + '.json'
	];
	return lines.join('\n') + '\n';
}

/**
 * Read one back.
 *
 * Tolerant on purpose: this is the file another system reads to work out what
 * an archive is, and refusing to parse because of an unrecognised keyword would
 * make every future field a breaking change. Unknown keys are kept.
 */
function parseIdentity(text) {
	var out = {};
	for (var line of String(text || '').split(/\r\n|\r|\n/)) {
		if (!line.trim() || line.trim().charAt(0) === '#') continue;
		var m = /^(\S+)\s*(.*)$/.exec(line);
		if (!m) continue;
		out[m[1].toLowerCase()] = m[2].trim();
	}
	if (!out.version) return null;
	return {
		software: out.software || null,
		version: out.version,
		channel: out.channel || null,
		codename: out.codename || null,
		released: out.released || null,
		delta: out.delta === 'yes',
		base: out.base || null,
		node_min: out.nodemin || null,
		min_upgrade_from: out.upgradefrom || null,
		migrations: out.migrations ? out.migrations.split(/\s+/) : [],
		raw: out
	};
}

function fit(line) {
	var s = String(line);
	return s.length > DIZ_WIDTH ? s.substring(0, DIZ_WIDTH) : s;
}

/**
 * FILE_ID.DIZ, the description a file area shows.
 *
 * Generated rather than hand-written so a release cannot ship a DIZ describing
 * the previous one, which is the single most common thing wrong with a BBS
 * archive's description.
 *
 * A description of the software and nothing else: it is what a BBS listing
 * shows. Upgrade notices belong in the release notes and the metadata, and a
 * file area listing is not where a sysop reads them.
 */
function buildFileIdDiz(meta, opts) {
	var o = opts || {};
	var lines = [];

	lines.push(fit('Canectic BBS ' + meta.version +
		(meta.codename ? ' "' + meta.codename + '"' : '')));
	lines.push(fit('Multi-node BBS: terminal and web, FTN,'));
	lines.push(fit('QWK and NNTP mail, door games, files.'));
	lines.push(fit(''));

	if (meta.delta && meta.base) {
		lines.push(fit('Development build. Needs ' + meta.base + ' to'));
		lines.push(fit('rebuild from; not installable alone.'));
	} else {
		lines.push(fit('Released ' + (meta.released || '') +
			(meta.node_min ? '. Needs Node ' + meta.node_min : '')));
	}

	while (lines.length < DIZ_LINES && o.pad) lines.push('');
	if (lines.length > DIZ_LINES) lines = lines.slice(0, DIZ_LINES);

	// Trailing blanks read as a broken description in a lister.
	while (lines.length && lines[lines.length - 1] === '') lines.pop();
	return lines.join('\n') + '\n';
}

export {
	IDENTITY_FILENAME,
	DIZ_FILENAME,
	DIZ_WIDTH,
	DIZ_LINES,
	withoutSelfChecksum,
	serialiseIdentity,
	parseIdentity,
	buildFileIdDiz
};
