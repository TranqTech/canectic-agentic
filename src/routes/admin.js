//imports
import express from 'express';
const router = express.Router();
import { DateTime } from "luxon";
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import sanitizeHtml from 'sanitize-html';
import mobile from 'is-mobile';

//internals
import * as msgGroups from '../models/msgGroups.js';
import * as msgAreas from '../models/msgAreas.js';
import * as netmail from '../models/netmail.js';
import * as echomail from '../models/echomail.js';
import * as linkedNodes from '../models/linkedNodes.js';
import * as systemAddresses from "../models/systemAddresses.js";
import * as userAccounts from "../models/useraccounts.js";
import * as sessionStore from "../middleware/db/sessionstore.js";
import * as alogger from "../utils/alogger.js";

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '250mb', extended: true });

//variables and const
const faviconlink    = process.env.faviconlink  || "/images/favicon.ico";
const boardname      = process.env.boardname;
const sitetld        = process.env.sitetld;
const loadcorsorigin = process.env.corsorigin;
const sitedomain     = process.env.sitedomain;
const fulldomain     = "https://" + sitedomain;
const basedir        = process.cwd();
const defaultUser    = process.env.DefaultUser || "John Doe";
const adminsecurity  = parseInt(process.env.adminsecurity) || 200;

// Inject shared locals for all admin views
router.use(function(req, res, next) {
	res.locals.boardname    = boardname    || 'BBS Admin';
	res.locals.faviconlink  = faviconlink  || '/images/favicon.ico';
	res.locals.currentPath  = '/admin' + req.path;
	res.locals.activelink   = '';
	next();
});

// Helper: get current user from session cookie
async function getCurrentUser(req) {
	return await sessionStore.sessionGet(req.cookies.sessionid) || null;
}

// Helper: check if user meets admin access requirements
function checkAdminAccess(user) {
	if (!user) return false;
	var security = parseInt(user.security) || 0;
	if (security < adminsecurity) return false;
	var perms = Array.isArray(user.permissionflags) ? user.permissionflags : [];
	return perms.includes('Sysop');
}

// Middleware: block POST routes if user is not authorized
async function requireAdmin(req, res, next) {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	if (sufficientAccess) return next();
	alogger.writeAlog(3, "Unauthorized admin POST attempt: " + req.path + " by " + (currentuser ? currentuser.username : 'unauthenticated'), "redbright");
	return res.status(403).render('admin/status/unauthorized', {
		title: 'Unauthorized',
		activelink: '',
		currentuser: currentuser
	});
}

/* GET Admin Main page. */
router.get('/', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	res.render('admin/dashboard', {
		sufficientAccess: sufficientAccess,
		title: 'Admin Dash',
		activelink: '',
		currentuser: currentuser
	});
});

router.get('/styles', async (req, res) => {
	var currentuser    = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	res.render('admin/styles', {
		sufficientAccess: sufficientAccess,
		title: 'Terminal Styles',
		activelink: '',
		currentuser: currentuser
	});
});

router.get('/msgGroups', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var grouplist = await msgGroups.getAllGroups();
	res.render('admin/msgGroups', {
		sufficientAccess: sufficientAccess,
		title: 'Message Groups',
		activelink: 'msgGroups',
		currentuser: currentuser,
		grouplist: grouplist
	});
});

router.get('/netmail', async (req, res, next) => {
	var currentuser  = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var inboundlist  = await netmail.getAllInbound();
	var outboundlist = await netmail.getAllOutbound();
	res.render('admin/netmail/index', {
		sufficientAccess: sufficientAccess,
		title: 'Netmail',
		activelink: 'msgGroups',
		currentuser: currentuser,
		inboundlist: inboundlist,
		outboundlist: outboundlist,
		DateTime: DateTime
	});
});

router.get('/netmail/in/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var uuid        = req.params.uuid.toUpperCase().trim();
	var message     = await netmail.getInboundMsgByUUID(uuid);
	var ftext       = message ? message.body_text.replace(/\r/g, '<br>') : "";
	res.render('admin/netmail/ibmsg', {
		sufficientAccess: sufficientAccess,
		title: 'Netmail',
		activelink: 'msgGroups',
		currentuser: currentuser,
		message: message,
		ftext: ftext,
		DateTime: DateTime
	});
});

router.get('/netmail/out/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var uuid        = req.params.uuid.toUpperCase().trim();
	var message     = await netmail.getOutboundMsgByUUID(uuid);
	var ftext       = message ? message.body_text.replace(/\r/g, '<br>') : "";
	res.render('admin/netmail/obmsg', {
		sufficientAccess: sufficientAccess,
		title: 'Sent Netmail',
		activelink: 'msgGroups',
		currentuser: currentuser,
		message: message,
		ftext: ftext,
		DateTime: DateTime
	});
});

router.post('/netmail/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var formObj     = req.body;
	formObj.FromUser = currentuser ? currentuser.name : defaultUser;
	var result = await netmail.newOutboundNetmail(formObj);
	if (result.status === true) {
		res.redirect('/admin/netmail');
	} else {
		var inboundlist  = await netmail.getAllInbound();
		var outboundlist = await netmail.getAllOutbound();
		res.render('admin/netmail/index', {
			sufficientAccess: sufficientAccess,
			title: 'Netmail',
			activelink: 'msgGroups',
			currentuser: currentuser,
			errormessages: result.errormessages,
			inboundlist: inboundlist,
			outboundlist: outboundlist,
			DateTime: DateTime
		});
	}
});

router.post('/msgGroup/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var formObj     = req.body;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await msgGroups.newGroup(formObj);
	if (result.status === true) {
		res.redirect(`/admin/msgGroup/${result.shortcode}`);
	} else {
		res.render('admin/msgGroups', {
			sufficientAccess: sufficientAccess,
			title: 'Message Groups',
			activelink: 'msgGroups',
			currentuser: currentuser,
			errors: result.errormessages
		});
	}
});

router.post('/msgGroup/:shortcode/newArea', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode   = req.params.shortcode.toUpperCase().trim();
	var formObj     = req.body;
	formObj.groupshortcode = shortcode;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await msgAreas.newArea(formObj);
	if (result.status === true) {
		res.redirect(`/admin/msgGroup/${shortcode}`);
	} else {
		res.render('admin/msgGroups', {
			sufficientAccess: sufficientAccess,
			title: 'Message Groups',
			activelink: 'msgGroups',
			currentuser: currentuser,
			errors: result.errormessages
		});
	}
});

router.get('/msgGroup/:shortcode', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode   = req.params.shortcode.toUpperCase().trim();
	var msgGroup    = await msgGroups.getGroupByShortcode(shortcode);
	var arealist    = await msgAreas.getListByGroupShortcode(shortcode);
	var title       = msgGroup ? msgGroup.name : "Unknown Message Group";
	res.render('admin/msgGroups/view', {
		sufficientAccess: sufficientAccess,
		title: title,
		activelink: 'msgGroups',
		currentuser: currentuser,
		msgGroup: msgGroup,
		arealist: arealist,
		DateTime: DateTime
	});
});

router.get('/msgAreas', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	res.render('admin/msgAreas', {
		sufficientAccess: sufficientAccess,
		title: 'Message Areas',
		activelink: 'msgGroups',
		currentuser: currentuser
	});
});

router.get('/nodes', async (req, res, next) => {
	var currentuser       = await getCurrentUser(req);
	var sufficientAccess  = checkAdminAccess(currentuser);
	var nodelist          = await linkedNodes.getAllNodes();
	var systemaddresslist = await systemAddresses.getActiveAddresses();
	res.render('admin/nodes', {
		sufficientAccess: sufficientAccess,
		title: 'Linked Nodes',
		activelink: 'msgGroups',
		currentuser: currentuser,
		nodelist: nodelist,
		DateTime: DateTime,
		systemaddresslist: systemaddresslist
	});
});

router.get('/node/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var node        = await linkedNodes.getNodeByUUID(uuid);
	var grouplist;
	if (node) {
		grouplist = await msgGroups.getAllGroupsWithAreas();
	}
	res.render('admin/nodes/view', {
		sufficientAccess: sufficientAccess,
		title: 'Linked Node',
		activelink: 'msgGroups',
		currentuser: currentuser,
		node: node,
		DateTime: DateTime,
		grouplist: grouplist
	});
});

router.post('/nodes/:uuid/updateallowedareas', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var allowedareas = req.body.allowedareas || [];
	var resultObj   = await linkedNodes.updateAllowedAreas(uuid, allowedareas);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateallowedareas incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/:uuid/updateenabledareas', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var enabledareas = req.body.enabledareas || [];
	var resultObj   = await linkedNodes.updateEnabledAreas(uuid, enabledareas);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateenabledareas incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/:uuid/updateaddress', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var resultObj   = await linkedNodes.updateAddress(uuid, req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateaddress incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/:uuid/updateconnection', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var resultObj   = await linkedNodes.updateConnection(uuid, req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateconnection incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/:uuid/updatepasswords', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var resultObj   = await linkedNodes.updatePasswords(uuid, req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updatepasswords incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var resultObj   = await linkedNodes.newNode(req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "newNode failed: " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/nodes');
});

router.post('/systemaddresses/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var resultObj   = await systemAddresses.newAddress(req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "newAddress failed: " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/nodes');
});

router.get('/msgArea/:shortcode/thread/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode   = req.params.shortcode.toLowerCase().trim();
	var uuid        = req.params.uuid.toLowerCase().trim();
	var thread      = await echomail.getThreadByUUID(uuid, shortcode);
	var msgArea;
	var msglist;
	if (thread) {
		msgArea = await msgAreas.getAreaByShortcode(shortcode);
		msglist = await echomail.getMessagesForThread(shortcode, thread.id);
	}
	var title = thread ? thread.subject : "Thread Not Found";
	res.render('admin/msgAreas/thread', {
		sufficientAccess: sufficientAccess,
		title: title,
		activelink: 'msgGroups',
		currentuser: currentuser,
		thread: thread,
		msgArea: msgArea,
		messages: msglist,
		DateTime: DateTime
	});
});

router.get('/msgArea/:shortcode', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode   = req.params.shortcode.toLowerCase().trim();
	var msgArea     = await msgAreas.getAreaByShortcode(shortcode);
	var threadlist  = await echomail.getRecentThreadsForArea(shortcode);
	res.render('admin/msgAreas/view', {
		sufficientAccess: sufficientAccess,
		title: msgArea ? msgArea.name : shortcode,
		activelink: 'msgGroups',
		currentuser: currentuser,
		msgArea: msgArea,
		threadlist: threadlist,
		DateTime: DateTime
	});
});

router.post('/msgArea/:shortcode/newthread', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var shortcode   = req.params.shortcode.toLowerCase().trim();
	var formObj     = req.body;
	if (currentuser) {
		formObj.from_user = formObj.from_user || currentuser.name;
	}
	var resultObj = await echomail.startNewThread(formObj, shortcode);
	if (resultObj.status === true) {
		res.redirect(`/admin/msgArea/${shortcode}/thread/${resultObj.threaduuid}`);
	} else {
		res.redirect(`/admin/msgArea/${shortcode}`);
	}
});

router.post('/msgArea/:shortcode/thread/:uuid/newreply', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var shortcode   = req.params.shortcode.toLowerCase().trim();
	var uuid        = req.params.uuid.toLowerCase().trim();
	var formObj     = req.body;
	if (currentuser) {
		formObj.from_user = formObj.from_user || currentuser.name;
	}
	var resultObj = await echomail.replyToThread(formObj, shortcode, uuid);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "replyToThread failed for thread " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/msgArea/${shortcode}/thread/${uuid}`);
});

router.post('/deletemsg/:shortcode/:uuid', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var shortcode   = req.params.shortcode.trim();
	var uuid        = req.params.uuid.trim();
	if (!uuid || !shortcode) {
		res.redirect('/admin/');
		return;
	}
	// TODO: add user authorization check here
	var delsuccess = await echomail.deleteMessageByUUID(uuid, shortcode);
	if (delsuccess) {
		res.redirect(`/admin/msgArea/${shortcode}`);
	} else {
		res.redirect('/admin');
	}
});

// Placeholder flag lists — replace with model lookups once permissions model exists
const availablePermissions  = ["Sysop", "Mod", "Adult", "Admin"];
const availableRestrictions = ["Underage", "Banned"];

router.get('/users', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var userlist    = await userAccounts.getUserList();
	res.render('admin/users/index', {
		sufficientAccess: sufficientAccess,
		title: 'Users',
		activelink: 'users',
		currentuser: currentuser,
		userlist: userlist,
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions,
		DateTime: DateTime
	});
});

router.get('/users/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var user        = await userAccounts.getUserByUUID(uuid);
	if (!user) {
		res.redirect('/admin/users');
		return;
	}
	res.render('admin/users/index', {
		sufficientAccess: sufficientAccess,
		title: 'Users',
		activelink: 'users',
		currentuser: currentuser,
		userlist: await userAccounts.getUserList(),
		openuser: user,
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions,
		DateTime: DateTime
	});
});

router.post('/users/:uuid/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var resultObj   = await userAccounts.updateUser(uuid, req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateUser failed for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/users');
});

router.post('/users/:uuid/resetpassword', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var resultObj   = await userAccounts.resetUserPassword(uuid, req.body.newpassword);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "resetUserPassword failed for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/users');
});

export { router };