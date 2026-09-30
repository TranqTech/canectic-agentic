// callflow.js -- Web call flow router.
//
// Guided login experience: walks web users through what's new since
// their last visit. Stages loaded via AJAX as HTML partials. Each stage is
// a web block from src/webBlocks, shared with the rest of the web UI.

import express from 'express';
var router = express.Router();

import bodyParser from 'body-parser';
import * as alogger from '../utils/alogger.js';
var urlencodedParser = bodyParser.urlencoded({ extended: true });

import * as sessionStore from '../middleware/db/sessionstore.js';
import * as postgres from '../middleware/db/postgres.js';
import { addMessage as addWallMessage, canPost as canPostWall, purgeOldMessages as purgeWall } from '../models/wall.js';
import * as webBlocks from '../webBlocks/index.js';
import appConfig from '../config/appConfig.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCurrentUser(req) {
	if (!req.cookies || !req.cookies.sessionid) return null;
	var session = await sessionStore.sessionGet(req.cookies.sessionid);
	return session && session.id ? session : null;
}

async function updateLastCallflowAt(userId) {
	await postgres.write(
		'UPDATE users SET last_callflow_at = NOW() WHERE id = $1',
		[userId]
	);
}

// ---------------------------------------------------------------------------
// Main call flow page
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.redirect('/users/login');

	// Read return URL from session (avoid looping back to callflow itself)
	var returnUrl = '/';
	var sess = null;
	if (req.cookies && req.cookies.sessionid) {
		sess = await sessionStore.sessionGet(req.cookies.sessionid);
		if (sess && sess.callflow_return_url && !sess.callflow_return_url.startsWith('/callflow')) {
			returnUrl = sess.callflow_return_url;
		}
	}

	if (!appConfig.getBoolean('callflow_enabled', true)) {
		return res.redirect(returnUrl);
	}

	// Suppress the banner on the callflow page itself
	res.locals.callflowPending = false;
	res.locals.callflowForce = false;

	// Reconcile the session's cached last_callflow_at against the database.
	//
	// That cache has no expiry and is only ever corrected by an explicit write,
	// so a session a write failed to reach keeps a stale value for its whole
	// life and is forced back here on every request. This is the way out: the
	// database is authoritative, the user is already on the page that would be
	// looping, and it costs one query on a page nobody loads in a hot path.
	if (currentuser && req.cookies && req.cookies.sessionid) {
		try {
			var dbLast = await webBlocks.getLastCallflowAt(parseInt(currentuser.id));
			var dbTs = dbLast ? String(dbLast.getTime()) : '0';
			if (sess && sess.last_callflow_at !== dbTs) {
				await sessionStore.sessionUpdate(req.cookies.sessionid, {
					last_callflow_at: dbTs,
					_callflow_checked: 'true'
				});
				alogger.writeAlog(5, 'Callflow: reconciled session cache from db (' +
					(sess.last_callflow_at || 'unset') + ' -> ' + dbTs + ')', 'cyan');
			}
		} catch (err) {
			alogger.writeAlog(4, 'Callflow: cache reconcile failed: ' + err.message, 'yellow');
		}
	}

	// Clear callflow_pending flag so viewing the callflow page itself breaks the loop.
	// If the user leaves without completing, the time-based check will still trigger
	// when appropriate, but the session won't have a sticky pending flag.
	if (sess && sess.callflow_pending === 'true') {
		await sessionStore.sessionUpdate(req.cookies.sessionid, { callflow_pending: '' });
	}

	res.render('callflow/index', {
		title: 'Welcome',
		activelink: '',
		currentuser: currentuser,
		returnUrl: returnUrl
	});
});

// ---------------------------------------------------------------------------
// Stages JSON -- list of stages with data for this user
// ---------------------------------------------------------------------------
//
// The stages are web blocks (src/webBlocks); this route only decides which
// flow and whose context.

router.get('/stages.json', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.json({ stages: [] });

	var ctx = webBlocks.createContext(req, currentuser);
	res.json({ stages: await webBlocks.buildStageList(ctx) });
});

// ---------------------------------------------------------------------------
// Stage partials
// ---------------------------------------------------------------------------

router.get('/stage/:name', async (req, res) => {
	var block = webBlocks.getBlock(req.params.name);
	if (!block) return res.status(404).send('');

	var currentuser = await getCurrentUser(req);
	if (block.requiresUser && !currentuser) return res.status(401).send('');

	var ctx = webBlocks.createContext(req, currentuser);
	var locals = await block.load(ctx);
	res.render(block.view, Object.assign({ layout: false }, locals));
});

router.post('/wall', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser || !canPostWall(currentuser)) return res.json({ status: false });

	var message = ((req.body && req.body.message) || '').trim();
	if (message.length > 0) {
		await addWallMessage(parseInt(currentuser.id), currentuser.username, message);
		await purgeWall();
	}
	res.json({ status: true });
});

// ---------------------------------------------------------------------------
// Complete -- mark call flow done, redirect to destination
// ---------------------------------------------------------------------------

router.post('/complete', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var nowTs = String(Date.now());

	alogger.writeAlog(5, 'Callflow complete: user=' + (currentuser ? currentuser.username : 'null') + ' nowTs=' + nowTs + ' session=' + (req.cookies ? req.cookies.sessionid : 'none'), 'cyan');

	var sessionFields = {
		last_callflow_at: nowTs,
		callflow_pending: '',
		_callflow_checked: 'true'
	};

	if (currentuser) {
		await updateLastCallflowAt(parseInt(currentuser.id));

		// Always write the session that actually completed the flow, first and
		// unconditionally. The broadcast below reaches every session in the
		// username index, and this one may not be in it: the index key expires
		// on its own schedule and is rebuilt at login, so an older window's
		// session drops out of it while its own hash lives on. The old code
		// only fell back when the broadcast updated nothing at all, so a user
		// with a newer session elsewhere got a non-zero count, no fallback, and
		// an older window that was forced back here on every request for ever.
		if (req.cookies && req.cookies.sessionid) {
			await sessionStore.sessionUpdate(req.cookies.sessionid, sessionFields);
		}

		// Then the rest of this user's sessions, for multi-tab and multi-device.
		var updateCount = await sessionStore.sessionUpdateUser(currentuser.username, sessionFields);
		alogger.writeAlog(5, 'Callflow session update: ' + updateCount + ' indexed session(s) for ' + currentuser.username, 'cyan');
	} else if (req.cookies && req.cookies.sessionid) {
		await sessionStore.sessionUpdate(req.cookies.sessionid, sessionFields);
		alogger.writeAlog(5, 'Callflow session update: no user, fallback for session ' + req.cookies.sessionid, 'cyan');
	}

	// Express 5 leaves req.body undefined when nothing is posted.
	var returnUrl = (req.body && req.body.return_url) || '/';
	if (returnUrl.startsWith('/callflow')) returnUrl = '/';
	alogger.writeAlog(5, 'Callflow complete: redirecting to ' + returnUrl, 'cyan');
	res.json({ redirect: returnUrl });
});

export { router };
