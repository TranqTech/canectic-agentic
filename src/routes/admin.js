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
// netmail import removed -- legacy admin netmail routes replaced by PM system
import * as messages from '../models/messages.js';
import * as peers from '../models/peers.js';
import * as doors from '../models/doors.js';
import * as doorCollections from '../models/doorCollections.js';
import * as announcements from '../models/announcements.js';
import * as wall from '../models/wall.js';
import * as bulletins from '../models/bulletins.js';
import * as newsFiles from '../models/newsFiles.js';
import * as seasonalArt from '../models/seasonalArt.js';
import * as freqModel from '../models/freq.js';
import * as fileWildcards from '../models/fileWildcards.js';
import * as timedEvents from '../models/timedEvents.js';
import * as callFlowsModel from '../models/callFlows.js';
import * as badEchomail from '../models/badEchomail.js';
import * as inboundFileLog from '../models/inboundFileLog.js';
import * as managedNodes from '../models/managedNodes.js';
import * as coordinatorSegments from '../models/coordinatorSegments.js';
import * as menus from '../models/menus.js';
import * as themes from '../models/themes.js';
import * as peerConnections from '../models/peerConnections.js';
import * as peerAreaSubscriptions from '../models/peerAreaSubscriptions.js';
import * as networkAreas from '../models/networkAreas.js';
import * as systemAddresses from "../models/systemAddresses.js";
import * as userAccounts from "../models/useraccounts.js";
import * as sessionStore from "../middleware/db/sessionstore.js";
import * as alogger from "../utils/alogger.js";
import * as jobs from "../queues/jobs.js";
import { updateTimedEventSchedule, removeTimedEventSchedule, updateSegmentSchedule, removeSegmentSchedule } from "../queues/schedules.js";
import { maintenanceQueue } from "../queues/queues.js";
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
import * as networkEcholist from '../models/networkEcholist.js';
import * as fileEcholist from '../models/fileEcholist.js';
import * as flash from '../middleware/db/flash.js';
import { formatActivity } from '../utils/activityMap.js';
import { getOnlineUsers } from '../middleware/webActivity.js';
import * as redis from '../middleware/db/redis.js';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';

//setup
router.use(cookieParser());
var urlencodedParser = bodyParser.urlencoded({ limit: '250mb', extended: true });

//variables and const
const basedir        = process.cwd();
const BUILTIN_PERMISSIONS  = ["Sysop", "Mod", "Adult", "Admin", "Email", "Netmail"];
const BUILTIN_RESTRICTIONS = ["Underage", "Unverified", "Banned", "Email", "Netmail", "Private Messages"];

function getAvailablePermissions() {
	var custom = appConfig.get('custom_permission_flags', '')
		.split(',').map(f => f.trim()).filter(Boolean);
	return BUILTIN_PERMISSIONS.concat(custom.filter(f => !BUILTIN_PERMISSIONS.includes(f)));
}
function getAvailableRestrictions() {
	var custom = appConfig.get('custom_restriction_flags', '')
		.split(',').map(f => f.trim()).filter(Boolean);
	return BUILTIN_RESTRICTIONS.concat(custom.filter(f => !BUILTIN_RESTRICTIONS.includes(f)));
}

// Inject shared locals for all admin views
router.use(async function(req, res, next) {
	res.locals.boardname    = appConfig.get('boardname', 'BBS Admin');
	res.locals.faviconlink  = appConfig.get('faviconlink', '/images/favicon.ico');
	res.locals.currentPath  = '/admin' + req.path;
	res.locals.activelink   = '';
	if (req.cookies.sessionid) {
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions()
	});
});

// Legacy netmail admin routes removed -- netmail now flows through the PM system.

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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions()
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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions()
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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions(),
			DateTime: DateTime
		});
	}
});

router.post('/msgGroup/:shortcode/pushDefaults', urlencodedParser, requireAdmin, async (req, res) => {
	var shortcode = req.params.shortcode.toUpperCase().trim();
	var fields = req.body.fields;
	if (typeof fields === 'string') fields = [fields];
	var result = await msgGroups.pushDefaultsToAreas(shortcode, fields || ['all']);
	if (result.status) {
		await flash.setOne(req, 'success', 'Pushed defaults to ' + result.updated + ' area(s).');
	} else {
		await flash.setOne(req, 'danger', 'Failed: ' + (result.errormessages || []).join(', '));
	}
	res.redirect('/admin/msgGroup/' + shortcode);
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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions(),
			DateTime: DateTime
		});
	}
});

// Reorder groups and areas
router.post('/msgGroups/reorder', express.json(), requireAdmin, async (req, res) => {
	var ids = req.body.ids;
	if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (_) { ids = []; } }
	if (Array.isArray(ids) && ids.length > 0) await msgGroups.reorderGroups(ids);
	res.json({ status: true });
});

router.post('/msgAreas/reorder', express.json(), requireAdmin, async (req, res) => {
	var ids = req.body.ids;
	if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (_) { ids = []; } }
	if (Array.isArray(ids) && ids.length > 0) await msgGroups.reorderAreas(ids);
	res.json({ status: true });
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
		post_rest_flags: group.post_rest_flags || [],
		post_as: group.post_as || 'username',
		newscan_default: group.newscan_default === true
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions(),
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions(),
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
	// Merge config fields into the network's config JSONB
	var configKeys = ['nodelist_area_shortcode', 'infopack_area', 'echolist_area', 'filebone_area'];
	var hasConfigField = configKeys.some(function(k) { return formObj[k] !== undefined; });
	if (hasConfigField) {
		var dbnet = await msgNetworks.getNetworkByUUID(uuid);
		var existingConfig = (dbnet && dbnet.config) ? (typeof dbnet.config === 'string' ? JSON.parse(dbnet.config) : dbnet.config) : {};
		for (var ck of configKeys) {
			if (formObj[ck] !== undefined) {
				existingConfig[ck] = formObj[ck] || null;
				delete formObj[ck];
			}
		}
		formObj.config = existingConfig;
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
	var shortcode   = req.params.shortcode.trim();
	var uuid        = req.params.uuid.trim();
	if (!uuid || !shortcode) return res.redirect('/admin/');

	// Find the thread UUID so we can redirect back to the thread view
	var msgtable = 'mb_' + shortcode.toLowerCase() + '_msgs';
	var dbmsg = await postgres.queryOne("SELECT thread_id FROM " + msgtable + " WHERE uuid = $1", [uuid]);
	var threadUuid = null;
	if (dbmsg && dbmsg.thread_id) {
		var threadtable = 'mb_' + shortcode.toLowerCase() + '_threads';
		var thread = await postgres.queryOne("SELECT uuid FROM " + threadtable + " WHERE id = $1", [dbmsg.thread_id]);
		if (thread) threadUuid = thread.uuid;
	}

	var delsuccess = await messages.deleteMessageByUUID(uuid, shortcode);
	if (delsuccess && threadUuid) {
		// Check if the thread still has messages
		var remaining = await postgres.queryOne("SELECT COUNT(*) AS cnt FROM " + msgtable + " WHERE thread_id = $1", [dbmsg.thread_id]);
		if (remaining && parseInt(remaining.cnt) > 0) {
			return res.redirect('/admin/msgArea/' + shortcode + '/thread/' + threadUuid);
		}
	}
	res.redirect('/admin/msgArea/' + shortcode);
});

router.post('/msgArea/:shortcode/thread/:uuid/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var shortcode = req.params.shortcode.trim();
	var uuid      = req.params.uuid.trim();
	if (!uuid || !shortcode) return res.redirect('/admin/');

	var result = await messages.deleteThreadByUUID(uuid, shortcode);
	if (result.status) {
		alogger.writeAlog(5, 'Thread ' + uuid + ' deleted from ' + shortcode + ' (' + result.deleted + ' messages)', 'yellow');
	}
	res.redirect('/admin/msgArea/' + shortcode);
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions()
	});
});

// Expand ~ to home directory for filesystem paths
function expandHome(dir) {
	if (!dir) return dir;
	if (dir.startsWith('~/') || dir === '~') return path.join(os.homedir(), dir.substring(1));
	return dir;
}

// Resolve a file group/area directory path (expand ~ and resolve relative to file_base_dir)
function resolveFileDir(dir) {
	if (!dir) return null;
	var expanded = expandHome(dir);
	if (path.isAbsolute(expanded)) return expanded;
	var globalBase = expandHome(appConfig.get('file_base_dir', 'files'));
	return path.join(globalBase, expanded);
}

// Check if a directory exists (AJAX endpoint for file group/area forms)
router.get('/fileGroup/checkdir', requireAdmin, async (req, res) => {
	var dir = resolveFileDir((req.query.dir || '').trim());
	if (!dir) return res.json({ exists: false, error: 'No path specified' });
	try {
		var exists = fs.existsSync(dir);
		return res.json({ exists: exists, path: dir });
	} catch (e) {
		return res.json({ exists: false, error: e.message });
	}
});

// Create a directory (AJAX endpoint for file group/area forms)
router.post('/fileGroup/mkdir', express.json(), requireAdmin, async (req, res) => {
	var dir = resolveFileDir((req.body.dir || '').trim());
	if (!dir) return res.json({ status: false, error: 'No path specified' });
	try {
		fs.mkdirSync(dir, { recursive: true });
		alogger.writeAlog(5, 'Created directory: ' + dir, 'cyan');
		return res.json({ status: true, path: dir });
	} catch (e) {
		return res.json({ status: false, error: e.message });
	}
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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions()
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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions()
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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions(),
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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions(),
			DateTime: DateTime
		});
	}
});

// Reorder file groups and areas
router.post('/fileGroups/reorder', express.json(), requireAdmin, async (req, res) => {
	var ids = req.body.ids;
	if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (_) { ids = []; } }
	if (Array.isArray(ids) && ids.length > 0) await fileGroups.reorderGroups(ids);
	res.json({ status: true });
});

router.post('/fileAreas/reorder', express.json(), requireAdmin, async (req, res) => {
	var ids = req.body.ids;
	if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (_) { ids = []; } }
	if (Array.isArray(ids) && ids.length > 0) await fileGroups.reorderAreas(ids);
	res.json({ status: true });
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
		post_rest_flags: group.post_rest_flags || [],
		newscan_default: group.newscan_default !== false,
		max_age_days: group.max_age_days || null,
		max_files: group.max_files || null
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions(),
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions(),
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
			availablePermissions: getAvailablePermissions(),
			availableRestrictions: getAvailableRestrictions(),
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions(),
		DateTime: DateTime
	});
});

router.post('/users/maintenance', urlencodedParser, requireAdmin, async (req, res) => {
	await jobs.enqueueUserMaintenance();
	res.redirect('/admin/users');
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions(),
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

router.post('/users/:uuid/kill-sessions', requireAdmin, async (req, res) => {
	var uuid = req.params.uuid.toLowerCase().trim();
	var user = await userAccounts.getUserByUUID(uuid);
	if (!user) return res.json({ status: false, message: 'User not found' });

	var count = await sessionStore.destroyAllForUser(user.username);
	alogger.writeAlog(2, 'Admin killed ' + count + ' session(s) for ' + user.username, 'cyanbright');
	res.json({ status: true, message: 'Killed ' + count + ' session(s) for ' + user.username });
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
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions()
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

router.post('/menus/:id/duplicate', urlencodedParser, requireAdmin, async (req, res) => {
	var sourceId = parseInt(req.params.id);
	var newName = (req.body.new_name || '').trim();
	var result = await menus.duplicateMenu(sourceId, newName);
	if (result.status && result.menuId) {
		res.redirect('/admin/menus/' + result.menuId);
	} else {
		res.redirect('/admin/menus/' + sourceId);
	}
});

router.get('/menus/:id/export.json', requireAdmin, async (req, res) => {
	var menuId = parseInt(req.params.id);
	var data = await menus.exportMenuToJson(menuId);
	if (!data) return res.status(404).json({ error: 'Menu not found' });
	res.setHeader('Content-Disposition', 'attachment; filename="menu-' + data.menu.name + '.json"');
	res.json(data);
});

router.post('/menus/import', multer({ dest: os.tmpdir() }).single('menu_file'), requireAdmin, async (req, res) => {
	var menuList = await menus.getAllMenus();

	if (!req.file) {
		return res.redirect('/admin/menus');
	}

	var fs = await import('fs');
	var raw;
	try {
		raw = fs.readFileSync(req.file.path, 'utf8');
		fs.unlinkSync(req.file.path);
	} catch (err) {
		return res.redirect('/admin/menus');
	}

	var data;
	try {
		data = JSON.parse(raw);
	} catch (_) {
		return res.redirect('/admin/menus');
	}

	var overrideName = (req.body.import_name || '').trim() || null;
	var result = await menus.importMenuFromJson(data, overrideName);
	if (result.status && result.menuId) {
		res.redirect('/admin/menus/' + result.menuId);
	} else {
		res.redirect('/admin/menus');
	}
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

router.post('/menus/:id/entries/reorder', express.json(), requireAdmin, async (req, res) => {
	var menuId = parseInt(req.params.id);
	var orderedIds = req.body.ids || req.body.order || [];
	if (typeof orderedIds === 'string') {
		try { orderedIds = JSON.parse(orderedIds); } catch (_) { orderedIds = []; }
	}
	if (Array.isArray(orderedIds) && orderedIds.length > 0) {
		await menus.reorderEntries(menuId, orderedIds);
	}
	if (req.headers.accept && req.headers.accept.includes('application/json')) {
		res.json({ status: true });
	} else {
		res.redirect('/admin/menus/' + menuId);
	}
});


// -------------------------------------------------------
// Door Collections
// -------------------------------------------------------

router.get('/doorCollections', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var collections      = await doorCollections.getAllCollections();
	var counts           = await doorCollections.getCollectionCounts();
	var allDoors         = await doors.getAllDoors();

	res.render('admin/doorCollections/index', {
		sufficientAccess: sufficientAccess,
		title: 'Door Collections',
		activelink: 'doorCollections',
		currentuser: currentuser,
		collections: collections,
		doorCounts: counts,
		allDoors: allDoors
	});
});

router.post('/doorCollections/new', urlencodedParser, requireAdmin, async (req, res) => {
	await doorCollections.createCollection(req.body);
	res.redirect('/admin/doorCollections');
});

router.post('/doorCollections/update/:id', urlencodedParser, requireAdmin, async (req, res) => {
	await doorCollections.updateCollection(parseInt(req.params.id), req.body);
	res.redirect('/admin/doorCollections');
});

router.post('/doorCollections/delete/:id', urlencodedParser, requireAdmin, async (req, res) => {
	await doorCollections.deleteCollection(parseInt(req.params.id));
	res.redirect('/admin/doorCollections');
});

router.get('/doorCollections/:id', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var collection       = await doorCollections.getCollectionById(parseInt(req.params.id));
	var collectionDoors  = await doorCollections.getAllDoorsInCollection(parseInt(req.params.id));
	var allDoors         = await doors.getAllDoors();

	res.render('admin/doorCollections/view', {
		sufficientAccess: sufficientAccess,
		title: collection ? collection.name : 'Collection',
		activelink: 'doorCollections',
		currentuser: currentuser,
		collection: collection,
		collectionDoors: collectionDoors,
		allDoors: allDoors,
		launchTypeLabels: doors.getLaunchTypeLabels()
	});
});

router.post('/doorCollections/:id/addDoor', urlencodedParser, requireAdmin, async (req, res) => {
	var collectionId = parseInt(req.params.id);
	var doorId = parseInt(req.body.door_id);
	if (doorId) await doorCollections.addDoorToCollection(collectionId, doorId);
	res.redirect('/admin/doorCollections/' + collectionId);
});

router.post('/doorCollections/:id/removeDoor/:doorId', urlencodedParser, requireAdmin, async (req, res) => {
	var collectionId = parseInt(req.params.id);
	var doorId = parseInt(req.params.doorId);
	await doorCollections.removeDoorFromCollection(collectionId, doorId);
	res.redirect('/admin/doorCollections/' + collectionId);
});

router.post('/doorCollections/:id/reorder', express.json(), requireAdmin, async (req, res) => {
	var collectionId = parseInt(req.params.id);
	var ids = req.body.ids || [];
	if (Array.isArray(ids) && ids.length > 0) {
		await doorCollections.updateEntrySortOrder(collectionId, ids);
	}
	res.json({ status: true });
});

// -------------------------------------------------------
// Doors
// -------------------------------------------------------

router.get('/doors', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var doorlist         = await doors.getAllDoors();
	var launchTypes        = doors.getValidLaunchTypes();
	var launchTypeLabels   = doors.getLaunchTypeLabels();
	var dropfileTypes      = doors.getValidDropfileTypes();
	var dropfileTypeLabels = doors.getDropfileTypeLabels();
	var configVars         = getVariableList();
	var collections        = await doorCollections.getActiveCollections();

	// Build per-door collection membership map for edit modal
	var doorCollectionMap = {};
	for (var d of (doorlist || [])) {
		var dc = await doorCollections.getCollectionsForDoor(d.id);
		doorCollectionMap[d.id] = dc.map(function(c) { return c.id; });
	}

	res.render('admin/doors/index', {
		sufficientAccess: sufficientAccess,
		title: 'Door Games',
		activelink: 'doors',
		currentuser: currentuser,
		doorlist: doorlist,
		launchTypes: launchTypes,
		launchTypeLabels: launchTypeLabels,
		dropfileTypes: dropfileTypes,
		dropfileTypeLabels: dropfileTypeLabels,
		configVars: configVars,
		collections: collections || [],
		doorCollectionMap: doorCollectionMap
	});
});

router.post('/doors/new', urlencodedParser, requireAdmin, async (req, res) => {
	var result = await doors.createDoor(req.body);
	if (result.status && result.insertId) {
		// Sync collection membership
		var collIds = req.body.collections;
		if (typeof collIds === 'string') collIds = [collIds];
		if (Array.isArray(collIds)) {
			for (var cid of collIds) {
				await doorCollections.addDoorToCollection(parseInt(cid), result.insertId);
			}
		}
		res.redirect('/admin/doors');
	} else {
		var currentuser      = await getCurrentUser(req);
		var sufficientAccess = checkAdminAccess(currentuser);
		var doorlist         = await doors.getAllDoors();
		var launchTypes        = doors.getValidLaunchTypes();
		var launchTypeLabels   = doors.getLaunchTypeLabels();
		var dropfileTypes      = doors.getValidDropfileTypes();
		var dropfileTypeLabels = doors.getDropfileTypeLabels();
		var configVars         = getVariableList();
		res.render('admin/doors/index', {
			sufficientAccess: sufficientAccess,
			title: 'Door Games',
			activelink: 'doors',
			currentuser: currentuser,
			doorlist: doorlist,
			launchTypes: launchTypes,
			launchTypeLabels: launchTypeLabels,
			dropfileTypes: dropfileTypes,
			dropfileTypeLabels: dropfileTypeLabels,
			configVars: configVars,
			collections: await doorCollections.getActiveCollections() || [],
			doorCollectionMap: {},
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

	// Sync collection membership: remove all, re-add selected
	var currentColls = await doorCollections.getCollectionsForDoor(doorId);
	for (var cc of currentColls) {
		await doorCollections.removeDoorFromCollection(cc.id, doorId);
	}
	var collIds = req.body.collections;
	if (typeof collIds === 'string') collIds = [collIds];
	if (Array.isArray(collIds)) {
		for (var cid of collIds) {
			await doorCollections.addDoorToCollection(parseInt(cid), doorId);
		}
	}

	res.redirect('/admin/doors');
});

router.post('/doors/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var doorId = parseInt(req.params.id);
	await doors.deleteDoor(doorId);
	res.redirect('/admin/doors');
});

// -----------------------------------------------------------------------
// Themes
// -----------------------------------------------------------------------

router.get('/themes', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var themeList = await themes.getAllThemes();
	var ansiColors = menus.getAnsiColors();
	var themeProperties = themes.getThemeProperties();
	var propertyCategories = themes.getPropertyCategories();
	res.render('admin/themes/index', {
		sufficientAccess: sufficientAccess,
		title: 'Themes',
		activelink: 'themes',
		currentuser: currentuser,
		themeList: themeList,
		ansiColors: ansiColors,
		themeProperties: themeProperties,
		propertyCategories: propertyCategories
	});
});

router.get('/themes/:id', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var theme = await themes.getThemeById(parseInt(req.params.id));
	if (!theme) return res.redirect('/admin/themes');
	var ansiColors = menus.getAnsiColors();
	var themeProperties = themes.getThemeProperties();
	var propertyCategories = themes.getPropertyCategories();
	res.render('admin/themes/view', {
		sufficientAccess: sufficientAccess,
		title: 'Edit Theme: ' + theme.name,
		activelink: 'themes',
		currentuser: currentuser,
		theme: theme,
		ansiColors: ansiColors,
		themeProperties: themeProperties,
		propertyCategories: propertyCategories
	});
});

router.post('/themes/new', urlencodedParser, requireAdmin, async (req, res) => {
	var result = await themes.createTheme(req.body);
	if (result.status) {
		res.redirect('/admin/themes/' + result.themeId);
	} else {
		var currentuser = await getCurrentUser(req);
		var sufficientAccess = checkAdminAccess(currentuser);
		var themeList = await themes.getAllThemes();
		var ansiColors = menus.getAnsiColors();
		var themeProperties = themes.getThemeProperties();
		var propertyCategories = themes.getPropertyCategories();
		res.render('admin/themes/index', {
			sufficientAccess: sufficientAccess,
			title: 'Themes',
			activelink: 'themes',
			currentuser: currentuser,
			themeList: themeList,
			ansiColors: ansiColors,
			themeProperties: themeProperties,
			propertyCategories: propertyCategories,
			errormessages: result.errormessages
		});
	}
});

router.post('/themes/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var themeId = parseInt(req.params.id);
	var result = await themes.updateTheme(themeId, req.body);
	if (!result.status) {
		alogger.writeAlog(3, "updateTheme failed for id " + themeId + ": " + result.errormessages.join(", "), "redbright");
	}
	res.redirect('/admin/themes/' + themeId);
});

router.post('/themes/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var themeId = parseInt(req.params.id);
	var result = await themes.deleteTheme(themeId);
	if (!result.status) {
		alogger.writeAlog(3, "deleteTheme blocked: " + (result.errormessages || []).join(", "), "yellowbright");
	}
	res.redirect('/admin/themes');
});

router.post('/themes/:id/set-default', urlencodedParser, requireAdmin, async (req, res) => {
	var themeId = parseInt(req.params.id);
	await themes.setDefaultTheme(themeId);
	// Update the config setting to match
	await configStore.upsert('theme', (await themes.getThemeById(themeId)).slug);
	res.redirect('/admin/themes');
});

router.post('/themes/:id/duplicate', urlencodedParser, requireAdmin, async (req, res) => {
	var themeId = parseInt(req.params.id);
	var newSlug = (req.body.slug || '').trim().toLowerCase();
	var newName = (req.body.name || '').trim();
	var result = await themes.duplicateTheme(themeId, newSlug, newName);
	if (result.status) {
		res.redirect('/admin/themes/' + result.themeId);
	} else {
		res.redirect('/admin/themes');
	}
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
// Echolists
// -------------------------------------------------------

// GET /admin/echolists — All echolists across all networks
router.get('/echolists', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networks         = await msgNetworks.getActiveNetworks();
	var echolists        = await networkEcholist.getAllEcholists();

	// Group echolists by network, then ensure all networks are represented
	var echoMap = {};
	for (var el of (echolists || [])) {
		if (!echoMap[el.network_id]) echoMap[el.network_id] = [];
		echoMap[el.network_id].push(el);
	}

	var grouped = (networks || []).map(function(n) {
		return {
			network_name: n.name,
			network_domain: n.domain,
			network_id: n.id,
			echolists: echoMap[n.id] || []
		};
	});

	res.render('admin/echolists/all', {
		sufficientAccess: sufficientAccess,
		title: 'All Echolists',
		activelink: 'networks',
		currentuser: currentuser,
		grouped: grouped
	});
});

// GET /admin/echolist/view/:echolistId — Browse echolist areas (before :networkId to avoid param collision)
router.get('/echolist/view/:echolistId', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var echolistId       = parseInt(req.params.echolistId);
	var echolist         = await networkEcholist.getEcholistById(echolistId);
	var network          = echolist ? await msgNetworks.getNetworkById(echolist.network_id) : null;
	var areas            = echolist ? await networkEcholist.getAreasByEcholist(echolistId, { activeOnly: false }) : [];
	var stats            = echolist ? await networkEcholist.getEcholistStats(echolistId) : {};
	var allFileAreas     = await fileAreas.getAllAreas();

	res.render('admin/echolists/view', {
		sufficientAccess: sufficientAccess,
		title: 'Echolist Browser',
		activelink: 'networks',
		currentuser: currentuser,
		echolist: echolist,
		network: network,
		areas: areas,
		stats: stats,
		diff: null,
		allFileAreas: allFileAreas || []
	});
});

// GET /admin/echolist/:networkId — List echolists for a network
router.get('/echolist/:networkId', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networkId        = parseInt(req.params.networkId);
	var network          = networkId ? await msgNetworks.getNetworkById(networkId) : null;
	var echolists        = network ? await networkEcholist.getEcholistsByNetwork(networkId) : [];

	res.render('admin/echolists/index', {
		sufficientAccess: sufficientAccess,
		title: 'Echolists',
		activelink: 'networks',
		currentuser: currentuser,
		network: network,
		echolists: echolists
	});
});

// POST /admin/echolist/:networkId/new — Create echolist + import from file
router.post('/echolist/:networkId/new', multer({ dest: os.tmpdir() }).single('echolist_file'), requireAdmin, async (req, res) => {
	var networkId   = parseInt(req.params.networkId);
	var description = (req.body.description || '').trim();
	var isDefault   = req.body.is_default === 'true';

	// Derive name from filename if not provided (keep extension)
	var name = (req.body.name || '').trim();
	if (!name && req.file && req.file.originalname) {
		name = req.file.originalname.trim();
	}
	if (!name) name = 'Echolist';

	var result = await networkEcholist.createEcholist(networkId, name, description, isDefault);
	if (!result.status) {
		if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
		await flash.setOne(req, 'danger', 'Failed to create echolist: ' + (result.errormessages || []).join(', '));
		return res.redirect('/admin/echolist/' + networkId);
	}

	var echolistId = result.insertId;

	// Import file if provided
	if (req.file) {
		var fileText = '';
		try { fileText = fs.readFileSync(req.file.path, 'utf8'); }
		finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }

		var { parseAreasBbs } = await import('../utils/areasBbsParser.js');
		var parsed = parseAreasBbs(fileText);

		if (parsed && parsed.length > 0) {
			var diff = await networkEcholist.buildImportDiff(echolistId, parsed);
			var importResult = await networkEcholist.executeImport(echolistId, diff);
			var verb = result.existing ? 'updated' : 'created';
			await flash.setOne(req, 'success',
				'Echolist "' + name + '" ' + verb + ' with ' + importResult.newCount + ' new, ' + importResult.changedCount + ' changed, ' + importResult.removedCount + ' removed.');
		} else {
			await flash.setOne(req, result.existing ? 'info' : 'warning',
				'Echolist "' + name + '" ' + (result.existing ? 'already exists' : 'created') + (result.existing ? '.' : ' but no areas found in file.'));
		}
	} else {
		await flash.setOne(req, 'success', 'Echolist "' + name + '" ' + (result.existing ? 'already exists.' : 'created (no file uploaded).'));
	}

	res.redirect('/admin/echolist/' + networkId);
});

// POST /admin/echolist/:echolistId/import — Upload and preview echolist import
var echolistUpload = multer({ dest: path.join(os.tmpdir(), 'canectic-echolist-uploads') });
router.post('/echolist/:echolistId/import', echolistUpload.single('echolist_file'), requireAdmin, async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var echolistId       = parseInt(req.params.echolistId);
	var echolist         = await networkEcholist.getEcholistById(echolistId);

	if (!echolist || !req.file) {
		await flash.setOne(req, 'danger', 'Echolist and file are required.');
		return res.redirect('/admin/echolist/view/' + echolistId);
	}

	var network = await msgNetworks.getNetworkById(echolist.network_id);
	var areas   = await networkEcholist.getAreasByEcholist(echolistId, { activeOnly: false });
	var stats   = await networkEcholist.getEcholistStats(echolistId);

	try {
		var fileContent = fs.readFileSync(req.file.path, 'utf8');
		var { parseAreasBbs } = await import('../utils/areasBbsParser.js');
		var parsed = parseAreasBbs(fileContent);
		var diff   = await networkEcholist.buildImportDiff(echolistId, parsed);

		// Clean up temp file
		try { fs.unlinkSync(req.file.path); } catch (_) {}

		res.render('admin/echolists/view', {
			sufficientAccess: sufficientAccess,
			title: 'Echolist Browser',
			activelink: 'networks',
			currentuser: currentuser,
			echolist: echolist,
			network: network,
			areas: areas,
			stats: stats,
			diff: diff,
			allFileAreas: (await fileAreas.getAllAreas()) || []
		});
	} catch (err) {
		alogger.writeAlog(2, '[admin/echolist] Import preview failed: ' + err.message, 'redbright');
		try { fs.unlinkSync(req.file.path); } catch (_) {}
		await flash.setOne(req, 'danger', 'Failed to parse echolist file: ' + err.message);
		res.redirect('/admin/echolist/view/' + echolistId);
	}
});

// POST /admin/echolist/:echolistId/import/run — Execute the import
router.post('/echolist/:echolistId/import/run', urlencodedParser, requireAdmin, async (req, res) => {
	var echolistId = parseInt(req.params.echolistId);
	var echolist   = await networkEcholist.getEcholistById(echolistId);

	if (!echolist) {
		await flash.setOne(req, 'danger', 'Echolist not found.');
		return res.redirect('/admin/networks');
	}

	try {
		var diff   = JSON.parse(req.body.diff_data);
		var result = await networkEcholist.executeImport(echolistId, diff);

		// Notify sysop if locally-carried areas disappeared
		if (diff.localCarriedRemovals && diff.localCarriedRemovals.length > 0) {
			var notifications = await import('../models/notifications.js');
			var tags = diff.localCarriedRemovals.map(function(r) { return r.areatag; }).join(', ');
			await notifications.createSysop(
				'echolist_removal',
				'Echolist areas removed: ' + echolist.name,
				diff.localCarriedRemovals.length + ' locally-carried area(s) disappeared from echolist "' + echolist.name + '": ' + tags,
				{ icon: 'exclamation-triangle', severity: 'warning', link: '/admin/echolist/view/' + echolistId }
			);
		}

		await flash.setOne(req, 'success',
			'Import complete: ' + result.newCount + ' new, ' +
			result.changedCount + ' changed, ' +
			result.removedCount + ' removed, ' +
			result.unchangedCount + ' unchanged.'
		);
	} catch (err) {
		alogger.writeAlog(2, '[admin/echolist] Import execution failed: ' + err.message, 'redbright');
		await flash.setOne(req, 'danger', 'Import failed: ' + err.message);
	}

	res.redirect('/admin/echolist/view/' + echolistId);
});

// POST /admin/echolist/:echolistId/update — Update echolist properties
router.post('/echolist/:echolistId/update', urlencodedParser, requireAdmin, async (req, res) => {
	var echolistId = parseInt(req.params.echolistId);
	var result = await networkEcholist.updateEcholist(echolistId, req.body);

	if (result.status) {
		await flash.setOne(req, 'success', 'Echolist updated.');
	} else {
		await flash.setOne(req, 'danger', 'Failed to update echolist: ' + (result.errormessages || []).join(', '));
	}

	res.redirect('/admin/echolist/view/' + echolistId);
});

// POST /admin/echolist/:echolistId/remove — Delete echolist and all its areas
router.post('/echolist/:echolistId/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var echolistId = parseInt(req.params.echolistId);
	var echolist   = await networkEcholist.getEcholistById(echolistId);
	var networkId  = echolist ? echolist.network_id : null;

	var result = await networkEcholist.removeEcholist(echolistId);
	if (result.status) {
		await flash.setOne(req, 'success', 'Echolist "' + (echolist ? echolist.name : '') + '" deleted.');
	} else {
		await flash.setOne(req, 'danger', 'Failed to delete echolist: ' + (result.errormessages || []).join(', '));
	}

	res.redirect('/admin/echolist/' + (networkId || ''));
});

// POST /admin/echolist/area/:areaId/update — Update an echolist area entry
router.post('/echolist/area/:areaId/update', urlencodedParser, requireAdmin, async (req, res) => {
	var areaId = parseInt(req.params.areaId);
	var area   = await networkEcholist.getAreaById(areaId);

	var result = await networkEcholist.updateArea(areaId, req.body);
	if (result.status) {
		await flash.setOne(req, 'success', 'Area updated.');
	} else {
		await flash.setOne(req, 'danger', 'Failed to update area: ' + (result.errormessages || []).join(', '));
	}

	res.redirect('/admin/echolist/view/' + (area ? area.echolist_id : ''));
});

// POST /admin/echolist/area/:areaId/remove — Remove an echolist area entry
router.post('/echolist/area/:areaId/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var areaId = parseInt(req.params.areaId);
	var area   = await networkEcholist.getAreaById(areaId);

	var result = await networkEcholist.removeArea(areaId);
	if (result.status) {
		await flash.setOne(req, 'success', 'Area removed.');
	} else {
		await flash.setOne(req, 'danger', 'Failed to remove area: ' + (result.errormessages || []).join(', '));
	}

	res.redirect('/admin/echolist/view/' + (area ? area.echolist_id : ''));
});

// -------------------------------------------------------
// Combined echolist view
// -------------------------------------------------------

router.get('/echolist/:networkId/combined', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networkId        = parseInt(req.params.networkId);
	var network          = networkId ? await msgNetworks.getNetworkById(networkId) : null;

	var echolistAreas    = network ? await networkEcholist.getAreasAcrossNetwork(networkId) : [];
	var orphanedAreas    = network ? await networkAreas.getOrphanedNetworkAreas(networkId) : [];
	var groups           = await msgGroups.getActiveGroups();

	// Build list of areas not already mapped to this network for the "map existing" dropdown
	var mappedRows   = await networkAreas.getAreasByNetwork(networkId);
	var mappedIds    = new Set((mappedRows || []).map(function(na) { return parseInt(na.area_id); }));
	var allAreas     = await msgAreas.getAllAreas();
	var unmappedAreas = (allAreas || []).filter(function(a) { return !mappedIds.has(parseInt(a.id)); });

	// Enrich echolist areas that are carried with shortcode/area_id for unmap action
	var areaIdMap = {};
	for (var a of (allAreas || [])) { areaIdMap[a.id] = a; }
	var naTagMap = {};
	for (var na of (mappedRows || [])) { naTagMap[na.areatag.toUpperCase()] = na; }
	for (var el of echolistAreas) {
		if (el.local_area_id) {
			var localArea = areaIdMap[el.local_area_id];
			el.local_shortcode = localArea ? localArea.shortcode : '';
			el.local_area_name = localArea ? localArea.name : '';
			var naRow = naTagMap[el.areatag.toUpperCase()];
			el.network_area_id = naRow ? naRow.area_id : el.local_area_id;
		}
	}

	res.render('admin/echolists/combined', {
		sufficientAccess: sufficientAccess,
		title: 'Combined Echolist',
		activelink: 'networks',
		currentuser: currentuser,
		network: network,
		echolistAreas: echolistAreas,
		orphanedAreas: orphanedAreas,
		groups: groups,
		unmappedAreas: unmappedAreas,
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions(),
		defaultReadSecurity: appConfig.getNumber('default_msg_read_security', 50),
		defaultPostSecurity: appConfig.getNumber('default_msg_post_security', 60)
	});
});

router.post('/echolist/:networkId/combined/subscribe', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var networkId   = parseInt(req.params.networkId);
	var action      = (req.body.action || '').trim();
	var areatag     = (req.body.areatag || '').trim();

	// allow_peers/enable_peers may be an array when both tabs have checkboxes in the same form
	var rawAllow = req.body.allow_peers;
	var rawEnable = req.body.enable_peers;
	var allowPeers  = rawAllow === 'true' || (Array.isArray(rawAllow) && rawAllow.includes('true'));
	var enablePeers = rawEnable === 'true' || (Array.isArray(rawEnable) && rawEnable.includes('true'));
	var syncOpts = {};
	if (allowPeers)  syncOpts.allowAll = true;
	if (enablePeers) syncOpts.enableAll = true;

	if (action === 'create') {
		var formObj = {
			groupshortcode:  req.body.group_shortcode,
			name:            req.body.name || areatag,
			description:     req.body.description || areatag,
			shortcode:       req.body.shortcode || areatag.toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 64),
			readsecurity:    req.body.read_security,
			postsecurity:    req.body.post_security,
			post_as:         req.body.post_as || 'realname',
			newscan_default: req.body.newscan_default,
			read_perm_flags: req.body.read_perm_flags,
			read_rest_flags: req.body.read_rest_flags,
			post_perm_flags: req.body.post_perm_flags,
			post_rest_flags: req.body.post_rest_flags,
			network_id:      networkId,
			areatag:         areatag,
			createdByUUID:   currentuser ? currentuser.uuid : '',
			createdByName:   currentuser ? currentuser.username : ''
		};
		var result = await msgAreas.newArea(formObj);
		if (result.status) {
			// newArea handles allowAll internally, but if enableAll was requested
			// we need an explicit sync pass to set enabled = true.
			if (enablePeers && result.shortcode) {
				var newArea = await msgAreas.getAreaByShortcode(result.shortcode);
				if (newArea) {
					await peerAreaSubscriptions.syncNetworkAreaToConnections(networkId, newArea.id, { enableAll: true });
				}
			}
			var peerMsg = allowPeers ? (enablePeers ? ' Allowed and enabled for all peers.' : ' Allowed for all peers.') : '';
			await flash.setOne(req, 'success', 'Area "' + formObj.shortcode + '" created and mapped.' + peerMsg);
		} else {
			await flash.setOne(req, 'danger', 'Failed: ' + (result.errormessages || []).join(', '));
		}
	} else if (action === 'map') {
		var areaId = parseInt(req.body.area_id);
		var mapResult = await networkAreas.addAreaToNetwork(networkId, areaId, areatag, {
			createdByUUID: currentuser ? currentuser.uuid : '',
			createdByName: currentuser ? currentuser.username : ''
		});
		if (mapResult.status) {
			await peerAreaSubscriptions.syncNetworkAreaToConnections(networkId, areaId, syncOpts);
			var peerMsg = allowPeers ? (enablePeers ? ' Allowed and enabled for all peers.' : ' Allowed for all peers.') : '';
			await flash.setOne(req, 'success', 'Area mapped to network.' + peerMsg);
		} else {
			await flash.setOne(req, 'danger', 'Failed: ' + (mapResult.errormessages || []).join(', '));
		}
	} else {
		await flash.setOne(req, 'danger', 'Unknown action.');
	}

	res.redirect('/admin/echolist/' + networkId + '/combined');
});

router.post('/echolist/:networkId/combined/unmap', urlencodedParser, requireAdmin, async (req, res) => {
	var networkId    = parseInt(req.params.networkId);
	var areaId       = parseInt(req.body.area_id);
	var deleteArea   = req.body.delete_area === 'true';
	var shortcode    = (req.body.shortcode || '').trim();

	var deleteTables = req.body.delete_tables === 'true';

	var removeResult = await networkAreas.removeAreaFromNetwork(networkId, areaId);
	if (removeResult.status) {
		await peerAreaSubscriptions.removeSubscriptionsForNetworkArea(networkId, areaId);
		if (deleteArea && shortcode) {
			var delResult = await msgAreas.removeArea(shortcode, deleteTables);
			if (delResult.status) {
				await flash.setOne(req, 'success', 'Area unmapped and deleted.' + (deleteTables ? ' Message tables removed.' : ''));
			} else {
				await flash.setOne(req, 'warning', 'Unmapped but area deletion failed: ' + (delResult.errormessages || []).join(', '));
			}
		} else {
			await flash.setOne(req, 'success', 'Area unmapped from network.');
		}
	} else {
		await flash.setOne(req, 'danger', 'Failed: ' + (removeResult.errormessages || []).join(', '));
	}

	res.redirect('/admin/echolist/' + networkId + '/combined');
});

// -------------------------------------------------------
// Filebones (file echo lists)
// -------------------------------------------------------

// GET /admin/filebones — All filebones across all networks
router.get('/filebones', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networks         = await msgNetworks.getActiveNetworks();
	var filebones        = await fileEcholist.getAllEcholists();

	var fbMap = {};
	for (var el of (filebones || [])) {
		if (!fbMap[el.network_id]) fbMap[el.network_id] = [];
		fbMap[el.network_id].push(el);
	}

	var grouped = (networks || []).map(function(n) {
		return { network_name: n.name, network_domain: n.domain, network_id: n.id, filebones: fbMap[n.id] || [] };
	});

	res.render('admin/filebones/all', {
		sufficientAccess: sufficientAccess, title: 'All Filebones',
		activelink: 'networks', currentuser: currentuser, grouped: grouped
	});
});

// GET /admin/filebone/view/:echolistId — Browse filebone areas (before :networkId to avoid param collision)
router.get('/filebone/view/:echolistId', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var echolistId       = parseInt(req.params.echolistId);
	var echolist         = await fileEcholist.getEcholistById(echolistId);
	var network          = echolist ? await msgNetworks.getNetworkById(echolist.network_id) : null;
	var areas            = echolist ? await fileEcholist.getAreasByEcholist(echolistId, { activeOnly: false }) : [];
	var stats            = echolist ? await fileEcholist.getEcholistStats(echolistId) : {};

	res.render('admin/filebones/view', {
		sufficientAccess: sufficientAccess, title: 'Filebone',
		activelink: 'networks', currentuser: currentuser,
		echolist: echolist, filebone: echolist, network: network, areas: areas, stats: stats, diff: null,
		allFileAreas: (await fileAreas.getAllAreas()) || []
	});
});

// GET /admin/filebone/:networkId — List filebones for a network
router.get('/filebone/:networkId', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networkId        = parseInt(req.params.networkId);
	var network          = networkId ? await msgNetworks.getNetworkById(networkId) : null;
	var filebones        = network ? await fileEcholist.getEcholistsByNetwork(networkId) : [];

	res.render('admin/filebones/index', {
		sufficientAccess: sufficientAccess, title: 'Filebones',
		activelink: 'networks', currentuser: currentuser, network: network,
		echolists: filebones, filebones: filebones
	});
});

// POST /admin/filebone/:networkId/new — Create filebone + import from file
router.post('/filebone/:networkId/new', multer({ dest: os.tmpdir() }).single('echolist_file'), requireAdmin, async (req, res) => {
	var networkId   = parseInt(req.params.networkId);
	var description = (req.body.description || '').trim();
	var isDefault   = req.body.is_default === 'true';

	var name = (req.body.name || '').trim();
	if (!name && req.file && req.file.originalname) {
		name = req.file.originalname.trim();
	}
	if (!name) name = 'Filebone';

	var result = await fileEcholist.createEcholist(networkId, name, description, isDefault);
	if (!result.status) {
		if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
		await flash.setOne(req, 'danger', 'Failed to create filebone: ' + (result.errormessages || []).join(', '));
		return res.redirect('/admin/filebone/' + networkId);
	}

	var echolistId = result.insertId;

	if (req.file) {
		var fileText = '';
		try { fileText = fs.readFileSync(req.file.path, 'utf8'); }
		finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }

		var { parseAreasBbs } = await import('../utils/areasBbsParser.js');
		var parsed = parseAreasBbs(fileText);

		if (parsed && parsed.length > 0) {
			var diff = await fileEcholist.buildImportDiff(echolistId, parsed);
			var importResult = await fileEcholist.executeImport(echolistId, diff);
			var verb = result.existing ? 'updated' : 'created';
			await flash.setOne(req, 'success',
				'Filebone "' + name + '" ' + verb + ' with ' + importResult.newCount + ' new, ' + importResult.changedCount + ' changed, ' + importResult.removedCount + ' removed.');
		} else {
			await flash.setOne(req, result.existing ? 'info' : 'warning',
				'Filebone "' + name + '" ' + (result.existing ? 'already exists' : 'created') + (result.existing ? '.' : ' but no areas found in file.'));
		}
	} else {
		await flash.setOne(req, 'success', 'Filebone "' + name + '" ' + (result.existing ? 'already exists.' : 'created (no file uploaded).'));
	}

	res.redirect('/admin/filebone/' + networkId);
});

// POST /admin/filebone/:echolistId/import — Upload and diff
router.post('/filebone/:echolistId/import', multer({ dest: os.tmpdir() }).single('echolist_file'), requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var echolistId = parseInt(req.params.echolistId);
	var echolist   = await fileEcholist.getEcholistById(echolistId);
	var network    = echolist ? await msgNetworks.getNetworkById(echolist.network_id) : null;

	if (!req.file || !echolist) {
		await flash.setOne(req, 'danger', !req.file ? 'No file uploaded.' : 'Filebone not found.');
		return res.redirect('/admin/filebone/view/' + echolistId);
	}

	var fileText = '';
	try { fileText = fs.readFileSync(req.file.path, 'utf8'); }
	finally { try { fs.unlinkSync(req.file.path); } catch (e) {} }

	var { parseAreasBbs } = await import('../utils/areasBbsParser.js');
	var parsed = parseAreasBbs(fileText);

	if (!parsed || parsed.length === 0) {
		await flash.setOne(req, 'danger', 'No areas found in file.');
		return res.redirect('/admin/filebone/view/' + echolistId);
	}

	var diff = await fileEcholist.buildImportDiff(echolistId, parsed);
	var areas = await fileEcholist.getAreasByEcholist(echolistId, { activeOnly: false });
	var stats = await fileEcholist.getEcholistStats(echolistId);

	res.render('admin/filebones/view', {
		sufficientAccess: sufficientAccess, title: 'Filebone',
		activelink: 'networks', currentuser: currentuser,
		echolist: echolist, filebone: echolist, network: network, areas: areas, stats: stats, diff: diff,
		allFileAreas: (await fileAreas.getAllAreas()) || []
	});
});

// POST /admin/filebone/:echolistId/import/run — Execute import
router.post('/filebone/:echolistId/import/run', urlencodedParser, requireAdmin, async (req, res) => {
	var echolistId = parseInt(req.params.echolistId);
	var echolist   = await fileEcholist.getEcholistById(echolistId);

	var diff;
	try { diff = JSON.parse(req.body.diff_data); }
	catch (e) {
		await flash.setOne(req, 'danger', 'Invalid diff data.');
		return res.redirect('/admin/filebone/view/' + echolistId);
	}

	var result = await fileEcholist.executeImport(echolistId, diff);

	if (diff.localCarriedRemovals && diff.localCarriedRemovals.length > 0 && echolist) {
		try {
			var notifications = await import('../models/notifications.js');
			var tags = diff.localCarriedRemovals.map(function(r) { return r.areatag; }).join(', ');
			await notifications.createSysop(
				'filebone_removal',
				'Filebone areas removed: ' + echolist.name,
				diff.localCarriedRemovals.length + ' locally-carried file area(s) disappeared from filebone "' + echolist.name + '": ' + tags,
				{ icon: 'exclamation-triangle', severity: 'warning', link: '/admin/filebone/view/' + echolistId }
			);
		} catch (e) {}
	}

	await flash.setOne(req, 'success', 'Import complete: ' + result.newCount + ' new, ' + result.changedCount + ' changed, ' + result.removedCount + ' removed, ' + result.unchangedCount + ' unchanged.');
	res.redirect('/admin/filebone/view/' + echolistId);
});

// POST /admin/filebone/:echolistId/update — Edit filebone
router.post('/filebone/:echolistId/update', urlencodedParser, requireAdmin, async (req, res) => {
	var echolistId = parseInt(req.params.echolistId);
	var echolist   = await fileEcholist.getEcholistById(echolistId);
	var result = await fileEcholist.updateEcholist(echolistId, req.body);
	if (result.status) { await flash.setOne(req, 'success', 'Filebone updated.'); }
	else { await flash.setOne(req, 'danger', 'Failed: ' + (result.errormessages || []).join(', ')); }
	res.redirect('/admin/filebone/' + (echolist ? echolist.network_id : ''));
});

// POST /admin/filebone/:echolistId/remove — Delete filebone
router.post('/filebone/:echolistId/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var echolistId = parseInt(req.params.echolistId);
	var echolist   = await fileEcholist.getEcholistById(echolistId);
	var networkId  = echolist ? echolist.network_id : '';
	var result = await fileEcholist.removeEcholist(echolistId);
	if (result.status) { await flash.setOne(req, 'success', 'Filebone deleted.'); }
	else { await flash.setOne(req, 'danger', 'Failed: ' + (result.errormessages || []).join(', ')); }
	res.redirect('/admin/filebone/' + networkId);
});

// POST /admin/filebone/area/:areaId/update — Edit filebone area
router.post('/filebone/area/:areaId/update', urlencodedParser, requireAdmin, async (req, res) => {
	var areaId = parseInt(req.params.areaId);
	var area   = await fileEcholist.getAreaById(areaId);
	var result = await fileEcholist.updateArea(areaId, req.body);
	if (result.status) { await flash.setOne(req, 'success', 'Area updated.'); }
	else { await flash.setOne(req, 'danger', 'Failed: ' + (result.errormessages || []).join(', ')); }
	res.redirect('/admin/filebone/view/' + (area ? area.echolist_id : ''));
});

// POST /admin/filebone/area/:areaId/remove — Remove filebone area
router.post('/filebone/area/:areaId/remove', urlencodedParser, requireAdmin, async (req, res) => {
	var areaId = parseInt(req.params.areaId);
	var area   = await fileEcholist.getAreaById(areaId);
	var result = await fileEcholist.removeArea(areaId);
	if (result.status) { await flash.setOne(req, 'success', 'Area removed.'); }
	else { await flash.setOne(req, 'danger', 'Failed: ' + (result.errormessages || []).join(', ')); }
	res.redirect('/admin/filebone/view/' + (area ? area.echolist_id : ''));
});

// -------------------------------------------------------
// Combined filebone view
// -------------------------------------------------------

router.get('/filebone/:networkId/combined', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networkId        = parseInt(req.params.networkId);
	var network          = networkId ? await msgNetworks.getNetworkById(networkId) : null;

	var fileboneAreas    = network ? await fileEcholist.getAreasAcrossNetwork(networkId) : [];
	var orphanedAreas    = network ? await fileNetworkAreas.getOrphanedNetworkAreas(networkId) : [];
	var groups           = await fileGroups.getAllGroups();

	var mappedRows   = await fileNetworkAreas.getMappingsForNetwork(networkId);
	var mappedIds    = new Set((mappedRows || []).map(function(na) { return parseInt(na.area_id); }));
	var allAreas     = await fileAreas.getAllAreas();
	var unmappedAreas = (allAreas || []).filter(function(a) { return !mappedIds.has(parseInt(a.id)); });

	// Enrich carried filebones with shortcode/area_id for unmap action
	var areaIdMap = {};
	for (var a of (allAreas || [])) { areaIdMap[a.id] = a; }
	var naTagMap = {};
	for (var na of (mappedRows || [])) { naTagMap[na.areatag.toUpperCase()] = na; }
	for (var el of fileboneAreas) {
		if (el.local_area_id) {
			var localArea = areaIdMap[el.local_area_id];
			el.local_shortcode = localArea ? localArea.shortcode : '';
			el.local_area_name = localArea ? localArea.name : '';
			var naRow = naTagMap[el.areatag.toUpperCase()];
			el.network_area_id = naRow ? naRow.area_id : el.local_area_id;
		}
	}

	res.render('admin/filebones/combined', {
		sufficientAccess: sufficientAccess,
		title: 'Combined Filebone',
		activelink: 'networks',
		currentuser: currentuser,
		network: network,
		fileboneAreas: fileboneAreas,
		orphanedAreas: orphanedAreas,
		groups: groups,
		unmappedAreas: unmappedAreas,
		availablePermissions: getAvailablePermissions(),
		availableRestrictions: getAvailableRestrictions(),
		defaultBrowseSecurity: appConfig.getNumber('default_file_browse_security', 50),
		defaultReadSecurity: appConfig.getNumber('default_file_read_security', 60),
		defaultPostSecurity: appConfig.getNumber('default_file_post_security', 100)
	});
});

router.post('/filebone/:networkId/combined/subscribe', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var networkId   = parseInt(req.params.networkId);
	var action      = (req.body.action || '').trim();
	var areatag     = (req.body.areatag || '').trim();

	// allow_peers/enable_peers may be an array when both tabs have checkboxes in the same form
	var rawAllow = req.body.allow_peers;
	var rawEnable = req.body.enable_peers;
	var allowPeers  = rawAllow === 'true' || (Array.isArray(rawAllow) && rawAllow.includes('true'));
	var enablePeers = rawEnable === 'true' || (Array.isArray(rawEnable) && rawEnable.includes('true'));
	var syncOpts = {};
	if (allowPeers)  syncOpts.allowAll = true;
	if (enablePeers) syncOpts.enableAll = true;

	if (action === 'create') {
		var shortcode = req.body.shortcode || areatag.toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 64);
		var formObj = {
			groupshortcode:  req.body.group_shortcode,
			name:            req.body.name || areatag,
			description:     req.body.description || areatag,
			shortcode:       shortcode,
			sub_dir:         req.body.sub_dir || '',
			browsesecurity:  req.body.browse_security,
			readsecurity:    req.body.read_security,
			postsecurity:    req.body.post_security,
			newscan_default: req.body.newscan_default,
			max_age_days: req.body.max_age_days || null,
			max_files: req.body.max_files || null,
			browse_perm_flags: req.body.browse_perm_flags,
			browse_rest_flags: req.body.browse_rest_flags,
			read_perm_flags: req.body.read_perm_flags,
			read_rest_flags: req.body.read_rest_flags,
			post_perm_flags: req.body.post_perm_flags,
			post_rest_flags: req.body.post_rest_flags,
			createdByUUID:   currentuser ? currentuser.uuid : '',
			createdByName:   currentuser ? currentuser.username : ''
		};
		var result = await fileAreas.newArea(formObj);
		if (result.status) {
			// Map to network
			var mapResult = await fileNetworkAreas.addMapping(networkId, result.insertId, areatag, {
				createdByUUID: currentuser ? currentuser.uuid : '',
				createdByName: currentuser ? currentuser.username : ''
			});
			if (mapResult.status && (allowPeers || enablePeers)) {
				await filePeerSubscriptions.syncFileAreaToConnections(networkId, result.insertId, syncOpts);
			}
			var peerMsg = allowPeers ? (enablePeers ? ' Allowed and enabled for all peers.' : ' Allowed for all peers.') : '';
			await flash.setOne(req, 'success', 'File area "' + shortcode + '" created and mapped.' + peerMsg);
		} else {
			await flash.setOne(req, 'danger', 'Failed: ' + (result.errormessages || []).join(', '));
		}
	} else if (action === 'map') {
		var areaId = parseInt(req.body.area_id);
		var mapResult = await fileNetworkAreas.addMapping(networkId, areaId, areatag, {
			createdByUUID: currentuser ? currentuser.uuid : '',
			createdByName: currentuser ? currentuser.username : ''
		});
		if (mapResult.status) {
			await filePeerSubscriptions.syncFileAreaToConnections(networkId, areaId, syncOpts);
			var peerMsg = allowPeers ? (enablePeers ? ' Allowed and enabled for all peers.' : ' Allowed for all peers.') : '';
			await flash.setOne(req, 'success', 'File area mapped to network.' + peerMsg);
		} else {
			await flash.setOne(req, 'danger', 'Failed: ' + (mapResult.errormessages || []).join(', '));
		}
	} else {
		await flash.setOne(req, 'danger', 'Unknown action.');
	}

	res.redirect('/admin/filebone/' + networkId + '/combined');
});

router.post('/filebone/:networkId/combined/unmap', urlencodedParser, requireAdmin, async (req, res) => {
	var networkId    = parseInt(req.params.networkId);
	var areaId       = parseInt(req.body.area_id);
	var deleteArea   = req.body.delete_area === 'true';
	var shortcode    = (req.body.shortcode || '').trim();

	var deleteFiles = req.body.delete_files === 'true';

	var removeResult = await fileNetworkAreas.removeMapping(networkId, areaId);
	if (removeResult) {
		await filePeerSubscriptions.removeSubscriptionsForFileArea(networkId, areaId);
		if (deleteArea && shortcode) {
			var delResult = await fileAreas.removeArea(shortcode, deleteFiles);
			if (delResult && delResult.status) {
				await flash.setOne(req, 'success', 'File area unmapped and deleted.' + (deleteFiles ? ' Files removed from disk.' : ''));
			} else {
				await flash.setOne(req, 'warning', 'Unmapped but area deletion failed.');
			}
		} else {
			await flash.setOne(req, 'success', 'File area unmapped from network.');
		}
	} else {
		await flash.setOne(req, 'danger', 'Failed to unmap file area.');
	}

	res.redirect('/admin/filebone/' + networkId + '/combined');
});

// -------------------------------------------------------
// Announcements
// -------------------------------------------------------
// Events / Maintenance
// -------------------------------------------------------

router.get('/events', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	res.render('admin/events/index', {
		sufficientAccess: sufficientAccess,
		title: 'Jobs & Maintenance',
		activelink: 'events',
		currentuser: currentuser,
		triggered: req.query.triggered || null
	});
});

// Queue status API
router.get('/events/queues.json', requireAdmin, async (req, res) => {
	var { Queue } = await import('bullmq');
	var { createQueueConnection } = await import('../queues/connection.js');
	var conn = createQueueConnection();
	var result = {};

	for (var name of ['toss', 'maintenance', 'mailer']) {
		var q = new Queue(name, { connection: conn });
		var active = await q.getActive();
		var waiting = await q.getWaiting();
		var delayed = await q.getDelayed();
		var failed = await q.getFailed(0, 10);

		result[name] = {
			active: active.map(function(j) {
				return { id: j.id, name: j.name, started: j.processedOn ? new Date(j.processedOn).toISOString() : null };
			}),
			waiting: waiting.length,
			delayed: delayed.length,
			failed: failed.map(function(j) {
				return { id: j.id, name: j.name, reason: (j.failedReason || '').substring(0, 200), failed_at: j.finishedOn ? new Date(j.finishedOn).toISOString() : null };
			})
		};
		await q.close();
	}

	conn.disconnect();
	res.json(result);
});

// Clean stuck/failed jobs
router.post('/events/clean', express.json(), requireAdmin, async (req, res) => {
	var { Queue } = await import('bullmq');
	var { createQueueConnection } = await import('../queues/connection.js');
	var conn = createQueueConnection();
	var action = req.body.action;
	var queueName = req.body.queue;
	var jobId = req.body.jobId;

	if (!queueName || !['toss', 'maintenance', 'mailer'].includes(queueName)) {
		conn.disconnect();
		return res.json({ status: false, error: 'Invalid queue' });
	}

	var q = new Queue(queueName, { connection: conn });
	var cleaned = 0;

	if (action === 'remove-failed') {
		// Remove all failed jobs
		var failed = await q.getFailed();
		for (var j of failed) {
			await j.remove();
			cleaned++;
		}
	} else if (action === 'retry-failed') {
		// Retry all failed jobs
		var failed = await q.getFailed();
		for (var j of failed) {
			await j.retry();
			cleaned++;
		}
	} else if (action === 'remove-job' && jobId) {
		// Remove a specific job by ID
		var job = await q.getJob(jobId);
		if (job) {
			await job.remove();
			cleaned = 1;
		}
	} else if (action === 'drain') {
		// Remove all waiting jobs
		await q.drain();
		cleaned = -1; // drained
	} else {
		await q.close();
		conn.disconnect();
		return res.json({ status: false, error: 'Unknown action' });
	}

	await q.close();
	conn.disconnect();
	alogger.writeAlog(5, 'Queue clean: ' + action + ' on ' + queueName + (cleaned >= 0 ? ' (' + cleaned + ' jobs)' : ' (drained)'), 'yellow');
	res.json({ status: true, cleaned: cleaned });
});

router.post('/events/trigger', express.json(), requireAdmin, async (req, res) => {
	var job = req.body.job;
	var triggered = null;

	switch (job) {
		// Toss jobs
		case 'ftn:inbound':       await jobs.enqueueFtnInbound(); triggered = 'FTN Inbound'; break;
		case 'ftn:outbound':      await jobs.enqueueFtnOutbound(); triggered = 'FTN Outbound'; break;
		case 'qwk:pull-all':      await jobs.enqueueQwkPullAll(); triggered = 'QWK Pull All'; break;
		case 'qwk:push-all':      await jobs.enqueueQwkPushAll(); triggered = 'QWK Push All'; break;
		case 'nntp:pull-all':     await jobs.enqueueNntpPullAll(); triggered = 'NNTP Pull All'; break;
		case 'nntp:push-all':     await jobs.enqueueNntpPushAll(); triggered = 'NNTP Push All'; break;
		case 'tic:inbound':       await jobs.enqueueTicInbound(); triggered = 'TIC Inbound'; break;
		case 'tic:outbound':      await jobs.enqueueTicOutbound(); triggered = 'TIC Outbound'; break;
		case 'email:outbound':    await jobs.enqueueEmailOutbound(); triggered = 'Email Outbound'; break;
		// Mailer jobs
		case 'bso-scan':          await jobs.enqueueMailerBsoScan(); triggered = 'BSO Scan'; break;
		// Maintenance jobs
		case 'regen-html':        await jobs.enqueueRegenHtml(); triggered = 'Regen Message HTML'; break;
		case 'regen-pm-html':     await jobs.enqueueRegenPmHtml(); triggered = 'Regen PM HTML'; break;
		case 'regen-file-html':   await jobs.enqueueRegenFileDescHtml(); triggered = 'Regen File Desc HTML'; break;
		case 'purge-pm-trash':    await jobs.enqueuePurgePmTrash(); triggered = 'Purge PM Trash'; break;
		case 'recalc-areas':      await jobs.enqueueRecalcAreaCounts(); triggered = 'Recalc Area Counts'; break;
		case 'recalc-files':      await jobs.enqueueRecalcFileCounts(); triggered = 'Recalc File Counts'; break;
		case 'user-maintenance':  await jobs.enqueueUserMaintenance(); triggered = 'User Maintenance'; break;
		case 'file-maintenance':  await jobs.enqueueFileMaintenance(); triggered = 'File Maintenance'; break;
		case 'scan-nodelists':    await jobs.enqueueScanNodelists(); triggered = 'Scan Nodelists'; break;
		case 'purge-tossed':      await jobs.enqueuePurgeTossed(); triggered = 'Purge Tossed Packets'; break;
		case 'purge-bad-echomail': await jobs.enqueuePurgeBadEchomail(); triggered = 'Purge Bad Echomail'; break;
		case 'rethread':          await jobs.enqueueRethread(); triggered = 'Rebuild Threads'; break;
		case 'scan-echolists':      await jobs.enqueueScanEcholists(); triggered = 'Scan Echolists/Filebones'; break;
		case 'reconcile-echolists': await jobs.enqueueReconcileEcholists(); triggered = 'Reconcile Echolists'; break;
		default:
			return res.json({ status: false, error: 'Unknown job' });
	}

	return res.json({ status: true, triggered: triggered });
});

// -------------------------------------------------------
// Message Base Import
// -------------------------------------------------------

router.get('/import/msgbase', async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var areaList         = await msgAreas.getAllAreas();
	res.render('admin/import/msgbase', {
		sufficientAccess: sufficientAccess,
		title: 'Import Message Base',
		activelink: 'import',
		currentuser: currentuser,
		areas: areaList,
		result: null,
		preview: null,
	});
});

router.post('/import/msgbase/preview', multer({ dest: os.tmpdir() }).fields([
	{ name: 'shd_file', maxCount: 1 },
	{ name: 'sdt_file', maxCount: 1 },
	{ name: 'sid_file', maxCount: 1 },
]), requireAdmin, async (req, res) => {
	var smbImport = await import('../maintenance/smbImport.js');
	var areaList = await msgAreas.getAllAreas();

	var shdFile = req.files['shd_file'] ? req.files['shd_file'][0] : null;
	var sdtFile = req.files['sdt_file'] ? req.files['sdt_file'][0] : null;
	var sidFile = req.files['sid_file'] ? req.files['sid_file'][0] : null;

	if (!shdFile || !sdtFile) {
		return res.render('admin/import/msgbase', {
			sufficientAccess: true,
			title: 'Import Message Base',
			activelink: 'import',
			currentuser: await getCurrentUser(req),
			areas: areaList,
			result: null,
			preview: { error: 'Both .shd and .sdt files are required' },
		});
	}

	var preview = smbImport.previewSMB(shdFile.path, sdtFile.path, sidFile ? sidFile.path : null);

	res.render('admin/import/msgbase', {
		sufficientAccess: true,
		title: 'Import Message Base',
		activelink: 'import',
		currentuser: await getCurrentUser(req),
		areas: areaList,
		result: null,
		preview: preview,
		shdPath: shdFile.path,
		sdtPath: sdtFile.path,
		sidPath: sidFile ? sidFile.path : '',
	});
});

router.post('/import/msgbase/run', urlencodedParser, requireAdmin, async (req, res) => {
	var smbImport = await import('../maintenance/smbImport.js');
	var areaList = await msgAreas.getAllAreas();

	var shdPath = req.body.shd_path;
	var sdtPath = req.body.sdt_path;
	var sidPath = req.body.sid_path || null;
	var areaShortcode = req.body.area_shortcode;

	if (!shdPath || !sdtPath || !areaShortcode) {
		return res.render('admin/import/msgbase', {
			sufficientAccess: true,
			title: 'Import Message Base',
			activelink: 'import',
			currentuser: await getCurrentUser(req),
			areas: areaList,
			result: { errors: ['Missing required fields'] },
			preview: null,
		});
	}

	var result = await smbImport.importSMB(shdPath, sdtPath, sidPath, areaShortcode);

	res.render('admin/import/msgbase', {
		sufficientAccess: true,
		title: 'Import Message Base',
		activelink: 'import',
		currentuser: await getCurrentUser(req),
		areas: areaList,
		result: result,
		preview: null,
	});
});

// -------------------------------------------------------
// areas.bbs Import
// -------------------------------------------------------

router.get('/import/areasbbs', requireAdmin, async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var groups           = await msgGroups.getAllGroups();
	var networks         = await msgNetworks.getActiveNetworks();

	res.render('admin/import/areasbbs', {
		sufficientAccess: sufficientAccess,
		title: 'Import areas.bbs',
		activelink: 'import',
		currentuser: currentuser,
		groups: groups,
		networks: networks,
		preview: null,
		result: null
	});
});

router.post('/import/areasbbs/preview', multer({ dest: os.tmpdir() }).single('areasbbs_file'), requireAdmin, async (req, res) => {
	var { parseAreasBbs } = await import('../utils/areasBbsParser.js');
	var groups   = await msgGroups.getAllGroups();
	var networks = await msgNetworks.getActiveNetworks();
	var currentuser = await getCurrentUser(req);

	var groupShortcode = (req.body.group_shortcode || '').trim();
	var networkId      = parseInt(req.body.network_id) || 0;

	if (!req.file || !groupShortcode || !networkId) {
		return res.render('admin/import/areasbbs', {
			sufficientAccess: true, title: 'Import areas.bbs', activelink: 'import',
			currentuser: currentuser, groups: groups, networks: networks, result: null,
			preview: { error: 'File, group, and network are all required.' }
		});
	}

	// Read and parse the file
	var fs = await import('fs');
	var fileText = fs.readFileSync(req.file.path, 'utf8');
	fs.unlinkSync(req.file.path);

	var parsed = parseAreasBbs(fileText);
	if (parsed.length === 0) {
		return res.render('admin/import/areasbbs', {
			sufficientAccess: true, title: 'Import areas.bbs', activelink: 'import',
			currentuser: currentuser, groups: groups, networks: networks, result: null,
			preview: { error: 'No areas found in file.' }
		});
	}

	var group = await msgGroups.getGroupByShortcode(groupShortcode);
	if (!group) {
		return res.render('admin/import/areasbbs', {
			sufficientAccess: true, title: 'Import areas.bbs', activelink: 'import',
			currentuser: currentuser, groups: groups, networks: networks, result: null,
			preview: { error: 'Group not found: ' + groupShortcode }
		});
	}

	// Check which areatags already exist on this network
	var existingNetAreas = await networkAreas.getAreasByNetwork(networkId);
	var existingTags = new Set();
	var mappedAreaIds = new Set();
	if (existingNetAreas) {
		for (var na of existingNetAreas) {
			existingTags.add((na.areatag || '').toUpperCase());
			if (na.area_id) mappedAreaIds.add(na.area_id);
		}
	}

	// Get areas in this group that are NOT already mapped to this network
	var groupAreas = await msgAreas.getListByGroupShortcode(groupShortcode);
	var unmappedAreas = [];
	if (groupAreas) {
		for (var ga of groupAreas) {
			if (!mappedAreaIds.has(ga.id)) {
				unmappedAreas.push({ id: ga.id, shortcode: ga.shortcode, name: ga.name });
			}
		}
	}

	// Build preview list
	var items = [];
	for (var entry of parsed) {
		var tag = entry.areatag.toUpperCase();
		var exists = existingTags.has(tag);
		items.push({
			areatag: entry.areatag,
			description: entry.description,
			exists: exists,
			willCreate: !exists
		});
	}

	var newCount = items.filter(function(i) { return i.willCreate; }).length;
	var skipCount = items.filter(function(i) { return i.exists; }).length;

	res.render('admin/import/areasbbs', {
		sufficientAccess: true, title: 'Import areas.bbs', activelink: 'import',
		currentuser: currentuser, groups: groups, networks: networks, result: null,
		preview: {
			items: items,
			newCount: newCount,
			skipCount: skipCount,
			groupShortcode: groupShortcode,
			groupName: group.name,
			networkId: networkId,
			networkName: (networks.find(function(n) { return n.id === networkId; }) || {}).name || '',
			unmappedAreas: unmappedAreas
		}
	});
});

router.post('/import/areasbbs/run', urlencodedParser, requireAdmin, async (req, res) => {
	var groups   = await msgGroups.getAllGroups();
	var networks = await msgNetworks.getActiveNetworks();
	var currentuser = await getCurrentUser(req);

	var groupShortcode = (req.body.group_shortcode || '').trim();
	var networkId      = parseInt(req.body.network_id) || 0;
	var areatags       = req.body.areatags; // array or string from hidden inputs
	var descriptions   = req.body.descriptions;

	if (!groupShortcode || !networkId || !areatags) {
		return res.render('admin/import/areasbbs', {
			sufficientAccess: true, title: 'Import areas.bbs', activelink: 'import',
			currentuser: currentuser, groups: groups, networks: networks, preview: null,
			result: { errors: ['Missing required fields.'] }
		});
	}

	// Normalize to arrays
	if (!Array.isArray(areatags)) areatags = [areatags];
	if (!Array.isArray(descriptions)) descriptions = descriptions ? [descriptions] : [];

	var group = await msgGroups.getGroupByShortcode(groupShortcode);
	if (!group) {
		return res.render('admin/import/areasbbs', {
			sufficientAccess: true, title: 'Import areas.bbs', activelink: 'import',
			currentuser: currentuser, groups: groups, networks: networks, preview: null,
			result: { errors: ['Group not found.'] }
		});
	}

	// Build per-area flags from form checkboxes.
	// The form has selected_N, allow_N, enable_N for each row.
	// Only areatags with non-disabled hidden inputs arrive here (JS disables unchecked rows).
	// Map the sequential areatags array to the per-row checkbox values.
	var allowFlags = {};
	var enableFlags = {};
	for (var key of Object.keys(req.body)) {
		if (key.startsWith('allow_')) allowFlags[key] = true;
		if (key.startsWith('enable_')) enableFlags[key] = true;
	}

	var created = [];
	var errors = [];

	for (var i = 0; i < areatags.length; i++) {
		var areatag = areatags[i].trim();
		if (!areatag) continue;

		var desc = (descriptions[i] || areatag).trim();
		var doAllow  = !!allowFlags['allow_' + i];
		var doEnable = !!enableFlags['enable_' + i];
		var action   = (req.body['action_' + i] || 'create').trim();

		// Action: map_<areaId> = map an existing area to this network
		if (action.startsWith('map_')) {
			var mapAreaId = parseInt(action.substring(4));
			if (!mapAreaId) {
				errors.push(areatag + ': invalid area ID for mapping');
				continue;
			}

			// Check not already mapped
			var existingMapping = await networkAreas.getNetworkArea(networkId, mapAreaId);
			if (existingMapping) {
				continue; // already mapped, skip silently
			}

			var mapResult = await networkAreas.addAreaToNetwork(networkId, mapAreaId, areatag, {
				createdByUUID: currentuser.uuid || '',
				createdByName: currentuser.username || ''
			});
			if (mapResult.status) {
				await peerAreaSubscriptions.syncNetworkAreaToConnections(networkId, mapAreaId, {
					allowAll: doAllow,
					enableAll: doEnable
				});
				// Look up the area to get its shortcode for display
				var areaRow = await postgres.queryOne('SELECT shortcode FROM message_areas WHERE id = $1', [mapAreaId]);
				created.push({ areatag: areatag, shortcode: areaRow ? areaRow.shortcode : String(mapAreaId), action: 'mapped' });
			} else {
				errors.push(areatag + ': ' + mapResult.errormessages.join(', '));
			}
			continue;
		}

		// Action: create = create new area
		// Generate shortcode from areatag: uppercase, replace non-alphanumeric with _
		var shortcode = areatag.toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 64);

		// Check for shortcode collision -- if it exists and is already mapped, skip
		var existingArea = await msgAreas.getAreaByShortcode(shortcode);
		if (existingArea) {
			var existingNetMapping = await networkAreas.getNetworkArea(networkId, existingArea.id);
			if (existingNetMapping) continue;

			// Shortcode exists but not on this network -- add the mapping
			var scMapResult = await networkAreas.addAreaToNetwork(networkId, existingArea.id, areatag, {
				createdByUUID: currentuser.uuid || '',
				createdByName: currentuser.username || ''
			});
			if (scMapResult.status) {
				await peerAreaSubscriptions.syncNetworkAreaToConnections(networkId, existingArea.id, {
					allowAll: doAllow,
					enableAll: doEnable
				});
				created.push({ areatag: areatag, shortcode: shortcode, action: 'mapped (shortcode existed)' });
			} else {
				errors.push(areatag + ': ' + scMapResult.errormessages.join(', '));
			}
			continue;
		}

		// Create new area inheriting group permissions
		var formObj = {
			groupshortcode: groupShortcode,
			name: desc || areatag,
			description: desc || areatag,
			shortcode: shortcode,
			readsecurity: group.read_security || 0,
			postsecurity: group.post_security || 0,
			minage: group.min_age || 0,
			maxage: group.max_age || 255,
			read_perm_flags: group.read_perm_flags || '[]',
			read_rest_flags: group.read_rest_flags || '[]',
			post_perm_flags: group.post_perm_flags || '[]',
			post_rest_flags: group.post_rest_flags || '[]',
			network_id: networkId,
			areatag: areatag,
			createdByUUID: currentuser.uuid || '',
			createdByName: currentuser.username || ''
		};

		var areaResult = await msgAreas.newArea(formObj);
		if (areaResult.status) {
			if (doAllow || doEnable) {
				var newArea = await msgAreas.getAreaByShortcode(shortcode);
				if (newArea) {
					await peerAreaSubscriptions.syncNetworkAreaToConnections(networkId, newArea.id, {
						allowAll: doAllow,
						enableAll: doEnable
					});
				}
			}
			created.push({ areatag: areatag, shortcode: shortcode, action: 'created' });
		} else {
			errors.push(areatag + ': ' + areaResult.errormessages.join(', '));
		}
	}

	res.render('admin/import/areasbbs', {
		sufficientAccess: true, title: 'Import areas.bbs', activelink: 'import',
		currentuser: currentuser, groups: groups, networks: networks, preview: null,
		result: { created: created, errors: errors }
	});
});

// areas.bbs export (download)
router.get('/export/areasbbs/:networkId', requireAdmin, async (req, res) => {
	var networkId = parseInt(req.params.networkId);
	var areas = await networkAreas.getAreasByNetwork(networkId);
	if (!areas || areas.length === 0) {
		return res.status(404).send('No areas on this network');
	}

	var network = await msgNetworks.getNetworkById(networkId);
	var networkName = network ? network.name : 'network-' + networkId;

	var { generateAreasBbs } = await import('../utils/areasBbsParser.js');
	var areaList = areas.map(function(a) {
		return { areatag: a.areatag, description: a.area_name || a.shortcode || '' };
	});

	var bbsName = appConfig.get('boardname', 'Canectic BBS');
	var text = generateAreasBbs(areaList, bbsName + ' -- ' + networkName);

	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Disposition', 'attachment; filename="areas-' + networkName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.bbs"');
	res.send(text);
});

// files.bbs export (download) -- file network areas
router.get('/export/filesbbs/:networkId', requireAdmin, async (req, res) => {
	var networkId = parseInt(req.params.networkId);
	var fileNetAreas = await import('../models/fileNetworkAreas.js');
	var areas = await fileNetAreas.getMappingsForNetwork(networkId);
	if (!areas || areas.length === 0) {
		return res.status(404).send('No file areas on this network');
	}

	var network = await msgNetworks.getNetworkById(networkId);
	var networkName = network ? network.name : 'network-' + networkId;

	var { generateAreasBbs } = await import('../utils/areasBbsParser.js');
	var areaList = areas.map(function(a) {
		return { areatag: a.areatag, description: a.area_name || a.shortcode || '' };
	});

	var bbsName = appConfig.get('boardname', 'Canectic BBS');
	var text = generateAreasBbs(areaList, bbsName + ' -- ' + networkName + ' (files)');

	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Disposition', 'attachment; filename="files-' + networkName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.bbs"');
	res.send(text);
});

// -------------------------------------------------------
// Migrations hub
// -------------------------------------------------------

router.get('/migrations', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	res.render('admin/migrations', {
		sufficientAccess: sufficientAccess, title: 'Migrations',
		activelink: 'migrations', currentuser: currentuser
	});
});

// -------------------------------------------------------
// sbbsecho.ini import (Synchronet linked nodes)
// -------------------------------------------------------

// Step 0: Upload form
router.get('/import/sbbsecho', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	res.render('admin/import/sbbsecho', {
		sufficientAccess: sufficientAccess, title: 'Import sbbsecho.ini',
		activelink: 'import', currentuser: currentuser,
		step: 'upload', preview: null, result: null, parsedData: null,
		networks: [], existingPeers: [], systemAddresses: [], networkResult: null
	});
});

// Step 1: Parse file -> show network mapping
router.post('/import/sbbsecho/preview', multer({ dest: os.tmpdir() }).single('sbbsecho_file'), requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var base = { sufficientAccess: sufficientAccess, title: 'Import sbbsecho.ini', activelink: 'import', currentuser: currentuser, result: null, networkResult: null };

	if (!req.file) {
		return res.render('admin/import/sbbsecho', Object.assign(base, {
			step: 'upload', preview: { error: 'No file uploaded.' }, parsedData: null,
			networks: [], existingPeers: [], systemAddresses: []
		}));
	}

	var fileText = '';
	try {
		fileText = fs.readFileSync(req.file.path, 'utf8');
	} finally {
		try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
	}

	var { parseSbbsecho } = await import('../utils/sbbsechoParser.js');
	var parsed = parseSbbsecho(fileText);

	if (parsed.nodes.length === 0) {
		return res.render('admin/import/sbbsecho', Object.assign(base, {
			step: 'upload', preview: { error: 'No linked nodes found in the file.' }, parsedData: null,
			networks: [], existingPeers: [], systemAddresses: []
		}));
	}

	// Annotate domains with node counts
	var domainCounts = {};
	for (var n of parsed.nodes) {
		if (n.domain) domainCounts[n.domain] = (domainCounts[n.domain] || 0) + 1;
	}
	for (var d of parsed.domains) {
		d.node_count = domainCounts[d.name] || 0;
	}

	var networkList = await msgNetworks.getActiveNetworks();

	// Extract unique local addresses per domain and check which exist
	var addrList = await systemAddresses.getActiveAddresses();
	var addrSet = new Set((addrList || []).map(function(a) { return a.address + '@' + (a.domain || ''); }));
	var localAddrMap = {};
	for (var node of parsed.nodes) {
		if (!node.local_address || !node.domain) continue;
		var key = node.local_address + '@' + node.domain;
		if (!localAddrMap[key]) {
			localAddrMap[key] = {
				address: node.local_address,
				domain: node.domain,
				exists: addrSet.has(key)
			};
		}
	}
	var localAddresses = Object.values(localAddrMap).sort(function(a, b) {
		return a.domain.localeCompare(b.domain) || a.address.localeCompare(b.address);
	});

	res.render('admin/import/sbbsecho', Object.assign(base, {
		step: 'networks',
		preview: { nodes: parsed.nodes, domains: parsed.domains, groups: parsed.groups },
		parsedData: parsed,
		networks: networkList || [],
		localAddresses: localAddresses,
		existingPeers: [], systemAddresses: []
	}));
});

// Step 1b: Process network mappings -> show peer grouping
router.post('/import/sbbsecho/networks', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var base = { sufficientAccess: sufficientAccess, title: 'Import sbbsecho.ini', activelink: 'import', currentuser: currentuser, result: null, preview: null };

	var parsed;
	try {
		parsed = JSON.parse(req.body.parsed_data);
	} catch (e) {
		return res.render('admin/import/sbbsecho', Object.assign(base, {
			step: 'upload', preview: { error: 'Invalid parsed data. Please re-upload.' }, parsedData: null,
			networks: [], existingPeers: [], systemAddresses: [], networkResult: null
		}));
	}

	// Process network mappings from form fields (network_<domain>)
	var createdNets = [];
	var skippedNets = [];
	var createdAddrs = [];
	var errors = [];

	// Build a lookup of domain -> zone numbers from parsed data
	var domainZones = {};
	for (var pd of parsed.domains) {
		domainZones[pd.name] = pd.zones || [];
	}

	for (var d = 0; d < parsed.domains.length; d++) {
		var domain = parsed.domains[d].name;
		var mapping = req.body['network_' + domain] || 'skip';

		if (mapping === 'skip') {
			skippedNets.push(domain);
			continue;
		}

		if (mapping === 'new') {
			var netResult = await msgNetworks.newNetwork({
				name: domain.charAt(0).toUpperCase() + domain.slice(1),
				domain: domain,
				description: 'Imported from sbbsecho.ini',
				network_type: 'FTN',
				createdByUUID: currentuser.uuid,
				createdByName: currentuser.username
			});
			if (netResult.status) {
				createdNets.push(domain);
				// Create zones for the new network from parsed domain data
				var zones = domainZones[domain] || [];
				for (var z = 0; z < zones.length; z++) {
					await msgZones.newZone({
						network_id: netResult.insertId,
						zone_number: zones[z],
						name: 'Zone ' + zones[z],
						createdByName: currentuser.username,
						createdByUUID: currentuser.uuid
					});
				}
			} else {
				var existing = await msgNetworks.getNetworkByDomain(domain);
				if (existing) {
					createdNets.push(domain + ' (already existed)');
				} else {
					errors.push('Failed to create network "' + domain + '": ' + netResult.errormessages.join(', '));
				}
			}
		}
		// mapping is an existing network ID -- nothing to do
	}

	// Process local address creation from form fields (addr_<address>_<domain>)
	// Collect unique addr+domain keys from parsed nodes
	var addrKeys = {};
	for (var node of parsed.nodes) {
		if (!node.local_address || !node.domain) continue;
		var akey = node.local_address + '_' + node.domain;
		addrKeys[akey] = { address: node.local_address, domain: node.domain };
	}

	for (var akey in addrKeys) {
		if (!addrKeys.hasOwnProperty(akey)) continue;
		var action = req.body['addr_' + akey] || 'skip';
		if (action === 'create') {
			var addrInfo = addrKeys[akey];
			// Look up the network for this domain (may have just been created)
			var addrNetwork = await msgNetworks.getNetworkByDomain(addrInfo.domain);
			if (!addrNetwork) {
				// Domain was skipped or failed to create
				continue;
			}
			var addrResult = await systemAddresses.newAddress({
				address: addrInfo.address,
				network_id: addrNetwork.id,
				createdByName: currentuser.username,
				createdByUUID: currentuser.uuid
			});
			if (addrResult.status) {
				createdAddrs.push(addrInfo.address + '@' + addrInfo.domain);
			} else {
				errors.push('Address ' + addrInfo.address + '@' + addrInfo.domain + ': ' + addrResult.errormessages.join(', '));
			}
		}
	}

	// Fetch fresh data for peer step (includes any just-created networks and addresses)
	var networkList = await msgNetworks.getActiveNetworks();
	var peerList = await peers.getAllPeers();
	var addrList = await systemAddresses.getActiveAddresses();

	res.render('admin/import/sbbsecho', Object.assign(base, {
		step: 'peers',
		parsedData: parsed,
		networks: (networkList || []).map(function(n) { return { id: n.id, name: n.name, domain: n.domain }; }),
		existingPeers: (peerList || []).map(function(p) { return { id: p.id, name: p.name, sysop_name: p.sysop_name || '' }; }),
		systemAddresses: (addrList || []).map(function(a) { return { id: a.id, address: a.address, domain: a.domain || '', network_id: a.network_id }; }),
		networkResult: { created: createdNets, skipped: skippedNets, createdAddrs: createdAddrs, errors: errors }
	}));
});

// Step 2: Import peers and connections
router.post('/import/sbbsecho/run', urlencodedParser, requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var base = { sufficientAccess: sufficientAccess, title: 'Import sbbsecho.ini', activelink: 'import', currentuser: currentuser, preview: null, step: 'result', parsedData: null, networks: [], existingPeers: [], systemAddresses: [], networkResult: null };

	var importData;
	try {
		importData = JSON.parse(req.body.import_data);
	} catch (e) {
		return res.render('admin/import/sbbsecho', Object.assign(base, {
			result: { errors: ['Invalid import data.'], created_peers: [], mapped_peers: [], created_connections: 0 }
		}));
	}

	var errors = [];
	var createdPeers = [];
	var mappedPeers = [];
	var createdConnections = 0;
	var nodes = importData.nodes || [];

	for (var g = 0; g < importData.groups.length; g++) {
		var group = importData.groups[g];
		var peerId;

		if (group.existing_peer_id) {
			peerId = parseInt(group.existing_peer_id);
			mappedPeers.push(group.peer_name || ('Peer #' + peerId));
		} else {
			var peerResult = await peers.newPeer({
				name: group.peer_name || 'Imported Peer',
				sysop_name: group.sysop_name || '',
				createdByUUID: currentuser.uuid,
				createdByName: currentuser.username
			});
			if (peerResult.status) {
				peerId = peerResult.insertId;
				createdPeers.push(group.peer_name || 'Imported Peer');
			} else {
				errors.push('Failed to create peer "' + group.peer_name + '": ' + peerResult.errormessages.join(', '));
				continue;
			}
		}

		for (var c = 0; c < group.nodes.length; c++) {
			var nodeRef = group.nodes[c];
			var node = nodes[nodeRef.node_idx];
			if (!node) {
				errors.push('Node index ' + nodeRef.node_idx + ' not found');
				continue;
			}

			var networkId = nodeRef.network_id ? parseInt(nodeRef.network_id) : null;
			if (!networkId) {
				errors.push('No network selected for ' + node.ftn_address);
				continue;
			}

			var connResult = await peerConnections.newConnection({
				peer_id: peerId,
				network_id: networkId,
				connection_type: 'FTN',
				system_address_id: nodeRef.system_address_id || null,
				poll_enabled: node.binkp_poll === true,
				address: node.ftn_address,
				remote_host: node.binkp_host || '',
				remote_port: node.binkp_port || null,
				session_password: node.session_password || '',
				packet_password: node.packet_password || '',
				tic_password: node.tic_password || '',
				areafix_password: node.areafix_password || '',
				direct: node.direct ? 'Yes' : 'No',
				status: node.status || 'NORMAL',
				route_to: node.route || '',
				createdByUUID: currentuser.uuid,
				createdByName: currentuser.username
			});

			if (connResult.status) {
				createdConnections++;
			} else {
				errors.push('Connection ' + node.ftn_address + ': ' + connResult.errormessages.join(', '));
			}
		}
	}

	res.render('admin/import/sbbsecho', Object.assign(base, {
		result: {
			created_peers: createdPeers,
			mapped_peers: mappedPeers,
			created_connections: createdConnections,
			errors: errors
		}
	}));
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

router.post('/announcements/reorder', express.json(), requireAdmin, async (req, res) => {
	var ids = req.body.ids;
	if (typeof ids === 'string') {
		try { ids = JSON.parse(ids); } catch (_) { ids = []; }
	}
	if (Array.isArray(ids) && ids.length > 0) {
		await announcements.updateSortOrder(ids);
	}
	res.json({ status: true });
});

// -------------------------------------------------------
// Bulletins
// -------------------------------------------------------

router.get('/bulletins', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var bulletinList = await bulletins.getAllBulletins();

	res.render('admin/bulletins/index', {
		sufficientAccess: sufficientAccess,
		title: 'Bulletins',
		activelink: 'bulletins',
		currentuser: currentuser,
		bulletins: bulletinList
	});
});

router.post('/bulletins/new', urlencodedParser, requireAdmin, async (req, res) => {
	var result = await bulletins.createBulletin(req.body);
	if (result.status) {
		res.redirect('/admin/bulletins');
	} else {
		var currentuser = await getCurrentUser(req);
		var sufficientAccess = checkAdminAccess(currentuser);
		var bulletinList = await bulletins.getAllBulletins();
		res.render('admin/bulletins/index', {
			sufficientAccess: sufficientAccess,
			title: 'Bulletins',
			activelink: 'bulletins',
			currentuser: currentuser,
			bulletins: bulletinList,
			errormessages: result.errormessages
		});
	}
});

router.post('/bulletins/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	await bulletins.updateBulletin(parseInt(req.params.id), req.body);
	res.redirect('/admin/bulletins');
});

router.post('/bulletins/delete/:id', urlencodedParser, requireAdmin, async (req, res) => {
	await bulletins.deleteBulletin(parseInt(req.params.id));
	res.redirect('/admin/bulletins');
});

router.post('/bulletins/reorder', express.json(), requireAdmin, async (req, res) => {
	var ids = req.body.ids;
	if (typeof ids === 'string') {
		try { ids = JSON.parse(ids); } catch (_) { ids = []; }
	}
	if (Array.isArray(ids) && ids.length > 0) {
		await bulletins.updateSortOrder(ids);
	}
	res.json({ status: true });
});

// -------------------------------------------------------
// News Files
// -------------------------------------------------------

router.get('/newsfiles', requireAdmin, async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var fileList         = await newsFiles.getAllNewsFiles();
	res.render('admin/newsfiles/index', {
		sufficientAccess: sufficientAccess,
		title: 'News Files',
		activelink: 'newsfiles',
		currentuser: currentuser,
		newsfiles: fileList
	});
});

router.post('/newsfiles/new', urlencodedParser, requireAdmin, async (req, res) => {
	await newsFiles.createNewsFile(req.body);
	res.redirect('/admin/newsfiles');
});

router.post('/newsfiles/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	await newsFiles.updateNewsFile(id, req.body);
	res.redirect('/admin/newsfiles');
});

router.post('/newsfiles/delete/:id', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	await newsFiles.deleteNewsFile(id);
	res.redirect('/admin/newsfiles');
});

router.post('/newsfiles/reorder', express.json(), requireAdmin, async (req, res) => {
	var ids = req.body.ids;
	if (typeof ids === 'string') {
		try { ids = JSON.parse(ids); } catch (_) { ids = []; }
	}
	if (Array.isArray(ids) && ids.length > 0) {
		await newsFiles.updateSortOrder(ids);
	}
	res.json({ status: true });
});

// -------------------------------------------------------
// FREQ (File Requests)
// -------------------------------------------------------

router.get('/freq', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var magicAliases = await freqModel.getAllMagic();

	// Get FTN connections for the request form
	var ftnConns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
	var connections = [];
	if (ftnConns) {
		for (var c of ftnConns) {
			var cd = c.connection_data;
			if (typeof cd === 'string') { try { cd = JSON.parse(cd); } catch (_) { cd = {}; } }
			connections.push({ id: c.id, peer_name: c.peer_name, connection_data: cd });
		}
	}

	// Filebox listing
	var fileboxDir = appConfig.get('freq_filebox_dir', 'ftn/filebox');
	var fileboxFiles = [];
	try {
		var fsList = (await import('fs')).default || await import('fs');
		if (fsList.existsSync(fileboxDir)) {
			var names = fsList.readdirSync(fileboxDir);
			for (var fname of names) {
				var fpath = fileboxDir + '/' + fname;
				var stat = fsList.statSync(fpath);
				if (stat.isFile() && !fname.startsWith('_')) {
					fileboxFiles.push({ name: fname, size: Math.round(stat.size / 1024) + ' KB' });
				}
			}
		}
	} catch (_) {}

	res.render('admin/freq/index', {
		sufficientAccess: sufficientAccess,
		title: 'File Requests (FREQ)',
		activelink: 'freq',
		currentuser: currentuser,
		magicAliases: magicAliases,
		connections: connections,
		fileboxDir: fileboxDir,
		fileboxFiles: fileboxFiles
	});
});

router.post('/freq/magic/new', urlencodedParser, requireAdmin, async (req, res) => {
	await freqModel.createMagic(req.body);
	res.redirect('/admin/freq');
});

router.post('/freq/magic/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	await freqModel.updateMagic(parseInt(req.params.id), req.body);
	res.redirect('/admin/freq');
});

router.post('/freq/magic/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	await freqModel.deleteMagic(parseInt(req.params.id));
	res.redirect('/admin/freq');
});

router.post('/freq/request', urlencodedParser, requireAdmin, async (req, res) => {
	var connectionId = parseInt(req.body.connection_id);
	var filenames = (req.body.filenames || '').split(/\r?\n/).map(function(f) { return f.trim(); }).filter(Boolean);

	if (connectionId && filenames.length > 0) {
		var conn = await peerConnections.getConnectionById(connectionId);
		if (conn) {
			var cd = conn.connection_data;
			if (typeof cd === 'string') { try { cd = JSON.parse(cd); } catch (_) { cd = {}; } }
			var addr = cd.address || '';
			if (addr) {
				var parts = addr.split(':');
				var netNode = parts[1] ? parts[1].split('/') : [];
				var destNet = parseInt(netNode[0]) || 0;
				var destNode = parseInt(netNode[1]) || 0;
				if (destNet && destNode) {
					freqModel.createReqFile(destNet, destNode, filenames);
				}
			}
		}
	}

	res.redirect('/admin/freq');
});

// -------------------------------------------------------
// Inbound Wildcards
// -------------------------------------------------------

router.get('/wildcards', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var rules = await fileWildcards.getAll();
	res.render('admin/wildcards/index', {
		sufficientAccess: sufficientAccess,
		title: 'Inbound Wildcards',
		activelink: 'wildcards',
		activenav: 'networks',
		currentuser: currentuser,
		rules: rules
	});
});

router.post('/wildcards/new', urlencodedParser, requireAdmin, async (req, res) => {
	await fileWildcards.create(req.body);
	res.redirect('/admin/wildcards');
});

router.post('/wildcards/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	await fileWildcards.update(parseInt(req.params.id), req.body);
	res.redirect('/admin/wildcards');
});

router.post('/wildcards/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	await fileWildcards.remove(parseInt(req.params.id));
	res.redirect('/admin/wildcards');
});

router.post('/wildcards/reorder', express.json(), requireAdmin, async (req, res) => {
	if (req.body && Array.isArray(req.body.ids)) {
		await fileWildcards.reorder(req.body.ids);
	}
	res.json({ status: true });
});

router.post('/wildcards/test', express.json(), requireAdmin, async (req, res) => {
	var filename = req.body && req.body.filename;
	if (!filename) {
		return res.json({ match: false, message: 'No filename provided' });
	}
	var rules = await fileWildcards.getActive();
	var match = await fileWildcards.matchFilename(filename, rules);
	if (match) {
		res.json({ match: true, pattern: match.pattern, target_dir: match.target_dir, still_toss: match.still_toss });
	} else {
		res.json({ match: false, message: 'No match -- file would go to default inbound directory' });
	}
});

// -------------------------------------------------------
// Bad Echomail
// -------------------------------------------------------

router.get('/bad-echomail', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var tags = await badEchomail.getAllTags();
	res.render('admin/badEchomail/index', {
		sufficientAccess, title: 'Bad Echomail', activelink: 'bad-echomail',
		activenav: 'messages', currentuser, tags
	});
});

router.get('/bad-echomail/:areatag', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var areatag = req.params.areatag.toUpperCase().trim();
	var messages = await badEchomail.getMessagesForTag(areatag, 200);
	var count = await badEchomail.getCountForTag(areatag);
	res.render('admin/badEchomail/view', {
		sufficientAccess, title: 'Bad Echomail: ' + areatag, activelink: 'bad-echomail',
		activenav: 'messages', currentuser, areatag, messages, count
	});
});

router.post('/bad-echomail/:areatag/recover', urlencodedParser, requireAdmin, async (req, res) => {
	var areatag = req.params.areatag.toUpperCase().trim();
	var echomail = await import('../models/echomail.js');
	var result = await badEchomail.recoverMessages(areatag, echomail);
	await flash.setOne(req, 'success',
		'Recovered ' + result.recovered + ' message(s), ' + result.dupes + ' dupe(s), ' + result.remaining + ' remaining.'
	);
	res.redirect('/admin/bad-echomail');
});

router.post('/bad-echomail/:areatag/purge', urlencodedParser, requireAdmin, async (req, res) => {
	var areatag = req.params.areatag.toUpperCase().trim();
	var purged = await badEchomail.purgeTag(areatag);
	await flash.setOne(req, 'info', 'Purged ' + purged + ' message(s) for ' + areatag);
	res.redirect('/admin/bad-echomail');
});

// -------------------------------------------------------
// Network Coordinator — Managed Nodes
// -------------------------------------------------------

// Segments overview for a network
router.get('/coordinator/:networkId', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var networkId = parseInt(req.params.networkId);
	var network = await msgNetworks.getNetworkById(networkId);
	var segments = await coordinatorSegments.getByNetwork(networkId);

	// Attach node counts per segment
	for (var seg of segments) {
		seg._stats = await managedNodes.getStats(null, seg.id);
	}

	var connections = await peerConnections.getConnectionsByNetwork(networkId);
	res.render('admin/coordinator/index', {
		sufficientAccess, title: 'Network Coordinator', activelink: 'coordinator',
		activenav: 'networks', currentuser, network, segments, connections,
		validRoles: coordinatorSegments.VALID_ROLES,
		roleLabels: coordinatorSegments.ROLE_LABELS,
		distributionMethods: coordinatorSegments.DISTRIBUTION_METHODS
	});
});

router.post('/coordinator/:networkId/segments/new', urlencodedParser, requireAdmin, async (req, res) => {
	req.body.network_id = parseInt(req.params.networkId);
	var result = await coordinatorSegments.create(req.body);
	if (result.status && result.insertId) {
		var seg = await coordinatorSegments.getById(result.insertId);
		if (seg && seg.schedule && seg.schedule !== 'manual' && seg.active) {
			await updateSegmentSchedule(seg.id, seg.schedule, true);
		}
	}
	res.redirect('/admin/coordinator/' + req.params.networkId);
});

router.post('/coordinator/segments/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	var seg = await coordinatorSegments.getById(id);
	await coordinatorSegments.update(id, req.body);
	var updated = await coordinatorSegments.getById(id);
	if (updated) {
		await updateSegmentSchedule(id, updated.schedule, updated.active);
	}
	res.redirect('/admin/coordinator/' + (seg ? seg.network_id : 0));
});

router.post('/coordinator/segments/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	var seg = await coordinatorSegments.getById(id);
	await removeSegmentSchedule(id);
	await coordinatorSegments.remove(id);
	res.redirect('/admin/coordinator/' + (seg ? seg.network_id : 0));
});

// Nodes within a segment
router.get('/coordinator/segment/:segmentId/nodes', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var segmentId = parseInt(req.params.segmentId);
	var segment = await coordinatorSegments.getById(segmentId);
	if (!segment) return res.redirect('/admin/networks');
	var network = await msgNetworks.getNetworkById(segment.network_id);
	var nodes = await managedNodes.getBySegment(segmentId);
	var stats = await managedNodes.getStats(null, segmentId);
	res.render('admin/coordinator/nodes', {
		sufficientAccess, title: 'Managed Nodes', activelink: 'coordinator',
		activenav: 'networks', currentuser, network, segment, nodes, stats,
		validKeywords: managedNodes.VALID_KEYWORDS,
		commonFlags: managedNodes.COMMON_FLAGS
	});
});

router.post('/coordinator/segment/:segmentId/nodes/new', urlencodedParser, requireAdmin, async (req, res) => {
	var segmentId = parseInt(req.params.segmentId);
	var segment = await coordinatorSegments.getById(segmentId);
	if (segment) {
		req.body.network_id = segment.network_id;
		req.body.segment_id = segmentId;
	}
	await managedNodes.create(req.body);
	res.redirect('/admin/coordinator/segment/' + segmentId + '/nodes');
});

router.post('/coordinator/nodes/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	var node = await managedNodes.getById(id);
	await managedNodes.update(id, req.body);
	var redirectTo = node && node.segment_id
		? '/admin/coordinator/segment/' + node.segment_id + '/nodes'
		: '/admin/coordinator/' + (node ? node.network_id : 0);
	res.redirect(redirectTo);
});

router.post('/coordinator/nodes/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	var node = await managedNodes.getById(id);
	await managedNodes.remove(id);
	var redirectTo = node && node.segment_id
		? '/admin/coordinator/segment/' + node.segment_id + '/nodes'
		: '/admin/coordinator/' + (node ? node.network_id : 0);
	res.redirect(redirectTo);
});

// Stub preview and download (per-segment)
router.get('/coordinator/segment/:segmentId/stub', requireAdmin, async (req, res) => {
	var segmentId = parseInt(req.params.segmentId);
	var segment = await coordinatorSegments.getById(segmentId);
	var stub = await managedNodes.generateStub(segment ? segment.network_id : 0, segmentId);
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Content-Disposition', 'inline; filename="' + (segment ? segment.name : 'segment') + '.txt"');
	res.send(stub);
});

router.get('/coordinator/segment/:segmentId/stub/download', requireAdmin, async (req, res) => {
	var segmentId = parseInt(req.params.segmentId);
	var segment = await coordinatorSegments.getById(segmentId);
	var stub = await managedNodes.generateStub(segment ? segment.network_id : 0, segmentId);
	var now = new Date();
	var dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
	var filename = (segment && segment.stub_filename ? segment.stub_filename : 'SEGMENT') + '.' + String(dayOfYear).padStart(3, '0');
	res.setHeader('Content-Type', 'application/octet-stream');
	res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
	res.send(stub);
});

// Manual generate + distribute
router.post('/coordinator/segment/:segmentId/generate', urlencodedParser, requireAdmin, async (req, res) => {
	var segmentId = parseInt(req.params.segmentId);
	var seg = await coordinatorSegments.getById(segmentId);
	await maintenanceQueue.add('generate-stub', { segmentId: segmentId }, {
		jobId: 'generate-stub-manual-' + segmentId + '-' + Date.now(),
		removeOnComplete: true, removeOnFail: true
	});
	await flash.setOne(req, 'info', 'Stub generation queued for ' + (seg ? seg.name : 'segment'));
	res.redirect('/admin/coordinator/' + (seg ? seg.network_id : 0));
});

// -------------------------------------------------------
// Inbound File Log
// -------------------------------------------------------

router.get('/inbound-log', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var entries = await inboundFileLog.getRecent(500);
	res.render('admin/inboundLog/index', {
		sufficientAccess, title: 'Inbound File Log', activelink: 'inbound-log',
		activenav: 'networks', currentuser, entries
	});
});

// -------------------------------------------------------
// Call Flows
// -------------------------------------------------------

router.get('/callflows', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var flows = await callFlowsModel.getAllFlows();
	var pools = await callFlowsModel.getAllPools();
	var availableStages = callFlowsModel.getAvailableStages();
	res.render('admin/callflows/index', {
		sufficientAccess, title: 'Call Flows', activelink: 'callflows', activenav: 'system',
		currentuser, flows, pools, availableStages
	});
});

router.post('/callflows/new', urlencodedParser, requireAdmin, async (req, res) => {
	await callFlowsModel.createFlow(req.body);
	res.redirect('/admin/callflows');
});

router.post('/callflows/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	await callFlowsModel.updateFlow(parseInt(req.params.id), req.body);
	res.redirect('/admin/callflows');
});

router.post('/callflows/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	await callFlowsModel.deleteFlow(parseInt(req.params.id));
	res.redirect('/admin/callflows');
});

router.post('/callflows/:id/stages', express.json(), requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	if (req.body && Array.isArray(req.body.stages)) {
		await callFlowsModel.updateFlow(id, { stages: req.body.stages });
	}
	res.json({ status: true });
});

router.post('/callpools/new', urlencodedParser, requireAdmin, async (req, res) => {
	await callFlowsModel.createPool(req.body);
	res.redirect('/admin/callflows');
});

router.post('/callpools/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	await callFlowsModel.updatePool(parseInt(req.params.id), req.body);
	res.redirect('/admin/callflows');
});

router.post('/callpools/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	await callFlowsModel.deletePool(parseInt(req.params.id));
	res.redirect('/admin/callflows');
});

// -------------------------------------------------------
// Timed Events
// -------------------------------------------------------

router.get('/timed-events', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var events = await timedEvents.getAll();
	res.render('admin/timedEvents/index', {
		sufficientAccess: sufficientAccess,
		title: 'Timed Events',
		activelink: 'timed-events',
		activenav: 'system',
		currentuser: currentuser,
		events: events,
		launchTypes: timedEvents.LAUNCH_TYPE_LABELS,
		variableList: getVariableList()
	});
});

router.post('/timed-events/new', urlencodedParser, requireAdmin, async (req, res) => {
	var result = await timedEvents.create(req.body);
	if (result.status && result.insertId) {
		var evt = await timedEvents.getById(result.insertId);
		if (evt && evt.active) {
			await updateTimedEventSchedule(evt.id, evt.cron_pattern, true);
		}
	}
	res.redirect('/admin/timed-events');
});

router.post('/timed-events/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	var result = await timedEvents.update(id, req.body);
	if (result.status) {
		var evt = await timedEvents.getById(id);
		if (evt) {
			await updateTimedEventSchedule(evt.id, evt.cron_pattern, evt.active);
		}
	}
	res.redirect('/admin/timed-events');
});

router.post('/timed-events/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	await removeTimedEventSchedule(id);
	await timedEvents.remove(id);
	res.redirect('/admin/timed-events');
});

router.post('/timed-events/:id/run', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	await maintenanceQueue.add('timed-event', { eventId: id }, {
		jobId: 'timed-event-manual-' + id + '-' + Date.now(),
		removeOnComplete: true, removeOnFail: true
	});
	res.redirect('/admin/timed-events');
});

// -------------------------------------------------------
// Seasonal Art
// -------------------------------------------------------

router.get('/seasonal-art', requireAdmin, async (req, res) => {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var seasons          = await seasonalArt.getAllSeasons();
	res.render('admin/seasonalArt/index', {
		sufficientAccess: sufficientAccess,
		title: 'Seasonal Art',
		activelink: 'seasonalart',
		currentuser: currentuser,
		seasons: seasons
	});
});

router.post('/seasonal-art/new', urlencodedParser, requireAdmin, async (req, res) => {
	await seasonalArt.createSeason(req.body);
	await seasonalArt.refreshSeasonCache();
	res.redirect('/admin/seasonal-art');
});

router.post('/seasonal-art/:id/update', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	await seasonalArt.updateSeason(id, req.body);
	await seasonalArt.refreshSeasonCache();
	res.redirect('/admin/seasonal-art');
});

router.post('/seasonal-art/:id/delete', urlencodedParser, requireAdmin, async (req, res) => {
	var id = parseInt(req.params.id);
	var deleteDirs = req.body.delete_dirs === 'true';
	await seasonalArt.deleteSeason(id, deleteDirs);
	await seasonalArt.refreshSeasonCache();
	res.redirect('/admin/seasonal-art');
});

// -------------------------------------------------------
// Wall
// -------------------------------------------------------

router.get('/wall', requireAdmin, async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	var messages = await wall.getAllMessages();

	res.render('admin/wall', {
		sufficientAccess: sufficientAccess,
		title: 'Wall Messages',
		activelink: 'wall',
		currentuser: currentuser,
		messages: messages
	});
});

router.post('/wall/delete/:uuid', urlencodedParser, requireAdmin, async (req, res) => {
	await wall.deleteMessage(req.params.uuid);
	res.redirect('/admin/wall');
});

// -------------------------------------------------------
// NodeSpy
// -------------------------------------------------------

function _formatDuration(sinceMs) {
	if (!sinceMs) return '-';
	var secs = Math.floor((Date.now() - sinceMs) / 1000);
	if (secs < 60) return secs + 's';
	var mins = Math.floor(secs / 60);
	if (mins < 60) return mins + 'm';
	var hrs = Math.floor(mins / 60);
	return hrs + 'h ' + (mins % 60) + 'm';
}

function _connectionLabel(node) {
	if (node.web_originated) return 'Web';
	var ct = node.connection_type || '';
	if (ct === 'Websock' || ct === 'Websocket' || ct === 'TCP' || ct === 'Telnet') return 'Terminal';
	return ct || 'Unknown';
}

router.get('/nodespy', async (req, res) => {
	var nodeManager = req.app.locals.nodeManager;
	var callManager = req.app.locals.callManager;
	var nodes = [];

	if (nodeManager) {
		var active = nodeManager.getActiveNodes();
		active.sort(function(a, b) { return a.nodenum - b.nodenum; });

		for (var n of active) {
			var call = callManager ? callManager.getCallByNode(n.nodenum) : null;
			nodes.push({
				nodenum: n.nodenum,
				username: n.username || '',
				activityLabel: formatActivity(n.status, n.detail, n.detail_display),
				connectionLabel: _connectionLabel(n),
				termWidth: call ? (call.term_width || 80) : 80,
				termHeight: call ? (call.term_height || 25) : 25,
				duration: _formatDuration(n.since)
			});
		}
	}

	res.render('admin/nodespy/index', {
		title: 'Node Spy',
		activelink: 'nodespy',
		currentuser: await getCurrentUser(req),
		nodes: nodes
	});
});

// JSON endpoint for dashboard auto-refresh
router.get('/nodespy/status.json', async (req, res) => {
	var nodeManager = req.app.locals.nodeManager;
	var callManager = req.app.locals.callManager;
	var nodes = [];

	if (nodeManager) {
		var active = nodeManager.getActiveNodes();
		active.sort(function(a, b) { return a.nodenum - b.nodenum; });

		for (var n of active) {
			var call = callManager ? callManager.getCallByNode(n.nodenum) : null;
			nodes.push({
				nodenum: n.nodenum,
				username: n.username || '',
				activityLabel: formatActivity(n.status, n.detail, n.detail_display),
				connectionLabel: _connectionLabel(n),
				termWidth: call ? (call.term_width || 80) : 80,
				termHeight: call ? (call.term_height || 25) : 25,
				duration: _formatDuration(n.since)
			});
		}
	}

	// Get web presence users (exclude any that are also terminal nodes)
	var terminalUsernames = new Set(nodes.map(function(n) { return (n.username || '').toLowerCase(); }));
	var onlineWeb = await getOnlineUsers();
	var webUsers = [];
	for (var wu of onlineWeb) {
		if (terminalUsernames.has((wu.username || '').toLowerCase())) continue;
		webUsers.push({
			userId: wu.userId,
			username: wu.username || '',
			activityLabel: formatActivity(wu.activity || 'web_browsing'),
			source: 'web',
			duration: _formatDuration(wu.lastSeen)
		});
	}

	res.json({ nodes: nodes, webUsers: webUsers });
});

router.get('/nodespy/:nodenum', async (req, res) => {
	var nodenum = parseInt(req.params.nodenum);
	if (isNaN(nodenum) || nodenum < 1) {
		return res.redirect('/admin/nodespy');
	}

	var callManager = req.app.locals.callManager;
	var call = callManager ? callManager.getCallByNode(nodenum) : null;
	if (!call) {
		return res.redirect('/admin/nodespy');
	}

	// Generate one-time Redis token
	var token = uuidv4().replace(/-/g, '');
	var tokenData = JSON.stringify({
		nodenum: nodenum,
		sessionId: req.cookies.sessionid,
		termWidth: call.term_width || 80,
		termHeight: call.term_height || 25,
		created: Date.now()
	});

	var rc = await redis.getClient();
	await rc.set('nodespy:' + token, tokenData, { EX: 60 });

	// Build WebSocket URL
	var wsProto = (req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https') ? 'wss:' : 'ws:';
	var wsUrl = wsProto + '//' + req.headers.host + '/ws/nodespy?token=' + token;

	res.render('admin/nodespy/watch', {
		title: 'Node Spy - Node ' + nodenum + ' (' + (call.caller_username || 'Unknown') + ')',
		boardname: appConfig.get('boardname', 'BBS'),
		nodenum: nodenum,
		username: call.caller_username || 'Unknown',
		termWidth: call.term_width || 80,
		termHeight: call.term_height || 25,
		wsUrl: wsUrl,
		returnUrl: '/admin/nodespy',
		ismobile: mobile({ ua: req.headers['user-agent'] })
	});
});

export { router };