/**
 * Maintenance mode banner.
 *
 * For a logged-in user it is the countdown: how long until the board closes,
 * ticking each second, reloading the page when it reaches zero so they land on
 * the maintenance page rather than finding out when a post fails. For a sysop
 * on the admin layout it is a standing reminder that the board is closed, with
 * a link to the Maintenance page.
 *
 * Two ways in. The server renders #maintenance-banner with data attributes on
 * any page loaded while the board is closing, and the presence socket pushes a
 * `maintenance` message to pages that are already open when it starts, which
 * is the notification blast. Both end up in show().
 *
 * Loaded as `<script type="module">` like messageAreas.js, exposed on window
 * so the layouts' inline presence handlers can reach it, and exporting its
 * pure parts for tests.
 */

/** "4:05", "1:02:03", "0:00". Pure. */
function formatRemaining(ms) {
	var total = Math.max(0, Math.ceil(ms / 1000));
	var h = Math.floor(total / 3600);
	var m = Math.floor((total % 3600) / 60);
	var s = total % 60;
	var ss = (s < 10 ? '0' : '') + s;
	if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss;
	return m + ':' + ss;
}

function clock(iso) {
	var d = new Date(iso);
	if (isNaN(d.getTime())) return '';
	return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); // pre-#59 fallback: a push without server-formatted times
}

/**
 * The banner text for a state at a moment. Pure.
 *
 * @param {object} s    { mode: 'countdown'|'admin', deadline, reason, expectedBack,
 *                      deadlineText, expectedBackText (server-formatted, #59) }
 * @param {number} now  epoch ms
 */
function bannerText(s, now) {
	var left = s.deadline ? new Date(s.deadline).getTime() - now : 0;
	// The server sends its own formatted times (#59), so every page shows the
	// board's clock; clock() is only for a push from an older process.
	var back = s.expectedBack ? ' Expected back around ' + (s.expectedBackText || clock(s.expectedBack)) + '.' : '';
	var reason = s.reason ? ' ' + s.reason + '.' : '';
	if (s.mode === 'admin') {
		var callers = left > 0
			? ' Connected callers are disconnected in ' + formatRemaining(left) + '.'
			: ' Callers are being refused.';
		return 'Maintenance mode is on.' + reason + callers;
	}
	if (left <= 0) return 'The board is closing for maintenance now.' + back;
	return 'The board closes for maintenance in ' + formatRemaining(left) +
		' (at ' + (s.deadlineText || clock(s.deadline)) + ').' + reason + back + ' Anything you post before then is kept.';
}

var state = null;
var timer = null;

function el() {
	return typeof document !== 'undefined' ? document.getElementById('maintenance-banner') : null;
}

function render() {
	var box = el();
	if (!box || !state) return;
	var now = Date.now();
	box.querySelector('.maintenance-banner-text').textContent = bannerText(state, now);
	box.hidden = false;
	if (state.mode !== 'admin' && state.deadline && now >= new Date(state.deadline).getTime()) {
		stopTimer();
		// A moment's grace so the last "closing now" is readable.
		setTimeout(function () { location.reload(); }, 1500);
	}
}

function stopTimer() {
	if (timer) clearInterval(timer);
	timer = null;
}

/** Show or update the banner. `data` is a presence message or the element's data. */
function show(data) {
	var box = el();
	if (!box) return;
	state = {
		mode:         box.getAttribute('data-mode') || 'countdown',
		deadline:     data.deadline || null,
		reason:       data.reason || null,
		expectedBack: data.expectedBack || null
	};
	stopTimer();
	render();
	timer = setInterval(render, 1000);
}

function clear() {
	stopTimer();
	state = null;
	var box = el();
	if (box) box.hidden = true;
}

function initFromPage() {
	var box = el();
	if (!box || !box.getAttribute('data-deadline')) return;
	show({
		deadline:     box.getAttribute('data-deadline'),
		reason:       box.getAttribute('data-reason') || null,
		expectedBack: box.getAttribute('data-back') || null,
		deadlineText: box.getAttribute('data-deadline-text') || null,
		expectedBackText: box.getAttribute('data-back-text') || null
	});
}

export { formatRemaining, bannerText };

if (typeof window !== 'undefined') {
	window.CanecticMaintenance = { show: show, clear: clear };
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', initFromPage);
	} else {
		initFromPage();
	}
}
