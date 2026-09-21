// webDrain.js -- telling logged-in web users the board is closing.
//
// Web users are not waited for. They are told, with a countdown, and after the
// grace every non-admin page shows them the maintenance page (see
// src/middleware/maintenanceWeb.js). Logged-in users often stay logged in for
// days, so waiting for them to finish would mean never closing.
//
// The telling is two things at once, because each misses somebody:
//
//   a pushed banner   every open page gets a `maintenance` presence message
//                     and shows a live countdown. Visible now, gone on reload
//   a notification    one per user with a page open, in the bell, so it is
//                     still there to read if they looked away
//
// Anyone who opens a page later in the grace gets the banner rendered by the
// server, so the blast only has to reach the pages already open.
//
// The presence server and notification model are passed in, so this is
// testable without either.

import { clockTime, countdown } from './terminalDrain.js';

/** The presence message for the current state. Pure. */
function presenceMessage(state) {
	var flag = (state && state.flag) || {};
	return {
		type:         'maintenance',
		deadline:     state.deadline ? new Date(state.deadline).toISOString() : null,
		reason:       flag.reason || null,
		expectedBack: state.expectedBack ? new Date(state.expectedBack).toISOString() : null
	};
}

/** The notification's title and body. Pure. */
function notificationText(state, now) {
	var flag = (state && state.flag) || {};
	var when = countdown(state.deadline, now);
	var body = when === 'now'
		? 'The board is closing for maintenance now.'
		: 'The board closes for maintenance at ' + clockTime(state.deadline) + ' (' + when + ').';
	if (flag.reason) body += ' ' + flag.reason + '.';
	if (state.expectedBack) body += ' Expected back around ' + clockTime(state.expectedBack) + '.';
	body += ' Anything you post before then is kept.';
	return { title: 'The board is closing for maintenance', body: body };
}

/**
 * @param {MaintenanceWatch} watch
 * @param {object} presence       has broadcast(obj) and connectedUserIds()
 * @param {object} notifications  has create(userId, type, title, body, opts)
 * @param {function} [log]
 */
function attachWebDrain(watch, presence, notifications, log) {
	var say = typeof log === 'function' ? log : function () {};

	function push() {
		var state = watch.current();
		if (!state.active || !presence) return;
		try {
			presence.broadcast(presenceMessage(state));
		} catch (err) {
			say(1, 'Maintenance: could not push the countdown to web users: ' + (err && err.message || err));
		}
	}

	async function notify() {
		var state = watch.current();
		if (!state.active || !presence || !notifications) return 0;
		// Already past the grace: this is a process starting on a board that is
		// already closed (the updater restarts the gateway with the flag set).
		// There is nobody left to warn, and "closing" would be untrue.
		if (watch.pastDeadline()) return 0;
		var text = notificationText(state, Date.now());
		var users = presence.connectedUserIds();
		var sent = 0;
		for (var userId of users) {
			try {
				await notifications.create(userId, 'maintenance', text.title, text.body,
					{ severity: 'warning', icon: 'tools' });
				sent++;
			} catch (err) {
				say(2, 'Maintenance: notification to user ' + userId + ' failed: ' + (err && err.message || err));
			}
		}
		if (sent) say(2, 'Maintenance: notified ' + sent + ' logged-in web user(s)');
		return sent;
	}

	// Enter: banner and notification. Change: the banner only, since a sysop
	// correcting the reason should not fill everybody's bell.
	watch.on('enter', function () { push(); return notify(); });
	watch.on('change', push);
	watch.on('leave', function () {
		if (!presence) return;
		try { presence.broadcast({ type: 'maintenance_clear' }); } catch (_) {}
	});
}

export {
	presenceMessage,
	notificationText,
	attachWebDrain
};
