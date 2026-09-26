// newSince.js — what "new" means for files: arrived since your last login.
//
// Files used to be "new" relative to a per-area read pointer
// (user_file_pointers), moved forward by viewing an area on the web, by the
// JSON listing, by the terminal browser's cursor and by its M(ark read) key.
// Many things moved it, which is how badges came to disagree with the lists
// under them. Now a file is new if it arrived (upload_date) after the start of
// your PREVIOUS visit, the classic BBS "new since last call", and nothing
// clears the marker during a visit.
//
// A visit starts at terminal login, web login, and on the web after
// web_idle_threshold minutes without activity; each of those runs
// updateUserCalls, which OVERWRITES users.lastlogon with the current time. So
// the baseline is the value from BEFORE that write, captured at the moment the
// visit starts (session.prev_logon on the web, call.prev_logon on a terminal).
// Read afterwards, lastlogon is this visit's own start and nothing is new.
//
// Someone with no previous login is measured from when their account was made,
// so a new user is not shown the whole file base as new.
//
// Pure; callers pass the values.

function toMs(value) {
	if (value === null || value === undefined || value === '') return null;
	if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === 'number') return isFinite(value) && value > 0 ? value : null;
	var s = String(value).trim();
	if (/^\d+$/.test(s)) { var n = Number(s); return n > 0 ? n : null; }
	var t = Date.parse(s);
	return isNaN(t) ? null : t;
}

/**
 * The baseline for "new", in epoch ms: the previous login, else the account's
 * creation, else 0 (everything new, only for a record with neither).
 */
export function newSinceMs(prevLogon, createdAt) {
	var p = toMs(prevLogon);
	if (p !== null) return p;
	var c = toMs(createdAt);
	return c !== null ? c : 0;
}

/** Did a file with this upload_date arrive after the baseline? */
export function isNewSince(uploadDate, sinceMs) {
	var t = toMs(uploadDate);
	return t !== null && t > (Number(sinceMs) || 0);
}
