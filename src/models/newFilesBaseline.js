// newFilesBaseline.js — the "new since" time for this visit, for web and terminal.
//
// The rule is in src/utils/newSince.js. This reads where each kind of visit
// keeps it: session.prev_logon on the web (set by buildSessionData at login
// and registration, and by webActivity on an idle resume), call.prev_logon on
// a terminal (set by the login handler before updateUserCalls).

import * as userAccounts from './useraccounts.js';
import * as sessionStore from '../middleware/db/sessionstore.js';
import { newSinceMs } from '../utils/newSince.js';

/**
 * The baseline for a web request, as a Date.
 *
 * A session created before prev_logon existed has none. Its previous login is
 * unknowable by now (lastlogon holds this visit's start), so it gets that
 * start, stored back on the session: nothing is new until the next visit
 * begins, which is the honest answer rather than a guess.
 */
export async function forWeb(req, sessionUser) {
	if (sessionUser && sessionUser.prev_logon) return new Date(Number(sessionUser.prev_logon));
	var ms = 0;
	try {
		var row = sessionUser && sessionUser.username ? await userAccounts.getUserRecord(sessionUser.username) : null;
		if (row) ms = newSinceMs(row.lastlogon, row.created_at);
		if (req && req.cookies && req.cookies.sessionid && ms) {
			await sessionStore.sessionUpdate(req.cookies.sessionid, { prev_logon: String(ms) });
		}
	} catch (_) {}
	return new Date(ms);
}

/** The baseline for a terminal call, as a Date. */
export function forCall(call) {
	if (call && call.prev_logon) return new Date(Number(call.prev_logon));
	var rec = (call && call.user_record) || {};
	return new Date(newSinceMs(rec.lastlogon, rec.created_at));
}
