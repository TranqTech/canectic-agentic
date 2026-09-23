// upgradeNotices.js -- which upgrade notices a board should be shown.
//
// A release declares notices in docs/releases/pending.json and the cut writes
// them into its metadata sidecar (canectic-<version>.json). Until #55 nothing on
// a board read them: the only place a sysop met "clear your gateway log" or
// "retention will be enforced on the first run" was the release notes.
//
// The rules, all pure:
//
//   COLLECT across every release being skipped. Notices belong to one release,
//   so a board on 0.9.6a moving to 0.9.10a needs 0.9.9a's as well as
//   0.9.10a's. Withdrawn releases count: a board that ran one may need what it
//   said. The range is running < v <= target.
//
//   DEDUPE by id. A notice carried forward into a later release (0.9.10a
//   repeated 0.9.9a's nine) is one notice. The latest release's copy wins,
//   since its wording is the most recent. A notice with no id, which is every
//   notice published before ids existed, gets one derived from its level and
//   text, so identical carried copies still collapse.
//
//   FILTER by the running version. `from_min` and `from_max` are inclusive and
//   optional: "Coming from 0.9.7a or earlier" is from_max 0.9.7a. A notice
//   with neither applies to everybody. A running version that cannot be parsed
//   sees everything, since hiding a warning is the worse mistake.
//
//   ORDER critical, then warning, then info; oldest release first within a
//   level, so the notes read in the order the changes happened.
//
// Only builtins, since the updater loads this while node_modules is replaced.

import { createHash } from 'crypto';
import { compareVersions, parseVersion } from '../utils/version.js';

var LEVEL_ORDER = { critical: 0, warning: 1, info: 2 };

/** A notice's id, derived from its content when it declares none. */
function noticeId(n) {
	if (n && n.id) return String(n.id);
	return 'n-' + createHash('sha256').update((n && n.level || 'info') + '\n' + (n && n.text || '')).digest('hex').slice(0, 12);
}

/** Whether a notice's version range includes the running version. */
function appliesTo(n, running) {
	if (!parseVersion(running)) return true;
	if (n.from_min && parseVersion(n.from_min) && compareVersions(running, n.from_min) < 0) return false;
	if (n.from_max && parseVersion(n.from_max) && compareVersions(running, n.from_max) > 0) return false;
	return true;
}

/**
 * Every published release, listed or withdrawn, with running < version <=
 * target, oldest first. Takes an index already through parseIndex.
 */
function releasesBetween(index, running, target) {
	var all = ((index && index.releases) || []).concat((index && index.withdrawn) || []);
	var seen = new Set();
	var out = [];
	for (var r of all) {
		if (!r || !parseVersion(r.version) || seen.has(r.version)) continue;
		if (parseVersion(running) && compareVersions(r.version, running) <= 0) continue;
		if (compareVersions(r.version, target) > 0) continue;
		seen.add(r.version);
		out.push(r);
	}
	out.sort(function (a, b) { return compareVersions(a.version, b.version); });
	return out;
}

/**
 * The notices of several releases as one list, deduplicated, each carrying the
 * release it came from. Not yet filtered by the running version: a stored
 * check keeps this, and the page filters it against whatever is running when
 * it is looked at.
 *
 * @param {Array<{version:string, notices:Array}>} metas
 */
function gatherNotices(metas) {
	var byId = new Map();
	var sorted = (metas || []).filter(function (m) { return m && parseVersion(m.version); })
		.slice().sort(function (a, b) { return compareVersions(a.version, b.version); });
	for (var m of sorted) {
		for (var n of m.notices || []) {
			if (!n || !n.text) continue;
			var id = noticeId(n);
			// Later releases replace earlier copies: newest wording wins.
			byId.set(id, {
				id: id,
				level: LEVEL_ORDER[n.level] !== undefined ? n.level : 'info',
				text: String(n.text),
				from_min: n.from_min || null,
				from_max: n.from_max || null,
				release: m.version
			});
		}
	}
	return Array.from(byId.values());
}

/** The gathered notices that apply to a board running `running`, in reading order. */
function applicableNotices(items, running) {
	return (items || []).filter(function (n) {
		return appliesTo(n, running) && !(parseVersion(running) && parseVersion(n.release) &&
			compareVersions(n.release, running) <= 0);
	}).sort(function (a, b) {
		return (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || compareVersions(a.release, b.release);
	});
}

/** Whether any notice is serious enough to be acknowledged before updating. */
function needsAcknowledgement(list) {
	return (list || []).some(function (n) { return n.level === 'warning' || n.level === 'critical'; });
}

/**
 * What an acknowledgement must carry: a short hash of exactly the notices the
 * sysop was shown. Empty when none needs acknowledging. Binding it to the ids
 * means a tick given against one set of notices does not carry over to a
 * different set, for instance after a check found a newer release.
 */
function acknowledgementToken(list) {
	if (!needsAcknowledgement(list)) return '';
	var ids = (list || []).map(function (n) { return n.id; }).sort();
	return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16);
}

/** "2 upgrade notes apply, 1 needs attention" style counts, for notifications. */
function describeCounts(list) {
	var total = (list || []).length;
	if (!total) return '';
	var serious = (list || []).filter(function (n) { return n.level !== 'info'; }).length;
	return total + ' upgrade note' + (total === 1 ? '' : 's') + ' appl' + (total === 1 ? 'ies' : 'y') +
		' to this system' + (serious ? ', ' + serious + ' of ' + (total === 1 ? 'it' : 'them') + ' needing attention before you update' : '');
}

export {
	LEVEL_ORDER,
	noticeId,
	appliesTo,
	releasesBetween,
	gatherNotices,
	applicableNotices,
	needsAcknowledgement,
	acknowledgementToken,
	describeCounts
};
