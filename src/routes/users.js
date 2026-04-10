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
import * as apiTokens from '../models/apiTokens.js';
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
function setSessionCookie(res, sessionid, maxAge) {
	res.cookie('sessionid', sessionid, {
		httpOnly: true,
		maxAge:   maxAge || cookieMaxAge,
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
	var successMsg = req.query.message || null;
	res.render('users/login', {
		title:    'Login',
		redirect: redirect,
		errors:   null,
		successMessage: successMsg,
		rememberDays: appConfig.getNumber('remember_me_days', 30)
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
			errors:   messages,
			rememberDays: appConfig.getNumber('remember_me_days', 30)
		});
	};

	if (!username || !password) {
		return fail(['Username and password are required']);
	}

	var clientIp = req.ip || req.connection.remoteAddress || 'unknown';
	var result = await userAccounts.checkUserPass(username, password, { ip: clientIp });

	if (!result.isvalid) {
		alogger.writeAlog(4, 'Failed login attempt for: ' + username, 'yellowbright');
		// Return a deliberately vague message — don't confirm whether username exists
		return fail(['Invalid username or password']);
	}

	var userobj = result.useraccount;

	var sessionid   = uuidv4();
	var sessionData = userAccounts.buildSessionData(userobj);
	var rememberMe  = req.body.remember_me === 'on' || req.body.remember_me === 'true';
	var sessionTtl  = rememberMe
		? appConfig.getNumber('remember_me_days', 30) * 86400
		: appConfig.getNumber('session_ttl', 2880) * 60;

	var ok = await sessionStore.sessionStore(sessionid, sessionData, sessionTtl);

	if (!ok) {
		alogger.writeAlog(3, 'Session creation failed for: ' + username, 'redbright');
		return fail(['Login failed — please try again']);
	}

	// Set cookie maxAge to match session TTL so the browser keeps it
	setSessionCookie(res, sessionid, rememberMe ? sessionTtl * 1000 : undefined);

	// Log the call and update user login stats (same as terminal login)
	var clientIp = req.ip || req.connection.remoteAddress || '';
	userAccounts.updateUserCalls(userobj);
	callers.logCall(userobj, 'Web', clientIp, userobj.location || '');

	// Set web activity timestamp so webActivity middleware doesn't double-log
	try {
		var redis = await import('../middleware/db/redis.js');
		var rc = await redis.getClient();
		await rc.set('web_activity:' + sessionid, String(Date.now()), { EX: appConfig.getNumber('session_ttl', 720) * 60 });
	} catch (_) {}

	// Cache last_callflow_at on session so the middleware doesn't need to query DB every request
	try {
		var lastCfDate = await userAccounts.getLastCallflowAt(userobj.id);
		var lastCfTs = lastCfDate ? String(lastCfDate.getTime()) : '0';
		await sessionStore.sessionUpdate(sessionid, {
			last_callflow_at: lastCfTs,
			_callflow_checked: 'true'
		});
	} catch (_) {}

	alogger.writeAlog(5, 'Web login: ' + username, 'greenbright');

	// Route through call flow on fresh login (if enabled)
	var callflowEnabled = appConfig.getBoolean('callflow_enabled', true);
	var finalRedirect = redirectTo;
	if (callflowEnabled) {
		// Store the original destination so call flow redirects there after completion
		await sessionStore.sessionUpdate(sessionid, { callflow_return_url: redirectTo });
		finalRedirect = '/callflow';
	}

	if (isAjax) {
		return res.json({ status: true, redirect: finalRedirect });
	}
	return res.redirect(finalRedirect);
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
   GET /users/forgot
   Renders password reset request page.
----------------------------------------------- */
router.get('/forgot', async (req, res) => {
	res.render('users/forgot', {
		title:   'Forgot Password',
		message: req.query.message || null,
		error:   req.query.error || null
	});
});

/* -----------------------------------------------
   POST /users/forgot
   Sends a reset token to the user's email/netmail.
----------------------------------------------- */
router.post('/forgot', urlencodedParser, async (req, res) => {
	var username = (req.body.username || '').trim();
	if (!username) {
		return res.redirect('/users/forgot?error=' + encodeURIComponent('Username is required'));
	}

	var passwordReset = await import('../models/passwordReset.js');
	await passwordReset.requestReset(username);

	// Always show the same message regardless of whether user exists
	return res.redirect('/users/forgot?message=' + encodeURIComponent('If an account exists for that username, a reset link has been sent to the address on file.'));
});

/* -----------------------------------------------
   GET /users/reset/:token
   Validates token and shows password change form.
----------------------------------------------- */
router.get('/reset/:token', async (req, res) => {
	var passwordReset = await import('../models/passwordReset.js');
	var validation = await passwordReset.validateToken(req.params.token);

	if (!validation.valid) {
		return res.render('users/forgot', {
			title:   'Forgot Password',
			message: null,
			error:   validation.error || 'Invalid or expired reset link'
		});
	}

	res.render('users/reset', {
		title:    'Reset Password',
		token:    req.params.token,
		username: validation.username,
		pwmin:    appConfig.getNumber('pwmin', 12),
		error:    null
	});
});

/* -----------------------------------------------
   POST /users/reset
   Validates token and changes password.
----------------------------------------------- */
router.post('/reset', urlencodedParser, async (req, res) => {
	var token = (req.body.token || '').trim();
	var newPassword = req.body.password || '';
	var confirmPassword = req.body.password_confirm || '';
	var pwmin = appConfig.getNumber('pwmin', 12);

	var passwordReset = await import('../models/passwordReset.js');

	// Validate token first
	var validation = await passwordReset.validateToken(token);
	if (!validation.valid) {
		return res.render('users/forgot', {
			title:   'Forgot Password',
			message: null,
			error:   validation.error || 'Invalid or expired reset link'
		});
	}

	// Validate password
	if (!newPassword || newPassword.length < pwmin) {
		return res.render('users/reset', {
			title:    'Reset Password',
			token:    token,
			username: validation.username,
			pwmin:    pwmin,
			error:    'Password must be at least ' + pwmin + ' characters'
		});
	}

	if (newPassword !== confirmPassword) {
		return res.render('users/reset', {
			title:    'Reset Password',
			token:    token,
			username: validation.username,
			pwmin:    pwmin,
			error:    'Passwords do not match'
		});
	}

	// Complete the reset
	var result = await passwordReset.completeReset(validation.userId, newPassword);
	if (!result.status) {
		return res.render('users/reset', {
			title:    'Reset Password',
			token:    token,
			username: validation.username,
			pwmin:    pwmin,
			error:    result.error || 'Reset failed'
		});
	}

	return res.redirect('/users/login?message=' + encodeURIComponent('Password reset successfully. Please log in.'));
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

	// Calculate username change cooldown
	var cooldownDays = appConfig.getNumber('username_change_cooldown', 90);
	var canChangeUsername = true;
	var usernameNextChange = null;
	if (cooldownDays > 0 && userRecord.username_changed_at) {
		var changed = new Date(userRecord.username_changed_at);
		var nextAllowed = new Date(changed.getTime() + cooldownDays * 24 * 60 * 60 * 1000);
		if (Date.now() < nextAllowed.getTime()) {
			canChangeUsername = false;
			usernameNextChange = nextAllowed;
		}
	}

	// Load user's API tokens for the Tokens section
	var userTokens = await apiTokens.getByUser(userRecord.id);

	res.render('users/profile', {
		title:             'My Profile',
		activelink:        '',
		user:              userRecord,
		canChangeUsername:  canChangeUsername,
		usernameNextChange: usernameNextChange,
		cooldownDays:      cooldownDays,
		pwmin:             appConfig.getNumber('pwmin', 12),
		apiTokenList:      userTokens,
		apiTokenScopes:    apiTokens.VALID_SCOPES,
		apiScopeLabels:    apiTokens.SCOPE_LABELS,
		newApiTokenValue:  req.query.new_token || null,
		message:           req.query.message || null,
		error:             req.query.error || null
	});
});

/* -----------------------------------------------
   User-managed API tokens
----------------------------------------------- */
router.post('/profile/api-tokens/new', urlencodedParser, async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session || !session.id) return res.redirect('/users/login');

	var result = await apiTokens.createToken(parseInt(session.id), req.body);
	if (!result.status) {
		return res.redirect('/users/profile?error=' + encodeURIComponent(result.errormessages.join('. ')));
	}
	// Pass the new token via query string once (user copies and it's gone)
	return res.redirect('/users/profile?new_token=' + encodeURIComponent(result.plaintext));
});

router.post('/profile/api-tokens/:id/revoke', urlencodedParser, async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session || !session.id) return res.redirect('/users/login');

	// Verify the token belongs to this user before revoking
	var token = await apiTokens.getById(parseInt(req.params.id));
	if (!token || token.user_id !== parseInt(session.id)) {
		return res.redirect('/users/profile?error=' + encodeURIComponent('Token not found'));
	}

	var result = await apiTokens.revokeToken(token.id);
	if (!result.status) {
		return res.redirect('/users/profile?error=' + encodeURIComponent(result.errormessages.join('. ')));
	}
	return res.redirect('/users/profile?message=' + encodeURIComponent('Token revoked'));
});

router.post('/profile/api-tokens/:id/delete', urlencodedParser, async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session || !session.id) return res.redirect('/users/login');

	var token = await apiTokens.getById(parseInt(req.params.id));
	if (!token || token.user_id !== parseInt(session.id)) {
		return res.redirect('/users/profile?error=' + encodeURIComponent('Token not found'));
	}

	var result = await apiTokens.deleteToken(token.id);
	if (!result.status) {
		return res.redirect('/users/profile?error=' + encodeURIComponent(result.errormessages.join('. ')));
	}
	return res.redirect('/users/profile?message=' + encodeURIComponent('Token deleted'));
});

/* -----------------------------------------------
   POST /users/profile
   Updates user profile fields.
----------------------------------------------- */
router.post('/profile', urlencodedParser, async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session) return res.redirect('/users/login');

	var uid = parseInt(session.id);
	var userRecord = await userAccounts.getUserByUUID(session.uuid);
	if (!userRecord) return res.redirect('/users/login');

	var postgres = await import('../middleware/db/postgres.js');
	var errors = [];
	var updateFields = {};

	// Username change (with cooldown)
	var newUsername = (req.body.username || '').trim();
	if (newUsername && newUsername !== userRecord.username) {
		var cooldownDays = appConfig.getNumber('username_change_cooldown', 90);
		if (cooldownDays > 0 && userRecord.username_changed_at) {
			var changed = new Date(userRecord.username_changed_at);
			var nextAllowed = new Date(changed.getTime() + cooldownDays * 24 * 60 * 60 * 1000);
			if (Date.now() < nextAllowed.getTime()) {
				errors.push('Username can only be changed every ' + cooldownDays + ' days. Next change allowed: ' + nextAllowed.toLocaleDateString());
			}
		}
		if (newUsername.length < 3) {
			errors.push('Username must be at least 3 characters');
		}
		if (errors.length === 0) {
			var available = await userAccounts.checkUsernameAvailable(newUsername);
			if (!available) {
				errors.push('Username is already taken');
			} else {
				updateFields.username = newUsername;
				updateFields.username_changed_at = new Date();
			}
		}
	}

	// Name fields
	var firstname = (req.body.firstname || '').trim();
	var lastname = (req.body.lastname || '').trim();
	if (firstname && firstname !== (userRecord.firstname || '')) {
		updateFields.firstname = firstname;
	}
	if (lastname && lastname !== (userRecord.lastname || '')) {
		updateFields.lastname = lastname;
	}
	if (updateFields.firstname || updateFields.lastname) {
		var fn = updateFields.firstname || userRecord.firstname || '';
		var ln = updateFields.lastname || userRecord.lastname || '';
		updateFields.fullname = (fn + ' ' + ln).trim();
	}

	// Location
	var location = (req.body.location || '').trim();
	if (location !== (userRecord.location || '')) {
		updateFields.location = location || null;
	}

	// Gender
	var gender = (req.body.gender || '').trim();
	if (gender && ['Male', 'Female', 'Other', 'Undisclosed'].includes(gender) && gender !== userRecord.gender) {
		updateFields.gender = gender;
	}

	if (errors.length > 0) {
		return res.redirect('/users/profile?error=' + encodeURIComponent(errors.join('. ')));
	}

	// Apply updates if any
	if (Object.keys(updateFields).length > 0) {
		updateFields.updated_at = new Date();
		await postgres.updateById(userRecord.id, updateFields, 'users');

		// Update session if username changed
		if (updateFields.username) {
			var updatedUser = await userAccounts.getUserByUUID(session.uuid);
			if (updatedUser) {
				var newSessionData = userAccounts.buildSessionData(updatedUser);
				await sessionStore.sessionStore(sessionid, newSessionData);
			}
		}

		return res.redirect('/users/profile?message=' + encodeURIComponent('Profile updated'));
	}

	return res.redirect('/users/profile');
});

/* -----------------------------------------------
   POST /users/profile/password
   Changes the user's password (requires current password).
----------------------------------------------- */
router.post('/profile/password', urlencodedParser, async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session) return res.redirect('/users/login');

	var currentPassword = req.body.current_password || '';
	var newPassword = req.body.new_password || '';
	var confirmPassword = req.body.confirm_password || '';
	var pwmin = appConfig.getNumber('pwmin', 12);

	// Verify current password
	var authResult = await userAccounts.checkUserPass(session.username, currentPassword);
	if (!authResult.isvalid) {
		return res.redirect('/users/profile?error=' + encodeURIComponent('Current password is incorrect'));
	}

	// Validate new password
	if (!newPassword || newPassword.length < pwmin) {
		return res.redirect('/users/profile?error=' + encodeURIComponent('New password must be at least ' + pwmin + ' characters'));
	}
	if (newPassword !== confirmPassword) {
		return res.redirect('/users/profile?error=' + encodeURIComponent('New passwords do not match'));
	}

	// Update password
	var success = await userAccounts.updateUserPassword(session.username, newPassword);
	if (!success) {
		return res.redirect('/users/profile?error=' + encodeURIComponent('Failed to update password'));
	}

	return res.redirect('/users/profile?message=' + encodeURIComponent('Password changed successfully'));
});

/* -----------------------------------------------
   POST /users/profile/logout-all
   Destroys all sessions except the current one.
----------------------------------------------- */
router.post('/profile/logout-all', urlencodedParser, async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session) return res.redirect('/users/login');

	var password = req.body.password || '';
	var authResult = await userAccounts.checkUserPass(session.username, password);
	if (!authResult.isvalid) {
		return res.redirect('/users/profile?error=' + encodeURIComponent('Incorrect password'));
	}

	var count = await sessionStore.destroyAllForUser(session.username, sessionid);
	return res.redirect('/users/profile?message=' + encodeURIComponent('Logged out ' + count + ' other session(s)'));
});

/* -----------------------------------------------
   GET /users/verify
   Shows email/netmail verification page.
----------------------------------------------- */
router.get('/verify', async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login?redirect=/users/verify');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session) return res.redirect('/users/login?redirect=/users/verify');

	res.locals.currentuser = session;
	var uid = parseInt(session.id);
	var userRecord = await userAccounts.getUserByUUID(session.uuid);
	if (!userRecord) return res.redirect('/users/login');

	var mailVerification = await import('../models/mailVerification.js');
	var verified = await mailVerification.isVerified(uid);

	// Calculate days remaining if unverified retention is configured
	var daysRemaining = null;
	if (!verified) {
		var retDays = appConfig.getNumber('unverified_retention_days', 14);
		if (retDays > 0 && userRecord.created_at) {
			var created = new Date(userRecord.created_at);
			var expires = new Date(created.getTime() + retDays * 24 * 60 * 60 * 1000);
			daysRemaining = Math.max(0, Math.ceil((expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
		}
	}

	res.render('users/verify', {
		title:         'Verify Address',
		activelink:    '',
		user:          userRecord,
		verified:      verified,
		daysRemaining: daysRemaining,
		message:       req.query.message || null,
		error:         req.query.error || null
	});
});

/* -----------------------------------------------
   POST /users/verify/send
   Sends/resends a verification code.
----------------------------------------------- */
router.post('/verify/send', async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session) return res.redirect('/users/login');

	var uid = parseInt(session.id);
	var mailVerification = await import('../models/mailVerification.js');
	var result = await mailVerification.sendVerificationCode(uid);

	if (result.status) {
		return res.redirect('/users/verify?message=Verification code sent');
	}
	return res.redirect('/users/verify?error=' + encodeURIComponent(result.error || 'Failed to send code'));
});

/* -----------------------------------------------
   POST /users/verify/check
   Validates a submitted verification code.
----------------------------------------------- */
router.post('/verify/check', urlencodedParser, async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session) return res.redirect('/users/login');

	var uid = parseInt(session.id);
	var code = (req.body.code || '').trim();
	var mailVerification = await import('../models/mailVerification.js');
	var result = await mailVerification.verifyCode(uid, code);

	if (result.status) {
		return res.redirect('/users/verify?message=Address verified successfully');
	}
	return res.redirect('/users/verify?error=' + encodeURIComponent(result.error || 'Verification failed'));
});

/* -----------------------------------------------
   POST /users/verify/change
   Updates the user's email/netmail address and sends a new code.
----------------------------------------------- */
router.post('/verify/change', urlencodedParser, async (req, res) => {
	var sessionid = req.cookies.sessionid;
	if (!sessionid) return res.redirect('/users/login');
	var session = await sessionStore.sessionGet(sessionid);
	if (!session) return res.redirect('/users/login');

	var uid = parseInt(session.id);
	var newAddr = (req.body.new_address || '').trim().toLowerCase();

	if (!newAddr) {
		return res.redirect('/users/verify?error=' + encodeURIComponent('Address cannot be empty'));
	}

	// Check uniqueness
	var isUnique = await userAccounts.checkMailUnique(newAddr);
	if (!isUnique) {
		return res.redirect('/users/verify?error=' + encodeURIComponent('That address is already in use'));
	}

	// Detect mail type
	var mailtype = userAccounts.detectMailType(newAddr);

	// Update user record, reset verification
	var postgres = await import('../middleware/db/postgres.js');
	await postgres.write(
		'UPDATE users SET mailaddress = $1, mailtype = $2, mailverified = false, mailverified_at = NULL, mailtoken = NULL, mailtoken_created = NULL, updated_at = NOW() WHERE id = $3',
		[newAddr, mailtype, uid]
	);

	// Send verification code to new address
	var mailVerification = await import('../models/mailVerification.js');
	var sendResult = await mailVerification.sendVerificationCode(uid);

	if (sendResult.status) {
		return res.redirect('/users/verify?message=' + encodeURIComponent('Address updated. Verification code sent to ' + newAddr));
	}
	return res.redirect('/users/verify?message=' + encodeURIComponent('Address updated to ' + newAddr) + '&error=' + encodeURIComponent(sendResult.error || 'Could not send verification code'));
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