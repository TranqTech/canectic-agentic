//imports
import express from 'express';
const router = express.Router();
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';

//internals
import * as userAccounts from '../models/useraccounts.js';
import * as sessionStore from '../middleware/db/sessionstore.js';
import * as alogger from '../utils/alogger.js';

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '1mb', extended: true });

//variables and const
const sitetld      = process.env.sitetld;
const cookieMaxAge = 1000 * 60 * 60 * 24 * 7; // 7 days

// Inject shared locals for all user views
router.use(function(req, res, next) {
	res.locals.currentPath = '/users' + req.path;
	next();
});

// Helper: set session cookie
function setSessionCookie(res, sessionid) {
	res.cookie('sessionid', sessionid, {
		httpOnly: true,
		maxAge:   cookieMaxAge,
		domain:   sitetld || undefined,
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

// Helper: flatten a user record into Redis-safe strings
// sessionGet will parse permissionflags, restrictionflags, isSysop, and security back out
function buildSessionData(userobj) {
	return {
		uuid:             userobj.uuid             || '',
		username:         userobj.username         || '',
		firstname:        userobj.firstname        || '',
		lastname:         userobj.lastname         || '',
		fullname:         userobj.fullname         || '',
		security:         String(userobj.security  || 0),
		isSysop:          String(userobj.isSysop   || false),
		permissionflags:  JSON.stringify(Array.isArray(userobj.permissionflags)  ? userobj.permissionflags  : []),
		restrictionflags: JSON.stringify(Array.isArray(userobj.restrictionflags) ? userobj.restrictionflags : []),
		mailaddress:      userobj.mailaddress      || '',
		mailtype:         userobj.mailtype         || '',
	};
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
	var sessionData = buildSessionData(userobj);
	var ok = await sessionStore.sessionStore(sessionid, sessionData);

	if (!ok) {
		alogger.writeAlog(3, 'Session creation failed for: ' + username, 'redbright');
		return fail(['Login failed — please try again']);
	}

	setSessionCookie(res, sessionid);
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
			domain:   sitetld || undefined,
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
		title:  'Register',
		errors: null
	});
});

/* -----------------------------------------------
   POST /users/register
   Creates new user account.
----------------------------------------------- */
router.post('/register', urlencodedParser, async (req, res) => {
	var formObj  = req.body;
	var isAjax   = wantsJson(req);

	var fail = function(messages) {
		if (isAjax) {
			return res.status(400).json({ status: false, errors: messages });
		}
		return res.render('users/register', {
			title:  'Register',
			errors: messages,
			form:   formObj  // repopulate form fields on error
		});
	};

	var result = await userAccounts.saveUser(formObj);

	if (!result.status) {
		return fail(result.errormessages);
	}

	if (isAjax) {
		return res.json({ status: true, redirect: '/users/login' });
	}
	return res.redirect('/users/login?registered=1');
});

export { router };