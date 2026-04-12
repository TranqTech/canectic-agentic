// diagnoseScanners.js — Diagnostic for echolist + nodelist scan jobs.
//
// Reproduces what src/maintenance/echolistScan.js and
// src/maintenance/nodelistImport.js scanForNewNodelists do, but logs
// every decision point so you can see why they're returning 0
// imported. Read-only -- no DB writes, no file moves.
//
// Usage:
//   node src/tools/diagnoseScanners.js
//
// Prints, for every active FTN network:
//   - configured nodelist/echolist/filebone/infopack areas
//   - whether each area resolves to a real file_areas row
//   - what files getEntriesForArea returns (filename, upload_date)
//   - the current nodelist_number from getImportInfo
//   - which files startsWith('NODELIST.'), what extractNodelistNumber
//     returns, and whether they pass the > currentNumber gate
//   - configured echolists/filebones with their last_imported_at
//   - which echolist/filebone names have a direct match in the
//     infopack area, and whether the matched file is "newer" by
//     the _isNewer check
//   - the newest ZIP in the area (no actual unzip -- just identifies it)
//
// At the end, prints a "verdict" for each scanner saying why it
// would or would not have imported anything.

import * as dotenv from 'dotenv';
import * as pgdb from '../middleware/db/postgres.js';
import appConfig from '../config/appConfig.js';
import * as msgNetworks from '../models/msgNetworks.js';
import * as networkEcholist from '../models/networkEcholist.js';
import * as fileEcholist from '../models/fileEcholist.js';
import * as fileEntries from '../models/fileEntries.js';
import * as fileAreas from '../models/fileAreas.js';
import * as fileGroups from '../models/fileGroups.js';
import * as ftnNodelist from '../models/ftnNodelist.js';

dotenv.config();

// Mirror of extractNodelistNumber from nodelistImport.js
function extractNodelistNumber(filePath) {
	var name = (filePath || '').toUpperCase();
	var slash = name.lastIndexOf('/');
	if (slash >= 0) name = name.substring(slash + 1);
	var match = name.match(/\.(\d+)$/);
	if (match) return parseInt(match[1]);
	var match2 = name.match(/\.[A-Z](\d+)$/);
	if (match2) return parseInt(match2[1]);
	return null;
}

// Mirror of _isNewer from echolistScan.js
function isNewer(fileEntry, lastImportedAt) {
	if (!lastImportedAt) return true;
	var fileDate = new Date(fileEntry.upload_date || fileEntry.created_at || 0);
	return fileDate > new Date(lastImportedAt);
}

function pad(s, n) {
	s = String(s);
	if (s.length >= n) return s;
	return s + ' '.repeat(n - s.length);
}

function fmtTs(ts) {
	if (!ts) return 'NULL';
	try { return new Date(ts).toISOString(); } catch (_) { return String(ts); }
}

async function dumpAreaFiles(label, areaShortcode) {
	console.log('  ' + label + ': "' + areaShortcode + '"');
	if (!areaShortcode) {
		console.log('    (not configured)');
		return null;
	}
	var area = await fileAreas.getAreaByShortcode(areaShortcode);
	if (!area) {
		console.log('    [!] getAreaByShortcode returned null -- area does not exist');
		return null;
	}
	console.log('    area_id=' + area.id + ' group_shortcode=' + area.group_shortcode);

	var files = await fileEntries.getEntriesForArea(area.id, { limit: 1000, orderBy: 'upload_date DESC' });
	console.log('    getEntriesForArea returned ' + (files ? files.length : 0) + ' active row(s)');
	if (files && files.length > 0) {
		var show = files.slice(0, 15);
		for (var f of show) {
			console.log('      ' + pad(f.filename, 40) + '  upload_date=' + fmtTs(f.upload_date) +
				'  active=' + f.active + '  source_type=' + f.source_type);
		}
		if (files.length > 15) console.log('      ... (' + (files.length - 15) + ' more)');
	}
	return { area: area, files: files || [] };
}

async function diagnoseNetwork(net) {
	console.log('');
	console.log('============================================================');
	console.log('Network: ' + net.name + ' (id=' + net.id + ', type=' + net.network_type + ')');
	console.log('============================================================');

	if (net.network_type !== 'FTN') {
		console.log('  [skipped] not an FTN network');
		return;
	}

	var config = net.config;
	if (typeof config === 'string') { try { config = JSON.parse(config); } catch (_) { config = {}; } }
	if (!config) config = {};

	console.log('  config:');
	console.log('    nodelist_area_shortcode=' + (config.nodelist_area_shortcode || 'NULL'));
	console.log('    echolist_area=' + (config.echolist_area || 'NULL'));
	console.log('    filebone_area=' + (config.filebone_area || 'NULL'));
	console.log('    infopack_area=' + (config.infopack_area || 'NULL'));

	// ---- NODELIST SCAN ----
	console.log('');
	console.log('  --- nodelist scan trace ---');
	var ndArea = await dumpAreaFiles('nodelist_area', config.nodelist_area_shortcode);

	var importInfo = await ftnNodelist.getImportInfo(net.id);
	var currentNumber = importInfo ? (importInfo.nodelist_number || 0) : 0;
	console.log('    getImportInfo: nodelist_number=' + (importInfo ? importInfo.nodelist_number : 'NULL') +
		'  last_import=' + (importInfo ? fmtTs(importInfo.last_import) : 'NULL') +
		'  entry_count=' + (importInfo ? importInfo.entry_count : 'NULL'));
	console.log('    -> currentNumber gate = ' + currentNumber);

	if (ndArea && ndArea.files.length > 0) {
		console.log('    candidate evaluation (looking for files startsWith "NODELIST." with day > ' + currentNumber + '):');
		var matched = 0;
		var bestFile = null;
		var bestNumber = currentNumber;
		for (var f of ndArea.files) {
			var fname = (f.filename || '').toUpperCase();
			if (!fname.startsWith('NODELIST.')) continue;
			matched++;
			var num = extractNodelistNumber(f.filename);
			var verdict;
			if (num === null) verdict = 'extractNodelistNumber=NULL (no day)';
			else if (num <= currentNumber) verdict = 'day=' + num + ' <= currentNumber=' + currentNumber + ' -- skipped';
			else if (num <= bestNumber) verdict = 'day=' + num + ' but a higher candidate already chosen';
			else { verdict = 'day=' + num + ' WINS so far'; bestNumber = num; bestFile = f; }
			console.log('      ' + pad(f.filename, 40) + '  ' + verdict);
		}
		if (matched === 0) console.log('      (no files start with NODELIST.)');
		console.log('    nodelist verdict: ' + (bestFile ? 'WOULD IMPORT ' + bestFile.filename : 'NOTHING TO IMPORT'));
	}

	// ---- ECHOLIST + FILEBONE SCAN ----
	console.log('');
	console.log('  --- echolist/filebone scan trace ---');

	var echolists = await networkEcholist.getEcholistsByNetwork(net.id);
	var filebones = await fileEcholist.getEcholistsByNetwork(net.id);
	console.log('    networkEcholist count: ' + (echolists ? echolists.length : 0));
	if (echolists && echolists.length > 0) {
		for (var el of echolists) {
			console.log('      [echolist] id=' + el.id + ' name="' + el.name + '" active=' + el.active +
				' scan_area=' + (el.scan_area || 'NULL') +
				' last_imported_at=' + fmtTs(el.last_imported_at));
		}
	}
	console.log('    fileEcholist (filebone) count: ' + (filebones ? filebones.length : 0));
	if (filebones && filebones.length > 0) {
		for (var fb of filebones) {
			console.log('      [filebone] id=' + fb.id + ' name="' + fb.name + '" active=' + fb.active +
				' scan_area=' + (fb.scan_area || 'NULL') +
				' last_imported_at=' + fmtTs(fb.last_imported_at));
		}
	}

	if ((!echolists || echolists.length === 0) && (!filebones || filebones.length === 0)) {
		console.log('    [skipped] no echolists or filebones configured for this network');
		return;
	}

	// Walk each tier the scanner walks
	if (config.echolist_area) {
		console.log('');
		var elArea = await dumpAreaFiles('echolist_area (tier 2)', config.echolist_area);
		if (elArea) await traceMatch(elArea, echolists, 'echolist');
	}
	if (config.filebone_area) {
		console.log('');
		var fbArea = await dumpAreaFiles('filebone_area (tier 3)', config.filebone_area);
		if (fbArea) await traceMatch(fbArea, filebones, 'filebone');
	}
	if (config.infopack_area) {
		console.log('');
		var ipArea = await dumpAreaFiles('infopack_area (tier 4)', config.infopack_area);
		if (ipArea) {
			await traceMatch(ipArea, echolists, 'echolist (via infopack)');
			await traceMatch(ipArea, filebones, 'filebone (via infopack)');
		}
	}
}

async function traceMatch(areaInfo, lists, label) {
	console.log('    --- direct-match trace for ' + label + ' ---');
	if (!lists || lists.length === 0) { console.log('      (no lists)'); return; }

	var nameMap = new Map();
	for (var l of lists) {
		if (!l.active) continue;
		nameMap.set((l.name || '').toLowerCase(), l);
	}

	for (var [lowerName, l] of nameMap) {
		var hit = null;
		for (var f of areaInfo.files) {
			if ((f.filename || '').toLowerCase() === lowerName) { hit = f; break; }
		}
		if (!hit) {
			console.log('      [no direct match] "' + l.name + '" -- not present as a loose file in this area');
			continue;
		}
		var newer = isNewer(hit, l.last_imported_at);
		console.log('      [direct match] "' + l.name + '" -> ' + hit.filename +
			'  upload=' + fmtTs(hit.upload_date) +
			'  last_imported_at=' + fmtTs(l.last_imported_at) +
			'  isNewer=' + newer);
	}

	// Newest archive in the area
	var zips = areaInfo.files.filter(function(f) {
		var ext = (f.filename || '').toLowerCase().split('.').pop();
		return ext === 'zip' || ext === 'lzh' || ext === 'rar' || ext === '7z';
	});
	if (zips.length > 0) {
		var newest = zips[0]; // already sorted DESC
		for (var z of zips) {
			if (new Date(z.upload_date || 0) > new Date(newest.upload_date || 0)) newest = z;
		}
		console.log('    newest archive in this area: ' + newest.filename + ' (upload=' + fmtTs(newest.upload_date) + ')');
		console.log('      -- the scanner would unzip this and look inside for any of: ' +
			Array.from(nameMap.keys()).join(', '));
	} else {
		console.log('    no archives (.zip/.lzh/.rar/.7z) found in this area');
	}
}

async function main() {
	try {
		await appConfig.load();
	} catch (e) {
		console.error('Fatal: appConfig load failed: ' + (e.message || e));
		process.exit(2);
	}

	try {
		await pgdb.query('SELECT 1', []);
	} catch (e) {
		console.error('Fatal: DB unreachable: ' + e.message);
		process.exit(2);
	}

	console.log('Scanner diagnostic -- read-only, no writes performed');
	console.log('');

	var nets = await msgNetworks.getActiveNetworks();
	if (!nets || nets.length === 0) {
		console.log('No active networks found.');
		process.exit(0);
	}
	console.log('Found ' + nets.length + ' active network(s)');

	for (var n of nets) {
		await diagnoseNetwork(n);
	}

	console.log('');
	console.log('Diagnostic complete.');
	process.exit(0);
}

main().catch(function(e) {
	console.error('Fatal: ' + (e && e.message ? e.message : e));
	if (e && e.stack) console.error(e.stack);
	process.exit(2);
});
