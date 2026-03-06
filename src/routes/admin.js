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
import * as sessionStore from "../middleware/db/sessionstore.js";
import * as alogger from "../utils/alogger.js";

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '250mb', extended: true });

//variables and const
const faviconlink  = process.env.faviconlink  || "/images/favicon.ico";
const boardname    = process.env.boardname;
const sitetld      = process.env.sitetld;
const loadcorsorigin = process.env.corsorigin;
const sitedomain   = process.env.sitedomain;
const fulldomain   = "https://" + sitedomain;
const basedir      = process.cwd();
const defaultUser  = process.env.DefaultUser || "John Doe";

// Helper: get current user from session cookie
async function getCurrentUser(req) {
	return await sessionStore.sessionGet(req.cookies.sessionid) || null;
}

/* GET Admin Main page. */
router.get('/', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	res.render('admin/dashboard', {
		currentuser: currentuser,
		title: 'Admin Dash'
	});
});

router.get('/styles', function (req, res, next) {
	res.render('admin/styles', {
		title: 'Terminal Styles'
	});
});

router.get('/msgGroups', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var grouplist = await msgGroups.getAllGroups();
	res.render('admin/msgGroups', {
		title: 'Message Groups',
		currentuser: currentuser,
		grouplist: grouplist
	});
});

router.get('/netmail', async (req, res, next) => {
	var currentuser  = await getCurrentUser(req);
	var inboundlist  = await netmail.getAllInbound();
	var outboundlist = await netmail.getAllOutbound();
	res.render('admin/netmail/index', {
		title: 'Netmail',
		currentuser: currentuser,
		inboundlist: inboundlist,
		outboundlist: outboundlist,
		DateTime: DateTime
	});
});

router.get('/netmail/in/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toUpperCase().trim();
	var message     = await netmail.getInboundMsgByUUID(uuid);
	var ftext       = message ? message.body_text.replace(/\r/g, '<br>') : "";
	res.render('admin/netmail/ibmsg', {
		title: 'Netmail',
		currentuser: currentuser,
		message: message,
		ftext: ftext,
		DateTime: DateTime
	});
});

router.get('/netmail/out/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toUpperCase().trim();
	var message     = await netmail.getOutboundMsgByUUID(uuid);
	var ftext       = message ? message.body_text.replace(/\r/g, '<br>') : "";
	res.render('admin/netmail/obmsg', {
		title: 'Sent Netmail',
		currentuser: currentuser,
		message: message,
		ftext: ftext,
		DateTime: DateTime
	});
});

router.post('/netmail/new', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var formObj     = req.body;
	formObj.FromUser = currentuser ? currentuser.name : defaultUser;
	var result = await netmail.newOutboundNetmail(formObj);
	if (result.status === true) {
		res.redirect('/admin/netmail');
	} else {
		var inboundlist  = await netmail.getAllInbound();
		var outboundlist = await netmail.getAllOutbound();
		res.render('admin/netmail/index', {
			title: 'Netmail',
			currentuser: currentuser,
			errormessages: result.errormessages,
			inboundlist: inboundlist,
			outboundlist: outboundlist,
			DateTime: DateTime
		});
	}
});

router.post('/msgGroup/new', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
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
			title: 'Message Groups',
			currentuser: currentuser,
			errors: result.errormessages
		});
	}
});

router.post('/msgGroup/:shortcode/newArea', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
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
			title: 'Message Groups',
			currentuser: currentuser,
			errors: result.errormessages
		});
	}
});

router.get('/msgGroup/:shortcode', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var shortcode   = req.params.shortcode.toUpperCase().trim();
	var msgGroup    = await msgGroups.getGroupByShortcode(shortcode);
	var arealist    = await msgAreas.getListByGroupShortcode(shortcode);
	var title       = msgGroup ? msgGroup.name : "Unknown Message Group";
	res.render('admin/msgGroups/view', {
		title: title,
		currentuser: currentuser,
		msgGroup: msgGroup,
		arealist: arealist,
		DateTime: DateTime
	});
});

router.get('/msgAreas', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	res.render('admin/msgAreas', {
		title: 'Message Areas',
		currentuser: currentuser
	});
});

router.get('/nodes', async (req, res, next) => {
	var currentuser       = await getCurrentUser(req);
	var nodelist          = await linkedNodes.getAllNodes();
	var systemaddresslist = await systemAddresses.getActiveAddresses();
	res.render('admin/nodes', {
		title: 'Linked Nodes',
		currentuser: currentuser,
		nodelist: nodelist,
		DateTime: DateTime,
		systemaddresslist: systemaddresslist
	});
});

router.get('/node/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var node        = await linkedNodes.getNodeByUUID(uuid);
	var grouplist;
	if (node) {
		grouplist = await msgGroups.getAllGroupsWithAreas();
	}
	res.render('admin/nodes/view', {
		title: 'Linked Node',
		currentuser: currentuser,
		node: node,
		DateTime: DateTime,
		grouplist: grouplist
	});
});

router.post('/nodes/:uuid/updateallowedareas', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var allowedareas = req.body.allowedareas || [];
	var resultObj   = await linkedNodes.updateAllowedAreas(uuid, allowedareas);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateallowedareas incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/:uuid/updateenabledareas', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var enabledareas = req.body.enabledareas || [];
	var resultObj   = await linkedNodes.updateEnabledAreas(uuid, enabledareas);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateenabledareas incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/:uuid/updateaddress', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var resultObj   = await linkedNodes.updateAddress(uuid, req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateaddress incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/:uuid/updateconnection', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var resultObj   = await linkedNodes.updateConnection(uuid, req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updateconnection incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/:uuid/updatepasswords', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var resultObj   = await linkedNodes.updatePasswords(uuid, req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "updatepasswords incomplete for " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect(`/admin/node/${uuid}`);
});

router.post('/nodes/new', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var resultObj   = await linkedNodes.newNode(req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "newNode failed: " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/nodes');
});

router.post('/systemaddresses/new', urlencodedParser, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var resultObj   = await systemAddresses.newAddress(req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "newAddress failed: " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/nodes');
});

router.get('/msgArea/:shortcode/thread/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
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
		title: title,
		currentuser: currentuser,
		thread: thread,
		msgArea: msgArea,
		messages: msglist,
		DateTime: DateTime
	});
});

router.get('/msgArea/:shortcode', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var shortcode   = req.params.shortcode.toLowerCase().trim();
	var msgArea     = await msgAreas.getAreaByShortcode(shortcode);
	var threadlist  = await echomail.getRecentThreadsForArea(shortcode);
	res.render('admin/msgAreas/view', {
		title: msgArea ? msgArea.name : shortcode,
		currentuser: currentuser,
		msgArea: msgArea,
		threadlist: threadlist,
		DateTime: DateTime
	});
});

router.post('/msgArea/:shortcode/newthread', urlencodedParser, async (req, res) => {
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

router.post('/msgArea/:shortcode/thread/:uuid/newreply', urlencodedParser, async (req, res) => {
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

router.post('/deletemsg/:shortcode/:uuid', urlencodedParser, async (req, res) => {
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

export { router };