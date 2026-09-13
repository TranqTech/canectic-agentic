// version.js -- parsing and ordering Canectic version strings.
//
// The scheme, from docs/reference/UPDATE_SYSTEM_DESIGN.md:
//
//   stable       MAJOR.MINOR.PATCH[phase]          0.9.5a
//   development  MAJOR.MINOR.PATCH[phase].DATE[.N] 0.9.5a.20260913
//
// The phase letter is `a` for alpha, `b` for beta, absent for a final release,
// lining up with the codenames: Handshake, Carrier, First Call.
//
// A development build carries THE LAST STABLE RELEASED plus its build date. It
// names where it came from, not where it is going, which is what lets it state
// its own delta base, removes any obligation to bump a branch version when a
// stable is cut, and keeps a version from making a promise about the future
// that turns out false.
//
// ORDERING. This is the rule to get right:
//
//   0.9.5a < 0.9.5a.20260901 < 0.9.5a.20260913 < 0.9.5b < 0.9.5b.20261005 < 0.9.5 < 0.9.6a
//
// A dated build sorts ABOVE the version in its name, because it was built after
// that release. An earlier phase sorts below a later one, because an alpha comes
// before a beta comes before the final.
//
// Reversing the date half inverts every comparison in the system: everyone on
// development would be told they are behind by builds they are ahead of, and an
// update check would offer downgrades. That is why it lives in one function and
// the tests assert the whole chain rather than pairs.

// a < b < (absent). Absent is highest because a final release is the most
// finished thing a version number can name.
var PHASE_RANK = { a: 0, b: 1 };
var PHASE_FINAL = 2;

// No date means the release itself, which comes before anything built after it.
var NO_DATE = -1;

var CURRENT_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)([ab])?(?:\.(\d{8})(?:\.(\d+))?)?$/;

// The retired form, still in two tags: v0.9.0-alpha.1, v0.9.1-alpha.1. Parsed so
// that an install still running one can be told something newer exists, and
// never emitted. formatVersion always produces the current form.
var LEGACY_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)-(alpha|beta)(?:\.(\d+))?$/;

function validDate(digits) {
	if (!digits) return true;
	var month = parseInt(digits.substring(4, 6), 10);
	var day   = parseInt(digits.substring(6, 8), 10);
	// Loose on purpose: this catches a packaging bug that produced a nonsense
	// stamp, not every impossible calendar date.
	return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * Parse a version string.
 *
 * @returns {object|null} { major, minor, patch, phase, date, build, legacy, raw }
 *                        or null when it is not a version. Never throws.
 *
 * `phase` is 'a', 'b' or null. `date` is the 8 digit build date as a number, or
 * null for a release. `build` is the same-day counter, defaulting to 0.
 */
function parseVersion(input) {
	if (input === null || input === undefined) return null;
	var raw = String(input).trim();
	if (!raw) return null;

	var m = CURRENT_PATTERN.exec(raw);
	if (m) {
		if (!validDate(m[5])) return null;
		return {
			major: parseInt(m[1], 10),
			minor: parseInt(m[2], 10),
			patch: parseInt(m[3], 10),
			phase: m[4] || null,
			date:  m[5] ? parseInt(m[5], 10) : null,
			build: m[6] ? parseInt(m[6], 10) : 0,
			legacy: false,
			raw: raw
		};
	}

	var l = LEGACY_PATTERN.exec(raw);
	if (l) {
		return {
			major: parseInt(l[1], 10),
			minor: parseInt(l[2], 10),
			patch: parseInt(l[3], 10),
			phase: l[4] === 'alpha' ? 'a' : 'b',
			date:  null,
			build: l[5] ? parseInt(l[5], 10) : 0,
			legacy: true,
			raw: raw
		};
	}

	return null;
}

function phaseRank(phase) {
	if (phase === null || phase === undefined) return PHASE_FINAL;
	var rank = PHASE_RANK[phase];
	return rank === undefined ? PHASE_FINAL : rank;
}

/**
 * Compare two versions. Returns -1, 0 or 1.
 *
 * Accepts strings or already-parsed objects. An unparseable version sorts below
 * everything, which is the safe direction for "is there something newer": a
 * system whose version cannot be read is told an update exists rather than
 * silently told it is current. Callers listing available releases should drop
 * unparseable entries rather than rely on this.
 */
function compareVersions(a, b) {
	var pa = (a && typeof a === 'object') ? a : parseVersion(a);
	var pb = (b && typeof b === 'object') ? b : parseVersion(b);

	if (!pa && !pb) return 0;
	if (!pa) return -1;
	if (!pb) return 1;

	if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
	if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
	if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

	var ra = phaseRank(pa.phase);
	var rb = phaseRank(pb.phase);
	if (ra !== rb) return ra < rb ? -1 : 1;

	// The load-bearing half. No date is the release itself and comes first.
	var da = pa.date === null ? NO_DATE : pa.date;
	var db = pb.date === null ? NO_DATE : pb.date;
	if (da !== db) return da < db ? -1 : 1;

	if (pa.build !== pb.build) return pa.build < pb.build ? -1 : 1;

	return 0;
}

/** Is `candidate` newer than `current`? */
function isNewer(candidate, current) {
	return compareVersions(candidate, current) > 0;
}

/** Is this a development build, meaning it carries a build date? */
function isDevelopment(version) {
	var p = (version && typeof version === 'object') ? version : parseVersion(version);
	return !!(p && p.date !== null);
}

/** Is this a stable release, meaning no build date? */
function isStable(version) {
	var p = (version && typeof version === 'object') ? version : parseVersion(version);
	return !!(p && p.date === null);
}

/** Which channel a version belongs to, derived from its shape. */
function channelOf(version) {
	var p = (version && typeof version === 'object') ? version : parseVersion(version);
	if (!p) return null;
	return p.date === null ? 'stable' : 'development';
}

/**
 * The stable release a development build deltas against.
 *
 * This is the payoff of naming the last stable rather than the next one: the
 * base is in the version, so it cannot disagree with the metadata field that
 * also states it.
 *
 * @returns {string|null} the base version, or null for a stable release, which
 *                        is a base rather than having one.
 */
function baseStable(version) {
	var p = (version && typeof version === 'object') ? version : parseVersion(version);
	if (!p || p.date === null) return null;
	return formatVersion({ major: p.major, minor: p.minor, patch: p.patch, phase: p.phase });
}

/**
 * Canonical string form. Always the current scheme, never the retired one, so
 * a legacy version round trips into the form everything else speaks.
 */
function formatVersion(parsed) {
	var p = (parsed && typeof parsed === 'object') ? parsed : parseVersion(parsed);
	if (!p) return null;
	var out = p.major + '.' + p.minor + '.' + p.patch + (p.phase || '');
	if (p.date !== null && p.date !== undefined) {
		out += '.' + String(p.date);
		if (p.build) out += '.' + p.build;
	}
	return out;
}

/** Oldest first. Unparseable entries are dropped rather than sorted. */
function sortVersions(versions) {
	return (versions || [])
		.filter(function (v) { return parseVersion(typeof v === 'object' && v ? v.raw || v : v) !== null; })
		.slice()
		.sort(compareVersions);
}

/**
 * The newest of a list, optionally restricted to one channel.
 *
 * @param {Array} versions  version strings
 * @param {string} [channel] 'stable' or 'development'
 * @returns {string|null} the newest version string, or null if none qualify
 */
function newest(versions, channel) {
	var best = null;
	for (var v of (versions || [])) {
		var p = parseVersion(v);
		if (!p) continue;
		if (channel && channelOf(p) !== channel) continue;
		if (best === null || compareVersions(p, best) > 0) best = p;
	}
	return best ? best.raw : null;
}

export {
	parseVersion,
	compareVersions,
	isNewer,
	isDevelopment,
	isStable,
	channelOf,
	baseStable,
	formatVersion,
	sortVersions,
	newest
};
