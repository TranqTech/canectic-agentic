// terminalDrain.js -- terminal callers and maintenance mode.
//
// New callers are refused at connect, before a node is allocated or anything
// is negotiated, with the reason and when the board expects to be back. That
// applies to everyone, sysops included: the web admin is the way in while the
// board is closed.
//
// Callers already connected are warned when maintenance starts, reminded as
// the grace runs down, and hung up when it runs out. The warning is drawn on
// the bottom line with the cursor saved and restored, so it lands on top of
// whatever the caller is doing, a door or the full screen editor included,
// and they are not left with a cursor somewhere unexpected. A terminal whose
// size was never negotiated gets plain lines instead.
//
// Imports nothing; the call manager is passed in, so it is testable with
// fake calls.

// Reminders before the grace runs out, in seconds. Only ones still in the
// future when maintenance starts are scheduled.
var REMINDERS = [60, 15];

function plural(n, word) {
	return n + ' ' + word + (n === 1 ? '' : 's');
}

function clockTime(date) {
	var d = new Date(date);
	var h = String(d.getHours()).padStart(2, '0');
	var m = String(d.getMinutes()).padStart(2, '0');
	return h + ':' + m;
}

// Strip anything that could move the cursor or ring the bell. The reason is
// typed by a sysop, but it is going onto every connected terminal.
function clean(text) {
	return String(text || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

/** "in 4 minutes", "in 30 seconds", "now". Pure. */
function countdown(deadline, now) {
	var secs = Math.round((new Date(deadline).getTime() - new Date(now || Date.now()).getTime()) / 1000);
	if (secs <= 0) return 'now';
	if (secs < 90) return 'in ' + plural(secs, 'second');
	return 'in ' + plural(Math.round(secs / 60), 'minute');
}

/**
 * What a caller refused at connect sees. Pure.
 * @param {object} state  currentMaintenance()
 */
function refusalText(state) {
	var flag = (state && state.flag) || {};
	var lines = ['', 'The board is closed for maintenance.'];
	if (flag.reason) lines.push(clean(flag.reason));
	var back = state && state.expectedBack;
	if (back) lines.push('Expected back around ' + clockTime(back) + ' (' + countdown(back) + ').');
	else lines.push('Please call back later.');
	lines.push('', '');
	return lines.join('\r\n');
}

/** The countdown warning shown to a connected caller. Pure. */
function warningText(state, now) {
	var flag = (state && state.flag) || {};
	var when = countdown(state.deadline, now);
	var text = when === 'now'
		? 'The board is closing for maintenance now.'
		: 'The board closes for maintenance ' + when + ' (' + clockTime(state.deadline) + '). Please finish up.';
	if (flag.reason) text += ' ' + clean(flag.reason);
	return text;
}

/** What a caller sees as they are disconnected. Pure. */
function goodbyeText(state) {
	var back = state && state.expectedBack;
	return '\r\n\r\n*** The board is now closed for maintenance. ' +
		(back ? 'Expected back around ' + clockTime(back) + '. ' : '') +
		'Please call back later. ***\r\n';
}

/**
 * Wrap a notice for one call: the bottom line with the cursor saved and
 * restored when the terminal size is known, plain lines when it is not.
 * CSI s / CSI u rather than DECSC because that is what ANSI.SYS-style BBS
 * terminals honour, and xterm.js does too. Pure.
 */
function noticeFor(call, text) {
	var rows = parseInt(call && call.term_height, 10) || 0;
	var cols = parseInt(call && call.term_width, 10) || 80;
	var body = clean(text);
	if (rows > 0) {
		if (body.length > cols - 1) body = body.substring(0, cols - 1);
		return '\x1b[s\x1b[' + rows + ';1H\x1b[0;1;37;41m\x1b[K' + body + '\x1b[0m\x1b[u';
	}
	return '\r\n*** ' + body + ' ***\r\n';
}

/** Every connected call across the call manager's pools. */
function connectedCalls(callManager) {
	var out = [];
	var pools = (callManager && callManager.pools) || [];
	for (var pool of pools) {
		for (var call of (pool && pool.connectedcalls) || []) {
			if (call && call.call_status !== 'Finished') out.push(call);
		}
	}
	return out;
}

function sendTo(call, text) {
	try {
		if (typeof call.sendString === 'function') call.sendString(text);
	} catch (_) { /* a call that is going away is not our problem */ }
}

/**
 * Warn connected callers as the board closes and hang them up when the grace
 * runs out. Registers the terminal calls as a drain source.
 *
 * @param {MaintenanceWatch} watch
 * @param {object} callManager  has pools[].connectedcalls
 * @param {function} [log]
 * @returns {{warnAll:function, dropAll:function, pendingReminders:function}} for tests
 */
function attachTerminalDrain(watch, callManager, log) {
	var say = typeof log === 'function' ? log : function () {};
	var timers = [];

	function clearTimers() {
		for (var t of timers) clearTimeout(t);
		timers = [];
	}

	function warnAll() {
		var state = watch.current();
		if (!state.active) return 0;
		var calls = connectedCalls(callManager);
		var text = warningText(state, Date.now());
		for (var call of calls) sendTo(call, noticeFor(call, text));
		return calls.length;
	}

	function dropAll() {
		var state = watch.current();
		var calls = connectedCalls(callManager);
		for (var call of calls) {
			sendTo(call, goodbyeText(state));
			try {
				if (typeof call.hangUpCall === 'function') call.hangUpCall();
			} catch (err) {
				say(1, 'Maintenance: could not hang up node ' + call.nodenum + ': ' + (err && err.message || err));
			}
		}
		if (calls.length) say(2, 'Maintenance: grace over, disconnected ' + plural(calls.length, 'caller'));
		return calls.length;
	}

	function schedule() {
		clearTimers();
		var state = watch.current();
		if (!state.active) return;
		var n = warnAll();
		if (n) say(2, 'Maintenance: warned ' + plural(n, 'connected caller') + ', closing ' + countdown(state.deadline));
		var now = Date.now();
		for (var secs of REMINDERS) {
			var at = state.deadline.getTime() - secs * 1000;
			// Skip a reminder that would land on top of the first warning.
			if (at - now < 5000) continue;
			var t = setTimeout(warnAll, at - now);
			if (t.unref) t.unref();
			timers.push(t);
		}
	}

	watch.registerDrainSource('terminal', function () {
		return { 'terminal calls': connectedCalls(callManager).length };
	});
	watch.on('enter', schedule);
	watch.on('change', schedule);
	watch.on('deadline', function () { clearTimers(); dropAll(); });
	watch.on('leave', clearTimers);

	return { warnAll: warnAll, dropAll: dropAll, pendingReminders: function () { return timers.length; } };
}

/**
 * For a connection class about to hand a new caller to a call pool: the text
 * to refuse them with, or null when the board is open.
 */
function refuseNewCaller(state) {
	if (!state || !state.active) return null;
	return refusalText(state);
}

export {
	countdown,
	refusalText,
	warningText,
	goodbyeText,
	noticeFor,
	connectedCalls,
	attachTerminalDrain,
	refuseNewCaller
};
