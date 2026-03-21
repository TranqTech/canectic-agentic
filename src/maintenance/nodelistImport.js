// nodelistImport.js — FTN nodelist import orchestrator.
//
// Ties the parser and model together.  Called by the Worker process
// via the maintenance queue's 'import-nodelist' job.
//
// Flow:
//   1. Parse the nodelist file
//   2. Validate: check error rate, ensure we got entries
//   3. Upsert into ftn_nodelist via the model
//   4. Log results
//   5. Return stats

import { parseNodelistFile, parseNodelistText } from '../utils/nodelistParser.js';
import * as ftnNodelist from '../models/ftnNodelist.js';
import * as alogger from '../utils/alogger.js';
import { basename } from 'path';
import AdmZip from 'adm-zip';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Extract nodelist number from filename
// Supports: NODELIST.074, NODELIST.Z79, NODELIST.Z7, NODELIST.A79, etc.
// The number is the digits in the extension (ignoring any leading letter)
// ---------------------------------------------------------------------------

function extractNodelistNumber(filePath) {
	var name = basename(filePath).toUpperCase();
	// Try pure numeric extension first: NODELIST.074
	var match = name.match(/\.(\d+)$/);
	if (match) {
		return parseInt(match[1]);
	}
	// Try letter+digits: NODELIST.Z79, NODELIST.A07
	var match2 = name.match(/\.[A-Z](\d+)$/);
	if (match2) {
		return parseInt(match2[1]);
	}
	return null;
}

// ---------------------------------------------------------------------------
// ZIP handling — detect and extract nodelist from ZIP archives
// ---------------------------------------------------------------------------

function isZipFile(filePath) {
	try {
		var buf = Buffer.alloc(4);
		var fd = fs.openSync(filePath, 'r');
		fs.readSync(fd, buf, 0, 4, 0);
		fs.closeSync(fd);
		// ZIP magic: PK\x03\x04
		return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
	} catch (_) {
		return false;
	}
}

function extractNodelistFromZip(filePath) {
	var zip = new AdmZip(filePath);
	var entries = zip.getEntries();

	// Look for NODELIST.* or any .??? file that looks like a nodelist
	for (var entry of entries) {
		var name = (entry.entryName || '').toUpperCase();
		var baseName = basename(name);
		if (baseName.startsWith('NODELIST.')) {
			var content = entry.getData();
			if (content && content.length > 0) {
				alogger.writeAlog(3, '[NodelistImport] Extracted from ZIP: ' + entry.entryName + ' (' + content.length + ' bytes)', 'cyan');
				return { text: content.toString('latin1'), filename: entry.entryName };
			}
		}
	}

	// Fallback: try the largest text-like file in the ZIP
	var largest = null;
	for (var e of entries) {
		if (e.isDirectory) continue;
		if (!largest || e.header.size > largest.header.size) {
			largest = e;
		}
	}
	if (largest) {
		var content = largest.getData();
		if (content && content.length > 0) {
			alogger.writeAlog(3, '[NodelistImport] Extracted largest file from ZIP: ' + largest.entryName + ' (' + content.length + ' bytes)', 'yellow');
			return { text: content.toString('latin1'), filename: largest.entryName };
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// importFromFile — main entry point
// ---------------------------------------------------------------------------

async function importFromFile(filePath, networkId, opts) {
	opts = opts || {};
	var startTime = Date.now();

	alogger.writeAlog(2, '[NodelistImport] Starting import: ' + filePath + ' for network ' + networkId, 'cyan');

	// Ensure the table exists
	await ftnNodelist.ensureTable();

	// Step 1: Parse (handle ZIP archives)
	var parseResult;
	var effectiveFilename = basename(filePath);
	try {
		if (isZipFile(filePath)) {
			alogger.writeAlog(3, '[NodelistImport] Detected ZIP archive, extracting...', 'cyan');
			var extracted = extractNodelistFromZip(filePath);
			if (!extracted) {
				alogger.writeAlog(0, '[NodelistImport] No nodelist found inside ZIP archive', 'redbright');
				return { status: false, error: 'No nodelist found inside ZIP archive' };
			}
			effectiveFilename = extracted.filename;
			parseResult = parseNodelistText(extracted.text);
		} else {
			parseResult = await parseNodelistFile(filePath);
		}
	} catch (err) {
		alogger.writeAlog(0, '[NodelistImport] Failed to read/parse file: ' + err.message, 'redbright');
		return { status: false, error: 'Failed to read/parse file: ' + err.message };
	}

	var entries = parseResult.entries;
	var parseErrors = parseResult.errors;

	alogger.writeAlog(3, '[NodelistImport] Parsed ' + entries.length + ' entries, ' + parseErrors.length + ' errors', 'cyan');

	// Step 2: Validate
	if (entries.length === 0) {
		alogger.writeAlog(0, '[NodelistImport] No entries parsed from file — aborting', 'redbright');
		return { status: false, error: 'No entries parsed from file' };
	}

	var totalLines = entries.length + parseErrors.length;
	var errorRate = parseErrors.length / totalLines;
	var maxErrorRate = opts.maxErrorRate || 0.05;

	if (errorRate > maxErrorRate) {
		alogger.writeAlog(0,
			'[NodelistImport] Error rate too high: ' + parseErrors.length + '/' + totalLines +
			' (' + (errorRate * 100).toFixed(1) + '%) — aborting (threshold: ' + (maxErrorRate * 100) + '%)',
			'redbright'
		);
		return {
			status: false,
			error: 'Error rate too high: ' + (errorRate * 100).toFixed(1) + '%',
			parseErrors: parseErrors
		};
	}

	// Extract nodelist number — try extracted ZIP filename, then original upload name, then temp path
	var nodelistNumber = opts.nodelistNumber
		|| extractNodelistNumber(effectiveFilename)
		|| (opts.originalName ? extractNodelistNumber(opts.originalName) : null);
	var nodelistDate   = opts.nodelistDate   || null;

	// Step 3: Import
	var importResult;
	try {
		importResult = await ftnNodelist.importNodelist(networkId, entries, {
			nodelistNumber: nodelistNumber,
			nodelistDate:   nodelistDate,
			batchSize:      opts.batchSize || 500
		});
	} catch (err) {
		alogger.writeAlog(0, '[NodelistImport] Database import failed: ' + err.message, 'redbright');
		return { status: false, error: 'Database import failed: ' + err.message };
	}

	// Step 4: Log results
	var elapsed = Date.now() - startTime;
	alogger.writeAlog(1,
		'[NodelistImport] Complete: ' + importResult.newNodes + ' new, ' +
		importResult.updatedNodes + ' updated, ' +
		importResult.deactivatedNodes + ' deactivated (' + elapsed + 'ms)',
		'greenbright'
	);

	if (parseErrors.length > 0) {
		alogger.writeAlog(3,
			'[NodelistImport] ' + parseErrors.length + ' parse warning(s) — non-fatal',
			'yellow'
		);
	}

	// Step 5: Return
	return {
		status: true,
		newNodes:         importResult.newNodes,
		updatedNodes:     importResult.updatedNodes,
		deactivatedNodes: importResult.deactivatedNodes,
		totalEntries:     entries.length,
		parseErrors:      parseErrors,
		nodelistNumber:   nodelistNumber,
		elapsed:          elapsed
	};
}

// ---------------------------------------------------------------------------
// scanForNewNodelists — scheduled daily task
// Checks each FTN network's configured nodelist file area for files
// newer than the last import. Auto-imports the newest one found.
// ---------------------------------------------------------------------------

async function scanForNewNodelists() {
	var msgNetworks = (await import('../models/msgNetworks.js'));
	var fileEntriesModel = (await import('../models/fileEntries.js'));
	var fileAreasModel = (await import('../models/fileAreas.js'));
	var fileGroupsModel = (await import('../models/fileGroups.js'));
	var pathMod = (await import('path'));

	var networks = await msgNetworks.getActiveNetworks();
	if (!networks || networks.length === 0) return;

	var scanned = 0;
	var imported = 0;

	for (var net of networks) {
		if (net.network_type !== 'FTN') continue;

		var config = net.config;
		if (typeof config === 'string') { try { config = JSON.parse(config); } catch(_) { config = {}; } }
		if (!config || !config.nodelist_area_shortcode) continue;

		var areaShortcode = config.nodelist_area_shortcode;
		var area = await fileAreasModel.getAreaByShortcode(areaShortcode);
		if (!area) {
			alogger.writeAlog(3, '[NodelistScan] Area not found for network ' + net.name + ': ' + areaShortcode, 'yellow');
			continue;
		}

		scanned++;

		// Get the current import info for this network
		var importInfo = await ftnNodelist.getImportInfo(net.id);
		var currentNumber = importInfo ? (importInfo.nodelist_number || 0) : 0;

		// Get files in the area, look for NODELIST.nnn pattern
		var files = await fileEntriesModel.getEntriesForArea(area.id, { limit: 1000, orderBy: 'upload_date DESC' });
		if (!files || files.length === 0) continue;

		var bestFile = null;
		var bestNumber = currentNumber;

		for (var f of files) {
			var fname = (f.filename || '').toUpperCase();
			// Match NODELIST.nnn, NODELIST.Znn, NODELIST.Ann, or zipped versions
			if (!fname.startsWith('NODELIST.')) continue;

			var num = extractNodelistNumber(f.filename);
			if (num !== null && num > bestNumber) {
				bestNumber = num;
				bestFile = f;
			}
		}

		if (!bestFile) continue;

		// Found a newer nodelist — resolve its path and import
		var group = area.group_shortcode ? await fileGroupsModel.getGroupByShortcode(area.group_shortcode) : null;
		var areaPath = fileAreasModel.resolveAreaPath(group, area);
		var filePath = pathMod.join(areaPath, bestFile.disk_path || bestFile.filename);

		alogger.writeAlog(2, '[NodelistScan] Found newer nodelist for ' + net.name + ': ' + bestFile.filename + ' (day ' + bestNumber + ', current: ' + currentNumber + ')', 'cyan');

		var result = await importFromFile(filePath, net.id, { originalName: bestFile.filename });
		if (result.status) {
			imported++;
			alogger.writeAlog(1, '[NodelistScan] Auto-imported nodelist for ' + net.name + ': ' + result.totalEntries + ' entries', 'greenbright');
		} else {
			alogger.writeAlog(2, '[NodelistScan] Auto-import failed for ' + net.name + ': ' + (result.error || 'unknown'), 'redbright');
		}
	}

	alogger.writeAlog(3, '[NodelistScan] Scan complete: ' + scanned + ' network(s) checked, ' + imported + ' imported', 'cyan');
}

export {
	importFromFile,
	extractNodelistNumber,
	scanForNewNodelists
};
