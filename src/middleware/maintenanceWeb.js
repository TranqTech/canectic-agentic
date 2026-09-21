// maintenanceWeb.js -- the web side of maintenance mode.
//
// Who sees what while the board is closed:
//
//   anonymous visitors   the maintenance page straight away, with the reason
//                        and when the board expects to be back
//   logged-in users      a countdown until the grace runs out (pushed to open
//                        pages and shown on every page they load), then the
//                        maintenance page on everything but the admin routes.
//                        Nothing waits for them: they are told, and can hold
//                        off posting until the board is back
//   sysops               the whole site, so they can check it before reopening
//   the REST API         a JSON 503
//
// The login page stays reachable so a sysop can get in, but a login by
// anybody else is refused rather than minting a session nobody can use.
//
// The page is sent with status 503 and Retry-After, which is what tells a
// search engine the outage is temporary and keeps the maintenance page out of
// its index. Visitors never see the number.

import * as sessionStore from './db/sessionstore.js';
import appConfig from '../config/appConfig.js';
import { parseFlags } from '../utils/areaAccess.js';
import { currentMaintenance } from '../maintenance/maintenanceWatch.js';

// Reachable whatever the state: the admin, the log viewer, the health check,
// and the way in and out for a sysop.
var OPEN_PATHS = [
	/^\/admin(\/|$)/,
	/^\/adminlogs(\/|$)/,
	/^\/health\/?$/,
	/^\/users\/login\/?$/,
	/^\/users\/logout\/?$/
];

function isSysop(user) {
	if (!user) return false;
	var security = parseInt(user.security) || 0;
	if (security < appConfig.getNumber('adminsecurity', 200)) return false;
	return parseFlags(user.permissionflags).includes('Sysop');
}

/**
 * What to do with one request. Pure.
 *
 * @param {object} o  { active, path, loggedIn, isSysop, pastDeadline }
 * @returns {string} pass | countdown | page | json
 */
function decide(o) {
	if (!o.active) return 'pass';
	var p = o.path || '/';
	for (var re of OPEN_PATHS) if (re.test(p)) return 'pass';
	if (/^\/api(\/|$)/.test(p)) return 'json';
	if (o.isSysop) return 'pass';
	if (o.loggedIn && !o.pastDeadline) return 'countdown';
	return 'page';
}

/** What the page, the banner and the API response show. Pure. */
function viewModel(state, now) {
	var flag = (state && state.flag) || {};
	var t = now ? new Date(now).getTime() : Date.now();
	var back = state && state.expectedBack ? new Date(state.expectedBack) : null;
	return {
		boardName:    appConfig.get('boardname', 'Canectic BBS'),
		reason:       flag.reason || null,
		since:        flag.since || null,
		deadline:     state && state.deadline ? new Date(state.deadline).toISOString() : null,
		expectedBack: back ? back.toISOString() : null,
		// Retry-After: when the board expects to be back, or ten minutes if
		// nobody said, so a crawler neither hammers nor gives up.
		retryAfter:   back && back.getTime() > t ? Math.ceil((back.getTime() - t) / 1000) : 600
	};
}

/** Send the maintenance page, or the API's JSON equivalent. */
function sendClosed(res, vm, asJson) {
	res.set('Retry-After', String(vm.retryAfter));
	res.set('Cache-Control', 'no-store');
	if (asJson) {
		return res.status(503).json({
			error: 'maintenance',
			message: 'The board is closed for maintenance' + (vm.reason ? ': ' + vm.reason : '.'),
			expected_back: vm.expectedBack
		});
	}
	return res.status(503).render('maintenance', vm);
}

async function sessionUser(req) {
	if (!req.cookies || !req.cookies.sessionid) return null;
	try {
		return await sessionStore.sessionGet(req.cookies.sessionid) || null;
	} catch (_) {
		// Redis unreachable: treat as anonymous. The admin routes stay open
		// regardless, so a sysop is never locked out by this.
		return null;
	}
}

function maintenanceMiddleware() {
	return async function (req, res, next) {
		var state = currentMaintenance();
		if (!state.active) return next();

		var vm = viewModel(state);
		// Every layout gets the state, so the admin banner and the user
		// countdown both have what they need.
		res.locals.maintenance = vm;

		var user = await sessionUser(req);
		var what = decide({
			active:       true,
			path:         req.path,
			loggedIn:     !!user,
			isSysop:      isSysop(user),
			pastDeadline: state.deadline && Date.now() >= new Date(state.deadline).getTime()
		});

		if (what === 'pass') return next();
		if (what === 'countdown') {
			res.locals.maintenanceCountdown = true;
			return next();
		}
		return sendClosed(res, vm, what === 'json');
	};
}

/**
 * For the login route: may this user log in right now? Anybody may while the
 * board is open; only a sysop while it is closed.
 */
function loginAllowed(user) {
	if (!currentMaintenance().active) return true;
	return isSysop(user);
}

export {
	OPEN_PATHS,
	isSysop,
	decide,
	viewModel,
	sendClosed,
	maintenanceMiddleware,
	loginAllowed
};
