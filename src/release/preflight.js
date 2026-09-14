// preflight.js -- what to check before an update is offered, not after it has
// started.
//
// The design is explicit about the timing and it is the whole point: several of
// these are only answerable while the BBS is up. Once the updater has stopped
// the processes, "how many callers are online" is zero and "is a toss job in
// flight" is no. Asking then would be asking a question whose answer the act of
// asking has already changed.
//
// So preflight runs in two places with different jobs. At OFFER time, in the
// gateway or the tool, with the board running: callers, jobs, disk, toolchain.
// Inside the UPDATER, as the new code, it re-checks only the cheap invariants
// it can still see, because by then the old release's word for them is worth
// less than its own.
//
// Checks are values, not throws. A preflight that stopped at the first problem
// would make a sysop fix one thing, run it again, and find the next, which for
// a maintenance window is exactly the wrong shape. Each carries whether it
// blocks or merely warns:
//
//   blocking  the update cannot work. Node too old, no disk, no target.
//   warning   the update will work and somebody will be inconvenienced.
//             Callers online is the clearest case, and the design calls it the
//             single most useful thing the page can say.
//
// Pure. Every probe is passed in, so this module has no idea whether a database
// or a presence server exists.

import { compareDotted } from './updateVerdict.js';

var LEVEL_BLOCK = 'block';
var LEVEL_WARN  = 'warn';
var LEVEL_OK    = 'ok';

// How much room an update wants beyond the artifact itself: a staged tree, a
// backup of what it displaces, and a database dump. Deliberately generous;
// running out of disk halfway through a file replacement is the worst time to
// find out.
var STAGING_HEADROOM = 3;

function check(id, level, summary, detail) {
	return { id: id, level: level, summary: summary, detail: detail || null };
}

/**
 * Assemble a preflight from probe results.
 *
 * @param {object} f
 * @param {string} f.nodeVersion      the running Node
 * @param {string} [f.nodeMin]        what the release needs
 * @param {number} [f.freeBytes]      free space where staging will go, null if unknown
 * @param {number} [f.artifactBytes]  the release's size
 * @param {number} [f.databaseBytes]  for the dump, null if not being taken
 * @param {boolean} [f.databaseReachable]
 * @param {number} [f.callersOnline]
 * @param {number} [f.jobsInFlight]
 * @param {boolean} [f.buildToolchain] whether a compiler is present
 * @param {boolean} [f.nativeModules]  whether this release changes one
 * @param {boolean} [f.targetWritable]
 * @returns {{ok:boolean, blocking:Array, warnings:Array, checks:Array}}
 */
function preflight(f) {
	var checks = [];

	if (f.nodeMin && f.nodeVersion && compareDotted(f.nodeVersion, f.nodeMin) < 0) {
		checks.push(check('node', LEVEL_BLOCK,
			'Node ' + f.nodeVersion + ' is older than the ' + f.nodeMin + ' this release needs'));
	} else if (f.nodeMin) {
		checks.push(check('node', LEVEL_OK, 'Node ' + f.nodeVersion));
	}

	if (f.targetWritable === false) {
		checks.push(check('writable', LEVEL_BLOCK, 'the installation directory is not writable'));
	}

	// Unknown free space is not zero. A check that cannot read statfs must not
	// refuse the update; it says it could not look.
	if (f.freeBytes === null || f.freeBytes === undefined) {
		checks.push(check('disk', LEVEL_WARN, 'free space could not be measured'));
	} else {
		var wanted = (f.artifactBytes || 0) * STAGING_HEADROOM + (f.databaseBytes || 0);
		if (wanted > 0 && f.freeBytes < wanted) {
			checks.push(check('disk', LEVEL_BLOCK,
				mb(f.freeBytes) + ' free, and this needs about ' + mb(wanted),
				'staging, a backup of what is displaced' + (f.databaseBytes ? ' and a database dump' : '')));
		} else {
			checks.push(check('disk', LEVEL_OK, mb(f.freeBytes) + ' free'));
		}
	}

	if (f.databaseReachable === false) {
		checks.push(check('database', LEVEL_BLOCK,
			'the database is not reachable, so the schema and migrations cannot run'));
	} else if (f.databaseReachable === true) {
		checks.push(check('database', LEVEL_OK, 'database reachable'));
	}

	// The most useful line on the page. Not blocking: it is the sysop's call
	// whether three people mid-door is a reason to wait.
	if (f.callersOnline > 0) {
		checks.push(check('callers', LEVEL_WARN,
			'this will disconnect ' + f.callersOnline + ' connected ' +
			(f.callersOnline === 1 ? 'user' : 'users')));
	} else if (f.callersOnline === 0) {
		checks.push(check('callers', LEVEL_OK, 'nobody is online'));
	}

	if (f.jobsInFlight > 0) {
		checks.push(check('jobs', LEVEL_WARN,
			f.jobsInFlight + ' job(s) in flight; an update now lands mid-toss',
			'they are retried, but a packet half tossed is worth waiting out'));
	}

	if (f.nativeModules && f.buildToolchain === false) {
		checks.push(check('toolchain', LEVEL_BLOCK,
			'this release rebuilds a native module and there is no compiler installed',
			'install build-essential and python3'));
	}

	var blocking = checks.filter(function (c) { return c.level === LEVEL_BLOCK; });
	var warnings = checks.filter(function (c) { return c.level === LEVEL_WARN; });
	return { ok: blocking.length === 0, blocking: blocking, warnings: warnings, checks: checks };
}

function mb(n) {
	return Math.round(n / 1048576) + ' MB';
}

export {
	LEVEL_BLOCK, LEVEL_WARN, LEVEL_OK,
	STAGING_HEADROOM,
	preflight
};
