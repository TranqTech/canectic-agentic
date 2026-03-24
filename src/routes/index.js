//imports
import express from 'express';
const router = express.Router();
// ..stuff below
import { DateTime } from "luxon";
import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import sanitizeHtml from 'sanitize-html';
import mobile from 'is-mobile';

//internals
import * as sessionStore from "../middleware/db/sessionstore.js";
import * as privateMessages from '../models/privateMessages.js';
import * as messages from '../models/messages.js';
import * as msgGroups from '../models/msgGroups.js';
import * as msgAreas from '../models/msgAreas.js';
import * as userAccounts from '../models/useraccounts.js';
import * as userMsgPointers from '../models/userMsgPointers.js';
import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";
import * as announcements from '../models/announcements.js';

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '250mb', extended: true })

//variables and const
const basedir = process.cwd()


// Inject shared locals for all user views
router.use(async function(req, res, next) {
	res.locals.boardname   = appConfig.get('boardname', 'BBS');
	res.locals.faviconlink = appConfig.get('faviconlink', '/images/favicon.ico');
	res.locals.currentPath = req.path;
	res.locals.activelink  = '';
	res.locals.DateTime    = DateTime;
	res.locals.ismobile    = mobile({ ua: req.headers['user-agent'] });
	res.locals.pmUnreadCount = 0;
	if (req.cookies.sessionid) {
		await sessionStore.sessionRenew(req.cookies.sessionid);
		var pmSession = await sessionStore.sessionGet(req.cookies.sessionid);
		if (pmSession) {
			var pmUid = parseInt(pmSession.id);
			if (pmUid && pmUid > 0) {
				res.locals.pmUnreadCount = await privateMessages.getUnreadCount(pmUid);
			}
		}
	}
	next();
});

// Helper: get current user from session cookie
async function getCurrentUser(req) {
	return await sessionStore.sessionGet(req.cookies.sessionid) || null;
}

// Helper: resolve the database integer ID for a session user.
// Redis stores all values as strings, so id comes back as "5" not 5.
// Parse it first, fall back to DB lookup if not present.
async function resolveUserId(sessionUser) {
	if (!sessionUser) return null;
	var id = parseInt(sessionUser.id);
	if (id && id > 0) return id;
	// Look up the full DB record to get the integer id
	var dbUser = null;
	if (sessionUser.uuid) {
		dbUser = await userAccounts.getUserByUUID(sessionUser.uuid);
	} else if (sessionUser.username) {
		dbUser = await userAccounts.getUserRecord(sessionUser.username);
	}
	return dbUser ? dbUser.id : null;
}

// Helper: resolve the display name for posting based on area's post_as setting.
// post_as = 'realname' → fullname (falling back to username)
// post_as = 'username' (default) → username
function resolvePostName(sessionUser, msgArea) {
	var postAs = (msgArea && msgArea.post_as) ? msgArea.post_as : 'username';
	if (postAs === 'realname') {
		return sessionUser.fullname || sessionUser.username || 'Unknown';
	}
	return sessionUser.username || 'Unknown';
}

// Helper: parse JSONB flags from DB — may be a JSON string, array, or null.
function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === 'string') {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

// Helper: check if user has sufficient access to read an area.
// Checks security level, required permission flags, and restriction flags.
function checkAreaReadAccess(sessionUser, msgArea) {
	if (!msgArea) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	if (msgArea.read_security && userSecurity < msgArea.read_security) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(msgArea.read_perm_flags);
	var restFlags  = parseFlags(msgArea.read_rest_flags);

	// Must have ALL required permission flags
	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	// Must have NONE of the restriction flags
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

// Helper: check if user has sufficient access to post in an area.
function checkAreaPostAccess(sessionUser, msgArea) {
	if (!msgArea) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	if (msgArea.post_security && userSecurity < msgArea.post_security) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(msgArea.post_perm_flags);
	var restFlags  = parseFlags(msgArea.post_rest_flags);

	// Must have ALL required permission flags
	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	// Must have NONE of the restriction flags
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

/* GET home page. */
router.get('/', async function(req, res, next) {
  var currentuser = await getCurrentUser(req);
  res.locals.currentuser = currentuser;
  var activeAnnouncements = await announcements.getActiveAnnouncements(10);
  res.render('public/index', { title: appConfig.get('boardname'), announcements: activeAnnouncements });
});

// -------------------------------------------------------
// Message Routes
// -------------------------------------------------------

// Message Groups listing
router.get('/messages', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('messages/index', {
			title: 'Messages',
			activelink: 'messages',
			currentuser: null,
			grouplist: []
		});
	}

	var userSecurity = parseInt(currentuser.security) || 0;
	var userId = await resolveUserId(currentuser);
	var grouplist = await messages.listMsgGroups(userSecurity);

	// Filter groups by read flags (DB already filtered by read_security level)
	grouplist = grouplist.filter(function(g) { return checkAreaReadAccess(currentuser, g); });

	// Attach unread counts per group (sum of unread across accessible areas)
	if (userId) {
		for (var group of grouplist) {
			var areas = await messages.getAreasInGroup(group.shortcode, userSecurity);
			// Filter areas by read flags
			areas = areas.filter(function(a) { return checkAreaReadAccess(currentuser, a); });
			var groupUnread = 0;
			for (var area of areas) {
				var unread = await userMsgPointers.getUnreadCount(userId, area.shortcode);
				groupUnread += unread;
			}
			group.unread_count = groupUnread;
			group._areaCount = areas.length;
		}
		// Remove groups with no accessible areas
		grouplist = grouplist.filter(function(g) { return g._areaCount > 0; });
	}

	res.render('messages/index', {
		title: 'Messages',
		activelink: 'messages',
		currentuser: currentuser,
		grouplist: grouplist
	});
});

// Areas in a group
router.get('/messages/group/:shortcode', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('messages/groups/view', {
			title: 'Message Group',
			activelink: 'messages',
			currentuser: null,
			msgGroup: null,
			arealist: []
		});
	}

	var shortcode    = req.params.shortcode.toUpperCase().trim();
	var userSecurity = parseInt(currentuser.security) || 0;
	var msgGroup     = await msgGroups.getGroupByShortcode(shortcode);

	if (!msgGroup) {
		return res.render('messages/groups/view', {
			title: 'Group Not Found',
			activelink: 'messages',
			currentuser: currentuser,
			msgGroup: null,
			arealist: []
		});
	}

	// Check group-level read access (flags)
	if (!checkAreaReadAccess(currentuser, msgGroup)) {
		return res.render('messages/groups/view', {
			title: 'Access Denied',
			activelink: 'messages',
			currentuser: currentuser,
			msgGroup: null,
			arealist: []
		});
	}

	var arealist = await messages.getAreasInGroup(shortcode, userSecurity);

	// Filter areas by read flags
	arealist = arealist.filter(function(a) { return checkAreaReadAccess(currentuser, a); });

	// Attach unread counts per area
	var userId = await resolveUserId(currentuser);
	if (userId) {
		for (var area of arealist) {
			area.unread_count = await userMsgPointers.getUnreadCount(userId, area.shortcode);
		}
	}

	res.render('messages/groups/view', {
		title: msgGroup.name,
		activelink: 'messages',
		currentuser: currentuser,
		msgGroup: msgGroup,
		arealist: arealist
	});
});

// Area view — threads listing or flat messages depending on thread_mode / user toggle
router.get('/messages/area/:shortcode', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var shortcode = req.params.shortcode.toLowerCase().trim();
	var msgArea   = currentuser ? await msgAreas.getAreaByShortcode(shortcode) : null;
	var sufficientAccess = currentuser && msgArea && checkAreaReadAccess(currentuser, msgArea);

	// Bail early if no user, no area, or no access — template guards handle display
	if (!currentuser || !msgArea || !sufficientAccess) {
		var threadMode = (msgArea && msgArea.thread_mode) || 'standard';
		var viewMode   = req.query.view || null;
		if ((threadMode === 'no_threads' || viewMode === 'flat') && msgArea) {
			return res.render('messages/areas/flat', {
				title: msgArea ? msgArea.name : 'Message Area',
				activelink: 'messages',
				currentuser: currentuser,
				sufficientAccess: !!sufficientAccess,
				canPost: false,
				msgArea: msgArea,
				messages: [],
				totalMessages: 0,
				firstUnreadId: 0,
				threadMode: threadMode,
				hasOlder: false,
				hasNewer: false,
				messagesBefore: 0,
				postFromName: ''
			});
		}
		return res.render('messages/areas/view', {
			title: msgArea ? msgArea.name : 'Message Area',
			activelink: 'messages',
			currentuser: currentuser,
			sufficientAccess: !!sufficientAccess,
			canPost: false,
			msgArea: msgArea,
			threadlist: [],
			totalThreads: 0
		});
	}

	var threadMode = msgArea.thread_mode || 'standard';
	var viewMode   = req.query.view || null;
	var canPost    = checkAreaPostAccess(currentuser, msgArea);

	// Flat view: forced by thread_mode=no_threads, or user toggle ?view=flat
	if (threadMode === 'no_threads' || viewMode === 'flat') {
		var batchSize     = 30;
		var totalMessages = await messages.getMessageCount(shortcode);
		var userId        = await resolveUserId(currentuser);

		// Find first unread before loading
		var firstUnreadId = 0;
		if (userId) {
			firstUnreadId = await userMsgPointers.getFirstUnreadInArea(userId, msgArea.shortcode);
		}

		// Load starting from first unread, or newest if all read
		var msglist;
		if (firstUnreadId > 0) {
			msglist = await messages.getMessages(shortcode, {
				afterId: firstUnreadId - 1,
				order: 'ASC',
				limit: batchSize
			});
		} else {
			msglist = await messages.getMessages(shortcode, {
				order: 'DESC',
				limit: batchSize
			});
			msglist.reverse();
		}

		// Advance area pointer to highest message in batch
		if (userId && msglist.length > 0) {
			var maxId = msglist[msglist.length - 1].id;
			await userMsgPointers.advancePointer(userId, msgArea.shortcode, maxId);
		}

		// Check for messages in each direction beyond the batch
		var hasOlder = false;
		var hasNewer = false;
		var messagesBefore = 0;
		if (msglist.length > 0) {
			var oldestInBatch = msglist[0].id;
			var newestInBatch = msglist[msglist.length - 1].id;
			var olderCheck = await messages.getMessages(shortcode, {
				beforeId: oldestInBatch,
				limit: 1
			});
			hasOlder = olderCheck.length > 0;
			var newerCheck = await messages.getMessages(shortcode, {
				afterId: newestInBatch,
				limit: 1
			});
			hasNewer = newerCheck.length > 0;
			messagesBefore = await messages.countMessagesBefore(shortcode, oldestInBatch);
		}

		// Resolve thread UUIDs for reply routing in flat view
		if (msglist.length > 0) {
			var threadIds = [...new Set(msglist.filter(m => m.thread_id).map(m => m.thread_id))];
			var threadUUIDs = await messages.getThreadUUIDMap(shortcode, threadIds);
			for (var msg of msglist) {
				msg.thread_uuid = threadUUIDs[msg.thread_id] || '';
			}
		}

		return res.render('messages/areas/flat', {
			title: msgArea.name,
			activelink: 'messages',
			currentuser: currentuser,
			sufficientAccess: true,
			canPost: canPost,
			msgArea: msgArea,
			messages: msglist,
			totalMessages: totalMessages,
			firstUnreadId: firstUnreadId,
			threadMode: threadMode,
			hasOlder: hasOlder,
			hasNewer: hasNewer,
			messagesBefore: messagesBefore,
			postFromName: resolvePostName(currentuser, msgArea)
		});
	}

	// Threaded view (default)
	var batchSize    = 30;
	var totalThreads = await messages.getThreadCount(shortcode);
	var threadlist   = await messages.getThreadsPage(shortcode, { limit: batchSize });

	// Attach unread counts per thread (batch query)
	var userId = await resolveUserId(currentuser);
	if (userId && threadlist.length > 0) {
		var threadIds = threadlist.map(function(t) { return t.id; });
		var unreadMap = await userMsgPointers.getThreadUnreadCounts(userId, msgArea.shortcode, threadIds);
		for (var thread of threadlist) {
			thread.unread_count = unreadMap[thread.id] || 0;
		}
	}

	res.render('messages/areas/view', {
		title: msgArea.name,
		activelink: 'messages',
		currentuser: currentuser,
		sufficientAccess: true,
		canPost: canPost,
		msgArea: msgArea,
		threadlist: threadlist,
		totalThreads: totalThreads,
		threadMode: threadMode,
		postFromName: resolvePostName(currentuser, msgArea)
	});
});

// Threads lazy-load endpoint — returns older threads as JSON
router.get('/messages/area/:shortcode/threads/load', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.status(401).json({ error: 'Not authenticated' });
	}

	var shortcode  = req.params.shortcode.toLowerCase().trim();
	var beforeDate = req.query.beforeDate || null;
	var beforeId   = parseInt(req.query.beforeId) || 0;
	var limit      = Math.min(parseInt(req.query.limit) || 30, 100);

	var msgArea = await msgAreas.getAreaByShortcode(shortcode);
	if (!msgArea) {
		return res.status(404).json({ error: 'Area not found' });
	}

	if (!checkAreaReadAccess(currentuser, msgArea)) {
		return res.status(403).json({ error: 'Access denied' });
	}

	var batch = await messages.getThreadsPage(shortcode, {
		limit: limit,
		beforeDate: beforeDate,
		beforeId: beforeId || undefined
	});

	// Attach unread counts (batch query)
	var userId = await resolveUserId(currentuser);
	if (userId && batch.length > 0) {
		var threadIds = batch.map(function(t) { return t.id; });
		var unreadMap = await userMsgPointers.getThreadUnreadCounts(userId, msgArea.shortcode, threadIds);
		for (var thread of batch) {
			thread.unread_count = unreadMap[thread.id] || 0;
		}
	}

	// Check if there are more beyond this batch
	var allLoaded = batch.length < limit;

	res.json({
		threads: batch.map(function(t) {
			return {
				id: t.id,
				uuid: t.uuid,
				subject: t.subject,
				message_count: t.message_count || 0,
				unread_count: t.unread_count || 0,
				started_by: t.started_by || '',
				last_message: t.last_message,
				last_message_from: t.last_message_from || ''
			};
		}),
		allLoaded: allLoaded
	});
});

// Flat-view lazy-load endpoint — returns older messages as JSON (area-wide, no thread filter)
// Flat-view lazy-load — supports both directions
// ?before=ID  → older messages (scroll up)
// ?after=ID   → newer messages (scroll down, advances area pointer)
router.get('/messages/area/:shortcode/messages/load', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.status(401).json({ error: 'Not authenticated' });
	}

	var shortcode = req.params.shortcode.toLowerCase().trim();
	var beforeId  = parseInt(req.query.before) || 0;
	var afterId   = parseInt(req.query.after) || 0;
	var limit     = Math.min(parseInt(req.query.limit) || 30, 100);

	var msgArea = await msgAreas.getAreaByShortcode(shortcode);
	if (!msgArea) {
		return res.status(404).json({ error: 'Area not found' });
	}

	if (!checkAreaReadAccess(currentuser, msgArea)) {
		return res.status(403).json({ error: 'Access denied' });
	}

	var batch;
	var direction;

	if (afterId) {
		direction = 'newer';
		batch = await messages.getMessages(shortcode, {
			afterId: afterId,
			order: 'ASC',
			limit: limit
		});

		// Advance area pointer for newly viewed messages
		var userId = await resolveUserId(currentuser);
		if (userId && batch.length > 0) {
			var maxId = batch[batch.length - 1].id;
			await userMsgPointers.advancePointer(userId, msgArea.shortcode, maxId);
		}
	} else if (beforeId) {
		direction = 'older';
		batch = await messages.getMessages(shortcode, {
			beforeId: beforeId,
			order: 'DESC',
			limit: limit
		});
		batch.reverse();
	} else {
		return res.status(400).json({ error: 'Must specify before or after' });
	}

	// Check if there are more in the same direction
	var hasMore = false;
	if (batch.length > 0) {
		var edgeId = direction === 'newer' ? batch[batch.length - 1].id : batch[0].id;
		var checkOpts = { limit: 1 };
		if (direction === 'newer') {
			checkOpts.afterId = edgeId;
		} else {
			checkOpts.beforeId = edgeId;
		}
		var check = await messages.getMessages(shortcode, checkOpts);
		hasMore = check.length > 0;
	}

	// Resolve thread UUIDs for reply routing
	var threadUUIDs = {};
	if (batch.length > 0) {
		var threadIds = [...new Set(batch.filter(m => m.thread_id).map(m => m.thread_id))];
		threadUUIDs = await messages.getThreadUUIDMap(shortcode, threadIds);
	}

	res.json({
		direction: direction,
		messages: batch.map(function(m) {
			return {
				id: m.id,
				msg_id: m.msg_id,
				from_user: m.from_user,
				to_user: m.to_user,
				subject: m.subject,
				system_time: m.system_time,
				body_text: m.body_text,
				body_html: m.body_html,
				isAnsi: m.isAnsi || false,
				thread_uuid: threadUUIDs[m.thread_id] || ''
			};
		}),
		hasMore: hasMore
	});
});

// Mark all messages in an area as read
router.post('/messages/area/:shortcode/markread', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.redirect('/users/login');
	}

	var shortcode = req.params.shortcode.toLowerCase().trim();
	var msgArea   = await msgAreas.getAreaByShortcode(shortcode);
	if (!msgArea) {
		return res.redirect('/messages');
	}

	var userId = await resolveUserId(currentuser);
	if (userId) {
		await userMsgPointers.markAreaRead(userId, msgArea.shortcode);
	}

	// Redirect back to the area
	var threadMode = msgArea.thread_mode || 'standard';
	var viewMode   = req.body.view || '';
	if (threadMode === 'no_threads' || viewMode === 'flat') {
		return res.redirect('/messages/area/' + msgArea.shortcode + '?view=flat');
	}
	res.redirect('/messages/area/' + msgArea.shortcode);
});

// Thread reader — initial page load (newest messages)
router.get('/messages/area/:shortcode/thread/:uuid', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var shortcode = req.params.shortcode.toLowerCase().trim();
	var uuid      = req.params.uuid.toLowerCase().trim();
	var msgArea   = currentuser ? await msgAreas.getAreaByShortcode(shortcode) : null;
	var sufficientAccess = currentuser && msgArea && checkAreaReadAccess(currentuser, msgArea);

	// Bail early if no user, no area, or no access — template guards handle display
	if (!currentuser || !msgArea || !sufficientAccess) {
		return res.render('messages/areas/thread', {
			title: msgArea ? msgArea.name : 'Thread',
			activelink: 'messages',
			currentuser: currentuser,
			sufficientAccess: !!sufficientAccess,
			canPost: false,
			msgArea: msgArea,
			thread: null,
			messages: [],
			totalMessages: 0,
			firstUnreadId: 0,
			hasOlder: false,
			hasNewer: false,
			messagesBefore: 0,
			postFromName: ''
		});
	}

	var canPost = checkAreaPostAccess(currentuser, msgArea);

	var thread = await messages.getThreadByUUID(uuid, shortcode);
	if (!thread) {
		return res.render('messages/areas/thread', {
			title: 'Thread Not Found',
			activelink: 'messages',
			currentuser: currentuser,
			sufficientAccess: true,
			canPost: canPost,
			msgArea: msgArea,
			thread: null,
			messages: [],
			totalMessages: 0,
			firstUnreadId: 0,
			hasOlder: false,
			hasNewer: false,
			messagesBefore: 0,
			postFromName: ''
		});
	}

	var totalMessages = thread.message_count || 0;
	var batchSize = 30;

	// Find first unread before loading messages
	var userId = await resolveUserId(currentuser);
	var firstUnreadId = 0;
	if (userId) {
		firstUnreadId = await userMsgPointers.getFirstUnreadInThread(userId, msgArea.shortcode, thread.id);
	}

	// Load starting from first unread, or newest if all read
	var allMessages;
	if (firstUnreadId > 0) {
		allMessages = await messages.getMessages(shortcode, {
			threadId: thread.id,
			afterId: firstUnreadId - 1,
			order: 'ASC',
			limit: batchSize
		});
	} else {
		allMessages = await messages.getMessages(shortcode, {
			threadId: thread.id,
			order: 'DESC',
			limit: batchSize
		});
		allMessages.reverse();
	}

	// Advance thread pointer (and area pointer) to highest message in batch
	if (userId && allMessages.length > 0) {
		var maxId = allMessages[allMessages.length - 1].id;
		await userMsgPointers.advanceThreadPointer(userId, msgArea.shortcode, thread.id, maxId);
	}

	// Determine if there are messages in each direction beyond the batch
	var hasOlder = false;
	var hasNewer = false;
	var messagesBefore = 0;
	if (allMessages.length > 0) {
		var oldestInBatch = allMessages[0].id;
		var newestInBatch = allMessages[allMessages.length - 1].id;
		var olderCheck = await messages.getMessages(shortcode, {
			threadId: thread.id,
			beforeId: oldestInBatch,
			limit: 1
		});
		hasOlder = olderCheck.length > 0;
		var newerCheck = await messages.getMessages(shortcode, {
			threadId: thread.id,
			afterId: newestInBatch,
			limit: 1
		});
		hasNewer = newerCheck.length > 0;
		messagesBefore = await messages.countMessagesBefore(shortcode, oldestInBatch, thread.id);
	}

	res.render('messages/areas/thread', {
		title: thread.subject,
		activelink: 'messages',
		currentuser: currentuser,
		sufficientAccess: true,
		canPost: canPost,
		msgArea: msgArea,
		thread: thread,
		messages: allMessages,
		totalMessages: totalMessages,
		firstUnreadId: firstUnreadId,
		hasOlder: hasOlder,
		hasNewer: hasNewer,
		messagesBefore: messagesBefore,
		postFromName: resolvePostName(currentuser, msgArea)
	});
});

// Thread lazy-load endpoint — supports both directions
// ?before=ID  → older messages (scroll up)
// ?after=ID   → newer messages (scroll down, advances pointer)
router.get('/messages/area/:shortcode/thread/:uuid/load', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.status(401).json({ error: 'Not authenticated' });
	}

	var shortcode = req.params.shortcode.toLowerCase().trim();
	var uuid      = req.params.uuid.toLowerCase().trim();
	var beforeId  = parseInt(req.query.before) || 0;
	var afterId   = parseInt(req.query.after) || 0;
	var limit     = Math.min(parseInt(req.query.limit) || 30, 100);

	var msgArea = await msgAreas.getAreaByShortcode(shortcode);
	if (!msgArea) {
		return res.status(404).json({ error: 'Area not found' });
	}

	if (!checkAreaReadAccess(currentuser, msgArea)) {
		return res.status(403).json({ error: 'Access denied' });
	}

	var thread = await messages.getThreadByUUID(uuid, shortcode);
	if (!thread) {
		return res.status(404).json({ error: 'Thread not found' });
	}

	var batch;
	var direction;

	if (afterId) {
		// Loading newer messages (scroll down)
		direction = 'newer';
		batch = await messages.getMessages(shortcode, {
			threadId: thread.id,
			afterId: afterId,
			order: 'ASC',
			limit: limit
		});

		// Advance thread pointer for newly viewed messages
		var userId = await resolveUserId(currentuser);
		if (userId && batch.length > 0) {
			var maxId = batch[batch.length - 1].id;
			await userMsgPointers.advanceThreadPointer(userId, msgArea.shortcode, thread.id, maxId);
		}
	} else if (beforeId) {
		// Loading older messages (scroll up)
		direction = 'older';
		batch = await messages.getMessages(shortcode, {
			threadId: thread.id,
			beforeId: beforeId,
			order: 'DESC',
			limit: limit
		});
		batch.reverse();
	} else {
		return res.status(400).json({ error: 'Must specify before or after' });
	}

	// Check if there are more in the same direction
	var hasMore = false;
	if (batch.length > 0) {
		var edgeId = direction === 'newer' ? batch[batch.length - 1].id : batch[0].id;
		var checkOpts = { threadId: thread.id, limit: 1 };
		if (direction === 'newer') {
			checkOpts.afterId = edgeId;
		} else {
			checkOpts.beforeId = edgeId;
		}
		var check = await messages.getMessages(shortcode, checkOpts);
		hasMore = check.length > 0;
	}

	res.json({
		direction: direction,
		messages: batch.map(function(m) {
			return {
				id: m.id,
				msg_id: m.msg_id,
				from_user: m.from_user,
				to_user: m.to_user,
				subject: m.subject,
				system_time: m.system_time,
				body_text: m.body_text,
				body_html: m.body_html,
				isAnsi: m.isAnsi || false
			};
		}),
		hasMore: hasMore
	});
});

// -------------------------------------------------------
// Message Posting Routes
// -------------------------------------------------------

// New thread
router.post('/messages/area/:shortcode/newthread', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.redirect('/users/login');
	}

	var shortcode = req.params.shortcode.toLowerCase().trim();
	var msgArea   = await msgAreas.getAreaByShortcode(shortcode);
	if (!msgArea) {
		return res.redirect('/messages');
	}

	// Post access check (security level + flags)
	if (!checkAreaPostAccess(currentuser, msgArea)) {
		return res.redirect('/messages/area/' + shortcode);
	}

	var formObj     = req.body;
	formObj.from_user = resolvePostName(currentuser, msgArea);

	var resultObj = await messages.startNewThread(formObj, shortcode);
	if (resultObj.status === true) {
		// Redirect to the new thread, or back to flat view
		var threadMode = msgArea.thread_mode || 'standard';
		if (threadMode === 'no_threads' || req.body.returnview === 'flat') {
			return res.redirect('/messages/area/' + shortcode + '?view=flat');
		}
		return res.redirect('/messages/area/' + shortcode + '/thread/' + resultObj.threaduuid);
	}

	// On failure redirect back
	res.redirect('/messages/area/' + shortcode);
});

// Reply to thread
router.post('/messages/area/:shortcode/thread/:uuid/reply', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.redirect('/users/login');
	}

	var shortcode = req.params.shortcode.toLowerCase().trim();
	var uuid      = req.params.uuid.toLowerCase().trim();
	var msgArea   = await msgAreas.getAreaByShortcode(shortcode);
	if (!msgArea) {
		return res.redirect('/messages');
	}

	// Post access check (security level + flags)
	if (!checkAreaPostAccess(currentuser, msgArea)) {
		return res.redirect('/messages/area/' + shortcode);
	}

	var formObj     = req.body;
	formObj.from_user = resolvePostName(currentuser, msgArea);

	var resultObj = await messages.replyToThread(formObj, shortcode, uuid);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "replyToThread failed for thread " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}

	// Redirect back — flat or threaded
	var threadMode = msgArea.thread_mode || 'standard';
	if (threadMode === 'no_threads' || req.body.returnview === 'flat') {
		return res.redirect('/messages/area/' + shortcode + '?view=flat');
	}
	res.redirect('/messages/area/' + shortcode + '/thread/' + uuid);
});

export{router}