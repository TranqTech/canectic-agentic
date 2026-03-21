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
import * as privateMessages from '../models/privateMessages.js';
import * as msgNetworks from '../models/msgNetworks.js';
import * as msgZones from '../models/msgZones.js';
import * as msgGroups from '../models/msgGroups.js';
import * as msgAreas from '../models/msgAreas.js';
import * as netmail from '../models/netmail.js';
import * as messages from '../models/messages.js';
import * as peers from '../models/peers.js';
import * as doors from '../models/doors.js';
import * as menus from '../models/menus.js';
import * as peerConnections from '../models/peerConnections.js';
import * as peerAreaSubscriptions from '../models/peerAreaSubscriptions.js';
import * as networkAreas from '../models/networkAreas.js';
import * as systemAddresses from "../models/systemAddresses.js";
import * as userAccounts from "../models/useraccounts.js";
import * as sessionStore from "../middleware/db/sessionstore.js";
import * as alogger from "../utils/alogger.js";
import * as jobs from "../queues/jobs.js";
import {getVariableList} from "../utils/configvars.js"
import appConfig from "../config/appConfig.js";
import { CONFIG_DEFINITIONS, getDefinition, getCategories } from "../config/configDefaults.js";
import * as configStore from "../models/configStore.js";

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '250mb', extended: true });

//variables and const
const basedir        = process.cwd();
const availablePermissions  = ["Sysop", "Mod", "Adult", "Admin", "Email", "Netmail"];
const availableRestrictions = ["Underage", "Banned", "Email", "Netmail","Private Messages"];

// Inject shared locals for all admin views
router.use(async function(req, res, next) {
	res.locals.boardname    = appConfig.get('boardname', 'BBS Admin');
	res.locals.faviconlink  = appConfig.get('faviconlink', '/images/favicon.ico');
	res.locals.currentPath  = '/admin' + req.path;
	res.locals.activelink   = '';
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

// Helper: check if user meets admin access requirements
function checkAdminAccess(user) {
	if (!user) return false;
	var security = parseInt(user.security) || 0;
	if (security < appConfig.getNumber('adminsecurity', 200)) return false;
	var perms = Array.isArray(user.permissionflags) ? user.permissionflags : [];
	return perms.includes('Sysop');
}

// Middleware: block POST routes if user is not authorized
async function requireAdmin(req, res, next) {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	if (sufficientAccess) return next();
	alogger.writeAlog(3, "Unauthorized admin POST attempt: " + req.path + " by " + (currentuser ? currentuser.username : 'unauthenticated'), "redbright");
	return res.status(403).render('admin/unauthorized', {
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
		activelink: 'dashboard',
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
		grouplist: grouplist,
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions
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
	formObj.FromUser = currentuser ? currentuser.name : appConfig.get('DefaultUser', 'John Doe');
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
			errors: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions
		});
	}
});

// Recalculate area counts for all groups
router.post('/msgGroups/recalculateAreaCounts', urlencodedParser, requireAdmin, async (req, res) => {
	await jobs.enqueueRecalcAreaCounts();
	res.redirect('/admin/msgGroups');
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
			errors: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions
		});
	}
});

router.post('/msgGroup/:shortcode/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode        = req.params.shortcode.toUpperCase().trim();
	var formObj          = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	var result = await msgGroups.updateGroup(shortcode, formObj);
	if (result.status === true) {
		res.redirect(`/admin/msgGroup/${shortcode}`);
	} else {
		alogger.writeAlog(3, "updateGroup failed for " + shortcode + ": " + result.errormessages.join(", "), "redbright");
		var msgGroup  = await msgGroups.getGroupByShortcode(shortcode);
		var arealist  = await msgAreas.getListByGroupShortcode(shortcode);
			// Augment each area with its first active network mapping (name + areatag)
			if (arealist && arealist.length > 0) {
				for (var area of arealist) {
					var netRows = await networkAreas.getNetworksByArea(area.id);
					if (netRows && netRows.length > 0) {
						var firstActive = netRows.find(nr => nr.active) || netRows[0];
						area.network_name = firstActive.network_name || null;
						area.areatag      = firstActive.areatag || null;
					}
				}
			}
			var networklist = await msgNetworks.getActiveNetworks();
		res.render('admin/msgGroups/view', {
			sufficientAccess: sufficientAccess,
			title: msgGroup ? msgGroup.name : shortcode,
			activelink: 'msgGroups',
			currentuser: currentuser,
			msgGroup: msgGroup,
			arealist: arealist,
			networklist: networklist,
			errormessages: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions,
			DateTime: DateTime
		});
	}
});

router.post('/msgGroup/:shortcode/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser  = await getCurrentUser(req);
	var deleteTables = (req.body.delete_tables === 'true');
	var shortcode    = req.params.shortcode.toUpperCase().trim();
	var result       = await msgGroups.removeGroup(shortcode, deleteTables);
	if (result.status === true) {
		res.redirect('/admin/msgGroups');
	} else {
		alogger.writeAlog(3, "removeGroup failed for " + shortcode + ": " + result.errormessages.join(", "), "redbright");
		var msgGroup  = await msgGroups.getGroupByShortcode(shortcode);
		var arealist  = await msgAreas.getListByGroupShortcode(shortcode);
			// Augment each area with its first active network mapping (name + areatag)
			if (arealist && arealist.length > 0) {
				for (var area of arealist) {
					var netRows = await networkAreas.getNetworksByArea(area.id);
					if (netRows && netRows.length > 0) {
						var firstActive = netRows.find(nr => nr.active) || netRows[0];
						area.network_name = firstActive.network_name || null;
						area.areatag      = firstActive.areatag || null;
					}
				}
			}
			var networklist = await msgNetworks.getActiveNetworks();
		res.render('admin/msgGroups/view', {
			sufficientAccess: true,
			title: msgGroup ? msgGroup.name : shortcode,
			activelink: 'msgGroups',
			currentuser: currentuser,
			msgGroup: msgGroup,
			arealist: arealist,
			networklist: networklist,
			errormessages: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions,
			DateTime: DateTime
		});
	}
});

// JSON endpoint — returns group security and flag defaults for new area modal auto-populate
router.get('/msgGroup/:shortcode/defaults', requireAdmin, async (req, res) => {
	var shortcode = req.params.shortcode.toUpperCase().trim();
	var group = await msgGroups.getGroupByShortcode(shortcode);
	if (!group) {
		return res.status(404).json({ error: 'Group not found' });
	}
	res.json({
		read_security: group.read_security || 0,
		post_security: group.post_security || 0,
		read_perm_flags: group.read_perm_flags || [],
		read_rest_flags: group.read_rest_flags || [],
		post_perm_flags: group.post_perm_flags || [],
		post_rest_flags: group.post_rest_flags || []
	});
});

router.get('/msgGroup/:shortcode', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode   = req.params.shortcode.toUpperCase().trim();
	var msgGroup    = await msgGroups.getGroupByShortcode(shortcode);
	var arealist    = await msgAreas.getListByGroupShortcode(shortcode);
	var title       = msgGroup ? msgGroup.name : "Unknown Message Group";
	// Augment each area with its first active network mapping (name + areatag)
	if (arealist && arealist.length > 0) {
		for (var area of arealist) {
			var netRows = await networkAreas.getNetworksByArea(area.id);
			if (netRows && netRows.length > 0) {
				var firstActive = netRows.find(nr => nr.active) || netRows[0];
				area.network_name = firstActive.network_name || null;
				area.areatag      = firstActive.areatag || null;
			}
		}
	}
	var networklist = await msgNetworks.getActiveNetworks();
	res.render('admin/msgGroups/view', {
		sufficientAccess: sufficientAccess,
		title: title,
		activelink: 'msgGroups',
		currentuser: currentuser,
		msgGroup: msgGroup,
		arealist: arealist,
		networklist: networklist,
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions,
		DateTime: DateTime
	});
});

router.get('/msgAreas', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var grouplist = await msgGroups.getAllGroups();
	var allAreas  = await msgAreas.getAllAreas();
	var networklist = await msgNetworks.getActiveNetworks();

	// Augment areas with network info
	if (allAreas && allAreas.length > 0) {
		for (var area of allAreas) {
			var netRows = await networkAreas.getNetworksByArea(area.id);
			if (netRows && netRows.length > 0) {
				var firstActive = netRows.find(nr => nr.active) || netRows[0];
				area.network_name = firstActive.network_name || null;
				area.areatag      = firstActive.areatag || null;
			}
		}
	}

	res.render('admin/msgAreas/index', {
		sufficientAccess: sufficientAccess,
		title: 'Message Areas',
		activelink: 'msgGroups',
		currentuser: currentuser,
		grouplist: grouplist,
		allAreas: allAreas || [],
		networklist: networklist,
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions,
		DateTime: DateTime
	});
});

router.get('/networks', async (req, res, next) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networklist      = await msgNetworks.getNetworksWithZoneCount();
	res.render('admin/msgNets/index', {
		sufficientAccess: sufficientAccess,
		title: 'Message Networks',
		activelink: 'networks',
		currentuser: currentuser,
		networklist: networklist
	});
});

router.post('/networks/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var formObj     = req.body;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await msgNetworks.newNetwork(formObj);
	if (result.status === true) {
		res.redirect('/admin/network/' + result.insertUUID);
	} else {
		alogger.writeAlog(3, "newNetwork failed: " + result.errormessages.join(", "), "redbright");
		var networklist = await msgNetworks.getNetworksWithZoneCount();
		res.render('admin/msgNets/index', {
			sufficientAccess: true,
			title: 'Message Networks',
			activelink: 'networks',
			currentuser: currentuser,
			networklist: networklist,
			errormessages: result.errormessages
		});
	}
});

router.get('/network/:uuid', async (req, res, next) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var uuid             = req.params.uuid.toLowerCase().trim();
	var network          = await msgNetworks.getNetworkByUUID(uuid);
	var zonelist, addresslist, connectionlist, networkareas, arealist;
	if (network) {
		zonelist       = await msgZones.getZonesByNetwork(network.id);
		addresslist    = await systemAddresses.getAddressesByNetwork(network.id);
		connectionlist = await peerConnections.getConnectionsByNetwork(network.id);
		networkareas   = await networkAreas.getAreasByNetwork(network.id);
		// arealist for the 'Add Area' modal — all areas not already mapped to this network,
		// grouped by message group for the optgroup select
		var allAreas  = await msgAreas.getAllAreas();
		var mappedIds = new Set((networkareas || []).map(na => parseInt(na.area_id)));
		var unmapped  = (allAreas || []).filter(a => !mappedIds.has(parseInt(a.id)));

		// Build grouped structure: [ { groupName, groupShortcode, areas: [...] }, ... ]
		var allGroups   = await msgGroups.getAllGroups();
		var groupMap    = {};
		for (var g of (allGroups || [])) {
			groupMap[g.shortcode] = g.name || g.shortcode;
		}
		var groupedAreas = {};
		for (var a of unmapped) {
			var gkey = a.group_shortcode || '_ungrouped';
			if (!groupedAreas[gkey]) {
				groupedAreas[gkey] = {
					groupName: groupMap[gkey] || gkey,
					groupShortcode: gkey,
					areas: []
				};
			}
			groupedAreas[gkey].areas.push(a);
		}
		arealist = Object.values(groupedAreas).sort((a, b) =>
			a.groupName.localeCompare(b.groupName)
		);
	}
	res.render('admin/msgNets/view', {
		sufficientAccess: sufficientAccess,
		title: 'Network',
		activelink: 'networks',
		currentuser: currentuser,
		network: network,
		zonelist: zonelist || [],
		addresslist: addresslist || [],
		connectionlist: connectionlist || [],
		networkareas: networkareas || [],
		arealist: arealist || []
	});
});

router.post('/network/:uuid/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var formObj     = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	var result = await msgNetworks.updateNetwork(uuid, formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "updateNetwork failed for " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/network/' + uuid);
});

router.post('/network/:uuid/newzone', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var network     = await msgNetworks.getNetworkByUUID(uuid);
	if (!network) {
		alogger.writeAlog(3, "newzone: network not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/networks');
	}
	var formObj = req.body;
	formObj.network_id = network.id;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await msgZones.newZone(formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "newZone failed for network " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/network/' + uuid);
});

router.post('/network/:uuid/newaddress', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var network     = await msgNetworks.getNetworkByUUID(uuid);
	if (!network) {
		alogger.writeAlog(3, "newaddress: network not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/networks');
	}
	var formObj = req.body;
	formObj.network_id = network.id;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await systemAddresses.newAddress(formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "newAddress failed for network " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/network/' + uuid);
});

router.post('/address/:uuid/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser  = await getCurrentUser(req);
	var addressuuid  = req.params.uuid.toLowerCase().trim();
	var formObj      = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	var dbaddress = await systemAddresses.getAddressByUUID(addressuuid);
	if (!dbaddress) {
		alogger.writeAlog(3, "updateAddress: not found for uuid " + addressuuid, "redbright");
		return res.redirect('/admin/networks');
	}
	var network = await msgNetworks.getNetworkById(dbaddress.network_id);
	var result  = await systemAddresses.updateAddress(addressuuid, formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "updateAddress failed for " + addressuuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/network/' + (network ? network.uuid : ''));
});

router.post('/address/:uuid/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var addressuuid  = req.params.uuid.toLowerCase().trim();
	var dbaddress    = await systemAddresses.getAddressByUUID(addressuuid);
	if (!dbaddress) {
		alogger.writeAlog(3, "removeAddress: not found for uuid " + addressuuid, "redbright");
		return res.redirect('/admin/networks');
	}
	var network = await msgNetworks.getNetworkById(dbaddress.network_id);
	var result  = await systemAddresses.removeAddress(addressuuid);
	if (result.status !== true) {
		alogger.writeAlog(3, "removeAddress failed for " + addressuuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/network/' + (network ? network.uuid : ''));
});

router.post('/address/:uuid/setdefault', urlencodedParser, requireAdmin, async (req, res) => {
	var addressuuid = req.params.uuid.toLowerCase().trim();
	var dbaddress   = await systemAddresses.getAddressByUUID(addressuuid);
	if (!dbaddress) {
		alogger.writeAlog(3, "setDefaultAddress: not found for uuid " + addressuuid, "redbright");
		return res.redirect('/admin/networks');
	}
	var network = await msgNetworks.getNetworkById(dbaddress.network_id);
	var result  = await systemAddresses.setDefaultAddress(dbaddress.network_id, addressuuid);
	if (result.status !== true) {
		alogger.writeAlog(3, "setDefaultAddress failed for " + addressuuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/network/' + (network ? network.uuid : ''));
});

router.post('/network/zone/:zoneuuid/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var zoneuuid    = req.params.zoneuuid.toLowerCase().trim();
	var formObj     = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	var dbzone  = await msgZones.getZoneByUUID(zoneuuid);
	if (!dbzone) {
		alogger.writeAlog(3, "updateZone: zone not found for uuid " + zoneuuid, "redbright");
		return res.redirect('/admin/networks');
	}
	var network = await msgNetworks.getNetworkById(dbzone.network_id);
	var result  = await msgZones.updateZone(zoneuuid, formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "updateZone failed for " + zoneuuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/network/' + (network ? network.uuid : ''));
});

// -------------------------------------------------------
// Peers
// -------------------------------------------------------

router.get('/peers', async (req, res, next) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var peerlist         = await peers.getAllPeers();
	res.render('admin/peers/index', {
		sufficientAccess: sufficientAccess,
		title: 'Peer Systems',
		activelink: 'networks',
		currentuser: currentuser,
		peerlist: peerlist || []
	});
});

router.post('/peers/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var formObj     = req.body;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await peers.newPeer(formObj);
	if (result.status === true) {
		res.redirect('/admin/peer/' + result.insertUUID);
	} else {
		alogger.writeAlog(3, "newPeer failed: " + result.errormessages.join(", "), "redbright");
		var peerlist = await peers.getAllPeers();
		res.render('admin/peers/index', {
			sufficientAccess: true,
			title: 'Peer Systems',
			activelink: 'networks',
			currentuser: currentuser,
			peerlist: peerlist || [],
			errormessages: result.errormessages
		});
	}
});

router.get('/peer/:uuid', async (req, res, next) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var uuid             = req.params.uuid.toLowerCase().trim();
	var peer             = await peers.getPeerByUUID(uuid);
	var connections, grouplist, networklist, networkAddressMap;
	if (peer) {
		connections = await peerConnections.getConnectionsByPeer(peer.id);
		// Attach subscription rows to each connection for the view
		if (connections && connections.length > 0) {
			for (var conn of connections) {
				conn.subscriptions = await peerAreaSubscriptions.getSubscriptionsByConnection(conn.id);
			}
		}
		grouplist   = await msgGroups.getAllGroupsWithAreas();
		networklist = await msgNetworks.getActiveNetworks();
		// Build networkId → [addresses] map for system address selects in connection modals
		networkAddressMap = {};
		if (networklist && networklist.length > 0) {
			for (var net of networklist) {
				networkAddressMap[net.id] = await systemAddresses.getAddressesByNetwork(net.id);
			}
		}
	}
	res.render('admin/peers/view', {
		sufficientAccess: sufficientAccess,
		title: 'Peer',
		activelink: 'networks',
		currentuser: currentuser,
		peer: peer || null,
		connections: connections || [],
		grouplist: grouplist || [],
		networklist: networklist || [],
		networkAddressMap: networkAddressMap || {}
	});
});

router.post('/peer/:uuid/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var formObj     = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	var result = await peers.updatePeer(uuid, formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "updatePeer failed for " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/peer/' + uuid);
});

router.post('/peer/:uuid/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var result      = await peers.removePeer(uuid);
	if (result.status !== true) {
		alogger.writeAlog(3, "removePeer failed for " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/peers');
});

// -------------------------------------------------------
// Peer Connections
// -------------------------------------------------------

router.post('/peer/:uuid/newconnection', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var peer        = await peers.getPeerByUUID(uuid);
	if (!peer) {
		alogger.writeAlog(3, "newconnection: peer not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/peers');
	}
	var formObj = req.body;
	formObj.peer_id = peer.id;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await peerConnections.newConnection(formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "newConnection failed for peer " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/peer/' + uuid);
});

router.post('/connection/:uuid/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var formObj     = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	var result = await peerConnections.updateConnection(uuid, formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "updateConnection failed for " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	// Redirect back to the owning peer's page
	var conn = await peerConnections.getConnectionByUUID(uuid);
	var peer = conn ? await peers.getPeerById(conn.peer_id) : null;
	res.redirect(peer ? '/admin/peer/' + peer.uuid : '/admin/peers');
});

router.post('/connection/:uuid/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var conn        = await peerConnections.getConnectionByUUID(uuid);
	var peer        = conn ? await peers.getPeerById(conn.peer_id) : null;
	var result      = await peerConnections.removeConnection(uuid);
	if (result.status !== true) {
		alogger.writeAlog(3, "removeConnection failed for " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect(peer ? '/admin/peer/' + peer.uuid : '/admin/peers');
});

router.post('/connection/:uuid/setallowed', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var conn        = await peerConnections.getConnectionByUUID(uuid);
	if (!conn) {
		alogger.writeAlog(3, "setallowed: connection not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/peers');
	}
	// allowedareas comes in as array of area id strings (or single string)
	var rawIds   = req.body.allowedareas || [];
	var areaIds  = (Array.isArray(rawIds) ? rawIds : [rawIds]).map(id => parseInt(id)).filter(Boolean);
	var formObj  = currentuser ? { updatedByUUID: currentuser.uuid, updatedByName: currentuser.name } : {};
	var result   = await peerAreaSubscriptions.setSubscriptions(conn.id, areaIds, 'allowed', formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "setallowed failed for conn " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	var peer = await peers.getPeerById(conn.peer_id);
	res.redirect(peer ? '/admin/peer/' + peer.uuid : '/admin/peers');
});

router.post('/connection/:uuid/setenabled', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var conn        = await peerConnections.getConnectionByUUID(uuid);
	if (!conn) {
		alogger.writeAlog(3, "setenabled: connection not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/peers');
	}
	var rawIds   = req.body.enabledareas || [];
	var areaIds  = (Array.isArray(rawIds) ? rawIds : [rawIds]).map(id => parseInt(id)).filter(Boolean);
	var formObj  = currentuser ? { updatedByUUID: currentuser.uuid, updatedByName: currentuser.name } : {};
	var result   = await peerAreaSubscriptions.setSubscriptions(conn.id, areaIds, 'enabled', formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "setenabled failed for conn " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	var peer = await peers.getPeerById(conn.peer_id);
	res.redirect(peer ? '/admin/peer/' + peer.uuid : '/admin/peers');
});

// Reset NNTP outbound msg_idx for a connection (all areas, or a specific area)
// so the next toss cycle rescans from the beginning.
router.post('/connection/:uuid/resetnntpidx', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var areaId      = req.body.area_id ? parseInt(req.body.area_id) : null;
	var conn        = await peerConnections.getConnectionByUUID(uuid);
	if (!conn) {
		alogger.writeAlog(3, "resetnntpidx: connection not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/peers');
	}
	var result = await peerAreaSubscriptions.resetOutboundIdx(uuid, areaId);
	if (result.status !== true) {
		alogger.writeAlog(3, "resetnntpidx failed for conn " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	var peer = await peers.getPeerById(conn.peer_id);
	res.redirect(peer ? '/admin/peer/' + peer.uuid : '/admin/peers');
});

// Reset outbound QWK msg_idx — same pattern as NNTP reset above.
router.post('/connection/:uuid/resetqwkidx', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var areaId      = req.body.area_id ? parseInt(req.body.area_id) : null;
	var conn        = await peerConnections.getConnectionByUUID(uuid);
	if (!conn) {
		alogger.writeAlog(3, "resetqwkidx: connection not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/peers');
	}
	var result = await peerAreaSubscriptions.resetOutboundIdx(uuid, areaId);
	if (result.status !== true) {
		alogger.writeAlog(3, "resetqwkidx failed for conn " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	var peer = await peers.getPeerById(conn.peer_id);
	res.redirect(peer ? '/admin/peer/' + peer.uuid : '/admin/peers');
});

// -------------------------------------------------------
// Network Areas
// -------------------------------------------------------

router.post('/network/:uuid/addarea', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var network     = await msgNetworks.getNetworkByUUID(uuid);
	if (!network) {
		alogger.writeAlog(3, "addarea: network not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/networks');
	}
	var formObj = req.body;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	// QWK networks require numeric areatags (conference numbers)
	if (network.network_type === 'QWK' && formObj.areatag) {
		if (!/^\d+$/.test(formObj.areatag.trim())) {
			alogger.writeAlog(3, "addarea: QWK areatag must be numeric, got '" + formObj.areatag + "'", "redbright");
			return res.redirect('/admin/network/' + uuid);
		}
	}
	var result = await networkAreas.addAreaToNetwork(
		network.id,
		parseInt(formObj.area_id),
		formObj.areatag,
		{ createdByUUID: formObj.createdByUUID, createdByName: formObj.createdByName }
	);
	if (result.status !== true) {
		alogger.writeAlog(3, "addAreaToNetwork failed for network " + uuid + ": " + result.errormessages.join(", "), "redbright");
	} else {
		// Sync all connections on this network — creates subscription rows for the
		// new area and optionally sets allowed/enabled based on checkboxes.
		await peerAreaSubscriptions.syncNetworkAreaToConnections(
			network.id,
			parseInt(formObj.area_id),
			{
				allowAll:  formObj.allow_all_peers === 'true',
				enableAll: formObj.enable_all_peers === 'true'
			}
		);
	}
	res.redirect('/admin/network/' + uuid);
});

router.post('/network/area/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var id          = parseInt(req.params.id);
	var formObj     = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	// Pre-validate: QWK networks require numeric areatags
	var naRow   = await networkAreas.getNetworkAreaById(id);
	if (!naRow) {
		alogger.writeAlog(3, "updateNetworkArea: network_area id " + id + " not found", "redbright");
		return res.redirect('/admin/networks');
	}
	var network = naRow ? await msgNetworks.getNetworkById(naRow.network_id) : null;
	if (network && network.network_type === 'QWK' && formObj.areatag) {
		if (!/^\d+$/.test(formObj.areatag.trim())) {
			alogger.writeAlog(3, "updateNetworkArea: QWK areatag must be numeric, got '" + formObj.areatag + "'", "redbright");
			return res.redirect(network ? '/admin/network/' + network.uuid : '/admin/networks');
		}
	}
	var result = await networkAreas.updateNetworkArea(naRow.network_id, naRow.area_id, formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "updateNetworkArea failed for id " + id + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect(network ? '/admin/network/' + network.uuid : '/admin/networks');
});

router.post('/network/area/:id/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var id          = parseInt(req.params.id);
	var naRow   = await networkAreas.getNetworkAreaById(id);
	var network = naRow ? await msgNetworks.getNetworkById(naRow.network_id) : null;
	if (!naRow) {
		alogger.writeAlog(3, "removeAreaFromNetwork: network_area id " + id + " not found", "redbright");
		return res.redirect('/admin/networks');
	}
	var result = await networkAreas.removeAreaFromNetwork(naRow.network_id, naRow.area_id);
	if (result.status !== true) {
		alogger.writeAlog(3, "removeAreaFromNetwork failed for id " + id + ": " + result.errormessages.join(", "), "redbright");
	} else {
		// Clean up subscription rows that referenced this area on this network
		await peerAreaSubscriptions.removeSubscriptionsForNetworkArea(naRow.network_id, naRow.area_id);
	}
	res.redirect(network ? '/admin/network/' + network.uuid : '/admin/networks');
});

// Kept: systemaddresses/new (still valid — system addresses are not peer-specific)
router.post('/systemaddresses/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var resultObj   = await systemAddresses.newAddress(req.body);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "newAddress failed: " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/networks');
});


router.get('/msgArea/:shortcode/thread/:uuid', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode   = req.params.shortcode.toLowerCase().trim();
	var uuid        = req.params.uuid.toLowerCase().trim();
	var thread      = await messages.getThreadByUUID(uuid, shortcode);
	var msgArea, msglist;
	if (thread) {
		msgArea = await msgAreas.getAreaByShortcode(shortcode);
		msglist = await messages.getMessagesForThread(shortcode, thread.id);
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

router.post('/msgArea/:shortcode/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode        = req.params.shortcode.toUpperCase().trim();
	var formObj          = req.body;
	var result           = await msgAreas.updateArea(shortcode, formObj);
	if (result.status === true) {
		res.redirect('/admin/msgGroup/' + (formObj.groupshortcode || ''));
	} else {
		alogger.writeAlog(3, "updateArea failed for " + shortcode + ": " + result.errormessages.join(", "), "redbright");
		var msgArea    = await msgAreas.getAreaByShortcode(shortcode);
		var threadlist = await messages.getRecentThreadsForArea(shortcode);
		res.render('admin/msgAreas/view', {
			sufficientAccess: sufficientAccess,
			title: msgArea ? msgArea.name : shortcode,
			activelink: 'msgGroups',
			currentuser: currentuser,
			msgArea: msgArea,
			threadlist: threadlist,
			errormessages: result.errormessages,
			DateTime: DateTime
		});
	}
});

router.post('/msgArea/:shortcode/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser    = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode      = req.params.shortcode.toUpperCase().trim();
	var deleteTables   = (req.body.delete_tables === 'true');
	var dbarea         = await msgAreas.getAreaByShortcode(shortcode);
	var groupshortcode = dbarea ? dbarea.group_shortcode : null;

	// Fetch network mappings before removal — removeArea bulk-deletes them
	// and we need areatag + network_type to clear NNTP HWMs first
	if (dbarea) {
		var areaMappings = await networkAreas.getNetworksByArea(dbarea.id);
		for (var mapping of (areaMappings || [])) {
			if (mapping.network_type === 'NNTP' && mapping.areatag) {
				await peerConnections.clearNntpHwmForArea(mapping.network_id, mapping.areatag);
			}
			// Clean up subscription rows for this area on each network
			await peerAreaSubscriptions.removeSubscriptionsForNetworkArea(mapping.network_id, dbarea.id);
		}
	}

	var result = await msgAreas.removeArea(shortcode, deleteTables);
	if (result.status === true) {
		res.redirect(groupshortcode ? '/admin/msgGroup/' + groupshortcode : '/admin/msgGroups');
	} else {
		alogger.writeAlog(3, "removeArea failed for " + shortcode + ": " + result.errormessages.join(", "), "redbright");
		res.redirect(groupshortcode ? '/admin/msgGroup/' + groupshortcode : '/admin/msgGroups');
	}
});

router.post('/msgArea/:shortcode/newthread', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var shortcode   = req.params.shortcode.toLowerCase().trim();
	var formObj     = req.body;
	if (currentuser) {
		formObj.from_user = formObj.from_user || currentuser.name;
	}
	var resultObj = await messages.startNewThread(formObj, shortcode);
	if (resultObj.status === true) {
		res.redirect('/admin/msgArea/' + shortcode + '/thread/' + resultObj.threaduuid);
	} else {
		res.redirect('/admin/msgArea/' + shortcode);
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
	var resultObj = await messages.replyToThread(formObj, shortcode, uuid);
	if (resultObj.status !== true) {
		alogger.writeAlog(3, "replyToThread failed for thread " + uuid + ": " + resultObj.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/msgArea/' + shortcode + '/thread/' + uuid);
});

router.get('/msgArea/:shortcode', async (req, res, next) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode        = req.params.shortcode.toLowerCase().trim();
	var msgArea          = await msgAreas.getAreaByShortcode(shortcode);
	var threadlist       = await messages.getRecentThreadsForArea(shortcode);
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

router.post('/deletemsg/:shortcode/:uuid', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var shortcode   = req.params.shortcode.trim();
	var uuid        = req.params.uuid.trim();
	if (!uuid || !shortcode) {
		res.redirect('/admin/');
		return;
	}
	var delsuccess = await messages.deleteMessageByUUID(uuid, shortcode);
	if (delsuccess) {
		res.redirect('/admin/msgArea/' + shortcode);
	} else {
		res.redirect('/admin');
	}
});

// -------------------------------------------------------
// Users
// -------------------------------------------------------

router.get('/users', async (req, res, next) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var userlist         = await userAccounts.getUserList();
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
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var uuid             = req.params.uuid.toLowerCase().trim();
	var user             = await userAccounts.getUserByUUID(uuid);
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

// -------------------------------------------------------
// Menu & Door Admin Routes
// -------------------------------------------------------
// Add these imports at the top of admin.js alongside existing imports:
//
//   import * as menus from '../models/menus.js';
//   import * as doors from '../models/doors.js';
//   import { getVariableList } from '../utils/configvars.js';
//
// Then paste these route blocks into admin.js before the final `export { router }`.


// -------------------------------------------------------
// Menus
// -------------------------------------------------------

router.get('/menus', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var menulist         = await menus.getAllMenus();
	var availCommands    = menus.getAvailableCommands();
	var menuTypes        = menus.getValidMenuTypes();
	var ansiColors       = menus.getAnsiColors();
	res.render('admin/menus/index', {
		sufficientAccess: sufficientAccess,
		title: 'Menus',
		activelink: 'menus',
		currentuser: currentuser,
		menulist: menulist,
		availCommands: availCommands,
		menuTypes: menuTypes,
		ansiColors: ansiColors
	});
});

router.get('/menus/:id', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var menuId           = parseInt(req.params.id);
	var menu             = await menus.getMenuById(menuId);
	if (!menu) {
		res.redirect('/admin/menus');
		return;
	}
	var entries        = await menus.getEntriesForMenu(menuId);
	var availCommands  = menus.getAvailableCommands();
	var menuTypes      = menus.getValidMenuTypes();
	var ansiColors     = menus.getAnsiColors();
	var allMenus       = await menus.getAllMenus();
	var allDoors       = await doors.getAllDoors();
	res.render('admin/menus/view', {
		sufficientAccess: sufficientAccess,
		title: menu.name,
		activelink: 'menus',
		currentuser: currentuser,
		menu: menu,
		entries: entries,
		availCommands: availCommands,
		menuTypes: menuTypes,
		ansiColors: ansiColors,
		allMenus: allMenus,
		allDoors: allDoors,
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions
	});
});

router.post('/menus/new', urlencodedParser, requireAdmin, async (req, res) => {
	var result = await menus.createMenu(req.body);
	if (result.status && result.menuId) {
		res.redirect('/admin/menus/' + result.menuId);
	} else {
		// Re-render with errors
		var currentuser      = await getCurrentUser(req);
		var sufficientAccess = checkAdminAccess(currentuser);
		var menulist         = await menus.getAllMenus();
		var availCommands    = menus.getAvailableCommands();
		var menuTypes        = menus.getValidMenuTypes();
		var ansiColors       = menus.getAnsiColors();
		res.render('admin/menus/index', {
			sufficientAccess: sufficientAccess,
			title: 'Menus',
			activelink: 'menus',
			currentuser: currentuser,
			menulist: menulist,
			availCommands: availCommands,
			menuTypes: menuTypes,
			ansiColors: ansiColors,
			errormessages: result.errormessages
		});
	}
});

router.post('/menus/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var menuId = parseInt(req.params.id);
	var result = await menus.updateMenu(menuId, req.body);
	if (result.status) {
		res.redirect('/admin/menus/' + menuId);
	} else {
		alogger.writeAlog(3, "updateMenu failed for id " + menuId + ": " + result.errormessages.join(", "), "redbright");
		res.redirect('/admin/menus/' + menuId);
	}
});

router.post('/menus/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var menuId = parseInt(req.params.id);
	await menus.deleteMenu(menuId);
	res.redirect('/admin/menus');
});

// --- Menu Entry routes ---

router.post('/menus/:id/entries/new', urlencodedParser, requireAdmin, async (req, res) => {
	var menuId = parseInt(req.params.id);
	var result = await menus.createEntry(menuId, req.body);
	if (!result.status) {
		alogger.writeAlog(3, "createEntry failed: " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/menus/' + menuId);
});

router.post('/menus/:id/entries/:entryId/update', urlencodedParser, requireAdmin, async (req, res) => {
	var menuId  = parseInt(req.params.id);
	var entryId = parseInt(req.params.entryId);
	var result  = await menus.updateEntry(entryId, req.body);
	if (!result.status) {
		alogger.writeAlog(3, "updateEntry failed for id " + entryId + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/menus/' + menuId);
});

router.post('/menus/:id/entries/:entryId/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var menuId  = parseInt(req.params.id);
	var entryId = parseInt(req.params.entryId);
	await menus.deleteEntry(entryId);
	res.redirect('/admin/menus/' + menuId);
});

router.post('/menus/:id/entries/reorder', urlencodedParser, requireAdmin, async (req, res) => {
	var menuId = parseInt(req.params.id);
	var orderedIds = [];
	try {
		orderedIds = JSON.parse(req.body.order || '[]');
	} catch (_) {}
	if (orderedIds.length > 0) {
		await menus.reorderEntries(menuId, orderedIds);
	}
	if (req.headers.accept && req.headers.accept.includes('application/json')) {
		res.json({ status: true });
	} else {
		res.redirect('/admin/menus/' + menuId);
	}
});


// -------------------------------------------------------
// Doors
// -------------------------------------------------------

router.get('/doors', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var doorlist         = await doors.getAllDoors();
	var launchTypes      = doors.getValidLaunchTypes();
	var dropfileTypes    = doors.getValidDropfileTypes();
	var configVars       = getVariableList();
	res.render('admin/doors/index', {
		sufficientAccess: sufficientAccess,
		title: 'Door Games',
		activelink: 'doors',
		currentuser: currentuser,
		doorlist: doorlist,
		launchTypes: launchTypes,
		dropfileTypes: dropfileTypes,
		configVars: configVars
	});
});

router.post('/doors/new', urlencodedParser, requireAdmin, async (req, res) => {
	var result = await doors.createDoor(req.body);
	if (result.status) {
		res.redirect('/admin/doors');
	} else {
		var currentuser      = await getCurrentUser(req);
		var sufficientAccess = checkAdminAccess(currentuser);
		var doorlist         = await doors.getAllDoors();
		var launchTypes      = doors.getValidLaunchTypes();
		var dropfileTypes    = doors.getValidDropfileTypes();
		var configVars       = getVariableList();
		res.render('admin/doors/index', {
			sufficientAccess: sufficientAccess,
			title: 'Door Games',
			activelink: 'doors',
			currentuser: currentuser,
			doorlist: doorlist,
			launchTypes: launchTypes,
			dropfileTypes: dropfileTypes,
			configVars: configVars,
			errormessages: result.errormessages
		});
	}
});

router.post('/doors/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var doorId = parseInt(req.params.id);
	var result = await doors.updateDoor(doorId, req.body);
	if (!result.status) {
		alogger.writeAlog(3, "updateDoor failed for id " + doorId + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/doors');
});

router.post('/doors/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var doorId = parseInt(req.params.id);
	await doors.deleteDoor(doorId);
	res.redirect('/admin/doors');
});

// -----------------------------------------------------------------------
// Config Settings
// -----------------------------------------------------------------------

router.get('/config', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);

	// Build per-key data for the template
	var allValues = appConfig.getAll();
	var categories = getCategories();
	var settings = [];
	for (var def of CONFIG_DEFINITIONS) {
		settings.push({
			key: def.key,
			defaultValue: def.defaultValue,
			type: def.type,
			category: def.category,
			description: def.description,
			restart: def.restart || false,
			value: allValues[def.key] !== undefined ? allValues[def.key] : def.defaultValue,
			source: appConfig.getSource(def.key)
		});
	}

	res.render('admin/config/index', {
		sufficientAccess: sufficientAccess,
		title: 'System Configuration',
		activelink: 'config',
		currentuser: currentuser,
		categories: categories,
		settings: settings
	});
});

router.post('/config', urlencodedParser, requireAdmin, async (req, res) => {
	var formData = req.body;
	var category = formData._category || '';
	var kvArray = [];

	for (var def of CONFIG_DEFINITIONS) {
		// Only process settings from the submitted category
		if (def.category !== category) continue;
		// Skip env-overridden keys — they can't be changed via UI
		if (appConfig.getSource(def.key) === 'env') continue;

		var formKey = 'cfg_' + def.key;
		var newValue;

		if (def.type === 'boolean') {
			// Checkbox: present in form = true, absent = false
			newValue = formData[formKey] ? 'true' : 'false';
		} else {
			newValue = formData[formKey] !== undefined ? formData[formKey] : def.defaultValue;
		}

		kvArray.push({ key: def.key, value: newValue });
	}

	if (kvArray.length > 0) {
		var ok = await configStore.setValues(kvArray);
		if (ok) {
			alogger.writeAlog(3, "[admin/config] Saved " + kvArray.length + " " + category + " settings", "cyan");
		} else {
			alogger.writeAlog(2, "[admin/config] Error saving " + category + " settings", "redbright");
		}
	}

	res.redirect('/admin/config');
});

router.post('/config/reset/:key', urlencodedParser, requireAdmin, async (req, res) => {
	var key = req.params.key;
	var def = getDefinition(key);
	if (!def) {
		alogger.writeAlog(3, "[admin/config] Reset requested for unknown key: " + key, "yellow");
		return res.redirect('/admin/config');
	}

	var ok = await configStore.setValue(key, def.defaultValue);
	if (ok) {
		alogger.writeAlog(3, "[admin/config] Reset " + key + " to default: " + def.defaultValue, "cyan");
	} else {
		alogger.writeAlog(2, "[admin/config] Error resetting " + key, "redbright");
	}

	res.redirect('/admin/config');
});

export { router };