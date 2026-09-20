/**
 * Whether a dependency audit should stop a release.
 *
 * The pure half of the check: `scripts/release.mjs` runs `npm audit --json`
 * and hands the parsed report here, so the rule that decides is testable
 * without a network round trip.
 *
 * Why this exists at all: a dependency sweep is correct on the day it is done
 * and stale a week later. adm-zip was taken to 0.6 on 2026-09-04, clearing
 * every advisory that existed; 0.6.1 landed on 2026-09-11 fixing two more, and
 * nothing would have noticed until somebody happened to run an audit. A cut is
 * the right moment to look, because it is the moment the tree stops being ours
 * and starts being everybody's.
 *
 * The rule is deliberately narrow, and the narrowness is the point:
 *
 *   BLOCK on high or critical severity, in a PRODUCTION dependency, where a
 *   fix is available.
 *
 * Every clause earns its place. Production, because dev dependencies are not
 * installed on a board and blocking a release over mocha's tree is noise.
 * High or critical, because a release held up by a low-severity advisory in a
 * transitive package is a release held up for ever. And fix available, because
 * a gate that cannot be satisfied is a gate that gets bypassed every time
 * until nobody reads it — an unfixable advisory is reported loudly and lets
 * the cut proceed, which is the honest treatment of a thing the maintainer
 * cannot act on today.
 *
 * Everything not blocking is still reported. The check never silently passes
 * something it saw.
 */

export const BLOCKING_SEVERITIES = ['high', 'critical'];

/**
 * A report we cannot read is not the same as a clean one.
 *
 * `npm audit` needs the registry, and a cut on a train with no signal must not
 * be reported as having passed an audit it never ran. The caller warns and
 * continues; what it must not do is print a tick.
 */
function unusable(reason) {
	return { usable: false, reason: reason, blocking: [], reported: [], counts: null };
}

/**
 * Normalise one `vulnerabilities` entry.
 *
 * `via` is either a list of package names (this package is only affected
 * through something else) or a list of advisory objects. Only the objects
 * carry a title worth printing.
 */
function describe(name, entry) {
	var titles = [];
	for (var v of (entry.via || [])) {
		if (v && typeof v === 'object' && v.title) titles.push(v.title);
	}

	// fixAvailable is `true`, `false`, or an object describing a fix that
	// changes a major version. An object still counts as a fix, but the caller
	// should say so, since it is not a `npm update` away.
	var fix = entry.fixAvailable;

	return {
		name: name,
		severity: entry.severity || 'unknown',
		direct: !!entry.isDirect,
		range: entry.range || '',
		titles: titles,
		fixAvailable: !!fix,
		fixIsBreaking: !!(fix && typeof fix === 'object'),
		fixVersion: (fix && typeof fix === 'object' && fix.version) ? fix.version : null,
	};
}

/**
 * @param {object} report - parsed `npm audit --json`, run with --omit=dev so
 *                          the entries are production dependencies
 * @returns {{usable: boolean, reason?: string, blocking: object[], reported: object[], counts: object|null}}
 */
export function summariseAudit(report) {
	if (!report || typeof report !== 'object') return unusable('no audit report');

	// npm 7 introduced this shape. An older or unexpected one is unreadable
	// rather than empty, and must not be mistaken for a clean bill.
	if (report.error) {
		return unusable(report.error.summary || report.error.code || 'the audit reported an error');
	}
	if (report.auditReportVersion !== 2) {
		return unusable('unrecognised audit report version: ' + JSON.stringify(report.auditReportVersion));
	}
	if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
		return unusable('the audit report carried no vulnerabilities section');
	}

	var reported = [];
	for (var name of Object.keys(report.vulnerabilities)) {
		reported.push(describe(name, report.vulnerabilities[name]));
	}
	reported.sort(function (a, b) { return a.name.localeCompare(b.name); });

	var blocking = reported.filter(function (v) {
		return BLOCKING_SEVERITIES.indexOf(v.severity) !== -1 && v.fixAvailable;
	});

	return {
		usable: true,
		blocking: blocking,
		reported: reported,
		counts: (report.metadata && report.metadata.vulnerabilities) || null,
	};
}

/**
 * One line per advisory, for a terminal.
 */
export function formatAdvisory(v) {
	var bits = [v.name, '(' + v.severity + (v.direct ? ', direct' : '') + ')'];
	if (v.titles.length) bits.push('- ' + v.titles[0]);
	if (!v.fixAvailable) bits.push('[no fix published]');
	else if (v.fixIsBreaking) bits.push('[fix is a breaking change' + (v.fixVersion ? ' to ' + v.fixVersion : '') + ']');
	return bits.join(' ');
}
