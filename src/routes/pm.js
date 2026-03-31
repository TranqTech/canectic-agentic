//imports
import express from 'express';
const router = express.Router();
import { DateTime } from "luxon";
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

//internals
import * as sessionStore from "../middleware/db/sessionstore.js";
import * as privateMessages from '../models/privateMessages.js';
import * as userAccounts from '../models/useraccounts.js';
import * as flash from '../middleware/db/flash.js';
import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '1mb', extended: true });

// Inject shared locals for all PM views
router.use(async function(req, res, next) {
	res.locals.boardname   = appConfig.get('boardname', 'BBS');
	res.locals.faviconlink = appConfig.get('faviconlink', '/images/favicon.ico');
	res.locals.currentPath = '/pm' + req.path;
	res.locals.activelink  = 'pm';
	res.locals.DateTime    = DateTime;
	res.locals.pmUnreadCount = 0;
	if (req.cookies.sessionid) {
		// Fetch unread count for nav badge
		var session = await sessionStore.sessionGet(req.cookies.sessionid);
		if (session) {
			res.locals.currentuser = session;
			var uid = parseInt(session.id);
			if (uid && uid > 0) {
				res.locals.pmUnreadCount = await privateMessages.getUnreadCount(uid);
			}
		}
	}
	// Load flash messages for this request
	res.locals.flash = await flash.get(req);
	next();
});

// Helper: get current user from session cookie
async function getCurrentUser(req) {
	return await sessionStore.sessionGet(req.cookies.sessionid) || null;
}

// Helper: resolve session user id (Redis stores as string)
async function resolveUserId(sessionUser) {
	if (!sessionUser) return null;
	var id = parseInt(sessionUser.id);
	if (id && id > 0) return id;
	var dbUser = null;
	if (sessionUser.uuid) {
		dbUser = await userAccounts.getUserByUUID(sessionUser.uuid);
	} else if (sessionUser.username) {
		dbUser = await userAccounts.getUserRecord(sessionUser.username);
	}
	return dbUser ? dbUser.id : null;
}

// Helper: parse JSONB flags
function parseFlags(val) {
	if (!val) return [];
	if (Array.isArray(val)) return val;
	if (typeof val === 'string') {
		try { var p = JSON.parse(val); return Array.isArray(p) ? p : []; }
		catch (_) { return []; }
	}
	return [];
}

// Helper: ensure session flags are parsed arrays (Redis stores as JSON strings)
function hydrateSessionFlags(sessionUser) {
	sessionUser.permissionflags = parseFlags(sessionUser.permissionflags);
	sessionUser.restrictionflags = parseFlags(sessionUser.restrictionflags);
	return sessionUser;
}

// Helper: check admin access (security level + Sysop flag)
function checkAdminAccess(user) {
	if (!user) return false;
	var sec = parseInt(user.security) || 0;
	if (sec < appConfig.getNumber('adminsecurity', 200)) return false;
	var perms = parseFlags(user.permissionflags);
	return perms.includes('Sysop');
}

// Helper: validate that a submitted from_user value is one of the user's
// allowed identities (username or fullname). Prevents form tampering.
// Returns the validated name or null if invalid.
function validateFromUser(sessionUser, submittedName) {
	if (!submittedName || !sessionUser) return null;
	var trimmed = submittedName.trim();
	if (trimmed === sessionUser.username) return trimmed;
	if (sessionUser.fullname && trimmed === sessionUser.fullname.trim()) return trimmed;
	return null;
}

// -------------------------------------------------------
// Inbox
// -------------------------------------------------------

// GET /pm or /pm/inbox — combined mail view with inbox/sent/trash tabs
router.get(['/', '/inbox'], async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('pm/inbox', {
			title: 'Private Messages',
			currentuser: null,
			messages: [],
			sentMessages: [],
			trashMessages: [],
			unreadCount: 0,
			allowedTransports: []
		});
	}

	hydrateSessionFlags(currentuser);
	var userId = await resolveUserId(currentuser);
	var limit = 50;

	var inboxMessages = await privateMessages.getInbox(userId, { limit: limit });
	var sentMessages = await privateMessages.getSentMessages(userId, { limit: limit });
	var trashMessages = await privateMessages.getTrash(userId, { limit: limit });
	var unreadCount = await privateMessages.getUnreadCount(userId);
	var allowedTransports = privateMessages.getAllowedTransports(currentuser);

	res.render('pm/inbox', {
		title: 'Mail',
		currentuser: currentuser,
		messages: inboxMessages,
		sentMessages: sentMessages,
		trashMessages: trashMessages,
		unreadCount: unreadCount,
		allowedTransports: allowedTransports
	});
});

// GET /pm/sent — sent messages
router.get('/sent', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('pm/sent', {
			title: 'Sent Messages',
			currentuser: null,
			messages: []
		});
	}

	var userId = await resolveUserId(currentuser);
	var page = parseInt(req.query.page) || 1;
	var limit = 50;
	var offset = (page - 1) * limit;

	var sentMessages = await privateMessages.getSentMessages(userId, { limit: limit, offset: offset });

	res.render('pm/sent', {
		title: 'Sent Messages',
		currentuser: currentuser,
		messages: sentMessages,
		page: page
	});
});

// GET /pm/trash — deleted messages
router.get('/trash', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('pm/trash', {
			title: 'Trash',
			currentuser: null,
			messages: []
		});
	}

	var userId = await resolveUserId(currentuser);
	var page = parseInt(req.query.page) || 1;
	var limit = 50;
	var offset = (page - 1) * limit;

	var trashMessages = await privateMessages.getTrash(userId, { limit: limit, offset: offset });

	res.render('pm/trash', {
		title: 'Trash',
		currentuser: currentuser,
		messages: trashMessages,
		page: page
	});
});

// -------------------------------------------------------
// Read Message
// -------------------------------------------------------

// GET /pm/inbox/:uuid — read single inbox message
router.get('/inbox/:uuid', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('pm/read', {
			title: 'Message',
			currentuser: null,
			message: null,
			allowedTransports: []
		});
	}

	hydrateSessionFlags(currentuser);
	var userId = await resolveUserId(currentuser);
	var message = await privateMessages.getMessage(userId, req.params.uuid);

	if (!message) {
		return res.render('pm/read', {
			title: 'Message Not Found',
			currentuser: currentuser,
			message: null,
			allowedTransports: []
		});
	}

	// Determine if user can reply via this transport
	var allowedTransports = privateMessages.getAllowedTransports(currentuser);

	res.render('pm/read', {
		title: message.subject || 'Message',
		currentuser: currentuser,
		message: message,
		allowedTransports: allowedTransports
	});
});

// GET /pm/sent/:uuid — view single sent message
router.get('/sent/:uuid', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('pm/read_sent', {
			title: 'Sent Message',
			currentuser: null,
			message: null
		});
	}

	var userId = await resolveUserId(currentuser);
	var message = await privateMessages.getSentMessage(userId, req.params.uuid);

	res.render('pm/read_sent', {
		title: message ? (message.subject || 'Sent Message') : 'Message Not Found',
		currentuser: currentuser,
		message: message
	});
});

// -------------------------------------------------------
// Compose & Reply
// -------------------------------------------------------

// POST /pm/compose/local — send a local user-to-user message
router.post('/compose/local', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.redirect('/users/login');

	hydrateSessionFlags(currentuser);
	var userId = await resolveUserId(currentuser);

	// Access check
	var accessCheck = privateMessages.checkTransportAccess(currentuser, 'LOCAL');
	if (!accessCheck.allowed) {
		await flash.setOne(req, 'danger', 'You do not have permission to send local messages');
		return res.redirect('/pm/inbox');
	}

	// Validate required fields
	var fromUser = validateFromUser(currentuser, req.body.from_user);
	var toUsername = (req.body.to_user || '').trim();
	var subject = (req.body.subject || '').trim();
	var bodyText = (req.body.body_text || '').trim();
	var errors = [];

	if (!fromUser) {
		fromUser = currentuser.username; // fallback to username if tampered
		errors.push('Invalid sender identity');
	}
	if (!toUsername) errors.push('Recipient is required');
	if (!subject) errors.push('Subject is required');
	if (!bodyText) errors.push('Message body cannot be empty');

	if (errors.length > 0) {
		await flash.set(req, errors.map(function(e) { return { type: 'danger', text: e }; }));
		return res.redirect('/pm/inbox');
	}

	// Resolve recipient
	var resolution = await privateMessages.resolveRecipient(toUsername);
	if (!resolution.resolved) {
		var reasonText = 'User "' + toUsername + '" not found';
		if (resolution.reason === 'ambiguous_match') {
			reasonText = 'Multiple users match "' + toUsername + '" — please use an exact username';
		}
		await flash.setOne(req, 'danger', reasonText);
		return res.redirect('/pm/inbox');
	}

	var messageObj = {
		user_id: userId,
		from_user: fromUser,
		to_user: resolution.username,
		from_address: currentuser.username,
		to_address: resolution.username,
		subject: subject,
		body_text: req.body.body_text || '',
		utf8: req.body.body_text || '',
		transport_type: 'LOCAL',
		transport_data: {
			sender_user_id: userId,
			recipient_user_id: resolution.userId
		}
	};

	var result = await privateMessages.queueMessage(messageObj, currentuser);
	if (!result.status) {
		alogger.writeAlog(3, "Local PM send failed: " + result.errormessages.join(', '), "redbright");
		await flash.set(req, result.errormessages.map(function(e) { return { type: 'danger', text: e }; }));
		return res.redirect('/pm/inbox');
	}

	await flash.setOne(req, 'success', 'Message sent to ' + resolution.username);
	res.redirect('/pm/inbox');
});

// POST /pm/compose/network — send a network message (FTN, QWK, etc.)
router.post('/compose/network', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.redirect('/users/login');

	hydrateSessionFlags(currentuser);
	var userId = await resolveUserId(currentuser);

	var transportType = (req.body.transport_type || '').toUpperCase();

	// Access check
	var accessCheck = privateMessages.checkTransportAccess(currentuser, transportType);
	if (!accessCheck.allowed) {
		await flash.setOne(req, 'danger', 'You do not have permission to send ' + (transportType || 'network') + ' messages');
		return res.redirect('/pm/inbox');
	}

	// Validate required fields
	var fromUser = validateFromUser(currentuser, req.body.from_user);
	var toUser = (req.body.to_user || '').trim();
	var toAddress = (req.body.to_address || '').trim();
	var subject = (req.body.subject || '').trim();
	var bodyText = (req.body.body_text || '').trim();
	var errors = [];

	if (!fromUser) {
		fromUser = currentuser.username;
		errors.push('Invalid sender identity');
	}
	if (!transportType) errors.push('Transport type is required');
	if (!toUser) errors.push('Recipient name is required');
	if (!toAddress) errors.push('Destination address is required');
	if (!subject) errors.push('Subject is required');
	if (!bodyText) errors.push('Message body cannot be empty');

	// Transport-specific address validation
	if (transportType === 'FTN' && toAddress) {
		var parsed = parseFtnAddress(toAddress);
		if (!parsed) {
			errors.push('Invalid FTN address format — expected zone:net/node (e.g. 1:123/456)');
		}
	}
	if (transportType === 'EMAIL' && toAddress) {
		// Basic email validation: must contain @ with non-empty local and domain parts
		var emailAtIdx = toAddress.indexOf('@');
		if (emailAtIdx <= 0 || emailAtIdx >= toAddress.length - 1 || !toAddress.substring(emailAtIdx + 1).includes('.')) {
			errors.push('Invalid email address format');
		}
	}

	if (errors.length > 0) {
		await flash.set(req, errors.map(function(e) { return { type: 'danger', text: e }; }));
		return res.redirect('/pm/inbox');
	}

	var messageObj = {
		user_id: userId,
		from_user: fromUser,
		to_user: toUser,
		from_address: (req.body.from_address || '').trim(),
		to_address: toAddress,
		subject: subject,
		body_text: req.body.body_text || '',
		utf8: req.body.body_text || '',
		transport_type: transportType,
		transport_data: {
			destination: toAddress
		}
	};

	// Build transport_data based on type
	if (transportType === 'FTN') {
		var destAddr = toAddress;
		var fromAddr = (req.body.from_address || '').trim();
		var parsed = parseFtnAddress(destAddr);
		if (parsed) {
			messageObj.transport_data = {
				source: fromAddr,
				destination: destAddr,
				destination_zone: parsed.zone,
				destination_net: parsed.net,
				destination_node: parsed.node,
				source_zone: 0,
				source_net: 0,
				source_node: 0
			};
		}
	} else if (transportType === 'EMAIL') {
		messageObj.to_address = toAddress;
		messageObj.transport_data = {
			email_address: toAddress
		};
	}

	var result = await privateMessages.queueMessage(messageObj, currentuser);
	if (!result.status) {
		alogger.writeAlog(3, "Network PM send failed: " + result.errormessages.join(', '), "redbright");
		await flash.set(req, result.errormessages.map(function(e) { return { type: 'danger', text: e }; }));
		return res.redirect('/pm/inbox');
	}

	await flash.setOne(req, 'success', transportType + ' message queued for ' + toUser + ' at ' + toAddress);
	res.redirect('/pm/inbox');
});

// POST /pm/reply/:uuid — reply to an inbox message
router.post('/reply/:uuid', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.redirect('/users/login');

	hydrateSessionFlags(currentuser);
	var userId = await resolveUserId(currentuser);

	// Load the original message to determine transport
	var original = await privateMessages.getMessage(userId, req.params.uuid);
	if (!original) {
		await flash.setOne(req, 'danger', 'Original message not found');
		return res.redirect('/pm/inbox');
	}

	var transportType = original.transport_type || 'LOCAL';

	// Access check for the reply transport
	var accessCheck = privateMessages.checkTransportAccess(currentuser, transportType);
	if (!accessCheck.allowed) {
		await flash.setOne(req, 'danger', 'You do not have permission to reply via ' + transportType);
		return res.redirect('/pm/inbox/' + req.params.uuid);
	}

	// Validate body
	var bodyText = (req.body.body_text || '').trim();
	if (!bodyText) {
		await flash.setOne(req, 'danger', 'Message body cannot be empty');
		return res.redirect('/pm/inbox/' + req.params.uuid);
	}

	var replySubject = (req.body.subject || '').trim();
	if (!replySubject) {
		replySubject = original.subject || '';
		if (replySubject && !replySubject.toUpperCase().startsWith('RE:')) {
			replySubject = 'Re: ' + replySubject;
		}
	}

	var messageObj = {
		user_id: userId,
		from_user: currentuser.username,
		to_user: original.from_user,
		from_address: original.to_address,
		to_address: original.from_address,
		subject: replySubject,
		body_text: req.body.body_text || '',
		utf8: req.body.body_text || '',
		transport_type: transportType,
		transport_data: {}
	};

	// Rebuild transport_data from original for network replies
	if (transportType === 'LOCAL') {
		var origTd = typeof original.transport_data === 'string'
			? JSON.parse(original.transport_data) : (original.transport_data || {});
		messageObj.transport_data = {
			sender_user_id: userId,
			recipient_user_id: origTd.sender_user_id || null
		};
		// Resolve recipient if we don't have it
		if (!messageObj.transport_data.recipient_user_id) {
			var resolution = await privateMessages.resolveRecipient(original.from_user);
			if (resolution.resolved) {
				messageObj.transport_data.recipient_user_id = resolution.userId;
			} else {
				await flash.setOne(req, 'danger', 'Could not resolve recipient "' + original.from_user + '"');
				return res.redirect('/pm/inbox/' + req.params.uuid);
			}
		}
	} else {
		// Network reply — flip source/destination from original
		var origTd = typeof original.transport_data === 'string'
			? JSON.parse(original.transport_data) : (original.transport_data || {});
		messageObj.transport_data = {
			source: origTd.destination || original.to_address,
			destination: origTd.source || original.from_address,
			source_zone: origTd.destination_zone || 0,
			source_net: origTd.destination_net || 0,
			source_node: origTd.destination_node || 0,
			destination_zone: origTd.source_zone || 0,
			destination_net: origTd.source_net || 0,
			destination_node: origTd.source_node || 0,
			reply_to: origTd.msg_id || original.msg_id || ''
		};
	}

	var result = await privateMessages.queueMessage(messageObj, currentuser);
	if (!result.status) {
		alogger.writeAlog(3, "PM reply failed: " + result.errormessages.join(', '), "redbright");
		await flash.set(req, result.errormessages.map(function(e) { return { type: 'danger', text: e }; }));
		return res.redirect('/pm/inbox/' + req.params.uuid);
	}

	await flash.setOne(req, 'success', 'Reply sent to ' + original.from_user);
	res.redirect('/pm/inbox');
});

// -------------------------------------------------------
// AJAX JSON Endpoints
// -------------------------------------------------------

// GET /pm/inbox/:uuid/json — load a single inbox message as JSON (for modal reader)
router.get('/inbox/:uuid/json', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.status(401).json({ error: 'Not authenticated' });

	hydrateSessionFlags(currentuser);
	var userId = await resolveUserId(currentuser);
	var message = await privateMessages.getMessage(userId, req.params.uuid);

	if (!message) {
		return res.status(404).json({ error: 'Message not found' });
	}

	// Determine reply permission
	var canReply = false;
	var transportType = message.transport_type || 'LOCAL';
	var accessCheck = privateMessages.checkTransportAccess(currentuser, transportType);
	canReply = accessCheck.allowed;

	res.json({
		uuid: message.uuid,
		from_user: message.from_user,
		to_user: message.to_user,
		from_address: message.from_address || '',
		to_address: message.to_address || '',
		subject: message.subject || '',
		body_html: message.body_html || '',
		body_text: message.body_text || '',
		transport_type: message.transport_type,
		system_time: message.system_time,
		read: message.read,
		canReply: canReply
	});
});

// GET /pm/sent/:uuid/json — load a single sent message as JSON (for modal reader)
router.get('/sent/:uuid/json', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.status(401).json({ error: 'Not authenticated' });

	var userId = await resolveUserId(currentuser);
	var message = await privateMessages.getSentMessage(userId, req.params.uuid);

	if (!message) {
		return res.status(404).json({ error: 'Message not found' });
	}

	res.json({
		uuid: message.uuid,
		from_user: message.from_user,
		to_user: message.to_user,
		from_address: message.from_address || '',
		to_address: message.to_address || '',
		subject: message.subject || '',
		body_html: message.body_html || '',
		body_text: message.body_text || '',
		transport_type: message.transport_type,
		system_time: message.system_time,
		sent: message.sent,
		sent_at: message.sent_at,
		send_error: message.send_error
	});
});

// -------------------------------------------------------
// Message State Actions
// -------------------------------------------------------

// POST /pm/inbox/:uuid/read — toggle read/unread
router.post('/inbox/:uuid/read', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.status(401).json({ error: 'Not authenticated' });

	var userId = await resolveUserId(currentuser);
	var action = req.body.action || 'read';

	if (action === 'unread') {
		await privateMessages.markUnread(userId, req.params.uuid);
	} else {
		await privateMessages.markRead(userId, req.params.uuid);
	}

	res.redirect('/pm/inbox');
});

// POST /pm/inbox/markallread — mark all read
router.post('/inbox/markallread', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.redirect('/users/login');

	var userId = await resolveUserId(currentuser);
	await privateMessages.markAllRead(userId);

	res.redirect('/pm/inbox');
});

// POST /pm/inbox/:uuid/delete — soft delete (move to trash)
router.post('/inbox/:uuid/delete', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.redirect('/users/login');

	var userId = await resolveUserId(currentuser);
	await privateMessages.deleteMessage(userId, req.params.uuid);

	res.redirect('/pm/inbox');
});

// POST /pm/sent/:uuid/delete — soft delete sent message
router.post('/sent/:uuid/delete', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.redirect('/users/login');

	var userId = await resolveUserId(currentuser);
	await privateMessages.deleteSentMessage(userId, req.params.uuid);

	res.redirect('/pm/inbox');
});

// POST /pm/trash/:uuid/restore — restore from trash (tries both inbox and outbox)
router.post('/trash/:uuid/restore', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.redirect('/users/login');

	var userId = await resolveUserId(currentuser);
	// Try both tables — one will be a no-op
	await privateMessages.restoreMessage(userId, req.params.uuid);
	await privateMessages.restoreSentMessage(userId, req.params.uuid);

	res.redirect('/pm/inbox');
});

// -------------------------------------------------------
// Admin: Undeliverable Queue
// -------------------------------------------------------

// GET /pm/undeliverable — sysop review queue
router.get('/undeliverable', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser || !checkAdminAccess(currentuser)) {
		return res.render('pm/undeliverable', {
			title: 'Undeliverable Messages',
			currentuser: currentuser,
			sufficientAccess: false,
			messages: []
		});
	}

	var filter = req.query.filter;
	var reviewedFilter = undefined;
	if (filter === 'reviewed') reviewedFilter = true;
	else if (filter === 'unreviewed' || !filter) reviewedFilter = false;

	var msgList = await privateMessages.getUndeliverableList({ reviewed: reviewedFilter });

	res.render('pm/undeliverable', {
		title: 'Undeliverable Messages',
		currentuser: currentuser,
		sufficientAccess: true,
		messages: msgList,
		filter: filter || 'unreviewed'
	});
});

// GET /pm/undeliverable/:uuid — view single undeliverable message
router.get('/undeliverable/:uuid', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser || !checkAdminAccess(currentuser)) {
		return res.render('pm/undeliverable_detail', {
			title: 'Undeliverable Message',
			currentuser: currentuser,
			sufficientAccess: false,
			message: null
		});
	}

	var message = await privateMessages.getUndeliverableMessage(req.params.uuid);

	res.render('pm/undeliverable_detail', {
		title: message ? 'Review: ' + (message.subject || 'No Subject') : 'Not Found',
		currentuser: currentuser,
		sufficientAccess: true,
		message: message
	});
});

// POST /pm/undeliverable/:uuid/action — sysop review action
router.post('/undeliverable/:uuid/action', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser || !checkAdminAccess(currentuser)) {
		return res.status(403).json({ error: 'Access denied' });
	}

	var userId = await resolveUserId(currentuser);
	var message = await privateMessages.getUndeliverableMessage(req.params.uuid);
	if (!message) {
		await flash.setOne(req, 'danger', 'Undeliverable message not found');
		return res.redirect('/pm/undeliverable');
	}

	var action = req.body.action || 'deleted';
	var deliverToUserId = null;

	if (action === 'delivered') {
		var deliverToUsername = (req.body.deliver_to_username || '').trim();
		if (!deliverToUsername) {
			await flash.setOne(req, 'danger', 'Username is required to deliver a message');
			return res.redirect('/pm/undeliverable/' + req.params.uuid);
		}
		var targetUser = await userAccounts.getUserRecord(deliverToUsername);
		if (!targetUser) {
			await flash.setOne(req, 'danger', 'User "' + deliverToUsername + '" not found');
			return res.redirect('/pm/undeliverable/' + req.params.uuid);
		}
		deliverToUserId = targetUser.id;
	}

	var result = await privateMessages.reviewMessage(message.id, userId, action, deliverToUserId);
	if (result.status) {
		var actionText = action === 'delivered' ? 'Delivered to ' + (req.body.deliver_to_username || '') : action.charAt(0).toUpperCase() + action.slice(1);
		await flash.setOne(req, 'success', 'Message reviewed: ' + actionText);
	} else {
		await flash.set(req, result.errormessages.map(function(e) { return { type: 'danger', text: e }; }));
	}

	res.redirect('/pm/undeliverable');
});

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

// Parse an FTN address string into components
function parseFtnAddress(addr) {
	if (!addr) return null;
	try {
		var zsplit = addr.split(':');
		var nnsplit = zsplit[1] ? zsplit[1].split('/') : [];
		var zone = parseInt(zsplit[0]);
		var net = parseInt(nnsplit[0]);
		var node = parseInt(nnsplit[1]);
		if (isNaN(zone) || isNaN(net) || isNaN(node)) return null;
		return { zone: zone, net: net, node: node };
	} catch (e) {
		return null;
	}
}

export { router };
