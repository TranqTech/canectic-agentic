// maintenance/echolistScan.js — Automated echolist and filebone scanning.
//
// Scans for updated echolist/filebone files and auto-imports them.
// Two-level scan priority per echolist/filebone:
//   1. Per-list scan_area override: check for direct file, then newest ZIP
//   2. Per-network infopack_area: unzip newest file, match all echolist/filebone names
//
// Uses the existing buildImportDiff/executeImport pipeline from the echolist models.
// Scheduled daily via BullMQ maintenance queue.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import * as alogger from '../utils/alogger.js';
import { parseAreasBbs } from '../utils/areasBbsParser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Find the newest file in a file area (by upload date or file mtime)
function _findNewestFile(files) {
	if (!files || files.length === 0) return null;
	var best = null;
	for (var f of files) {
		var ts = f.upload_date || f.created_at;
		if (!best || (ts && new Date(ts) > new Date(best.upload_date || best.created_at))) {
			best = f;
		}
	}
	return best;
}

// Find a file in a list by exact name match (case-insensitive)
function _findFileByName(files, filename) {
	var lowerName = filename.toLowerCase();
	for (var f of files) {
		if ((f.filename || '').toLowerCase() === lowerName) return f;
	}
	return null;
}

// Find the newest ZIP in a file list
function _findNewestZip(files) {
	var zips = (files || []).filter(function(f) {
		var ext = (f.filename || '').toLowerCase().split('.').pop();
		return ext === 'zip' || ext === 'lzh' || ext === 'rar' || ext === '7z';
	});
	return _findNewestFile(zips);
}

// Resolve a file entry's disk path within its area
function _resolveFilePath(fileEntry, areaPath) {
	return path.join(areaPath, fileEntry.disk_path || fileEntry.filename);
}

// Unzip a file to a temp directory, return the temp dir path
function _unzipToTemp(zipPath, label) {
	var tmpDir = path.join(os.tmpdir(), 'canectic-echolist-scan-' + Date.now());
	fs.mkdirSync(tmpDir, { recursive: true });

	try {
		var ext = path.extname(zipPath).toLowerCase();
		if (ext === '.zip') {
			execSync('unzip -o -j ' + JSON.stringify(zipPath) + ' -d ' + JSON.stringify(tmpDir), {
				stdio: 'pipe', timeout: 30000
			});
		} else if (ext === '.7z') {
			execSync('7z x -y -o' + JSON.stringify(tmpDir) + ' ' + JSON.stringify(zipPath), {
				stdio: 'pipe', timeout: 30000
			});
		} else {
			alogger.writeAlog(3, '[EcholistScan] Unsupported archive format: ' + ext + ' (' + label + ')', 'yellow');
			_cleanupTemp(tmpDir);
			return null;
		}
	} catch (err) {
		alogger.writeAlog(3, '[EcholistScan] Unzip failed for ' + label + ': ' + err.message, 'yellow');
		_cleanupTemp(tmpDir);
		return null;
	}
	return tmpDir;
}

// Clean up temp directory
function _cleanupTemp(tmpDir) {
	try {
		if (tmpDir && fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	} catch (_) {}
}

// Check if an echolist file is newer than last import
function _isNewer(fileEntry, lastImportedAt) {
	if (!lastImportedAt) return true;
	var fileDate = new Date(fileEntry.upload_date || fileEntry.created_at || 0);
	return fileDate > new Date(lastImportedAt);
}

// Import an echolist/filebone file
async function _importFile(filePath, echolistId, echolistName, model, type) {
	try {
		var content = fs.readFileSync(filePath, 'utf8');
		var parsed = parseAreasBbs(content);
		if (!parsed || parsed.length === 0) {
			alogger.writeAlog(5, '[EcholistScan] No areas parsed from ' + echolistName + ' (' + type + ')', 'yellow');
			return null;
		}

		var diff = await model.buildImportDiff(echolistId, parsed);
		if (diff.newAreas.length === 0 && diff.changedAreas.length === 0 && diff.removedAreas.length === 0) {
			alogger.writeAlog(5, '[EcholistScan] No changes in ' + echolistName + ' (' + type + ')', 'cyan');
			return { unchanged: true };
		}

		await model.executeImport(echolistId, diff);

		// Sysop notification for locally-carried removals
		if (diff.localCarriedRemovals && diff.localCarriedRemovals.length > 0) {
			try {
				var notifications = (await import('../models/notifications.js'));
				var removedTags = diff.localCarriedRemovals.map(function(r) { return r.areatag; }).join(', ');
				var notifType = type === 'filebone' ? 'filebone_removal' : 'echolist_removal';
				await notifications.createSysop(notifType,
					echolistName + ': ' + diff.localCarriedRemovals.length + ' locally-carried area(s) removed',
					'The following locally-carried areas were removed from ' + echolistName + ':\n' + removedTags,
					{ icon: 'exclamation-triangle', severity: 'warning' }
				);
			} catch (_) {}
		}

		alogger.writeAlog(2,
			'[EcholistScan] Imported ' + echolistName + ' (' + type + '): ' +
			diff.newAreas.length + ' new, ' + diff.changedAreas.length + ' changed, ' +
			diff.removedAreas.length + ' removed, ' + diff.unchangedCount + ' unchanged',
			'greenbright'
		);

		return {
			newAreas: diff.newAreas.length,
			changedAreas: diff.changedAreas.length,
			removedAreas: diff.removedAreas.length,
			unchangedCount: diff.unchangedCount
		};
	} catch (err) {
		alogger.writeAlog(3, '[EcholistScan] Import failed for ' + echolistName + ': ' + err.message, 'redbright');
		return null;
	}
}

// ---------------------------------------------------------------------------
// Per-list scan: check scan_area override
// ---------------------------------------------------------------------------

async function _scanListOverride(echolist, model, type, fileEntriesModel, fileAreasModel, fileGroupsModel) {
	if (!echolist.scan_area) return false;

	var area = await fileAreasModel.getAreaByShortcode(echolist.scan_area);
	if (!area) {
		alogger.writeAlog(5, '[EcholistScan] scan_area not found for ' + echolist.name + ': ' + echolist.scan_area, 'yellow');
		return false;
	}

	var group = area.group_shortcode ? await fileGroupsModel.getGroupByShortcode(area.group_shortcode) : null;
	var areaPath = fileAreasModel.resolveAreaPath(group, area);
	var files = await fileEntriesModel.getEntriesForArea(area.id, { limit: 500, orderBy: 'upload_date DESC' });
	if (!files || files.length === 0) return false;

	// 1. Direct file match
	var directMatch = _findFileByName(files, echolist.name);
	if (directMatch && _isNewer(directMatch, echolist.last_imported_at)) {
		var filePath = _resolveFilePath(directMatch, areaPath);
		if (fs.existsSync(filePath)) {
			var result = await _importFile(filePath, echolist.id, echolist.name, model, type);
			return result !== null;
		}
	}

	// 2. Newest ZIP containing the file
	var newestZip = _findNewestZip(files);
	if (newestZip && _isNewer(newestZip, echolist.last_imported_at)) {
		var zipPath = _resolveFilePath(newestZip, areaPath);
		if (fs.existsSync(zipPath)) {
			var tmpDir = _unzipToTemp(zipPath, echolist.name);
			if (tmpDir) {
				try {
					// Look for the echolist file in the extracted contents (case-insensitive)
					var extracted = fs.readdirSync(tmpDir);
					var matchName = echolist.name.toLowerCase();
					var match = extracted.find(function(f) { return f.toLowerCase() === matchName; });
					if (match) {
						var result = await _importFile(path.join(tmpDir, match), echolist.id, echolist.name, model, type);
						return result !== null;
					}
				} finally {
					_cleanupTemp(tmpDir);
				}
			}
		}
	}

	return false;
}

// ---------------------------------------------------------------------------
// Per-network scan: check infopack_area
// ---------------------------------------------------------------------------

async function _scanNetworkInfopack(network, echolists, filebones, networkEcholist, fileEcholist, fileEntriesModel, fileAreasModel, fileGroupsModel) {
	var config = network.config;
	if (typeof config === 'string') { try { config = JSON.parse(config); } catch(_) { config = {}; } }
	if (!config || !config.infopack_area) return 0;

	var area = await fileAreasModel.getAreaByShortcode(config.infopack_area);
	if (!area) {
		alogger.writeAlog(5, '[EcholistScan] infopack_area not found for network ' + network.name + ': ' + config.infopack_area, 'yellow');
		return 0;
	}

	var group = area.group_shortcode ? await fileGroupsModel.getGroupByShortcode(area.group_shortcode) : null;
	var areaPath = fileAreasModel.resolveAreaPath(group, area);
	var files = await fileEntriesModel.getEntriesForArea(area.id, { limit: 500, orderBy: 'upload_date DESC' });
	if (!files || files.length === 0) return 0;

	// Find the newest file (ZIP or direct) in the infopack area
	var newestFile = _findNewestFile(files);
	if (!newestFile) return 0;

	// Build a map of echolist/filebone names to check against
	var nameMap = new Map(); // lowercase name -> { echolist, model, type }
	for (var el of (echolists || [])) {
		if (el.scan_area) continue; // has override, already scanned
		nameMap.set(el.name.toLowerCase(), { echolist: el, model: networkEcholist, type: 'echolist' });
	}
	for (var fb of (filebones || [])) {
		if (fb.scan_area) continue;
		nameMap.set(fb.name.toLowerCase(), { echolist: fb, model: fileEcholist, type: 'filebone' });
	}

	if (nameMap.size === 0) return 0;

	var imported = 0;
	var filePath = _resolveFilePath(newestFile, areaPath);
	if (!fs.existsSync(filePath)) return 0;

	var ext = path.extname(newestFile.filename || '').toLowerCase();
	var isArchive = ext === '.zip' || ext === '.7z';

	if (isArchive) {
		// Unzip and match contents against all echolist/filebone names
		var tmpDir = _unzipToTemp(filePath, 'infopack for ' + network.name);
		if (!tmpDir) return 0;

		try {
			var extracted = fs.readdirSync(tmpDir);
			for (var fname of extracted) {
				var entry = nameMap.get(fname.toLowerCase());
				if (!entry) continue;
				if (!_isNewer(newestFile, entry.echolist.last_imported_at)) continue;

				var result = await _importFile(path.join(tmpDir, fname), entry.echolist.id, entry.echolist.name, entry.model, entry.type);
				if (result && !result.unchanged) imported++;
			}
		} finally {
			_cleanupTemp(tmpDir);
		}
	} else {
		// Direct file -- check if it matches any echolist/filebone name
		var entry = nameMap.get((newestFile.filename || '').toLowerCase());
		if (entry && _isNewer(newestFile, entry.echolist.last_imported_at)) {
			var result = await _importFile(filePath, entry.echolist.id, entry.echolist.name, entry.model, entry.type);
			if (result && !result.unchanged) imported++;
		}
	}

	return imported;
}

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

async function scanForUpdates() {
	var msgNetworks = (await import('../models/msgNetworks.js'));
	var networkEcholist = (await import('../models/networkEcholist.js'));
	var fileEcholist = (await import('../models/fileEcholist.js'));
	var fileEntriesModel = (await import('../models/fileEntries.js'));
	var fileAreasModel = (await import('../models/fileAreas.js'));
	var fileGroupsModel = (await import('../models/fileGroups.js'));

	var networks = await msgNetworks.getActiveNetworks();
	if (!networks || networks.length === 0) return;

	var totalImported = 0;
	var networksScanned = 0;

	for (var net of networks) {
		if (net.network_type !== 'FTN') continue;

		var echolists = await networkEcholist.getEcholistsByNetwork(net.id);
		var filebones = await fileEcholist.getEcholistsByNetwork(net.id);
		if ((!echolists || echolists.length === 0) && (!filebones || filebones.length === 0)) continue;

		networksScanned++;

		// Phase 1: Per-list scan_area overrides (checked first)
		for (var el of (echolists || [])) {
			if (!el.scan_area || !el.active) continue;
			var handled = await _scanListOverride(el, networkEcholist, 'echolist', fileEntriesModel, fileAreasModel, fileGroupsModel);
			if (handled) totalImported++;
		}
		for (var fb of (filebones || [])) {
			if (!fb.scan_area || !fb.active) continue;
			var handled = await _scanListOverride(fb, fileEcholist, 'filebone', fileEntriesModel, fileAreasModel, fileGroupsModel);
			if (handled) totalImported++;
		}

		// Phase 2: Network infopack_area (for lists without scan_area override)
		var infoImported = await _scanNetworkInfopack(
			net, echolists, filebones,
			networkEcholist, fileEcholist,
			fileEntriesModel, fileAreasModel, fileGroupsModel
		);
		totalImported += infoImported;
	}

	alogger.writeAlog(3,
		'[EcholistScan] Scan complete: ' + networksScanned + ' network(s) checked, ' +
		totalImported + ' list(s) updated',
		totalImported > 0 ? 'greenbright' : 'cyan'
	);
}

export { scanForUpdates };
