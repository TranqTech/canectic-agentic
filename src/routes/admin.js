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
import * as announcements from '../models/announcements.js';
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
import * as fileGroups from '../models/fileGroups.js';
import * as fileAreas from '../models/fileAreas.js';
import * as fileEntries from '../models/fileEntries.js';
import * as fileNetworkAreas from '../models/fileNetworkAreas.js';
import * as filePeerSubscriptions from '../models/filePeerSubscriptions.js';
import { applyDescriptions } from '../utils/fileDescExtractor.js';
import * as postgres from '../middleware/db/postgres.js';
import * as ftnNodelist from '../models/ftnNodelist.js';
import * as flash from '../middleware/db/flash.js';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

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
	var fileAreaMappings, fileArealist;
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

		// File area mappings for this network
		fileAreaMappings = await fileNetworkAreas.getMappingsForNetwork(network.id);
		// Build grouped file area list for the 'Add File Area' modal (unmapped only)
		var allFileAreas     = await fileAreas.getActiveAreas();
		var fileMappedIds    = new Set((fileAreaMappings || []).map(fm => parseInt(fm.area_id)));
		var unmappedFiles    = (allFileAreas || []).filter(fa => !fileMappedIds.has(parseInt(fa.id)));
		var allFileGroups    = await fileGroups.getAllGroups();
		var fileGroupMap     = {};
		for (var fg of (allFileGroups || [])) {
			fileGroupMap[fg.shortcode] = fg.name || fg.shortcode;
		}
		var groupedFileAreas = {};
		for (var fa of unmappedFiles) {
			var fgkey = fa.group_shortcode || '_ungrouped';
			if (!groupedFileAreas[fgkey]) {
				groupedFileAreas[fgkey] = {
					groupName: fileGroupMap[fgkey] || fgkey,
					groupShortcode: fgkey,
					areas: []
				};
			}
			groupedFileAreas[fgkey].areas.push(fa);
		}
		fileArealist = Object.values(groupedFileAreas).sort((a, b) =>
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
		arealist: arealist || [],
		fileAreaMappings: fileAreaMappings || [],
		fileArealist: fileArealist || [],
		allFileAreasList: (network && network.network_type === 'FTN') ? (fileAreaMappings || []) : [],
		networkConfig: (network && network.config) ? (typeof network.config === 'string' ? JSON.parse(network.config) : network.config) : {}
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
	// Merge nodelist_area_shortcode into the network's config JSONB
	if (formObj.nodelist_area_shortcode !== undefined) {
		var dbnet = await msgNetworks.getNetworkByUUID(uuid);
		var existingConfig = (dbnet && dbnet.config) ? (typeof dbnet.config === 'string' ? JSON.parse(dbnet.config) : dbnet.config) : {};
		existingConfig.nodelist_area_shortcode = formObj.nodelist_area_shortcode || null;
		formObj.config = existingConfig;
		delete formObj.nodelist_area_shortcode;
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
	var connections, grouplist, networklist, networkAddressMap, fileGrouplist;
	if (peer) {
		connections = await peerConnections.getConnectionsByPeer(peer.id);
		// Attach subscription rows to each connection for the view
		if (connections && connections.length > 0) {
			for (var conn of connections) {
				conn.subscriptions     = await peerAreaSubscriptions.getSubscriptionsByConnection(conn.id);
				conn.fileSubscriptions = await filePeerSubscriptions.getSubscriptionsByConnection(conn.id);
			}
		}
		grouplist      = await msgGroups.getAllGroupsWithAreas();
		fileGrouplist  = await fileGroups.getAllGroupsWithAreas();
		networklist    = await msgNetworks.getActiveNetworks();
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
		fileGrouplist: fileGrouplist || [],
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

// -------------------------------------------------------
// File Network Areas
// -------------------------------------------------------

router.post('/network/:uuid/addfilearea', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var network     = await msgNetworks.getNetworkByUUID(uuid);
	if (!network) {
		alogger.writeAlog(3, "addfilearea: network not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/networks');
	}
	var formObj = req.body;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await fileNetworkAreas.addMapping(
		network.id,
		parseInt(formObj.file_area_id),
		formObj.areatag,
		{ createdByUUID: formObj.createdByUUID, createdByName: formObj.createdByName }
	);
	if (result.status !== true) {
		alogger.writeAlog(3, "addfilearea failed for network " + uuid + ": " + result.errormessages.join(", "), "redbright");
	} else {
		// Sync all connections on this network — creates subscription rows for the
		// new file area and optionally sets allowed/enabled based on checkboxes.
		await filePeerSubscriptions.syncFileAreaToConnections(
			network.id,
			parseInt(formObj.file_area_id),
			{
				allowAll:  formObj.allow_all_peers === 'true',
				enableAll: formObj.enable_all_peers === 'true'
			}
		);
	}
	res.redirect('/admin/network/' + uuid);
});

router.post('/network/filearea/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var id          = parseInt(req.params.id);
	var formObj     = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	var fnaRow = await fileNetworkAreas.getMappingById(id);
	if (!fnaRow) {
		alogger.writeAlog(3, "updateFileNetworkArea: file_network_area id " + id + " not found", "redbright");
		return res.redirect('/admin/networks');
	}
	var network = await msgNetworks.getNetworkById(fnaRow.network_id);
	var updateObj = {};
	if (formObj.areatag !== undefined) updateObj.areatag = formObj.areatag.toUpperCase().trim();
	if (formObj.active  !== undefined) updateObj.active  = (formObj.active === 'true' || formObj.active === true);
	if (formObj.updatedByUUID) updateObj.updated_by_uuid = formObj.updatedByUUID;
	if (formObj.updatedByName) updateObj.updated_by_name = formObj.updatedByName;
	var result = await fileNetworkAreas.updateMapping(id, updateObj);
	if (!result) {
		alogger.writeAlog(3, "updateFileNetworkArea failed for id " + id, "redbright");
	}
	res.redirect(network ? '/admin/network/' + network.uuid : '/admin/networks');
});

router.post('/network/filearea/:id/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var id          = parseInt(req.params.id);
	var fnaRow = await fileNetworkAreas.getMappingById(id);
	if (!fnaRow) {
		alogger.writeAlog(3, "removeFileNetworkArea: file_network_area id " + id + " not found", "redbright");
		return res.redirect('/admin/networks');
	}
	var network = await msgNetworks.getNetworkById(fnaRow.network_id);
	var result  = await fileNetworkAreas.removeMapping(fnaRow.network_id, fnaRow.area_id);
	if (!result) {
		alogger.writeAlog(3, "removeFileNetworkArea failed for id " + id, "redbright");
	} else {
		// Clean up subscription rows that referenced this file area on this network
		await filePeerSubscriptions.removeSubscriptionsForFileArea(fnaRow.network_id, fnaRow.area_id);
	}
	res.redirect(network ? '/admin/network/' + network.uuid : '/admin/networks');
});

// -------------------------------------------------------
// File Peer Subscriptions
// -------------------------------------------------------

router.post('/connection/:uuid/setfileallowed', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var conn        = await peerConnections.getConnectionByUUID(uuid);
	if (!conn) {
		alogger.writeAlog(3, "setfileallowed: connection not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/peers');
	}
	var rawIds   = req.body.allowedfileareas || [];
	var areaIds  = (Array.isArray(rawIds) ? rawIds : [rawIds]).map(id => parseInt(id)).filter(Boolean);
	var formObj  = currentuser ? { updatedByUUID: currentuser.uuid, updatedByName: currentuser.name } : {};
	var result   = await filePeerSubscriptions.setSubscriptions(conn.id, areaIds, 'allowed', formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "setfileallowed failed for conn " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	var peer = await peers.getPeerById(conn.peer_id);
	res.redirect(peer ? '/admin/peer/' + peer.uuid : '/admin/peers');
});

router.post('/connection/:uuid/setfileenabled', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var uuid        = req.params.uuid.toLowerCase().trim();
	var conn        = await peerConnections.getConnectionByUUID(uuid);
	if (!conn) {
		alogger.writeAlog(3, "setfileenabled: connection not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/peers');
	}
	var rawIds   = req.body.enabledfileareas || [];
	var areaIds  = (Array.isArray(rawIds) ? rawIds : [rawIds]).map(id => parseInt(id)).filter(Boolean);
	var formObj  = currentuser ? { updatedByUUID: currentuser.uuid, updatedByName: currentuser.name } : {};
	var result   = await filePeerSubscriptions.setSubscriptions(conn.id, areaIds, 'enabled', formObj);
	if (result.status !== true) {
		alogger.writeAlog(3, "setfileenabled failed for conn " + uuid + ": " + result.errormessages.join(", "), "redbright");
	}
	var peer = await peers.getPeerById(conn.peer_id);
	res.redirect(peer ? '/admin/peer/' + peer.uuid : '/admin/peers');
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
// File Groups
// -------------------------------------------------------

router.get('/fileGroups', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var grouplist = await fileGroups.getAllGroups();
	res.render('admin/fileGroups', {
		sufficientAccess: sufficientAccess,
		title: 'File Groups',
		activelink: 'fileGroups',
		currentuser: currentuser,
		grouplist: grouplist,
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions
	});
});

router.post('/fileGroup/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var formObj     = req.body;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await fileGroups.newGroup(formObj);
	if (result.status === true) {
		res.redirect(`/admin/fileGroup/${result.shortcode}`);
	} else {
		res.render('admin/fileGroups', {
			sufficientAccess: sufficientAccess,
			title: 'File Groups',
			activelink: 'fileGroups',
			currentuser: currentuser,
			errors: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions
		});
	}
});

// Recalculate area counts for all file groups
router.post('/fileGroups/recalculateAreaCounts', urlencodedParser, requireAdmin, async (req, res) => {
	await fileGroups.recalculateAreaCounts();
	res.redirect('/admin/fileGroups');
});

router.post('/fileGroup/:shortcode/newArea', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode   = req.params.shortcode.toUpperCase().trim();
	var formObj     = req.body;
	formObj.groupshortcode = shortcode;
	if (currentuser) {
		formObj.createdByName = currentuser.name;
		formObj.createdByUUID = currentuser.uuid;
	}
	var result = await fileAreas.newArea(formObj);
	if (result.status === true) {
		res.redirect(`/admin/fileGroup/${shortcode}`);
	} else {
		res.render('admin/fileGroups', {
			sufficientAccess: sufficientAccess,
			title: 'File Groups',
			activelink: 'fileGroups',
			currentuser: currentuser,
			errors: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions
		});
	}
});

router.post('/fileGroup/:shortcode/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode        = req.params.shortcode.toUpperCase().trim();
	var formObj          = req.body;
	if (currentuser) {
		formObj.updatedByName = currentuser.name;
		formObj.updatedByUUID = currentuser.uuid;
	}
	var result = await fileGroups.updateGroup(shortcode, formObj);
	if (result.status === true) {
		res.redirect(`/admin/fileGroup/${shortcode}`);
	} else {
		alogger.writeAlog(3, "updateFileGroup failed for " + shortcode + ": " + result.errormessages.join(", "), "redbright");
		var fileGroup = await fileGroups.getGroupByShortcode(shortcode);
		var arealist  = await fileAreas.getAreasInGroup(shortcode);
		res.render('admin/fileGroups/view', {
			sufficientAccess: sufficientAccess,
			title: fileGroup ? fileGroup.name : shortcode,
			activelink: 'fileGroups',
			currentuser: currentuser,
			fileGroup: fileGroup,
			arealist: arealist,
			errormessages: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions,
			DateTime: DateTime
		});
	}
});

router.post('/fileGroup/:shortcode/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser  = await getCurrentUser(req);
	var deleteFiles  = (req.body.delete_files === 'true');
	var shortcode    = req.params.shortcode.toUpperCase().trim();
	var result       = await fileGroups.removeGroup(shortcode, deleteFiles);
	if (result.status === true) {
		res.redirect('/admin/fileGroups');
	} else {
		alogger.writeAlog(3, "removeFileGroup failed for " + shortcode + ": " + result.errormessages.join(", "), "redbright");
		var fileGroup = await fileGroups.getGroupByShortcode(shortcode);
		var arealist  = await fileAreas.getAreasInGroup(shortcode);
		res.render('admin/fileGroups/view', {
			sufficientAccess: true,
			title: fileGroup ? fileGroup.name : shortcode,
			activelink: 'fileGroups',
			currentuser: currentuser,
			fileGroup: fileGroup,
			arealist: arealist,
			errormessages: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions,
			DateTime: DateTime
		});
	}
});

// JSON endpoint — returns group security and flag defaults for new area modal auto-populate
router.get('/fileGroup/:shortcode/defaults', requireAdmin, async (req, res) => {
	var shortcode = req.params.shortcode.toUpperCase().trim();
	var group = await fileGroups.getGroupByShortcode(shortcode);
	if (!group) {
		return res.status(404).json({ error: 'Group not found' });
	}
	res.json({
		browse_security: group.browse_security || 0,
		browse_perm_flags: group.browse_perm_flags || [],
		browse_rest_flags: group.browse_rest_flags || [],
		read_security: group.read_security || 0,
		post_security: group.post_security || 0,
		read_perm_flags: group.read_perm_flags || [],
		read_rest_flags: group.read_rest_flags || [],
		post_perm_flags: group.post_perm_flags || [],
		post_rest_flags: group.post_rest_flags || []
	});
});

router.get('/fileGroup/:shortcode', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode   = req.params.shortcode.toUpperCase().trim();
	var fileGroup   = await fileGroups.getGroupByShortcode(shortcode);
	var arealist    = await fileAreas.getAreasInGroup(shortcode);
	var title       = fileGroup ? fileGroup.name : "Unknown File Group";
	res.render('admin/fileGroups/view', {
		sufficientAccess: sufficientAccess,
		title: title,
		activelink: 'fileGroups',
		currentuser: currentuser,
		fileGroup: fileGroup,
		arealist: arealist,
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions,
		DateTime: DateTime
	});
});

// -------------------------------------------------------
// File Areas
// -------------------------------------------------------

router.get('/fileAreas', async (req, res, next) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var grouplist = await fileGroups.getAllGroups();
	var allAreas  = await fileAreas.getAllAreas();

	res.render('admin/fileAreas/index', {
		sufficientAccess: sufficientAccess,
		title: 'File Areas',
		activelink: 'fileGroups',
		currentuser: currentuser,
		grouplist: grouplist,
		allAreas: allAreas || [],
		availablePermissions: availablePermissions,
		availableRestrictions: availableRestrictions,
		DateTime: DateTime
	});
});

router.post('/fileArea/:shortcode/update', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode        = req.params.shortcode.toUpperCase().trim();
	var formObj          = req.body;
	var result           = await fileAreas.updateArea(shortcode, formObj);
	if (result.status === true) {
		res.redirect('/admin/fileGroup/' + (formObj.groupshortcode || ''));
	} else {
		alogger.writeAlog(3, "updateFileArea failed for " + shortcode + ": " + result.errormessages.join(", "), "redbright");
		var grouplist = await fileGroups.getAllGroups();
		var allAreas  = await fileAreas.getAllAreas();
		res.render('admin/fileAreas/index', {
			sufficientAccess: sufficientAccess,
			title: 'File Areas',
			activelink: 'fileGroups',
			currentuser: currentuser,
			grouplist: grouplist,
			allAreas: allAreas || [],
			errormessages: result.errormessages,
			availablePermissions: availablePermissions,
			availableRestrictions: availableRestrictions,
			DateTime: DateTime
		});
	}
});

router.post('/fileArea/:shortcode/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser    = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode      = req.params.shortcode.toUpperCase().trim();
	var deleteFiles    = (req.body.delete_files === 'true');
	var dbarea         = await fileAreas.getAreaByShortcode(shortcode);
	var groupshortcode = dbarea ? dbarea.group_shortcode : null;

	var result = await fileAreas.removeArea(shortcode, deleteFiles);
	if (result.status === true) {
		res.redirect(groupshortcode ? '/admin/fileGroup/' + groupshortcode : '/admin/fileGroups');
	} else {
		alogger.writeAlog(3, "removeFileArea failed for " + shortcode + ": " + result.errormessages.join(", "), "redbright");
		res.redirect(groupshortcode ? '/admin/fileGroup/' + groupshortcode : '/admin/fileGroups');
	}
});

// -------------------------------------------------------
// File Area Detail / Browser
// -------------------------------------------------------

router.get('/fileArea/:shortcode', async (req, res, next) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var shortcode        = req.params.shortcode.toUpperCase().trim();
	var fileArea         = await fileAreas.getAreaByShortcode(shortcode);
	var group            = fileArea ? await fileGroups.getGroupByShortcode(fileArea.group_shortcode) : null;
	var resolvedPath     = fileArea ? fileAreas.resolveAreaPath(group, fileArea) : '';
	var allAreasList     = await fileAreas.getAllAreas();

	// Get ALL entries for this area (including inactive) — admin view
	var entries = [];
	if (fileArea) {
		entries = await postgres.query(
			"SELECT * FROM file_entries WHERE area_id = $1 ORDER BY upload_date DESC",
			[fileArea.id]
		);
	}

	// Check for scan results in query string (set by redirect from scan route)
	var scanResults = null;
	if (req.query.scanFound !== undefined) {
		scanResults = {
			found:   parseInt(req.query.scanFound) || 0,
			added:   parseInt(req.query.scanAdded) || 0,
			skipped: parseInt(req.query.scanSkipped) || 0,
			errors:  parseInt(req.query.scanErrors) || 0
		};
	}

	res.render('admin/fileAreas/view', {
		sufficientAccess: sufficientAccess,
		title: fileArea ? fileArea.name : 'Unknown File Area',
		activelink: 'fileAreas',
		currentuser: currentuser,
		fileArea: fileArea,
		fileEntries: entries || [],
		resolvedPath: resolvedPath,
		allAreas: allAreasList || [],
		scanResults: scanResults,
		DateTime: DateTime
	});
});

router.post('/fileEntry/:uuid/update', urlencodedParser, requireAdmin, async (req, res) => {
	var uuid  = req.params.uuid;
	var entry = await fileEntries.getEntryByUUID(uuid);
	if (!entry) {
		alogger.writeAlog(3, "fileEntry update: entry not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/fileGroups');
	}

	var updateObj = {
		short_desc: req.body.short_desc || null,
		long_desc:  req.body.long_desc || null,
		active:     (req.body.active === 'true' || req.body.active === true),
		flagged:    (req.body.flagged === 'true' || req.body.flagged === true)
	};

	var ok = await fileEntries.updateEntry(entry.id, updateObj);
	if (!ok) {
		alogger.writeAlog(3, "fileEntry update failed for uuid " + uuid, "redbright");
	}
	res.redirect('/admin/fileArea/' + (entry.area_shortcode || ''));
});

router.post('/fileEntry/:uuid/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var uuid  = req.params.uuid;
	var entry = await fileEntries.getEntryByUUID(uuid);
	if (!entry) {
		alogger.writeAlog(3, "fileEntry delete: entry not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/fileGroups');
	}

	var areaShortcode  = entry.area_shortcode;
	var deleteFromDisk = (req.body.delete_from_disk === 'true');

	// Optionally remove file from disk
	if (deleteFromDisk && entry.disk_path) {
		try {
			var area  = await fileAreas.getAreaByShortcode(areaShortcode);
			var group = area ? await fileGroups.getGroupByShortcode(area.group_shortcode) : null;
			var areaPath = fileAreas.resolveAreaPath(group, area);
			var filePath = path.join(areaPath, entry.disk_path);
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
				alogger.writeAlog(5, "fileEntry delete: removed file from disk: " + filePath, "yellow");
			}
		} catch (e) {
			alogger.writeAlog(3, "fileEntry delete: disk removal failed: " + e.message, "redbright");
		}
	}

	var ok = await fileEntries.deleteEntry(uuid);
	if (!ok) {
		alogger.writeAlog(3, "fileEntry delete failed for uuid " + uuid, "redbright");
	}

	// Update area stats
	if (areaShortcode) {
		await fileAreas.updateStatsForArea(areaShortcode);
	}

	res.redirect('/admin/fileArea/' + (areaShortcode || ''));
});

router.post('/fileEntry/:uuid/move', urlencodedParser, requireAdmin, async (req, res) => {
	var uuid  = req.params.uuid;
	var entry = await fileEntries.getEntryByUUID(uuid);
	if (!entry) {
		alogger.writeAlog(3, "fileEntry move: entry not found for uuid " + uuid, "redbright");
		return res.redirect('/admin/fileGroups');
	}

	var sourceAreaShortcode = entry.area_shortcode;
	var targetShortcode     = (req.body.target_area_shortcode || '').toUpperCase().trim();
	var moveOnDisk          = (req.body.move_on_disk === 'true');

	var targetArea = await fileAreas.getAreaByShortcode(targetShortcode);
	if (!targetArea) {
		alogger.writeAlog(3, "fileEntry move: target area not found: " + targetShortcode, "redbright");
		return res.redirect('/admin/fileArea/' + (sourceAreaShortcode || ''));
	}

	// Optionally move file on disk
	if (moveOnDisk && entry.disk_path) {
		try {
			var sourceArea  = await fileAreas.getAreaByShortcode(sourceAreaShortcode);
			var sourceGroup = sourceArea ? await fileGroups.getGroupByShortcode(sourceArea.group_shortcode) : null;
			var targetGroup = await fileGroups.getGroupByShortcode(targetArea.group_shortcode);
			var sourcePath  = path.join(fileAreas.resolveAreaPath(sourceGroup, sourceArea), entry.disk_path);
			var targetDir   = fileAreas.resolveAreaPath(targetGroup, targetArea);
			var targetPath  = path.join(targetDir, entry.disk_path);

			if (fs.existsSync(sourcePath)) {
				// Ensure target directory exists
				if (!fs.existsSync(targetDir)) {
					fs.mkdirSync(targetDir, { recursive: true });
				}
				fs.renameSync(sourcePath, targetPath);
				alogger.writeAlog(5, "fileEntry move: moved file on disk from " + sourcePath + " to " + targetPath, "greenbright");
			}
		} catch (e) {
			alogger.writeAlog(3, "fileEntry move: disk move failed: " + e.message, "redbright");
		}
	}

	// Update the database entry
	var ok = await fileEntries.updateEntry(entry.id, {
		area_id: targetArea.id,
		area_shortcode: targetShortcode
	});

	if (!ok) {
		alogger.writeAlog(3, "fileEntry move: DB update failed for uuid " + uuid, "redbright");
	}

	// Update stats for both areas
	if (sourceAreaShortcode) {
		await fileAreas.updateStatsForArea(sourceAreaShortcode);
	}
	await fileAreas.updateStatsForArea(targetShortcode);

	res.redirect('/admin/fileArea/' + targetShortcode);
});

router.post('/fileArea/:shortcode/scan', urlencodedParser, requireAdmin, async (req, res) => {
	var shortcode = req.params.shortcode.toUpperCase().trim();
	var area      = await fileAreas.getAreaByShortcode(shortcode);
	if (!area) {
		alogger.writeAlog(3, "fileArea scan: area not found: " + shortcode, "redbright");
		return res.redirect('/admin/fileGroups');
	}

	var group       = await fileGroups.getGroupByShortcode(area.group_shortcode);
	var areaPath    = fileAreas.resolveAreaPath(group, area);
	var found       = 0;
	var added       = 0;
	var skipped     = 0;
	var errors      = 0;

	try {
		if (fs.existsSync(areaPath) && fs.statSync(areaPath).isDirectory()) {
			var dirEntries = fs.readdirSync(areaPath);
			for (var i = 0; i < dirEntries.length; i++) {
				var fname    = dirEntries[i];
				var fullPath = path.join(areaPath, fname);
				var stat;
				try {
					stat = fs.statSync(fullPath);
				} catch (e) {
					errors++;
					continue;
				}
				if (!stat.isFile()) continue;

				found++;

				// Check if already tracked
				var existing = await postgres.queryOne(
					"SELECT id FROM file_entries WHERE area_id = $1 AND filename = $2",
					[area.id, fname]
				);

				if (existing) {
					skipped++;
					continue;
				}

				// Build entry and extract FILE_ID.DIZ if archive
				var entryObj = {
					area_id: area.id,
					area_shortcode: shortcode,
					filename: fname,
					disk_path: fname,
					file_size: stat.size,
					file_date: stat.mtime,
					source_type: 'local',
					source_data: { import_method: 'directory_scan' }
				};
				applyDescriptions(entryObj, fullPath);

				var entryResult = await fileEntries.addFileEntry(entryObj);

				if (entryResult.status) {
					added++;
				} else {
					errors++;
					alogger.writeAlog(3, "fileArea scan: failed to add entry for " + fname + ": " + entryResult.errormessages.join(", "), "yellow");
				}
			}
		} else {
			alogger.writeAlog(3, "fileArea scan: directory does not exist: " + areaPath, "yellow");
		}
	} catch (e) {
		alogger.writeAlog(3, "fileArea scan: error scanning " + areaPath + ": " + e.message, "redbright");
		errors++;
	}

	// Update area stats
	await fileAreas.updateStatsForArea(shortcode);

	alogger.writeAlog(5, "fileArea scan complete for " + shortcode + ": found=" + found + " added=" + added + " skipped=" + skipped + " errors=" + errors, "cyan");

	res.redirect('/admin/fileArea/' + shortcode + '?scanFound=' + found + '&scanAdded=' + added + '&scanSkipped=' + skipped + '&scanErrors=' + errors);
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

	res.locals.flash = await flash.get(req);
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
			await flash.setOne(req, 'success', 'Saved ' + kvArray.length + ' ' + category + ' setting(s).');
		} else {
			alogger.writeAlog(2, "[admin/config] Error saving " + category + " settings", "redbright");
			await flash.setOne(req, 'danger', 'Error saving ' + category + ' settings.');
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
		await flash.setOne(req, 'success', 'Reset ' + key + ' to default (' + def.defaultValue + ').');
	} else {
		alogger.writeAlog(2, "[admin/config] Error resetting " + key, "redbright");
		await flash.setOne(req, 'danger', 'Error resetting ' + key + '.');
	}

	res.redirect('/admin/config');
});

// ---------------------------------------------------------------------------
// Nodelist Management
// ---------------------------------------------------------------------------

var nodelistUpload = multer({
	dest: path.join(os.tmpdir(), 'canectic-nodelist-uploads'),
	limits: { fileSize: 50 * 1024 * 1024 }  // 50 MB max
});

// GET /admin/nodelists — Main nodelist management page
router.get('/nodelists', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var ftnNetworks      = await msgNetworks.getNetworksByType('FTN');
	var importInfoMap    = {};
	var statsMap         = {};
	for (var i = 0; i < ftnNetworks.length; i++) {
		var net = ftnNetworks[i];
		importInfoMap[net.id] = await ftnNodelist.getImportInfo(net.id);
		statsMap[net.id]      = await ftnNodelist.getNetworkStats(net.id);
	}
	res.locals.flash = await flash.get(req);
	res.render('admin/nodelists/index', {
		sufficientAccess: sufficientAccess,
		title: 'Nodelist Management',
		activelink: 'networks',
		currentuser: currentuser,
		ftnNetworks: ftnNetworks,
		importInfoMap: importInfoMap,
		statsMap: statsMap
	});
});

// POST /admin/nodelists/import — Upload and enqueue nodelist import
router.post('/nodelists/import', nodelistUpload.single('nodelist'), requireAdmin, async (req, res) => {
	var networkId = parseInt(req.body.network_id);
	if (!networkId || !req.file) {
		await flash.setOne(req, 'danger', 'Network and nodelist file are required.');
		return res.redirect('/admin/nodelists');
	}

	// Verify the network exists and is FTN
	var network = await msgNetworks.getNetworkById(networkId);
	if (!network || network.network_type !== 'FTN') {
		await flash.setOne(req, 'danger', 'Invalid FTN network selected.');
		// Clean up uploaded file
		if (req.file && req.file.path) {
			try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
		}
		return res.redirect('/admin/nodelists');
	}

	var filePath = req.file.path;
	alogger.writeAlog(3, '[admin/nodelists] Import queued for network ' + network.name + ' (id=' + networkId + '), file: ' + req.file.originalname, 'cyan');

	try {
		await jobs.enqueueNodelistImport({ filePath: filePath, networkId: networkId, originalName: req.file.originalname });
		await flash.setOne(req, 'success', 'Nodelist import queued for ' + network.name + '. The file will be processed by the worker.');
	} catch (err) {
		alogger.writeAlog(2, '[admin/nodelists] Failed to enqueue import: ' + err.message, 'redbright');
		await flash.setOne(req, 'danger', 'Failed to queue import: ' + err.message);
		// Clean up uploaded file on failure
		try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
	}

	res.redirect('/admin/nodelists');
});

// POST /admin/nodelists/clear/:networkId — Clear all nodelist data for a network
router.post('/nodelists/clear/:networkId', urlencodedParser, requireAdmin, async (req, res) => {
	var networkId = parseInt(req.params.networkId);
	if (!networkId) {
		await flash.setOne(req, 'danger', 'Invalid network ID.');
		return res.redirect('/admin/nodelists');
	}

	var network = await msgNetworks.getNetworkById(networkId);
	if (!network) {
		await flash.setOne(req, 'danger', 'Network not found.');
		return res.redirect('/admin/nodelists');
	}

	try {
		await ftnNodelist.clearNetwork(networkId);
		alogger.writeAlog(3, '[admin/nodelists] Cleared all nodelist data for ' + network.name + ' (id=' + networkId + ')', 'yellow');
		await flash.setOne(req, 'success', 'All nodelist data cleared for ' + network.name + '.');
	} catch (err) {
		alogger.writeAlog(2, '[admin/nodelists] Clear failed for network ' + networkId + ': ' + err.message, 'redbright');
		await flash.setOne(req, 'danger', 'Failed to clear nodelist data: ' + err.message);
	}

	res.redirect('/admin/nodelists');
});

// GET /admin/nodelist/:networkId — Browse/search nodelist for a specific network
router.get('/nodelist/:networkId', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networkId        = parseInt(req.params.networkId);
	var network          = networkId ? await msgNetworks.getNetworkById(networkId) : null;

	if (!network || network.network_type !== 'FTN') {
		return res.render('admin/nodelists/view', {
			sufficientAccess: sufficientAccess,
			title: 'Nodelist Browser',
			activelink: 'networks',
			currentuser: currentuser,
			network: null,
			importInfo: null,
			stats: null,
			nodes: []
		});
	}

	var importInfo = await ftnNodelist.getImportInfo(networkId);
	var stats      = await ftnNodelist.getNetworkStats(networkId);
	// Default: load active nodes (limited to first 500 for performance)
	var nodes = await ftnNodelist.searchNodes(networkId, '', 50000);

	// Count connection types and flags for glossary
	var flagCounts = {};
	try {
		var allFlags = await postgres.query(
			"SELECT flags, connection_types FROM ftn_nodelist WHERE network_id = $1 AND active = true",
			[networkId]
		);
		for (var fr of (allFlags || [])) {
			// Count raw flags
			if (fr.flags) {
				var parts = fr.flags.split(',');
				for (var fp of parts) {
					var fk = fp.trim().split(':')[0].toUpperCase();
					if (fk) flagCounts[fk] = (flagCounts[fk] || 0) + 1;
				}
			}
			// Count connection types
			var ct = fr.connection_types || [];
			if (typeof ct === 'string') { try { ct = JSON.parse(ct); } catch(_) { ct = []; } }
			for (var c of ct) {
				var ck = '_ct_' + c;
				flagCounts[ck] = (flagCounts[ck] || 0) + 1;
			}
		}
		// Count keywords
		var kwRows = await postgres.query(
			"SELECT keyword, COUNT(*) as cnt FROM ftn_nodelist WHERE network_id = $1 AND active = true GROUP BY keyword",
			[networkId]
		);
		for (var kw of (kwRows || [])) {
			flagCounts['_kw_' + (kw.keyword || 'node').toLowerCase()] = parseInt(kw.cnt);
		}
	} catch (_) {}

	res.render('admin/nodelists/view', {
		sufficientAccess: sufficientAccess,
		title: 'Nodelist Browser',
		activelink: 'networks',
		currentuser: currentuser,
		network: network,
		importInfo: importInfo,
		stats: stats,
		nodes: nodes || [],
		flagCounts: flagCounts
	});
});

// GET /admin/nodelist/:networkId/search.json — JSON search/filter endpoint
router.get('/nodelist/:networkId/search.json', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	if (!sufficientAccess) {
		return res.status(403).json({ error: 'Unauthorized' });
	}

	var networkId = parseInt(req.params.networkId);
	if (!networkId) {
		return res.status(400).json({ error: 'Invalid network ID' });
	}

	var searchTerm = req.query.q || '';
	var filter     = req.query.filter || 'active';
	var limit      = Math.min(parseInt(req.query.limit) || 50000, 50000);
	var nodes      = [];

	try {
		if (searchTerm) {
			nodes = await ftnNodelist.searchNodes(networkId, searchTerm, limit);
		} else if (filter === 'added') {
			nodes = await ftnNodelist.getRecentlyAdded(networkId, 7);
		} else if (filter === 'removed') {
			nodes = await ftnNodelist.getRecentlyRemoved(networkId, 7);
		} else if (filter === 'all') {
			// All nodes (active + inactive), limited
			nodes = await postgres.query(
				'SELECT * FROM ftn_nodelist WHERE network_id = $1 ORDER BY zone, net, node LIMIT $2',
				[networkId, limit]
			);
			nodes = nodes || [];
		} else {
			// Default: active nodes
			nodes = await ftnNodelist.searchNodes(networkId, '', limit);
		}
	} catch (err) {
		alogger.writeAlog(2, '[admin/nodelists] Search error: ' + err.message, 'redbright');
		return res.status(500).json({ error: 'Search failed' });
	}

	res.json({ nodes: nodes });
});

// -------------------------------------------------------
// Announcements
// -------------------------------------------------------

router.get('/announcements', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var announcementList = await announcements.getAllAnnouncements();
	res.render('admin/announcements/index', {
		sufficientAccess: sufficientAccess,
		title: 'Announcements',
		activelink: 'announcements',
		currentuser: currentuser,
		announcements: announcementList
	});
});

router.post('/announcements/new', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	req.body.author_id = currentuser ? currentuser.id : null;
	req.body.author_name = currentuser ? currentuser.username : 'System';
	var result = await announcements.createAnnouncement(req.body);
	if (result.status) {
		res.redirect('/admin/announcements');
	} else {
		var sufficientAccess = checkAdminAccess(currentuser);
		var announcementList = await announcements.getAllAnnouncements();
		res.render('admin/announcements/index', {
			sufficientAccess: sufficientAccess,
			title: 'Announcements',
			activelink: 'announcements',
			currentuser: currentuser,
			announcements: announcementList,
			errormessages: result.errormessages
		});
	}
});

router.post('/announcements/update/:id', urlencodedParser, requireAdmin, async (req, res) => {
	var announcementId = parseInt(req.params.id);
	var result = await announcements.updateAnnouncement(announcementId, req.body);
	if (!result.status) {
		alogger.writeAlog(3, "updateAnnouncement failed for id " + announcementId + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/announcements');
});

router.post('/announcements/delete/:id', urlencodedParser, requireAdmin, async (req, res) => {
	var announcementId = parseInt(req.params.id);
	await announcements.deleteAnnouncement(announcementId);
	res.redirect('/admin/announcements');
});

export { router };