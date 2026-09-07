// mailerFormat.js -- presentation helpers for the mailer diagnostics views.
//
// Kept out of the templates so they can be tested, and shared between the peer
// page and the dashboard so the two cannot disagree about what "ok" means or
// when a peer counts as stale.
//
// Byte counts arrive from postgres as strings, because node-postgres hands
// BIGINT back as text rather than silently losing precision above 2^53. Every
// function here accepts either.

const KB = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

// A peer that has not been heard from in this long is worth pointing at, even
// if its last session succeeded. Most links poll hourly or better, so a full
// day of silence means something changed.
const DEFAULT_STALE_HOURS = 24;

/**
 * Human byte count. Accepts a number, a BIGINT string, or null.
 */
function formatBytes(value) {
	var n = toNumber(value);
	if (n === null || n < 0) return '-';
	if (n === 0) return '0';

	var unit = 0;
	var size = n;
	while (size >= KB && unit < UNITS.length - 1) {
		size = size / KB;
		unit++;
	}
	// Whole bytes read better without a decimal; everything else gets one
	// unless it would round to a whole number anyway.
	if (unit === 0) return n + UNITS[0];
	var rounded = size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
	return rounded + UNITS[unit];
}

/**
 * Compact age: "just now", "4m", "2h", "3d", "6w". Returns null for no date,
 * so a caller can render its own placeholder rather than a misleading "0m".
 */
function relativeAge(value, now) {
	var then = toDate(value);
	if (!then) return null;
	var ref = toDate(now) || new Date();

	var seconds = Math.floor((ref.getTime() - then.getTime()) / 1000);
	// A clock skew or a row written a moment ahead should not read as "in the
	// future", which tells a sysop nothing useful.
	if (seconds < 0) seconds = 0;

	if (seconds < 60) return 'just now';
	var minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes + 'm';
	var hours = Math.floor(minutes / 60);
	if (hours < 48) return hours + 'h';
	var days = Math.floor(hours / 24);
	if (days < 14) return days + 'd';
	return Math.floor(days / 7) + 'w';
}

/**
 * Bootstrap contextual class for a session outcome.
 */
function outcomeClass(outcome) {
	if (outcome === 'complete') return 'success';
	if (outcome === 'connect_failed' || outcome === 'auth_failed') return 'danger';
	if (outcome === 'busy') return 'secondary';
	return 'warning';
}

/**
 * Short label for a session outcome. The raw reason is shown alongside, so
 * this only has to be scannable in a column.
 */
function outcomeLabel(outcome) {
	switch (outcome) {
		case 'complete':       return 'ok';
		case 'connect_failed': return 'no connect';
		case 'auth_failed':    return 'auth';
		case 'timeout':        return 'timeout';
		case 'busy':           return 'busy';
		case 'error':          return 'error';
		default:               return outcome || 'unknown';
	}
}

/**
 * The dashboard row for one connection.
 *
 * `stats` is a statsByConnection row (window bounded), `contact` is a
 * lastContactByConnection row (all history). They come from different queries
 * because the window is the right frame for "how has it been going lately" and
 * the wrong one for "when did this last work at all": a peer broken for a week
 * would show no last success under a 24 hour window, which is exactly when a
 * sysop most needs the answer.
 *
 * @returns {object} attempts, successes, successRate (null when nothing was
 *   attempted, not 0, since no attempts is not a 0% success rate), bytes and
 *   file totals, ages, and whether the peer needs attention.
 */
function summariseConnection(stats, contact, opts) {
	var o = opts || {};
	var now = toDate(o.now) || new Date();
	var staleHours = o.staleHours === undefined ? DEFAULT_STALE_HOURS : o.staleHours;

	var s = stats || {};
	var c = contact || {};

	var attempts = toNumber(s.attempts) || 0;
	var successes = toNumber(s.successes) || 0;

	var lastContact = toDate(c.last_contact);
	var lastSuccess = toDate(c.last_success);

	var hoursSinceSuccess = lastSuccess
		? (now.getTime() - lastSuccess.getTime()) / 3600000
		: null;

	// Never contacted is not the same as failing. A newly added peer should
	// not be flagged red before it has had a chance to poll.
	var failing = false;
	if (lastContact) {
		failing = (hoursSinceSuccess === null) || (hoursSinceSuccess > staleHours);
	}

	return {
		attempts:          attempts,
		successes:         successes,
		successRate:       attempts > 0 ? Math.round((successes / attempts) * 100) : null,
		filesSent:         toNumber(s.files_sent) || 0,
		filesReceived:     toNumber(s.files_received) || 0,
		bytesSent:         toNumber(s.bytes_sent) || 0,
		bytesReceived:     toNumber(s.bytes_received) || 0,
		lastContact:       lastContact,
		lastContactAge:    relativeAge(lastContact, now),
		lastSuccess:       lastSuccess,
		lastSuccessAge:    relativeAge(lastSuccess, now),
		lastOutcome:       c.last_outcome || null,
		lastReason:        c.last_reason || null,
		peerSoftware:      c.peer_software || null,
		everContacted:     !!lastContact,
		failing:           failing
	};
}

/**
 * Duration in seconds as something readable in a narrow column.
 */
function formatDuration(seconds) {
	var n = toNumber(seconds);
	if (n === null) return '-';
	if (n < 60) return n + 's';
	var m = Math.floor(n / 60);
	var s = n % 60;
	if (m < 60) return m + 'm' + (s ? ' ' + s + 's' : '');
	return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// ---------------------------------------------------------------------------

function toNumber(value) {
	if (value === null || value === undefined || value === '') return null;
	var n = typeof value === 'number' ? value : parseInt(value, 10);
	return isNaN(n) ? null : n;
}

function toDate(value) {
	if (!value) return null;
	var d = value instanceof Date ? value : new Date(value);
	return isNaN(d.getTime()) ? null : d;
}

export {
	formatBytes,
	relativeAge,
	outcomeClass,
	outcomeLabel,
	summariseConnection,
	formatDuration,
	DEFAULT_STALE_HOURS
};
