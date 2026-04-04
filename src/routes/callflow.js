// callflow.js -- Web call flow router.
//
// Guided login experience: walks web users through what's new since
// their last visit. Stages loaded via AJAX as HTML partials.

import express from 'express';
var router = express.Router();

import bodyParser from 'body-parser';
var urlencodedParser = bodyParser.urlencoded({ extended: true });

import * as sessionStore from '../middleware/db/sessionstore.js';
import * as postgres from '../middleware/db/postgres.js';
import * as announcements from '../models/announcements.js';
import { getLastCallers } from '../models/callers.js';
import { getOnlineUsers } from '../middleware/webActivity.js';
import { getRecentMessages as getWallMessages, addMessage as addWallMessage, canPost as canPostWall, purgeOldMessages as purgeWall } from '../models/wall.js';
import * as userMsgPointers from '../models/userMsgPointers.js';
import * as userAreaSubs from '../models/userAreaSubs.js';
import * as userFilePointers from '../models/userFilePointers.js';
import * as userFileSubs from '../models/userFileSubs.js';
import * as msgAreas from '../models/msgAreas.js';
import * as fileAreas from '../models/fileAreas.js';
import * as fileGroups from '../models/fileGroups.js';
import * as privateMessages from '../models/privateMessages.js';
import { formatActivity } from '../utils/activityMap.js';
import { getDefaultTheme, resolveWebColour } from '../models/themes.js';
import * as newsFilesModel from '../models/newsFiles.js';
import { formatBodyHtml } from '../utils/terminalText.js';
import { getRandomWebArt } from '../utils/webArt.js';
import appConfig from '../config/appConfig.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCurrentUser(req) {
	if (!req.cookies || !req.cookies.sessionid) return null;
	var session = await sessionStore.sessionGet(req.cookies.sessionid);
	return session && session.id ? session : null;
}

async function getLastCallflowAt(userId) {
	var row = await postgres.queryOne(
		'SELECT last_callflow_at FROM users WHERE id = $1',
		[userId]
	);
	return row && row.last_callflow_at ? new Date(row.last_callflow_at) : null;
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

	if (!appConfig.getBoolean('callflow_enabled', true)) {
		return res.redirect(req.session && req.session.callflow_return_url || '/');
	}

	res.render('callflow/index', {
		title: 'Welcome',
		activelink: '',
		currentuser: currentuser
	});
});

// ---------------------------------------------------------------------------
// Stages JSON -- list of stages with data for this user
// ---------------------------------------------------------------------------

router.get('/stages.json', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.json({ stages: [] });

	var userId = parseInt(currentuser.id);
	var lastCf = await getLastCallflowAt(userId);
	var stages = [];

	// 0. Welcome (always shown)
	stages.push({ name: 'welcome', label: 'Welcome' });

	// 1. Announcements: new since last call flow + any pinned (always relevant)
	var allAnnouncements = await announcements.getActiveAnnouncements(20);
	var showAnnouncements = [];
	for (var ann of allAnnouncements) {
		var isNew = !lastCf || new Date(ann.created_at) > lastCf;
		var isPinned = !!ann.pinned;
		if (isNew || isPinned) {
			showAnnouncements.push(ann);
		}
	}
	if (showAnnouncements.length > 0) {
		stages.push({ name: 'announcements', label: 'Announcements', count: showAnnouncements.length });
	}

	// 2. Last callers (always show)
	stages.push({ name: 'lastcallers', label: 'Last Callers' });

	// 3. Who's online (always show)
	stages.push({ name: 'whosonline', label: "Who's Online" });

	// 4. Wall (always show)
	stages.push({ name: 'wall', label: 'The Wall' });

	// 5. News files (door scores, BBS news, etc.)
	var activeNews = await newsFilesModel.getActiveNewsFiles();
	if (activeNews.length > 0) {
		stages.push({ name: 'newsfiles', label: 'News', count: activeNews.length });
	}

	// 6. New messages
	var allAreas = await msgAreas.getAllAreas();
	var activeAreas = allAreas.filter(function(a) { return a.active; });
	var areasWithDefaults = activeAreas.map(function(a) {
		return { shortcode: a.shortcode, newscan_default: a.newscan_default };
	});
	var subscribedShortcodes = await userAreaSubs.getSubscribedAreas(userId, areasWithDefaults);
	var newMsgSummary = await userMsgPointers.getNewscanSummary(userId, subscribedShortcodes);
	if (newMsgSummary.length > 0) {
		var totalNew = 0;
		for (var ns of newMsgSummary) totalNew += ns.unread_count;
		stages.push({ name: 'newmsgs', label: 'New Messages', count: totalNew, areas: newMsgSummary.length });
	}

	// 6. New files
	var allFileAreas = await fileAreas.getAllAreas();
	var activeFileAreas = allFileAreas.filter(function(a) { return a.active; });
	var fileAreasWithDefaults = activeFileAreas.map(function(a) {
		return { shortcode: a.shortcode, newscan_default: a.newscan_default };
	});
	var subscribedFileShortcodes = await userFileSubs.getSubscribedAreas(userId, fileAreasWithDefaults);
	var newFileCount = 0;
	var newFileAreas = 0;
	for (var fsc of subscribedFileShortcodes) {
		var fa = activeFileAreas.find(function(a) { return a.shortcode === fsc; });
		if (!fa) continue;
		var fc = await userFilePointers.getNewCount(userId, fsc, fa.id);
		if (fc > 0) {
			newFileCount += fc;
			newFileAreas++;
		}
	}
	if (newFileCount > 0) {
		stages.push({ name: 'newfiles', label: 'New Files', count: newFileCount, areas: newFileAreas });
	}

	res.json({ stages: stages });
});

// ---------------------------------------------------------------------------
// Stage partials
// ---------------------------------------------------------------------------

router.get('/stage/welcome', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var username = currentuser ? currentuser.username : 'Guest';
	var boardname = appConfig.get('boardname', 'Canectic BBS');
	var artPath = await getRandomWebArt('welcome');

	res.render('callflow/welcome', {
		layout: false,
		username: username,
		boardname: boardname,
		artUrl: artPath ? '/' + artPath : null
	});
});

router.get('/stage/announcements', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.status(401).send('');

	var userId = parseInt(currentuser.id);
	var lastCf = await getLastCallflowAt(userId);
	var allAnnouncements = await announcements.getActiveAnnouncements(20);

	// Include new announcements + pinned (always relevant)
	var showAnnouncements = [];
	for (var ann of allAnnouncements) {
		var isNew = !lastCf || new Date(ann.created_at) > lastCf;
		var isPinned = !!ann.pinned;
		if (isNew || isPinned) {
			ann._isNew = isNew && !isPinned; // flag for "new" badge (only if not pinned, to avoid double-badge)
			showAnnouncements.push(ann);
		}
	}

	// Resolve theme colour for announcement text
	var theme = await getDefaultTheme();
	var themeTextColour = resolveWebColour(theme, 'announcements');

	res.render('callflow/announcements', { layout: false, announcements: showAnnouncements, themeTextColour: themeTextColour });
});

router.get('/stage/lastcallers', async (req, res) => {
	var callers = await getLastCallers(15);
	res.render('callflow/lastcallers', { layout: false, callers: callers || [] });
});

router.get('/stage/whosonline', async (req, res) => {
	var nodeManager = req.app.locals.nodeManager;
	var terminalNodes = [];
	if (nodeManager) {
		terminalNodes = nodeManager.getActiveNodes();
		terminalNodes.sort(function(a, b) { return a.nodenum - b.nodenum; });
	}

	var webUsers = [];
	try { webUsers = await getOnlineUsers(); } catch (_) {}

	var onlineUsers = [];
	var webNodeUsers = {};

	for (var node of terminalNodes) {
		if (node.web_originated && node.username) {
			webNodeUsers[node.username.toLowerCase()] = true;
		}
		var connType = node.connection_type || '';
		var connLabel = (connType === 'Websock' || connType === 'Websocket' || connType === 'TCP' || connType === 'Telnet')
			? 'Terminal' : (connType || 'Unknown');
		if (node.web_originated) connLabel = 'Web';

		onlineUsers.push({
			nodenum: node.nodenum,
			username: node.username || '',
			activity: formatActivity(node.status, node.detail, node.detail_display),
			connection: connLabel
		});
	}

	webUsers.sort(function(a, b) { return (a.username || '').localeCompare(b.username || ''); });
	for (var wu of webUsers) {
		if (!wu.username) continue;
		if (webNodeUsers[wu.username.toLowerCase()]) continue;
		onlineUsers.push({
			nodenum: null,
			username: wu.username,
			activity: wu.activity || 'Browsing Web',
			connection: 'Web'
		});
	}

	res.render('callflow/whosonline', { layout: false, onlineUsers: onlineUsers });
});

router.get('/stage/wall', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var messages = await getWallMessages(15);
	var userCanPost = currentuser ? canPostWall(currentuser) : false;
	res.render('callflow/wall', { layout: false, messages: messages || [], canPost: userCanPost, currentUsername: currentuser ? currentuser.username : '' });
});

router.post('/wall', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser || !canPostWall(currentuser)) return res.json({ status: false });

	var message = (req.body.message || '').trim();
	if (message.length > 0) {
		await addWallMessage(parseInt(currentuser.id), currentuser.username, message);
		await purgeWall();
	}
	res.json({ status: true });
});

router.get('/stage/newsfiles', async (req, res) => {
	var activeNews = await newsFilesModel.getActiveNewsFiles();
	var fs = await import('fs');
	var items = [];

	for (var nf of activeNews) {
		var filePath = nf.file_path;
		try {
			var rawBuf = fs.readFileSync(filePath);
			// Strip EOF marker (0x1A) if present
			var eofIdx = rawBuf.indexOf(0x1A);
			if (eofIdx !== -1) rawBuf = rawBuf.subarray(0, eofIdx);
			if (rawBuf.length === 0) continue;

			// Convert to string and render as HTML
			var text = rawBuf.toString('binary');
			var html = await formatBodyHtml(text);

			items.push({
				title: nf.title,
				description: nf.description || '',
				html: html,
				center: !!nf.center,
				sourceWidth: nf.source_width || 80
			});
		} catch (err) {
			// File not found or unreadable -- skip silently
			items.push({
				title: nf.title,
				description: nf.description || '',
				html: '<p class="text-muted">File not found: ' + nf.file_path + '</p>',
				center: false,
				sourceWidth: 80
			});
		}
	}

	res.render('callflow/newsfiles', { layout: false, items: items });
});

router.get('/stage/newmsgs', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.status(401).send('');

	var userId = parseInt(currentuser.id);
	var allAreas = await msgAreas.getAllAreas();
	var activeAreas = allAreas.filter(function(a) { return a.active; });
	var areasWithDefaults = activeAreas.map(function(a) {
		return { shortcode: a.shortcode, newscan_default: a.newscan_default };
	});
	var subscribedShortcodes = await userAreaSubs.getSubscribedAreas(userId, areasWithDefaults);
	var summary = await userMsgPointers.getNewscanSummary(userId, subscribedShortcodes);

	// Enrich with area names
	var areaMap = {};
	for (var a of activeAreas) areaMap[a.shortcode] = a;
	var items = [];
	for (var s of summary) {
		var area = areaMap[s.area_shortcode];
		items.push({
			shortcode: s.area_shortcode,
			name: area ? area.name : s.area_shortcode,
			group: area ? area.group_shortcode : '',
			unread: s.unread_count
		});
	}

	res.render('callflow/newmsgs', { layout: false, items: items });
});

router.get('/stage/newfiles', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.status(401).send('');

	var userId = parseInt(currentuser.id);
	var allFileAreasArr = await fileAreas.getAllAreas();
	var activeFileAreas = allFileAreasArr.filter(function(a) { return a.active; });
	var fileAreasWithDefaults = activeFileAreas.map(function(a) {
		return { shortcode: a.shortcode, newscan_default: a.newscan_default };
	});
	var subscribedFileShortcodes = await userFileSubs.getSubscribedAreas(userId, fileAreasWithDefaults);

	var items = [];
	for (var fsc of subscribedFileShortcodes) {
		var fa = activeFileAreas.find(function(a) { return a.shortcode === fsc; });
		if (!fa) continue;
		var count = await userFilePointers.getNewCount(userId, fsc, fa.id);
		if (count > 0) {
			items.push({ shortcode: fsc, name: fa.name || fsc, count: count });
		}
	}

	res.render('callflow/newfiles', { layout: false, items: items });
});

// ---------------------------------------------------------------------------
// Complete -- mark call flow done, redirect to destination
// ---------------------------------------------------------------------------

router.post('/complete', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var nowTs = String(Date.now());

	if (currentuser) {
		await updateLastCallflowAt(parseInt(currentuser.id));

		// Update last_callflow_at on ALL sessions for this user (handles multi-tab/device)
		await sessionStore.sessionUpdateUser(currentuser.username, {
			last_callflow_at: nowTs,
			callflow_pending: '',
			_callflow_checked: 'true'
		});
	} else if (req.cookies && req.cookies.sessionid) {
		// Fallback: update just this session
		await sessionStore.sessionUpdate(req.cookies.sessionid, {
			last_callflow_at: nowTs,
			callflow_pending: '',
			_callflow_checked: 'true'
		});
	}

	var returnUrl = req.body.return_url || '/';
	res.json({ redirect: returnUrl });
});

export { router };
