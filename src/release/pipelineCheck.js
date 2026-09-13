// pipelineCheck.js -- the migration coverage rule, in both places it is asked.
//
// Section 7: a move is safe when every migration already applied to this
// database also exists in the target release. Channel is not the test and
// neither is version, quite. Someone on a development build from 1 September
// moving to a stable released on the 10th is moving forward and should be
// allowed; what constrains them is whether the target understands the state
// their database is in.
//
// The case version comparison misses is work that went out on development and
// then got deferred out of the stable cut. Version-wise the move is forward. In
// practice the database carries a migration the target does not ship and cannot
// reason about.
//
// The same rule is asked twice:
//
//   checkMoveSafety      at update time, on a sysop's box, against what their
//                        ledger says has actually been applied.
//   checkStableCoverage  at release time, on the maintainer's box, against
//                        every development build published on this base.
//
// The second is the first asked one step earlier. It catches the identical
// failure for the cost of a warning before publication, rather than a bug
// report from someone who cannot move off development.

import { compareVersions } from '../utils/version.js';

function uniqueSorted(ids) {
	return Array.from(new Set((ids || []).map(String))).sort();
}

/** Every migration id any of these releases ships. */
function migrationsFrom(releases) {
	var all = [];
	for (var r of (releases || [])) all = all.concat(r.migrations || []);
	return uniqueSorted(all);
}

/**
 * Is moving to this target safe for a database in this state?
 *
 * @param {object} opts
 * @param {string[]} opts.applied  migration ids the ledger records as applied
 * @param {string[]} opts.target   migration ids the target release ships
 * @returns {{ok:boolean, blocking:string[], applied:number, target:number}}
 *
 * `blocking` names what the target does not ship. On refusal the caller must
 * print those ids: "you cannot move to stable" is not actionable, "your
 * database has applied 0007-fileecho-hashes, which stable 0.9.6a does not ship"
 * is.
 */
function checkMoveSafety(opts) {
	var applied = uniqueSorted(opts && opts.applied);
	var target = new Set(uniqueSorted(opts && opts.target));
	var blocking = applied.filter(function (id) { return !target.has(id); });
	return {
		ok: blocking.length === 0,
		blocking: blocking,
		applied: applied.length,
		target: target.size
	};
}

/**
 * Does a stable about to be cut ship every migration its own development builds
 * already put into people's databases?
 *
 * Normal convergence is always fine: stable 0.9.6a contains everything its
 * 0.9.6a.* builds had. The answer is only ever no when something was deferred
 * out of the cut, and then everyone running development is about to be refused
 * the upgrade.
 *
 * @param {object} opts
 * @param {string}   opts.version              the stable being cut
 * @param {string[]} opts.migrations           what it ships
 * @param {Array}    opts.developmentReleases  index entries, any base
 * @param {string}   [opts.previousStable]     the stable those builds were based on
 * @returns {{ok:boolean, missing:string[], builds:Array, checked:number}}
 */
function checkStableCoverage(opts) {
	var previousStable = opts.previousStable || null;
	var candidates = (opts.developmentReleases || []).filter(function (r) {
		if (!previousStable) return true;
		return r.base && compareVersions(r.base, previousStable) === 0;
	});

	var shipped = new Set(uniqueSorted(opts.migrations));
	var missing = migrationsFrom(candidates).filter(function (id) { return !shipped.has(id); });

	var builds = [];
	if (missing.length) {
		for (var r of candidates) {
			var theirs = (r.migrations || []).filter(function (id) { return missing.indexOf(id) !== -1; });
			if (theirs.length) builds.push({ version: r.version, migrations: uniqueSorted(theirs) });
		}
	}

	return {
		ok: missing.length === 0,
		missing: missing,
		builds: builds,
		checked: candidates.length
	};
}

/**
 * How overdue a stable is, as the delta's share of the full tree.
 *
 * A development delta grows through a cycle and resets to near zero when stable
 * is cut, so a build approaching full-tree size says a release is due. Reported
 * rather than enforced: it is a signal to a maintainer, not a rule.
 */
function deltaShare(deltaBytes, fullBytes) {
	if (!fullBytes) return null;
	return deltaBytes / fullBytes;
}

export {
	migrationsFrom,
	checkMoveSafety,
	checkStableCoverage,
	deltaShare
};
