//imports
import express from 'express';
const router = express.Router();
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import mobile from 'is-mobile';

//internals
import * as userAccounts from '../models/useraccounts.js';
import * as sessionStore from '../middleware/db/sessionstore.js';
import * as callers from '../models/callers.js';
import * as alogger from '../utils/alogger.js';
import appConfig from "../config/appConfig.js";

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '1mb', extended: true });
const cookieMaxAge = 1000 * 60 * 60 * 24 * 7; // 7 days

// Inject shared locals for all user views
router.use(function(req, res, next) {
	res.locals.currentPath = '/users' + req.path;
	res.locals.boardname   = appConfig.get('boardname', 'BBS');
	res.locals.faviconlink = appConfig.get('faviconlink', '/images/favicon.ico');
	res.locals.ismobile    = mobile({ ua: req.headers['user-agent'] });
	next();
});

// Helper: set session cookie
function setSessionCookie(res, sessionid) {
	res.cookie('sessionid', sessionid, {
		httpOnly: true,
		maxAge:   cookieMaxAge,
		domain:   appConfig.get('sitetld') || undefined,
		sameSite: 'lax'
	});
}

// Helper: determine if request expects JSON
function wantsJson(req) {
	return req.headers['accept'] && req.headers['accept'].includes('application/json');
}

// Helper: safe redirect target — reject absolute URLs and protocol-relative paths
function safeRedirect(target, fallback) {
	if (!target || typeof target !== 'string') return fallback;
	if (/^(https?:)?\/\//i.test(target)) return fallback;
	return target;
}

/* -----------------------------------------------
   GET /users/login
   Renders login page. If already logged in, redirect to /
----------------------------------------------- */
router.get('/login', async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (sessionid) {
		var existing = await sessionStore.sessionGet(sessionid);
		if (existing) return res.redirect('/');
	}
	var redirect = safeRedirect(req.query.redirect, '/');
	res.render('users/login', {
		title:    'Login',
		redirect: redirect,
		errors:   null
	});
});

/* -----------------------------------------------
   POST /users/login
   Accepts both form submissions and JSON/AJAX.
   Form:  reads req.body.redirect for post-login destination
   AJAX:  same, but responds with JSON { status, redirect }
          instead of performing the redirect server-side.
          Caller is responsible for setting window.location.
----------------------------------------------- */
router.post('/login', urlencodedParser, async (req, res) => {
	console.log(req.body)
	var username   = (req.body.username || '').trim();
	var password   = req.body.password  || '';
	var redirectTo = safeRedirect(req.body.redirect, '/');
	var isAjax     = wantsJson(req);

	var fail = function(messages) {
		if (isAjax) {
			return res.status(401).json({ status: false, errors: messages });
		}
		return res.render('users/login', {
			title:    'Login',
			redirect: redirectTo,
			errors:   messages
		});
	};

	if (!username || !password) {
		return fail(['Username and password are required']);
	}

	var result = await userAccounts.checkUserPass(username, password);

	if (!result.isvalid) {
		alogger.writeAlog(4, 'Failed login attempt for: ' + username, 'yellowbright');
		// Return a deliberately vague message — don't confirm whether username exists
		return fail(['Invalid username or password']);
	}

	var userobj = result.useraccount;

	var sessionid   = uuidv4();
	var sessionData = userAccounts.buildSessionData(userobj);
	var ok = await sessionStore.sessionStore(sessionid, sessionData);

	if (!ok) {
		alogger.writeAlog(3, 'Session creation failed for: ' + username, 'redbright');
		return fail(['Login failed — please try again']);
	}

	setSessionCookie(res, sessionid);

	// Log the call and update user login stats (same as terminal login)
	var clientIp = req.ip || req.connection.remoteAddress || '';
	userAccounts.updateUserCalls(userobj);
	callers.logCall(userobj, 'Web', clientIp, userobj.location || '');

	alogger.writeAlog(5, 'Web login: ' + username, 'greenbright');

	if (isAjax) {
		return res.json({ status: true, redirect: redirectTo });
	}
	return res.redirect(redirectTo);
});

/* -----------------------------------------------
   GET /users/logout
   Destroys session and clears cookie.
   Redirects to /users/login.
----------------------------------------------- */
router.get('/logout', async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (sessionid) {
		await sessionStore.sessionDestroy(sessionid);
		res.clearCookie('sessionid', {
			httpOnly: true,
			domain:   appConfig.get('sitetld') || undefined,
			sameSite: 'lax'
		});
	}
	res.redirect('/users/login');
});

/* -----------------------------------------------
   GET /users/register
   Renders registration page.
----------------------------------------------- */
router.get('/register', async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (sessionid) {
		var existing = await sessionStore.sessionGet(sessionid);
		if (existing) return res.redirect('/');
	}
	res.render('users/register', {
		title:    'Register',
		errors:   null,
		form:     null,
		minage:   appConfig.getNumber('minage', 13),
		pwmin:    appConfig.getNumber('pwmin', 12)
	});
});

/* -----------------------------------------------
   POST /users/register
   Creates new user account.
----------------------------------------------- */
router.post('/register', urlencodedParser, async (req, res) => {
	var formObj  = req.body;
	var isAjax   = wantsJson(req);
	var minage   = appConfig.getNumber('minage', 13);
	var pwmin    = appConfig.getNumber('pwmin', 12);

	var fail = function(messages) {
		if (isAjax) {
			return res.status(400).json({ status: false, errors: messages });
		}
		return res.render('users/register', {
			title:  'Register',
			errors: messages,
			form:   formObj,
			minage: minage,
			pwmin:  pwmin
		});
	};

	// --- Server-side validation ---
	var errors = [];

	// Age verification
	if (formObj.age_verified !== 'yes') {
		errors.push('You must confirm you are at least ' + minage + ' years old');
	}

	// Username
	var username = (formObj.username || '').trim();
	if (!username) {
		errors.push('Username is required');
	} else if (username.length < 3) {
		errors.push('Username must be at least 3 characters');
	}

	// Password
	var password = formObj.password || '';
	if (!password) {
		errors.push('Password is required');
	} else if (password.length < pwmin) {
		errors.push('Password must be at least ' + pwmin + ' characters');
	}

	// Password confirmation
	var passwordConfirm = formObj.password_confirm || '';
	if (password && password !== passwordConfirm) {
		errors.push('Passwords do not match');
	}

	// First name
	if (!(formObj.firstname || '').trim()) {
		errors.push('First name is required');
	}

	// Last name
	if (!(formObj.lastname || '').trim()) {
		errors.push('Last name is required');
	}

	// Email / Netmail
	if (!(formObj.mailaddress || '').trim()) {
		errors.push('Email or netmail address is required');
	}

	// Gender
	var gender = (formObj.gender || '').trim();
	if (!gender) {
		errors.push('Gender selection is required');
	} else if (!['Male', 'Female', 'Other', 'Undisclosed'].includes(gender)) {
		errors.push('Invalid gender selection');
	}

	// Birthdate
	var birthdate = (formObj.birthdate || '').trim();
	if (!birthdate) {
		errors.push('Birthdate is required');
	} else {
		var bd = new Date(birthdate);
		if (isNaN(bd.getTime())) {
			errors.push('Birthdate must be a valid date');
		} else {
			// Check minimum age
			var today = new Date();
			var age = today.getFullYear() - bd.getFullYear();
			var monthDiff = today.getMonth() - bd.getMonth();
			if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < bd.getDate())) {
				age--;
			}
			if (age < minage) {
				errors.push('You must be at least ' + minage + ' years old to register');
			}
		}
	}

	if (errors.length > 0) {
		return fail(errors);
	}

	// Check username availability
	var usernameAvailable = await userAccounts.checkUsernameAvailable(username);
	if (!usernameAvailable) {
		return fail(['Username is already taken']);
	}

	// --- Create the user ---
	var result = await userAccounts.createNewUser(formObj);

	if (!result.status) {
		return fail(result.errormessages);
	}

	alogger.writeAlog(3, 'New web registration: ' + username + ' (id: ' + result.resultid + ')', 'greenbright');

	// Auto-login the new user
	var newUser = await userAccounts.getUserByUUID(formObj.uuid || '');
	if (!newUser) {
		// Fallback: fetch by username if uuid not on formObj
		newUser = await userAccounts.getUserRecord(username);
	}
	if (newUser) {
		var sessionid   = uuidv4();
		var sessionData = userAccounts.buildSessionData(newUser);
		var ok = await sessionStore.sessionStore(sessionid, sessionData);
		if (ok) {
			setSessionCookie(res, sessionid);

			// Log the call for the new registration
			var regIp = req.ip || req.connection.remoteAddress || '';
			userAccounts.updateUserCalls(newUser);
			callers.logCall(newUser, 'Web', regIp, newUser.location || '');

			alogger.writeAlog(5, 'Auto-login after registration: ' + username, 'greenbright');
			if (isAjax) {
				return res.json({ status: true, redirect: '/users/profile' });
			}
			return res.redirect('/users/profile');
		}
	}

	// Fallback if auto-login fails
	if (isAjax) {
		return res.json({ status: true, redirect: '/users/login' });
	}
	return res.redirect('/users/login');
});

/* -----------------------------------------------
   GET /users/profile
   Shows user profile/settings page (logged in only).
----------------------------------------------- */
router.get('/profile', async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login?redirect=/users/profile');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session) return res.redirect('/users/login?redirect=/users/profile');

	res.locals.currentuser = session;

	// Unread PM count for nav badge
	var uid = parseInt(session.id);
	if (uid && uid > 0) {
		var privateMessages = await import('../models/privateMessages.js');
		res.locals.pmUnreadCount = await privateMessages.getUnreadCount(uid);
	}

	// Fetch full user record for display
	var userRecord = await userAccounts.getUserByUUID(session.uuid);
	if (!userRecord) return res.redirect('/users/login');

	res.render('users/profile', {
		title:      'My Profile',
		activelink: '',
		user:       userRecord
	});
});

/* -----------------------------------------------
   GET /users/check-username?username=...
   AJAX endpoint: checks if a username is available.
----------------------------------------------- */
router.get('/check-username', async (req, res) => {
	var username = (req.query.username || '').trim();
	if (!username || username.length < 3) {
		return res.json({ available: false, reason: 'too_short' });
	}
	var available = await userAccounts.checkUsernameAvailable(username);
	return res.json({ available: available });
});

/* -----------------------------------------------
   GET /users/check-email?email=...
   AJAX endpoint: checks if an email/netmail is already registered.
----------------------------------------------- */
router.get('/check-email', async (req, res) => {
	var email = (req.query.email || '').trim();
	if (!email) {
		return res.json({ available: true });
	}
	var available = await userAccounts.checkMailUnique(email);
	return res.json({ available: available });
});

export { router };