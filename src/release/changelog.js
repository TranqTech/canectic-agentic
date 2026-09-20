// changelog.js -- reading and closing the Pending section of the changelog.
//
// The changelog is the human half of a release and the pending declarations in
// docs/releases/pending.json are the machine half. This module handles the
// human half and cross-checks the two, but deliberately does NOT derive one
// from the other. Parsing prose to decide what to execute on someone's live
// board works right up until a bullet is reworded, and the failure is silent.
//
// What it does instead is notice when the two halves disagree in the way that
// actually happens: upgrade notes written for people with nothing declared for
// the updater, or the reverse. That is a warning at cut time, when the person
// who wrote one of them is still in the room.
//
// Pure string functions. No filesystem.

var PENDING_HEADING = /^## Pending \(since (v?[^)]+)\)\s*$/;
var RELEASE_HEADING = /^## (v?\d[^\s(]*)\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;
var SECTION_HEADING = /^### (.+?)\s*$/;
var UPGRADE_SECTION = 'Upgrade Notes';

// The two fields a human fills in. Everything else in a release notes file is
// generated: the upgrade block comes from the notices and the whole Changes
// section from the changelog.
//
// They are named constants rather than literals because the publish step
// refuses to send a notes file that still contains them, and a guard matching
// a string typed out twice is a guard that stops matching the first time
// somebody reworded one. v0.9.7a reached the website with both still in place.
export const NOTES_SUMMARY_PLACEHOLDER = '**One sentence saying what this release is for.**';
export const NOTES_HIGHLIGHTS_PLACEHOLDER = 'TODO: the two or three things a sysop would notice.';

/**
 * Which placeholders a notes file still carries. Empty means it is ready.
 */
export function unfilledPlaceholders(text) {
	var found = [];
	if (!text) return found;
	if (text.indexOf(NOTES_SUMMARY_PLACEHOLDER) !== -1) found.push('the one-line summary');
	if (text.indexOf(NOTES_HIGHLIGHTS_PLACEHOLDER) !== -1) found.push('the Highlights section');
	return found;
}

function splitLines(text) {
	return String(text || '').split('\n');
}

/**
 * Locate the Pending block.
 *
 * @returns {{since:string, headingIndex:number, bodyStart:number, bodyEnd:number, body:string}|null}
 *          bodyEnd is exclusive and stops at the next `## ` heading.
 */
function findPending(text) {
	// The FIRST Pending heading wins, and its body stops at the next `## `,
	// which means a second one left behind by a hand edit silently truncates
	// the block rather than being reported. That happened once, from a script
	// that prepended a heading instead of inserting under the existing one.
	// `duplicatePendingHeadings` is the check worth running before a cut.
	var lines = splitLines(text);
	var headingIndex = -1;
	var since = null;

	for (var i = 0; i < lines.length; i++) {
		var m = PENDING_HEADING.exec(lines[i]);
		if (m) { headingIndex = i; since = m[1]; break; }
	}
	if (headingIndex === -1) return null;

	var end = lines.length;
	for (var j = headingIndex + 1; j < lines.length; j++) {
		if (lines[j].indexOf('## ') === 0) { end = j; break; }
	}

	return {
		since: since,
		headingIndex: headingIndex,
		bodyStart: headingIndex + 1,
		bodyEnd: end,
		body: lines.slice(headingIndex + 1, end).join('\n')
	};
}

/**
 * How many `## Pending` headings the document carries.
 *
 * Exactly one is correct. Zero means the section was closed and never reopened.
 * More than one means a hand edit or a script put a second heading in, and
 * since findPending takes the first and stops at the next `## `, the extras are
 * invisible: the entries under them are silently dropped from the release they
 * were written for.
 */
function countPendingHeadings(text) {
	return splitLines(text).filter(function (l) { return PENDING_HEADING.test(l); }).length;
}

/**
 * Is there anything in Pending?
 *
 * A heading with no content under it counts as empty. So does a block holding
 * nothing but section headings, which is what a maintainer leaves behind when
 * they set up the shape of a release and then write none of it.
 */
function pendingIsEmpty(text) {
	var pending = findPending(text);
	if (!pending) return true;
	for (var line of splitLines(pending.body)) {
		var t = line.trim();
		if (!t) continue;
		if (t.indexOf('#') === 0) continue;
		return false;
	}
	return true;
}

/** The `### ` section titles inside Pending, in order. */
function pendingSections(text) {
	var pending = findPending(text);
	if (!pending) return [];
	var out = [];
	for (var line of splitLines(pending.body)) {
		var m = SECTION_HEADING.exec(line);
		if (m) out.push(m[1]);
	}
	return out;
}

/**
 * The top level bullets under `### Upgrade Notes`.
 *
 * Only the first line of each bullet, and only bullets at column zero. A note
 * runs to several paragraphs with an indented code block in it, and the first
 * line is the claim; the rest is the explanation.
 */
function upgradeNotes(text) {
	var pending = findPending(text);
	if (!pending) return [];

	var lines = splitLines(pending.body);
	var inSection = false;
	var inFence = false;
	var out = [];

	for (var line of lines) {
		var heading = SECTION_HEADING.exec(line);
		if (heading) { inSection = heading[1] === UPGRADE_SECTION; continue; }
		if (!inSection) continue;
		if (line.indexOf('## ') === 0) break;

		if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
		if (inFence) continue;

		if (/^- \S/.test(line)) out.push(line.substring(2).trim());
	}
	return out;
}

/**
 * Close Pending into a released version and open a fresh Pending above it.
 *
 * The new Pending is `since` the version just cut, so the next release's
 * heading states what it accumulated against without anyone having to remember.
 */
function closePending(text, opts) {
	var version = String(opts.version);
	var date = String(opts.date);
	var pending = findPending(text);
	if (!pending) throw new Error('changelog has no Pending section to close');

	var lines = splitLines(text);
	var replacement = [
		'## Pending (since v' + version + ')',
		'',
		'## v' + version + ' (' + date + ')'
	];

	var before = lines.slice(0, pending.headingIndex);
	var after = lines.slice(pending.headingIndex + 1);
	return before.concat(replacement, after).join('\n');
}

/**
 * Where the human and machine halves of a release disagree.
 *
 * Presence based rather than count based on purpose. One upgrade note can be
 * two declared steps and a notice, or a step whose explanation runs to three
 * paragraphs, so matching them up one to one would be a rule nobody could
 * follow. What it catches is a whole half missing, which is the failure that
 * has actually happened.
 *
 * @returns {string[]} warnings, empty when the two halves are consistent
 */
function crossCheckPending(text, pending) {
	var warnings = [];
	var notes = upgradeNotes(text);
	var declared = ((pending && pending.steps) || []).length + ((pending && pending.notices) || []).length;

	if (notes.length && declared === 0) {
		warnings.push('the changelog carries ' + notes.length + ' upgrade note' +
			(notes.length === 1 ? '' : 's') + ' but pending.json declares no steps or notices, ' +
			'so the updater will apply this release silently');
	}
	if (!notes.length && declared > 0) {
		warnings.push('pending.json declares ' + declared + ' step(s) and notice(s) but the changelog ' +
			'has no Upgrade Notes section, so nobody reading the release notes will know');
	}
	return warnings;
}

/**
 * A release note skeleton, seeded from what the release already knows.
 *
 * A skeleton rather than a finished document. v0.9.5a shipped with no release
 * notes at all and had to be written retrospectively five months later from the
 * changelog, which is the gap this closes: after a cut there is always a file,
 * carrying the upgrade actions and the change list, waiting for the prose that
 * says what the release is for.
 */
function releaseNoteSkeleton(opts) {
	var version = opts.version;
	var meta = opts.meta || {};
	var out = [];

	out.push('# Canectic BBS v' + version);
	out.push('');
	out.push(NOTES_SUMMARY_PLACEHOLDER);
	out.push('');
	out.push('Released ' + meta.released + (meta.codename ? ' (' + meta.codename + ')' : '') + '.');
	out.push('');
	out.push('## Highlights');
	out.push('');
	out.push(NOTES_HIGHLIGHTS_PLACEHOLDER);
	out.push('');

	var steps = meta.steps || [];
	var notices = meta.notices || [];
	if (steps.length || notices.length) {
		out.push('## Upgrading');
		out.push('');
		for (var n of notices) {
			out.push('- **' + n.level.toUpperCase() + ':** ' + n.text);
		}
		for (var s of steps) {
			var prefix = s.automatic ? 'Applied automatically' : 'Run by hand';
			out.push('- **' + s.description + '** (' + prefix + ')');
			if (s.command) {
				out.push('');
				out.push('  ```');
				out.push('  ' + s.command);
				out.push('  ```');
				out.push('');
			}
		}
		out.push('');
	}

	if (opts.body) {
		out.push('## Changes');
		out.push('');
		out.push(String(opts.body).trim());
		out.push('');
	}

	return out.join('\n');
}

export {
	PENDING_HEADING,
	RELEASE_HEADING,
	UPGRADE_SECTION,
	findPending,
	countPendingHeadings,
	pendingIsEmpty,
	pendingSections,
	upgradeNotes,
	closePending,
	crossCheckPending,
	releaseNoteSkeleton
};
