// callflowTrigger.js -- when the web call flow should be offered or forced.
//
// The decision reads three session fields and a clock, and it used to live
// inline in the root router where nothing could test it. It is extracted for
// the same reason the message area comparator is: the interesting part is the
// arithmetic, and a request pipeline is not a testable unit.
//
// The rule it encodes: a user who has not been through the call flow in a long
// time gets sent through it, and one who is merely a couple of hours stale gets
// offered it. `last_callflow_at` is cached on the session so this does not hit
// the database on every request, and that cache is the whole hazard. It has no
// expiry of its own. It is corrected only when something explicitly writes to
// the session, so any session a write fails to reach keeps the stale value for
// as long as it lives, and forces the call flow on every single request. See
// reconcileFromDb in routes/callflow.js for the path back.

// Hours since the last completed call flow before it is forced rather than
// offered. A day is long enough that a normal user never meets it.
var DEFAULT_FORCE_HOURS = 24;

// Hours before the "welcome back" prompt appears.
var DEFAULT_PROMPT_HOURS = 2;

// Sentinel hours reported for a user who has never completed one, so a caller
// showing "it has been N hours" has something to show.
var NEVER_HOURS = 999;

/**
 * Decide what the call flow should do for this session.
 *
 * `session` is the raw Redis session hash, so every value is a string.
 * Returns { force, pending, hoursSince, needsLookup }.
 *
 * `needsLookup` asks the caller to read last_callflow_at from the database and
 * cache it. It is true only once per session, on the first request that finds
 * nothing cached, which is what keeps this off the database on every hit.
 */
function evaluateCallflow(session, now, opts) {
	var o = opts || {};
	var forceHours  = o.forceHours  === undefined ? DEFAULT_FORCE_HOURS  : o.forceHours;
	var promptHours = o.promptHours === undefined ? DEFAULT_PROMPT_HOURS : o.promptHours;

	var s = session || {};
	var lastCf = s.last_callflow_at ? parseInt(s.last_callflow_at) : 0;
	if (isNaN(lastCf)) lastCf = 0;

	var result = {
		force: false,
		pending: false,
		hoursSince: 0,
		needsLookup: !lastCf && !s._callflow_checked
	};

	if (lastCf) {
		result.hoursSince = (now - lastCf) / 3600000;
		if (result.hoursSince >= forceHours) result.force = true;
		else if (result.hoursSince >= promptHours) result.pending = true;
	} else {
		// Never completed one, or a cached value we could not trust.
		result.force = true;
		result.hoursSince = NEVER_HOURS;
	}

	// The idle-resume flag raises the prompt independently of the clock.
	if (s.callflow_pending === 'true') result.pending = true;

	return result;
}

/**
 * Whether a forced call flow may redirect this request.
 *
 * The call flow's own pages are the important exclusion: redirecting them
 * would be an immediate loop. The rest are paths where a redirect would either
 * break a non-page request or trap the user somewhere they need to get out of,
 * login and logout above all.
 */
function isRedirectablePath(path, method) {
	if (method !== 'GET') return false;
	if (!path) return false;

	var exempt = ['/callflow', '/users', '/admin', '/health', '/webart', '/ws/', '/pm', '/notifications'];
	for (var prefix of exempt) {
		if (path.startsWith(prefix)) return false;
	}
	return true;
}

export {
	DEFAULT_FORCE_HOURS,
	DEFAULT_PROMPT_HOURS,
	NEVER_HOURS,
	evaluateCallflow,
	isRedirectablePath
};
