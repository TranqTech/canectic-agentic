// updateVerdict.js -- is there an update, and may this system take it?
//
// The check is read-only and never downloads anything. Its whole job is to turn
// a release index plus what this database has actually done into one of three
// answers per channel: current, available, or blocked with reasons.
//
// Three rules decide it, and each is directional in a way that is easy to get
// backwards. All three are stated here as the direction plus the failure that
// reversing them produces:
//
//   NEWER. compareVersions, where a dated build sorts above the stable in its
//   name. Reversed, everyone on development is told they are behind by builds
//   they are ahead of.
//
//   MIGRATIONS. Every migration this database has APPLIED must exist in the
//   target. Reversed, every ordinary upgrade is refused, because every release
//   ships migrations the database has not run yet.
//
//   MIN UPGRADE FROM. The installed version must be at or above the target's
//   floor. Reversed, the only systems allowed to upgrade are the ones too old
//   to do it safely.
//
// A blocked release is reported, not hidden. "You cannot move to stable" is not
// actionable; "your database has applied 0007-fileecho-hashes, which stable
// 0.9.6a does not ship" is, and a sysop who can see the reason can act on it.
//
// Pure: no network, no database, no filesystem.

import { compareVersions, isNewer, parseVersion, channelOf } from '../utils/version.js';
import { checkMoveSafety } from './pipelineCheck.js';
import { findWithdrawn, replacementFor } from './releaseIndex.js';
import { applicableNotices, describeCounts } from './upgradeNotices.js';

var VERDICT_CURRENT   = 'current';
var VERDICT_AVAILABLE = 'available';
var VERDICT_BLOCKED   = 'blocked';
var VERDICT_UNKNOWN   = 'unknown';

var BLOCKER_MIGRATION = 'migration';
var BLOCKER_TOO_OLD   = 'min_upgrade_from';
var BLOCKER_NODE      = 'node_min';
var BLOCKER_NOT_NEWER = 'not_newer';
var BLOCKER_WITHDRAWN = 'withdrawn';

/**
 * Compare two dotted numeric versions, for `node_min`.
 *
 * Node versions are semver, not Canectic versions, so they do not go through
 * version.js. Prerelease and build metadata are ignored: a system running a
 * Node release candidate is close enough to that major for this purpose, and
 * refusing it would be a worse answer than allowing it.
 */
function compareDotted(a, b) {
	var pa = String(a || '').replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
	var pb = String(b || '').replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
	for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
		// A missing component is zero, so 22 and 22.0.0 are the same version.
		// An unreadable one gives up and reports equal, which means a version
		// nobody can parse never blocks an upgrade. `|| 0` cannot do both jobs:
		// NaN is falsy, so it would quietly turn an unreadable version into
		// zero and report every release as needing a newer Node.
		var x = pa[i] === undefined ? 0 : pa[i];
		var y = pb[i] === undefined ? 0 : pb[i];
		if (isNaN(x) || isNaN(y)) return 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/**
 * Everything standing between this system and one particular release.
 *
 * @param {object} opts
 * @param {string} opts.current            the version running here
 * @param {object} opts.release            an index entry
 * @param {string[]} [opts.appliedMigrations] ids the ledger records as APPLIED
 * @param {string} [opts.nodeVersion]      the running Node version
 * @returns {Array<{kind:string, detail:string, ids?:string[]}>}
 */
function blockersFor(opts) {
	var release = opts.release || {};
	var blockers = [];

	// Moving to the version already running, or back to an older one, is not
	// an update. The Update page offered the running version as an update on
	// a board that had just taken it, from a check made before it did, and the
	// apply route would have staged and reinstalled it. Here rather than in
	// the page so the Admin UI, the CLI and the page all refuse alike.
	if (release.version && opts.current && parseVersion(release.version) && parseVersion(opts.current) &&
		!isNewer(release.version, opts.current)) {
		blockers.push({
			kind: BLOCKER_NOT_NEWER,
			detail: release.version + ' is not newer than ' + opts.current + ', which this system is running'
		});
	}

	if (release.superseded_by || release.withdrawn_at) {
		var why = release.withdrawn_reason || release.superseded_reason;
		blockers.push({
			kind: BLOCKER_WITHDRAWN,
			detail: release.version + ' has been withdrawn' + (why ? ' (' + why + ')' : '') +
				(release.superseded_by ? '; ' + release.superseded_by + ' replaces it' : '')
		});
	}

	// The migration rule. Only migrations the ledger recorded as `applied` are
	// considered: `skipped` means this system was told it did not need the
	// migration, and `preinstalled` means the database was born in that state,
	// so in neither case is there a transformation for the target to
	// understand. `applied` is the only outcome that means data here changed.
	var safety = checkMoveSafety({
		applied: opts.appliedMigrations || [],
		target: release.migrations || []
	});
	if (!safety.ok) {
		blockers.push({
			kind: BLOCKER_MIGRATION,
			ids: safety.blocking,
			detail: 'this database has applied ' + safety.blocking.join(', ') +
				', which ' + release.version + ' does not ship'
		});
	}

	// The floor. Compared against the INSTALLED version: the release states the
	// oldest thing it knows how to upgrade, and this system must be at or above
	// it.
	if (release.min_upgrade_from && parseVersion(release.min_upgrade_from) &&
		compareVersions(opts.current, release.min_upgrade_from) < 0) {
		blockers.push({
			kind: BLOCKER_TOO_OLD,
			detail: release.version + ' upgrades from ' + release.min_upgrade_from +
				' or later, and this system is ' + opts.current
		});
	}

	if (release.node_min && opts.nodeVersion && compareDotted(opts.nodeVersion, release.node_min) < 0) {
		blockers.push({
			kind: BLOCKER_NODE,
			detail: release.version + ' needs Node ' + release.node_min +
				' or later, and this system runs ' + opts.nodeVersion
		});
	}

	return blockers;
}

/**
 * The verdict for one channel.
 *
 * The newest release is evaluated even when it is blocked, rather than falling
 * back to an older one that is not. A sysop who is stuck needs to be told they
 * are stuck and why; silently offering them something older would hide the
 * problem behind a smaller number.
 *
 * @returns {{channel, verdict, current, available, release, blockers}}
 */
function evaluateChannel(opts) {
	var index = opts.index;
	var channel = (index && index.channel) || opts.channel || null;
	var releases = (index && index.releases) || [];

	// A withdrawn release is not a candidate. Offering one is worse than
	// offering nothing: the board takes it, meets the fault it was withdrawn
	// for, and is now stranded on a version nobody intends to fix.
	var best = null;
	for (var r of releases) {
		if (!parseVersion(r.version)) continue;
		if (r.superseded_by) continue;
		if (best === null || compareVersions(r.version, best.version) > 0) best = r;
	}

	// Whether the version they are RUNNING has been withdrawn. Separate from
	// the choice above, and worth surfacing even when nothing newer is
	// available: it is the difference between "you are current" and "you are
	// on a release that was pulled".
	// findWithdrawn reads the first format too, which marked a withdrawal
	// inside `releases`. `by` is where the chain of replacements ends, not the
	// first link, which may itself have been withdrawn since.
	var withdrawn = null;
	var gone = (index && opts.current && parseVersion(opts.current)) ? findWithdrawn(index, opts.current) : null;
	if (gone) {
		withdrawn = { by: replacementFor(index, opts.current), reason: gone.withdrawn_reason || null };
	}

	if (!best || !isNewer(best.version, opts.current)) {
		return {
			channel: channel,
			verdict: VERDICT_CURRENT,
			current: opts.current,
			available: null,
			release: null,
			blockers: [],
			withdrawn: withdrawn
		};
	}

	var blockers = blockersFor({
		current: opts.current,
		release: best,
		appliedMigrations: opts.appliedMigrations,
		nodeVersion: opts.nodeVersion
	});

	return {
		channel: channel,
		verdict: blockers.length ? VERDICT_BLOCKED : VERDICT_AVAILABLE,
		current: opts.current,
		available: best.version,
		release: best,
		blockers: blockers,
		withdrawn: withdrawn
	};
}

/**
 * Which channels this system should be told about.
 *
 * A system on development is told about stable as well, because convergence
 * onto stable is a move it should be offered and would otherwise never see. A
 * system on stable is NOT told about development: that is a channel it did not
 * opt into, and offering it would be the software talking someone into running
 * prerelease code.
 */
function channelsToCheck(selected) {
	return selected === 'development' ? ['development', 'stable'] : ['stable'];
}

/**
 * Evaluate every channel this system should hear about.
 *
 * @param {object} opts
 * @param {string} opts.current     the running version
 * @param {string} opts.channel     the configured channel
 * @param {object} opts.indexes     { stable: index, development: index }
 * @returns {{current, channel, channels: object, best: object|null}}
 *
 * `best` is the one worth telling a sysop about: the configured channel wins
 * when it has something, since that is the channel they chose, and stable is
 * the fallback for a system on development whose own channel is quiet.
 */
function evaluate(opts) {
	var wanted = channelsToCheck(opts.channel);
	var channels = {};

	for (var name of wanted) {
		var index = (opts.indexes || {})[name];
		if (!index) {
			channels[name] = {
				channel: name, verdict: VERDICT_UNKNOWN, current: opts.current,
				available: null, release: null, blockers: []
			};
			continue;
		}
		channels[name] = evaluateChannel({
			index: index,
			channel: name,
			current: opts.current,
			appliedMigrations: opts.appliedMigrations,
			nodeVersion: opts.nodeVersion
		});
	}

	var best = null;
	for (var pref of wanted) {
		var c = channels[pref];
		if (c && (c.verdict === VERDICT_AVAILABLE || c.verdict === VERDICT_BLOCKED)) { best = c; break; }
	}

	return { current: opts.current, channel: opts.channel, channels: channels, best: best };
}

/**
 * A stored check result, judged against what is running NOW.
 *
 * A check is stored when it runs and read whenever the Update page is shown,
 * and in between the board can change version, most often because it has just
 * been updated. The hub, on 0.9.8a, went on being offered 0.9.8a until
 * somebody pressed Check now. The releases a check found do not go stale;
 * which of them is newer than this board does. So each channel's release is
 * judged again against the running version, with its blockers worked out
 * afresh.
 *
 * @param {object} result   from evaluate(), as stored
 * @param {object} opts     { current, appliedMigrations, nodeVersion }.
 *                          appliedMigrations null means the ledger could not be
 *                          read, and the migration blockers the check found are
 *                          kept rather than cleared
 * @returns {object} the result as it applies now; `checkedFor` names the
 *          version the check ran under when that differs
 */
function reconcileWithRunning(result, opts) {
	var o = opts || {};
	if (!result || !result.channels || !o.current || !parseVersion(o.current)) return result;
	if (result.current && parseVersion(result.current) && compareVersions(result.current, o.current) === 0) {
		return result;
	}

	var channels = {};
	for (var name of Object.keys(result.channels)) {
		var c = result.channels[name] || {};
		// What they were running when this was checked says nothing about
		// what they run now.
		var base = Object.assign({}, c, { current: o.current, withdrawn: null });
		if (!c.release || !c.available) { channels[name] = base; continue; }
		if (!isNewer(c.available, o.current)) {
			channels[name] = Object.assign(base, {
				verdict: VERDICT_CURRENT, available: null, release: null, blockers: []
			});
			continue;
		}
		var unknownLedger = o.appliedMigrations === null || o.appliedMigrations === undefined;
		var blockers = blockersFor({
			current: o.current, release: c.release,
			appliedMigrations: unknownLedger ? [] : o.appliedMigrations,
			nodeVersion: o.nodeVersion
		});
		if (unknownLedger) {
			blockers = (c.blockers || []).filter(function (b) { return b.kind === BLOCKER_MIGRATION; })
				.concat(blockers.filter(function (b) { return b.kind !== BLOCKER_MIGRATION; }));
		}
		channels[name] = Object.assign(base, {
			verdict: blockers.length ? VERDICT_BLOCKED : VERDICT_AVAILABLE,
			blockers: blockers
		});
	}

	var best = null;
	for (var pref of channelsToCheck(result.channel)) {
		var ch = channels[pref];
		if (ch && (ch.verdict === VERDICT_AVAILABLE || ch.verdict === VERDICT_BLOCKED)) { best = ch; break; }
	}

	return Object.assign({}, result, {
		current: o.current, channels: channels, best: best, checkedFor: result.current || null
	});
}

/**
 * Whether the release this result was checked under has been withdrawn, as
 * { by, reason }, or null. Every channel reports it, so the first one that
 * does is the answer.
 */
function runningWithdrawn(result) {
	if (!result || !result.channels) return null;
	for (var name of Object.keys(result.channels)) {
		var c = result.channels[name];
		if (c && c.withdrawn) return c.withdrawn;
	}
	return null;
}

/**
 * Should this result produce a notification?
 *
 * A daily job that says the same thing every morning is a job a sysop turns
 * off, so the dedupe is not a nicety. The key is version AND verdict, because a
 * release that was blocked and is now reachable (they ran the migration, they
 * upgraded Node) is news even though the version has not moved.
 *
 * Running a withdrawn release is news in its own right, and more urgent than
 * any update: the verdict alone says `current` when nothing newer is listed
 * yet, so without this a board on a pulled release heard nothing unless its
 * sysop opened the Update page. Told once per running version, so the daily
 * check does not repeat it; a replacement appearing later is still news by
 * the ordinary rule, since it arrives as an available version.
 *
 * @param {object} result   from evaluate()
 * @param {object} [last]   { version, verdict, current, withdrawn } from the
 *                          last notification sent; `withdrawn` true when that
 *                          notification said the running release was pulled
 */
function shouldNotify(result, last) {
	if (!result) return false;
	if (runningWithdrawn(result) &&
		!(last && last.withdrawn && last.current && result.current &&
			compareVersions(last.current, result.current) === 0)) {
		return true;
	}
	if (!result.best) return false;
	if (result.best.verdict !== VERDICT_AVAILABLE && result.best.verdict !== VERDICT_BLOCKED) return false;
	if (!last || !last.version) return true;
	return !(compareVersions(last.version, result.best.available) === 0 && last.verdict === result.best.verdict);
}

/**
 * What the notification says about upgrade notes for the release on offer, or
 * an empty string. Counts rather than the notes themselves: they are for
 * reading on the Update page, where they can be acknowledged.
 */
function noticesSentence(result) {
	var b = result && result.best;
	var n = result && result.notices;
	if (!b || !b.available || !n || n.target !== b.available) return '';
	if (!n.verified) return ' Its upgrade notes could not be verified, so read the release notes before you update.';
	var counts = describeCounts(applicableNotices(n.items, result.current));
	return counts ? ' ' + counts + '; read them on the Update page before you update.' : '';
}

/** The notification a result warrants. Null when there is nothing to say. */
function notificationFor(result) {
	if (!result) return null;
	var b = result.best;
	var withNotes = function (note) {
		if (note) note.body += noticesSentence(result);
		return note;
	};
	return withNotes(baseNotification(result, b));
}

function baseNotification(result, b) {

	var gone = runningWithdrawn(result);
	if (gone) {
		var body = result.current + ', which this system is running, has been withdrawn' +
			(gone.reason ? ': ' + gone.reason : '') + '. ';
		if (b && b.verdict === VERDICT_AVAILABLE) {
			body += b.available + ' is available on the ' + b.channel + ' channel and this system can take it.';
		} else if (b && b.verdict === VERDICT_BLOCKED) {
			body += b.available + ' is available but cannot be applied yet: ' +
				b.blockers.map(function (x) { return x.detail; }).join('; ') + '.';
		} else if (gone.by) {
			body += gone.by + ' replaces it.';
		} else {
			body += 'No replacement is published yet; stay on ' + result.current + ' until one is.';
		}
		return {
			severity: 'warning',
			title: 'Canectic ' + result.current + ' has been withdrawn',
			body: body
		};
	}

	if (!b) return null;

	if (b.verdict === VERDICT_AVAILABLE) {
		return {
			severity: 'info',
			title: 'Canectic ' + b.available + ' is available',
			body: 'This system is running ' + b.current + '. ' + b.available +
				' is the newest release on the ' + b.channel + ' channel and this system can take it.'
		};
	}

	if (b.verdict === VERDICT_BLOCKED) {
		return {
			severity: 'warning',
			title: 'Canectic ' + b.available + ' is available but blocked',
			body: 'This system is running ' + b.current + '. ' + b.available +
				' cannot be applied yet: ' + b.blockers.map(function (x) { return x.detail; }).join('; ') + '.'
		};
	}

	return null;
}

export {
	VERDICT_CURRENT,
	VERDICT_AVAILABLE,
	VERDICT_BLOCKED,
	VERDICT_UNKNOWN,
	BLOCKER_MIGRATION,
	BLOCKER_TOO_OLD,
	BLOCKER_NODE,
	BLOCKER_NOT_NEWER,
	BLOCKER_WITHDRAWN,
	reconcileWithRunning,
	runningWithdrawn,
	compareDotted,
	blockersFor,
	evaluateChannel,
	channelsToCheck,
	evaluate,
	shouldNotify,
	notificationFor
};
