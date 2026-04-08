//imports
import express from 'express';
var router = express.Router();
import { DateTime } from "luxon";
import cookieParser from 'cookie-parser';
import mobile from 'is-mobile';
import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import { computeHashes } from '../utils/fileHasher.js';
import { applyDescriptions } from '../utils/fileDescExtractor.js';

//internals
import * as sessionStore from "../middleware/db/sessionstore.js";
import * as privateMessages from '../models/privateMessages.js';
import * as fileGroups from '../models/fileGroups.js';
import * as fileAreas from '../models/fileAreas.js';
import * as fileEntries from '../models/fileEntries.js';
import * as userFilePointers from '../models/userFilePointers.js';
import * as userAccounts from '../models/useraccounts.js';
import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";
import * as fileNetworkAreas from '../models/fileNetworkAreas.js';
import * as userFileSubs from '../models/userFileSubs.js';
import * as filePeerSubscriptions from '../models/filePeerSubscriptions.js';
import * as fileDistribution from '../models/fileDistribution.js';
import * as jobs from '../queues/jobs.js';

//setup
router.use(cookieParser());

// Inject shared locals for all file views
router.use(async function(req, res, next) {
	res.locals.boardname   = appConfig.get('boardname', 'BBS');
	res.locals.faviconlink = appConfig.get('faviconlink', '/images/favicon.ico');
	res.locals.currentPath = req.path;
	res.locals.activelink  = 'files';
	res.locals.DateTime    = DateTime;
	res.locals.ismobile    = mobile({ ua: req.headers['user-agent'] });
	res.locals.pmUnreadCount = 0;
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

// Helper: resolve the database integer ID for a session user.
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

// Helper: check if user has sufficient access to read a file area or group.
function checkFileAreaBrowseAccess(sessionUser, areaOrGroup) {
	if (!areaOrGroup) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	// browse_security is the visibility gate; falls back to read_security if not set
	var browseSec = areaOrGroup.browse_security !== null && areaOrGroup.browse_security !== undefined
		? parseInt(areaOrGroup.browse_security)
		: (areaOrGroup.read_security ? parseInt(areaOrGroup.read_security) : 0);
	if (userSecurity < browseSec) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	// browse flags fall back to read flags if not set
	var reqFlags   = parseFlags(areaOrGroup.browse_perm_flags || areaOrGroup.read_perm_flags);
	var restFlags  = parseFlags(areaOrGroup.browse_rest_flags || areaOrGroup.read_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

// Helper: check if user has sufficient access to download from a file area or group.
function checkFileAreaReadAccess(sessionUser, areaOrGroup) {
	if (!areaOrGroup) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	if (areaOrGroup.read_security && userSecurity < areaOrGroup.read_security) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(areaOrGroup.read_perm_flags);
	var restFlags  = parseFlags(areaOrGroup.read_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

// Helper: check if user has sufficient access to upload to a file area or group.
function checkFileAreaUploadAccess(sessionUser, areaOrGroup) {
	if (!areaOrGroup) return false;
	var userSecurity = parseInt(sessionUser.security) || 0;
	if (areaOrGroup.post_security && userSecurity < areaOrGroup.post_security) return false;

	var userPerms  = parseFlags(sessionUser.permissionflags);
	var userRestrs = parseFlags(sessionUser.restrictionflags);
	var reqFlags   = parseFlags(areaOrGroup.post_perm_flags);
	var restFlags  = parseFlags(areaOrGroup.post_rest_flags);

	if (reqFlags.length > 0 && !reqFlags.every(function(f) { return userPerms.includes(f); })) return false;
	if (restFlags.length > 0 && restFlags.some(function(f) { return userRestrs.includes(f); })) return false;

	return true;
}

// Helper: format bytes to human-readable string
function formatBytes(bytes) {
	var n = parseInt(bytes) || 0;
	if (n <= 0) return '0 B';
	var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	var i = Math.floor(Math.log(n) / Math.log(1024));
	if (i >= sizes.length) i = sizes.length - 1;
	return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
}

// -------------------------------------------------------
// File info JSON (for modal AJAX load)
// -------------------------------------------------------

router.get('/info/:uuid.json', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.status(401).json({ error: 'Not authenticated' });
	}

	var uuid = req.params.uuid.toLowerCase().trim();
	var entry = await fileEntries.getEntryByUUID(uuid);
	if (!entry) {
		return res.status(404).json({ error: 'File not found' });
	}

	var fileArea = entry.area_shortcode ? await fileAreas.getAreaByShortcode(entry.area_shortcode) : null;
	if (!fileArea || !checkFileAreaReadAccess(currentuser, fileArea)) {
		return res.status(403).json({ error: 'Access denied' });
	}

	var fileGroup = fileArea.group_shortcode ? await fileGroups.getGroupByShortcode(fileArea.group_shortcode) : null;

	res.json({
		uuid: entry.uuid,
		filename: entry.filename,
		file_size: parseInt(entry.file_size) || 0,
		file_size_display: formatBytes(entry.file_size),
		file_date: entry.file_date,
		upload_date: entry.upload_date,
		uploader_name: entry.uploader_name || null,
		download_count: entry.download_count || 0,
		short_desc: entry.short_desc || null,
		long_desc: entry.long_desc || null,
		long_desc_html: entry.long_desc_html || null,
		file_hash_crc32: entry.file_hash_crc32 || null,
		file_hash_sha256: entry.file_hash_sha256 || null,
		source_type: entry.source_type || null,
		area_name: fileArea ? fileArea.name : null,
		area_shortcode: fileArea ? fileArea.shortcode : null,
		group_name: fileGroup ? fileGroup.name : null,
		download_url: '/files/download/' + entry.uuid,
		detail_url: '/files/view/' + entry.uuid
	});
});

// -------------------------------------------------------
// Search
// -------------------------------------------------------

router.get('/search', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('files/search', {
			title: 'File Search',
			currentuser: null,
			results: [],
			query: '',
			totalResults: 0,
			formatBytes: formatBytes
		});
	}

	var query = (req.query.q || '').trim();
	var results = [];
	var totalResults = 0;

	if (query.length > 0) {
		var userId = await resolveUserId(currentuser);
		var allResults = await fileEntries.searchEntries(query, { limit: 200 });

		// Filter results by access control — only show files in areas the user can access
		for (var entry of allResults) {
			var area = entry.area_shortcode ? await fileAreas.getAreaByShortcode(entry.area_shortcode) : null;
			if (area && checkFileAreaBrowseAccess(currentuser, area)) {
				var group = area.group_shortcode ? await fileGroups.getGroupByShortcode(area.group_shortcode) : null;
				entry._areaName = area.name;
				entry._areaShortcode = area.shortcode;
				entry._groupName = group ? group.name : '';
				results.push(entry);
			}
		}
		totalResults = results.length;
		// Trim to display limit
		if (results.length > 50) results = results.slice(0, 50);
	}

	res.render('files/search', {
		title: query ? 'Search: ' + query : 'File Search',
		currentuser: currentuser,
		results: results,
		query: query,
		totalResults: totalResults,
		formatBytes: formatBytes
	});
});

// -------------------------------------------------------
// File Routes
// -------------------------------------------------------

// File area browser -- combined grouped view with subscriptions
router.get('/', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('files/index', {
			title: 'Files',
			currentuser: null,
			groupedAreas: []
		});
	}

	var userId = await resolveUserId(currentuser);
	var grouplist = await fileGroups.getActiveGroups();
	grouplist = grouplist.filter(function(g) { return checkFileAreaBrowseAccess(currentuser, g); });

	var groupedAreas = [];
	for (var group of grouplist) {
		var areas = await fileAreas.getAreasInGroup(group.shortcode);
		areas = areas.filter(function(a) { return a.active && checkFileAreaBrowseAccess(currentuser, a); });
		if (areas.length === 0) continue;

		var subMap = userId ? await userFileSubs.getSubscriptionMap(userId, areas) : {};
		for (var area of areas) {
			area.subscribed = subMap[area.shortcode] !== undefined ? subMap[area.shortcode] : (area.newscan_default !== false);
			area.new_count = userId ? await userFilePointers.getNewCount(userId, area.shortcode, area.id) : 0;
		}

		groupedAreas.push({
			group: group,
			areas: areas
		});
	}

	res.render('files/index', {
		title: 'Files',
		currentuser: currentuser,
		groupedAreas: groupedAreas
	});
});

// AJAX: toggle file area subscription
router.post('/area/:shortcode/subscribe', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) return res.status(401).json({ error: 'Not authenticated' });
	var userId = await resolveUserId(currentuser);
	if (!userId) return res.status(401).json({ error: 'No user' });
	var shortcode = req.params.shortcode.toUpperCase().trim();
	var newState = await userFileSubs.toggleSubscription(userId, shortcode);
	res.json({ subscribed: newState });
});

// Areas in a group
router.get('/group/:shortcode', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('files/groups/view', {
			title: 'File Group',
			currentuser: null,
			fileGroup: null,
			arealist: []
		});
	}

	var shortcode = req.params.shortcode.toUpperCase().trim();
	var fileGroup = await fileGroups.getGroupByShortcode(shortcode);

	if (!fileGroup) {
		return res.render('files/groups/view', {
			title: 'Group Not Found',
			currentuser: currentuser,
			fileGroup: null,
			arealist: []
		});
	}

	// Check group-level read access
	if (!checkFileAreaBrowseAccess(currentuser, fileGroup)) {
		return res.render('files/groups/view', {
			title: 'Access Denied',
			currentuser: currentuser,
			fileGroup: null,
			arealist: []
		});
	}

	var arealist = await fileAreas.getAreasInGroup(shortcode);

	// Filter areas by active + read access
	arealist = arealist.filter(function(a) { return a.active && checkFileAreaBrowseAccess(currentuser, a); });

	// Attach new counts and upload access per area
	var userId = await resolveUserId(currentuser);
	for (var area of arealist) {
		area.canUpload = checkFileAreaUploadAccess(currentuser, area);
		area.new_count = 0;
		if (userId) {
			area.new_count = await userFilePointers.getNewCount(userId, area.shortcode, area.id);
		}
	}

	res.render('files/groups/view', {
		title: fileGroup.name,
		currentuser: currentuser,
		fileGroup: fileGroup,
		arealist: arealist,
		formatBytes: formatBytes
	});
});

// File listing in area
router.get('/area/:shortcode', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var shortcode = req.params.shortcode.toUpperCase().trim();
	var fileArea = currentuser ? await fileAreas.getAreaByShortcode(shortcode) : null;
	var sufficientAccess = currentuser && fileArea && checkFileAreaBrowseAccess(currentuser, fileArea);

	if (!currentuser || !fileArea || !sufficientAccess) {
		return res.render('files/areas/view', {
			title: fileArea ? fileArea.name : 'File Area',
			currentuser: currentuser,
			sufficientAccess: !!sufficientAccess,
			canUpload: false,
			fileArea: fileArea,
			fileGroup: null,
			filelist: [],
			totalFiles: 0,
			formatBytes: formatBytes
		});
	}

	var canDownload = checkFileAreaReadAccess(currentuser, fileArea);
	var canUpload = checkFileAreaUploadAccess(currentuser, fileArea);

	// Load parent group for breadcrumb
	var fileGroup = await fileGroups.getGroupByShortcode(fileArea.group_shortcode);

	var totalFiles = await fileEntries.getEntryCount(fileArea.id);
	var filelist = await fileEntries.getEntriesForArea(fileArea.id, { limit: 50, offset: 0 });

	// Advance scan pointer to highest file ID in results
	var userId = await resolveUserId(currentuser);
	if (userId && filelist.length > 0) {
		var maxId = 0;
		for (var f of filelist) {
			if (f.id > maxId) maxId = f.id;
		}
		await userFilePointers.advancePointer(userId, fileArea.shortcode, maxId);
	}

	res.render('files/areas/view', {
		title: fileArea.name,
		currentuser: currentuser,
		sufficientAccess: true,
		canDownload: canDownload,
		canUpload: canUpload,
		fileArea: fileArea,
		fileGroup: fileGroup,
		filelist: filelist,
		totalFiles: totalFiles,
		formatBytes: formatBytes,
		uploaded: req.query.uploaded || null,
		error: req.query.error || null
	});
});

// File detail view
router.get('/view/:uuid', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('files/view', {
			title: 'File Detail',
			currentuser: null,
			sufficientAccess: false,
			entry: null,
			fileArea: null,
			fileGroup: null,
			formatBytes: formatBytes
		});
	}

	var uuid = req.params.uuid.toLowerCase().trim();
	var entry = await fileEntries.getEntryByUUID(uuid);

	if (!entry) {
		return res.render('files/view', {
			title: 'File Not Found',
			currentuser: currentuser,
			sufficientAccess: true,
			entry: null,
			fileArea: null,
			fileGroup: null,
			formatBytes: formatBytes
		});
	}

	// Load parent area and group, check access
	var fileArea = entry.area_shortcode ? await fileAreas.getAreaByShortcode(entry.area_shortcode) : null;
	if (!fileArea) {
		// Fall back to area_id lookup
		var allAreas = await fileAreas.getAllAreas();
		fileArea = allAreas.find(function(a) { return a.id === entry.area_id; }) || null;
	}

	var fileGroup = null;
	if (fileArea && fileArea.group_shortcode) {
		fileGroup = await fileGroups.getGroupByShortcode(fileArea.group_shortcode);
	}

	var sufficientAccess = fileArea && checkFileAreaReadAccess(currentuser, fileArea);
	if (!sufficientAccess) {
		return res.render('files/view', {
			title: 'Access Denied',
			currentuser: currentuser,
			sufficientAccess: false,
			entry: null,
			fileArea: fileArea,
			fileGroup: fileGroup,
			formatBytes: formatBytes
		});
	}

	res.render('files/view', {
		title: entry.filename,
		currentuser: currentuser,
		sufficientAccess: true,
		entry: entry,
		fileArea: fileArea,
		fileGroup: fileGroup,
		formatBytes: formatBytes
	});
});

// Download file
router.get('/download/:uuid', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.status(401).send('Not authenticated');
	}

	var uuid = req.params.uuid.toLowerCase().trim();
	var entry = await fileEntries.getEntryByUUID(uuid);

	if (!entry) {
		return res.status(404).send('File not found');
	}

	// Load parent area and group for access check and path resolution
	var fileArea = entry.area_shortcode ? await fileAreas.getAreaByShortcode(entry.area_shortcode) : null;
	if (!fileArea) {
		var allAreas = await fileAreas.getAllAreas();
		fileArea = allAreas.find(function(a) { return a.id === entry.area_id; }) || null;
	}

	if (!fileArea) {
		return res.status(404).send('File area not found');
	}

	if (!checkFileAreaReadAccess(currentuser, fileArea)) {
		return res.status(403).send('Access denied');
	}

	var fileGroup = null;
	if (fileArea.group_shortcode) {
		fileGroup = await fileGroups.getGroupByShortcode(fileArea.group_shortcode);
	}

	// Resolve full filesystem path
	var areaPath = fileAreas.resolveAreaPath(fileGroup, fileArea);
	var fullPath = path.join(areaPath, entry.disk_path || entry.filename);

	// Verify file exists on disk
	if (!fs.existsSync(fullPath)) {
		alogger.writeAlog(2, "File download failed — file not on disk: " + fullPath, "redbright");
		return res.status(404).send('File not found on disk');
	}

	// Increment download count
	await fileEntries.incrementDownloadCount(entry.id);

	alogger.writeAlog(5, "File download: " + entry.filename + " by " + (currentuser.username || 'unknown'), "cyan");

	// Send file with original filename
	res.download(fullPath, entry.filename, function(err) {
		if (err) {
			alogger.writeAlog(2, "File download error for " + entry.filename + ": " + err.message, "redbright");
		}
	});
});

// JSON pagination endpoint for file listings
router.get('/area/:shortcode/files.json', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.status(401).json({ error: 'Not authenticated' });
	}

	var shortcode = req.params.shortcode.toUpperCase().trim();
	var fileArea = await fileAreas.getAreaByShortcode(shortcode);

	if (!fileArea) {
		return res.status(404).json({ error: 'Area not found' });
	}

	if (!checkFileAreaBrowseAccess(currentuser, fileArea)) {
		return res.status(403).json({ error: 'Access denied' });
	}

	var offset = parseInt(req.query.offset) || 0;
	var limit = Math.min(parseInt(req.query.limit) || 50, 200);
	var sort = req.query.sort || 'upload_date';
	var order = req.query.order || 'desc';

	// Whitelist sort columns
	var allowedSorts = ['filename', 'upload_date', 'file_size', 'download_count'];
	if (allowedSorts.indexOf(sort) === -1) sort = 'upload_date';

	// Whitelist order direction
	var orderDir = (order.toLowerCase() === 'asc') ? 'ASC' : 'DESC';
	var orderBy = sort + ' ' + orderDir;

	var filelist = await fileEntries.getEntriesForArea(fileArea.id, {
		limit: limit,
		offset: offset,
		orderBy: orderBy
	});

	var total = await fileEntries.getEntryCount(fileArea.id);

	// Advance scan pointer
	var userId = await resolveUserId(currentuser);
	if (userId && filelist.length > 0) {
		var maxId = 0;
		for (var f of filelist) {
			if (f.id > maxId) maxId = f.id;
		}
		await userFilePointers.advancePointer(userId, fileArea.shortcode, maxId);
	}

	res.json({
		files: filelist.map(function(f) {
			return {
				uuid: f.uuid,
				filename: f.filename,
				file_size: f.file_size,
				file_size_display: formatBytes(f.file_size),
				upload_date: f.upload_date,
				short_desc: f.short_desc || '',
				download_count: f.download_count || 0,
				uploader_name: f.uploader_name || ''
			};
		}),
		total: total,
		offset: offset
	});
});

// -------------------------------------------------------
// Upload
// -------------------------------------------------------

// Multer config — stage uploads to a temp directory
var upload = multer({
	dest: appConfig.get('file_upload_staging_dir', 'files/staging'),
	limits: {
		fileSize: appConfig.getNumber('file_max_upload_size', 10485760)
	}
});

// Upload form page
router.get('/area/:shortcode/upload', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.render('files/upload', {
			title: 'Upload File',
			currentuser: null,
			sufficientAccess: false,
			canUpload: false,
			fileArea: null,
			fileGroup: null,
			formatBytes: formatBytes
		});
	}

	var shortcode = req.params.shortcode.toUpperCase().trim();
	var fileArea = await fileAreas.getAreaByShortcode(shortcode);
	if (!fileArea) {
		return res.redirect('/files');
	}

	var fileGroup = fileArea.group_shortcode ? await fileGroups.getGroupByShortcode(fileArea.group_shortcode) : null;
	var sufficientAccess = checkFileAreaReadAccess(currentuser, fileArea);
	var canUpload = checkFileAreaUploadAccess(currentuser, fileArea);

	if (!canUpload) {
		return res.render('files/upload', {
			title: 'Upload File',
			currentuser: currentuser,
			sufficientAccess: sufficientAccess,
			canUpload: false,
			fileArea: fileArea,
			fileGroup: fileGroup,
			formatBytes: formatBytes
		});
	}

	res.render('files/upload', {
		title: 'Upload to ' + fileArea.name,
		currentuser: currentuser,
		sufficientAccess: true,
		canUpload: true,
		fileArea: fileArea,
		fileGroup: fileGroup,
		formatBytes: formatBytes,
		maxSize: appConfig.getNumber('file_max_upload_size', 10485760),
		allowedExtensions: appConfig.get('file_allowed_extensions', '')
	});
});

// Handle upload POST
router.post('/area/:shortcode/upload', upload.single('file'), async (req, res) => {
	var currentuser = await getCurrentUser(req);
	if (!currentuser) {
		return res.status(401).send('Not authenticated');
	}

	var shortcode = req.params.shortcode.toUpperCase().trim();
	var fileArea = await fileAreas.getAreaByShortcode(shortcode);
	if (!fileArea) {
		return res.status(404).send('Area not found');
	}

	if (!checkFileAreaUploadAccess(currentuser, fileArea)) {
		return res.status(403).send('Upload not permitted');
	}

	if (!req.file) {
		return res.redirect('/files/area/' + shortcode + '?error=No+file+selected');
	}

	var fileGroup = fileArea.group_shortcode ? await fileGroups.getGroupByShortcode(fileArea.group_shortcode) : null;
	var stagingPath = req.file.path;
	var originalName = req.file.originalname;
	var userId = await resolveUserId(currentuser);

	try {
		// Check allowed extensions
		var allowedExt = appConfig.get('file_allowed_extensions', '');
		if (allowedExt) {
			var ext = path.extname(originalName).toLowerCase().replace('.', '');
			var allowed = allowedExt.split(',').map(function(e) { return e.trim().toLowerCase().replace('.', ''); });
			if (allowed.length > 0 && allowed[0] !== '' && allowed.indexOf(ext) === -1) {
				fs.unlinkSync(stagingPath);
				return res.redirect('/files/area/' + shortcode + '?error=File+type+not+allowed');
			}
		}

		// Compute hashes
		var hashes = computeHashes(stagingPath);

		// Dupe check
		var isDupe = await fileEntries.checkDupe(fileArea.id, originalName, hashes.crc32);
		if (isDupe) {
			fs.unlinkSync(stagingPath);
			return res.redirect('/files/area/' + shortcode + '?error=Duplicate+file');
		}

		// Resolve area directory and ensure it exists
		var areaPath = fileAreas.resolveAreaPath(fileGroup, fileArea);
		if (!fs.existsSync(areaPath)) {
			fs.mkdirSync(areaPath, { recursive: true });
		}

		// Move file from staging to area directory
		var destPath = path.join(areaPath, originalName);
		fs.renameSync(stagingPath, destPath);

		// Build entry object
		var stat = fs.statSync(destPath);
		var entryObj = {
			area_id: fileArea.id,
			area_shortcode: shortcode,
			filename: originalName,
			disk_path: originalName,
			file_size: stat.size,
			file_date: stat.mtime,
			file_hash_crc32: hashes.crc32,
			file_hash_sha256: hashes.sha256,
			short_desc: req.body.short_desc || null,
			upload_date: new Date(),
			uploader_uuid: currentuser.uuid || null,
			uploader_name: currentuser.username || null,
			source_type: 'local',
			source_data: { upload_method: 'web', upload_ip: req.ip }
		};

		// Extract FILE_ID.DIZ from archives
		applyDescriptions(entryObj, destPath);

		// If user provided a short_desc, prefer it over the extracted one
		if (req.body.short_desc && req.body.short_desc.trim()) {
			entryObj.short_desc = req.body.short_desc.trim();
		}

		// Create the entry
		var result = await fileEntries.addFileEntry(entryObj);

		if (!result.status) {
			alogger.writeAlog(2, "File upload failed for " + originalName + ": " + result.errormessages.join(", "), "redbright");
			return res.redirect('/files/area/' + shortcode + '?error=Upload+failed');
		}

		// Update area stats
		await fileAreas.updateStatsForArea(shortcode);

		// If this area is mapped to a network, create distribution rows and enqueue TIC outbound
		try {
			var networkMappings = await fileNetworkAreas.getNetworksByFileArea(fileArea.id);
			if (networkMappings && networkMappings.length > 0) {
				var subscribedConns = await filePeerSubscriptions.getSubscribedConnections(fileArea.id);
				if (subscribedConns && subscribedConns.length > 0) {
					var connIds = subscribedConns.map(function(c) { return c.peer_connection_id; });
					await fileDistribution.createDistributionRows(result.entryId, connIds, 'tic');
					await jobs.enqueueTicOutbound();
					alogger.writeAlog(3, "File upload hatched to " + connIds.length + " peer(s) for TIC distribution", "cyan");
				}
			}
		} catch (distErr) {
			alogger.writeAlog(3, "File upload TIC distribution error: " + distErr.message, "yellow");
		}

		alogger.writeAlog(3, "File uploaded: " + originalName + " to " + shortcode + " by " + (currentuser.username || 'unknown'), "greenbright");

		res.redirect('/files/area/' + shortcode + '?uploaded=' + encodeURIComponent(originalName));

	} catch (err) {
		alogger.writeAlog(2, "File upload error: " + err.message, "redbright");
		// Clean up staging file if still there
		try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (_) {}
		res.redirect('/files/area/' + shortcode + '?error=Upload+error');
	}
});

export { router };
