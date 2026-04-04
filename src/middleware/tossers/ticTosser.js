// ticTosser.js — FTN TIC file echo processor
//
// Handles inbound .tic files (parse, validate, import to file areas, create
// distribution rows) and outbound TIC generation (build descriptors, stage
// files for the mailer).
//
// Follows the same structural patterns as ftnTosser.js.

import * as fs from 'fs';
import * as path from 'path';

// Internal modules
import * as fileEntries from '../../models/fileEntries.js';
import * as fileAreas from '../../models/fileAreas.js';
import * as fileGroups from '../../models/fileGroups.js';
import * as fileNetworkAreas from '../../models/fileNetworkAreas.js';
import * as filePeerSubscriptions from '../../models/filePeerSubscriptions.js';
import * as fileDistribution from '../../models/fileDistribution.js';
import * as peerConnections from '../../models/peerConnections.js';
import * as systemAddresses from '../../models/systemAddresses.js';
import { computeHashes } from '../../utils/fileHasher.js';
import { applyDescriptions } from '../../utils/fileDescExtractor.js';
import appConfig from '../../config/appConfig.js';
import * as alogger from '../../utils/alogger.js';

// ---------------------------------------------------------------------------
// TIC file parser
// ---------------------------------------------------------------------------

/**
 * Parse a TIC file into a structured object.
 * TIC format: one key-value pair per line, first word is key, rest is value.
 * LDesc, Path, and Seenby can appear multiple times — accumulated into arrays.
 */
function parseTicFile(ticContent) {
	var tic = {
		area: '',
		file: '',
		replaces: '',
		desc: '',
		ldesc: [],
		size: 0,
		date: 0,
		crc: '',
		origin: '',
		from: '',
		to: '',
		path: [],
		seenby: [],
		pw: '',
		magic: ''
	};

	var lines = ticContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

	for (var line of lines) {
		var trimmed = line.trim();
		if (!trimmed || trimmed.length === 0) continue;

		var spaceIdx = trimmed.indexOf(' ');
		if (spaceIdx === -1) {
			// Key with no value (unlikely but handle gracefully)
			continue;
		}

		var key = trimmed.substring(0, spaceIdx).toLowerCase();
		var value = trimmed.substring(spaceIdx + 1).trim();

		switch (key) {
			case 'area':
				tic.area = value;
				break;
			case 'file':
				tic.file = value;
				break;
			case 'replaces':
				tic.replaces = value;
				break;
			case 'desc':
				tic.desc = value;
				break;
			case 'ldesc':
				tic.ldesc.push(value);
				break;
			case 'size':
				tic.size = parseInt(value) || 0;
				break;
			case 'date':
				tic.date = parseInt(value) || 0;
				break;
			case 'crc':
				tic.crc = value.toUpperCase();
				break;
			case 'origin':
				tic.origin = value;
				break;
			case 'from':
				tic.from = value;
				break;
			case 'to':
				tic.to = value;
				break;
			case 'path':
				tic.path.push(value);
				break;
			case 'seenby':
				tic.seenby.push(value);
				break;
			case 'pw':
				tic.pw = value;
				break;
			case 'magic':
				tic.magic = value;
				break;
			default:
				// Unknown key — ignore (TIC files may have vendor extensions)
				break;
		}
	}

	return tic;
}

/**
 * Build a TIC descriptor string from structured data.
 */
function buildTicDescriptor(ticData) {
	var lines = [];

	lines.push('Area ' + ticData.area);
	lines.push('File ' + ticData.file);
	if (ticData.replaces) lines.push('Replaces ' + ticData.replaces);
	if (ticData.desc) lines.push('Desc ' + ticData.desc);
	if (ticData.ldesc && ticData.ldesc.length > 0) {
		for (var ld of ticData.ldesc) {
			lines.push('LDesc ' + ld);
		}
	}
	if (ticData.size) lines.push('Size ' + ticData.size);
	if (ticData.date) lines.push('Date ' + ticData.date);
	if (ticData.crc) lines.push('CRC ' + ticData.crc);
	if (ticData.origin) lines.push('Origin ' + ticData.origin);
	if (ticData.from) lines.push('From ' + ticData.from);
	if (ticData.to) lines.push('To ' + ticData.to);
	if (ticData.path && ticData.path.length > 0) {
		for (var p of ticData.path) {
			lines.push('Path ' + p);
		}
	}
	if (ticData.seenby && ticData.seenby.length > 0) {
		for (var sb of ticData.seenby) {
			lines.push('Seenby ' + sb);
		}
	}
	if (ticData.pw) lines.push('Pw ' + ticData.pw);
	if (ticData.magic) lines.push('Magic ' + ticData.magic);

	return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

function ensureDirSync(dirPath) {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

function getInboundDir() {
	var ticInbound = appConfig.get('tic_inbound_dir', '');
	if (ticInbound) return ticInbound;
	return appConfig.get('ftninbound', 'ftn/in');
}

function getTossedDir() {
	return appConfig.get('ftntossed', 'ftn/tossed');
}

function getBadDir() {
	var badDir = appConfig.get('ftnbad', 'ftn/bad');
	ensureDirSync(badDir);
	return badDir;
}

function getOutboundDir() {
	return appConfig.get('ftnoutbound', 'ftn/out');
}

// ---------------------------------------------------------------------------
// Inbound TIC processing
// ---------------------------------------------------------------------------

/**
 * Find the FTN peer connection that matches a 'From' address.
 * Returns the connection row or null.
 */
async function resolveSourceConnection(fromAddress) {
	if (!fromAddress) return null;

	var ftnConnections = await peerConnections.getActiveConnectionsByNetworkType('FTN');
	for (var conn of ftnConnections) {
		var cd = conn.connection_data || {};
		if (cd.address && cd.address.toLowerCase() === fromAddress.toLowerCase()) {
			return conn;
		}
	}
	return null;
}

/**
 * Check if a 'To' address matches one of our system addresses.
 */
async function validateToAddress(toAddress, networkId) {
	if (!toAddress) return true; // Some TIC files omit To — allow

	var sysAddr = await systemAddresses.getDefaultAddress(networkId);
	if (sysAddr && sysAddr.address) {
		if (sysAddr.address.toLowerCase() === toAddress.toLowerCase()) {
			return true;
		}
	}

	// Also check all active addresses on this network
	var allAddrs = await systemAddresses.getAddressesByNetwork(networkId);
	if (allAddrs) {
		for (var addr of allAddrs) {
			if (addr.address && addr.address.toLowerCase() === toAddress.toLowerCase()) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Process all inbound .tic files from the inbound directory.
 */
async function tossInbound() {
	var inDir = getInboundDir();
	var tossedDir = getTossedDir();
	var badDir = getBadDir();

	ensureDirSync(inDir);
	ensureDirSync(tossedDir);

	var summary = { processed: 0, errors: 0, dupes: 0, skipped: 0 };

	// Scan for .tic files (case-insensitive)
	var filelist;
	try {
		filelist = fs.readdirSync(inDir);
	} catch (err) {
		alogger.writeAlog(2, '[TIC] Cannot read inbound directory ' + inDir + ': ' + err.message, 'redbright');
		return summary;
	}

	var ticFiles = filelist.filter(function(f) {
		return f.toLowerCase().endsWith('.tic');
	});

	if (ticFiles.length === 0) {
		alogger.writeAlog(3, '[TIC] No .tic files in ' + inDir, 'cyan');
		return summary;
	}

	alogger.writeAlog(2, '[TIC] Found ' + ticFiles.length + ' .tic file(s) in ' + inDir, 'cyan');

	for (var ticFilename of ticFiles) {
		var ticFilePath = path.join(inDir, ticFilename);

		try {
			var result = await processOneTicFile(ticFilePath, ticFilename, inDir, tossedDir, badDir);

			if (result === 'processed') {
				summary.processed++;
			} else if (result === 'dupe') {
				summary.dupes++;
			} else if (result === 'skipped') {
				summary.skipped++;
			} else {
				summary.errors++;
			}
		} catch (err) {
			alogger.writeAlog(2, '[TIC] Unhandled error processing ' + ticFilename + ': ' + err.message, 'redbright');
			summary.errors++;
			// Move to bad dir
			try {
				await fs.promises.rename(ticFilePath, path.join(badDir, ticFilename));
			} catch (_) {}
		}
	}

	alogger.writeAlog(2,
		'[TIC] Inbound complete: ' + summary.processed + ' processed, ' +
		summary.dupes + ' dupes, ' + summary.skipped + ' skipped, ' +
		summary.errors + ' errors',
		summary.errors > 0 ? 'yellowbright' : 'greenbright'
	);

	return summary;
}

/**
 * Process a single inbound TIC file.
 * Returns: 'processed', 'dupe', 'skipped', or 'error'
 */
async function processOneTicFile(ticFilePath, ticFilename, inDir, tossedDir, badDir) {
	// 1. Read and parse the TIC file
	var ticContent;
	try {
		ticContent = fs.readFileSync(ticFilePath, 'utf8');
	} catch (err) {
		alogger.writeAlog(2, '[TIC] Cannot read ' + ticFilename + ': ' + err.message, 'redbright');
		return 'error';
	}

	var tic = parseTicFile(ticContent);

	if (!tic.file) {
		alogger.writeAlog(2, '[TIC] ' + ticFilename + ': missing File field', 'redbright');
		await moveToBad(ticFilePath, ticFilename, badDir);
		return 'error';
	}

	if (!tic.area) {
		alogger.writeAlog(2, '[TIC] ' + ticFilename + ': missing Area field', 'redbright');
		await moveToBad(ticFilePath, ticFilename, badDir);
		return 'error';
	}

	alogger.writeAlog(3, '[TIC] Processing: ' + tic.file + ' in area ' + tic.area + ' from ' + tic.from, 'cyan');

	// 2. Find the attached file
	var attachedFilePath = path.join(inDir, tic.file);

	// Try case-insensitive match if exact name not found
	if (!fs.existsSync(attachedFilePath)) {
		var dirFiles = fs.readdirSync(inDir);
		var match = dirFiles.find(function(f) {
			return f.toLowerCase() === tic.file.toLowerCase();
		});
		if (match) {
			attachedFilePath = path.join(inDir, match);
			tic.file = match; // Use actual filename on disk
		} else {
			alogger.writeAlog(2, '[TIC] ' + ticFilename + ': attached file ' + tic.file + ' not found in ' + inDir, 'redbright');
			await moveToBad(ticFilePath, ticFilename, badDir);
			return 'error';
		}
	}

	// 3. Resolve source connection from From address
	var sourceConn = await resolveSourceConnection(tic.from);

	// 4. Validate TIC password
	if (sourceConn) {
		var cd = sourceConn.connection_data || {};
		var expectedPw = cd.tic_password || '';
		if (expectedPw && tic.pw) {
			if (expectedPw.toUpperCase() !== tic.pw.toUpperCase()) {
				alogger.writeAlog(2, '[TIC] ' + ticFilename + ': TIC password mismatch from ' + tic.from, 'redbright');
				await moveToBad(ticFilePath, ticFilename, badDir);
				return 'error';
			}
		}
		// If either side has no password configured, allow (common in small nets)
	}

	// 5. Resolve area tag to file_area via file_network_areas
	var networkId = sourceConn ? sourceConn.network_id : null;

	// If no source connection found, try all FTN networks
	var areaMapping = null;
	if (networkId) {
		areaMapping = await fileNetworkAreas.getAreaByTag(networkId, tic.area);
	}
	if (!areaMapping) {
		// Try all FTN networks as fallback
		var ftnConns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
		var triedNetworks = networkId ? [networkId] : [];
		for (var conn of ftnConns) {
			if (triedNetworks.indexOf(conn.network_id) !== -1) continue;
			triedNetworks.push(conn.network_id);
			areaMapping = await fileNetworkAreas.getAreaByTag(conn.network_id, tic.area);
			if (areaMapping) {
				networkId = conn.network_id;
				break;
			}
		}
	}

	if (!areaMapping) {
		alogger.writeAlog(2, '[TIC] ' + ticFilename + ': area tag ' + tic.area + ' not mapped to any file area', 'yellowbright');
		await moveToBad(ticFilePath, ticFilename, badDir);
		return 'skipped';
	}

	var fileAreaId = areaMapping.area_id;
	var areaShortcode = areaMapping.shortcode;

	// 6. Validate To address
	if (tic.to && networkId) {
		var toValid = await validateToAddress(tic.to, networkId);
		if (!toValid) {
			alogger.writeAlog(2, '[TIC] ' + ticFilename + ': To address ' + tic.to + ' does not match any system address', 'yellowbright');
			// Not fatal — some TIC implementations omit or mis-set To
		}
	}

	// 7. Check peer subscription (if source connection known)
	if (sourceConn) {
		var subscribed = await filePeerSubscriptions.isSubscribed(sourceConn.id, fileAreaId);
		if (!subscribed) {
			alogger.writeAlog(3, '[TIC] ' + ticFilename + ': area ' + tic.area + ' not subscribed for connection ' + sourceConn.id + ' — allowing anyway (inbound)', 'yellow');
			// Log but don't reject — many sysops want to receive first, subscribe later
		}
	}

	// 8. Verify CRC-32
	var hashes = computeHashes(attachedFilePath);
	if (tic.crc) {
		if (hashes.crc32 !== tic.crc.toUpperCase().padStart(8, '0')) {
			alogger.writeAlog(2,
				'[TIC] ' + ticFilename + ': CRC mismatch — TIC says ' + tic.crc +
				', file is ' + hashes.crc32, 'redbright'
			);
			await moveToBad(ticFilePath, ticFilename, badDir);
			return 'error';
		}
	}

	// 9. Dupe check
	var isDupe = await fileEntries.checkDupe(fileAreaId, tic.file, hashes.crc32);
	if (isDupe) {
		alogger.writeAlog(3, '[TIC] ' + ticFilename + ': dupe — ' + tic.file + ' already exists in area ' + areaShortcode, 'yellow');
		// Move TIC and attached file to tossed (not bad — it's a valid dupe)
		await moveToTossed(ticFilePath, ticFilename, tossedDir);
		try {
			await fs.promises.rename(attachedFilePath, path.join(tossedDir, tic.file));
		} catch (_) {}
		return 'dupe';
	}

	// 10. Handle Replaces — deactivate old file if specified
	if (tic.replaces) {
		var oldEntry = await findEntryByFilename(fileAreaId, tic.replaces);
		if (oldEntry) {
			await fileEntries.deactivateEntry(oldEntry.id);
			alogger.writeAlog(3, '[TIC] Deactivated replaced file: ' + tic.replaces + ' in ' + areaShortcode, 'cyan');
		}
	}

	// 11. Resolve area path and move file
	var dbarea = await fileAreas.getAreaByShortcode(areaShortcode);
	var dbgroup = await fileGroups.getGroupByShortcode(dbarea.group_shortcode);
	var areaPath = fileAreas.resolveAreaPath(dbgroup, dbarea);
	ensureDirSync(areaPath);

	var destFilePath = path.join(areaPath, tic.file);

	// Handle filename collision on disk (shouldn't happen after dupe check, but be safe)
	if (fs.existsSync(destFilePath)) {
		var ext = path.extname(tic.file);
		var base = path.basename(tic.file, ext);
		var counter = 1;
		while (fs.existsSync(destFilePath)) {
			destFilePath = path.join(areaPath, base + '_' + counter + ext);
			counter++;
		}
		alogger.writeAlog(3, '[TIC] Filename collision — saving as ' + path.basename(destFilePath), 'yellow');
	}

	await fs.promises.rename(attachedFilePath, destFilePath);

	// 12. Build file entry
	var fileDate = tic.date ? new Date(tic.date * 1000) : new Date();
	var shortDesc = tic.desc || '';
	var longDesc = tic.ldesc.length > 0 ? tic.ldesc.join('\n') : null;
	var longDescHtml = null;

	// If no LDesc in TIC, try extracting FILE_ID.DIZ
	var entryObj = {
		short_desc: shortDesc || null,
		long_desc: longDesc,
		long_desc_html: longDescHtml
	};

	if (!longDesc) {
		applyDescriptions(entryObj, destFilePath);
	}

	// If still no short_desc, derive from filename
	if (!entryObj.short_desc && !shortDesc) {
		entryObj.short_desc = tic.file;
	}

	// Build source_data JSONB
	var sourceData = {
		tic_origin: tic.origin || '',
		tic_from: tic.from || '',
		tic_area: tic.area,
		tic_replaces: tic.replaces || '',
		tic_magic: tic.magic || '',
		tic_path: tic.path,
		tic_seenby: tic.seenby,
		tic_pw: tic.pw ? 'verified' : '',
		tic_ldesc: tic.ldesc,
		tic_crc: hashes.crc32
	};

	var stat = fs.statSync(destFilePath);

	var addResult = await fileEntries.addFileEntry({
		area_id: fileAreaId,
		area_shortcode: areaShortcode,
		filename: path.basename(destFilePath),
		disk_path: path.basename(destFilePath),
		file_size: stat.size,
		file_date: fileDate,
		file_hash_crc32: hashes.crc32,
		file_hash_sha256: hashes.sha256,
		short_desc: entryObj.short_desc || shortDesc || tic.file,
		long_desc: entryObj.long_desc || longDesc,
		long_desc_html: entryObj.long_desc_html || null,
		upload_date: new Date(),
		uploader_uuid: null,
		uploader_name: tic.origin || tic.from || 'Network Import',
		source_type: 'ftn',
		source_network_id: networkId,
		source_peer_id: sourceConn ? sourceConn.peer_id : null,
		source_data: sourceData
	});

	if (!addResult.status) {
		alogger.writeAlog(2, '[TIC] Failed to insert file entry for ' + tic.file + ': ' + addResult.errormessages.join(', '), 'redbright');
		return 'error';
	}

	// 13. Create distribution rows for all subscribed peers EXCEPT source
	var subscribers = await filePeerSubscriptions.getSubscribedConnections(fileAreaId);

	// Build seenby set for exclusion (includes source connection + TIC seenby)
	var seenbySet = new Set();
	for (var sb of tic.seenby) {
		seenbySet.add(sb.toLowerCase().trim());
	}
	for (var pp of tic.path) {
		// Path entries may include timestamps — extract just the address
		var pathAddr = pp.split(' ')[0];
		seenbySet.add(pathAddr.toLowerCase().trim());
	}
	if (tic.from) seenbySet.add(tic.from.toLowerCase().trim());

	var distConnIds = [];
	for (var sub of subscribers) {
		var subCd = sub.connection_data || {};
		var subAddr = (subCd.address || '').toLowerCase().trim();

		// Skip source connection
		if (sourceConn && sub.peer_connection_id === sourceConn.id) continue;

		// Skip if already in seenby
		if (subAddr && seenbySet.has(subAddr)) continue;

		distConnIds.push(sub.peer_connection_id);
	}

	if (distConnIds.length > 0) {
		await fileDistribution.createDistributionRows(addResult.entryId, distConnIds, 'tic');
		alogger.writeAlog(3, '[TIC] Created ' + distConnIds.length + ' distribution row(s) for ' + tic.file, 'cyan');
	}

	// 14. Move .tic to tossed
	await moveToTossed(ticFilePath, ticFilename, tossedDir);

	// 15. Update area stats
	await fileAreas.updateStatsForArea(areaShortcode);

	alogger.writeAlog(2, '[TIC] Imported: ' + tic.file + ' -> ' + areaShortcode + ' (' + hashes.crc32 + ')', 'greenbright');

	return 'processed';
}

// ---------------------------------------------------------------------------
// Outbound TIC processing
// ---------------------------------------------------------------------------

/**
 * Build and stage outbound .tic files for all pending distributions.
 */
async function tossOutbound() {
	var outDir = getOutboundDir();
	ensureDirSync(outDir);

	var summary = { sent: 0, errors: 0, skipped: 0 };

	// Get all pending distribution rows
	var pendingRows = await fileDistribution.getAllPending();

	if (!pendingRows || pendingRows.length === 0) {
		alogger.writeAlog(3, '[TIC] No pending outbound distributions', 'cyan');
		return summary;
	}

	// Group by peer_connection_id
	var grouped = {};
	for (var row of pendingRows) {
		var connId = row.peer_connection_id;
		if (!grouped[connId]) {
			grouped[connId] = [];
		}
		grouped[connId].push(row);
	}

	var connIds = Object.keys(grouped);
	alogger.writeAlog(2, '[TIC] Outbound: ' + pendingRows.length + ' file(s) for ' + connIds.length + ' connection(s)', 'cyan');

	for (var cid of connIds) {
		var files = grouped[cid];
		var conn = null;

		try {
			// Resolve connection
			conn = await peerConnections.getConnectionById(parseInt(cid));
			if (!conn || !conn.active) {
				alogger.writeAlog(3, '[TIC] Skipping inactive connection ' + cid, 'yellow');
				for (var f of files) {
					await fileDistribution.markSkipped(f.id, 'Connection inactive');
					summary.skipped++;
				}
				continue;
			}

			var cd = conn.connection_data || {};
			var peerAddress = cd.address || '';
			if (!peerAddress) {
				alogger.writeAlog(2, '[TIC] Connection ' + cid + ' has no FTN address — skipping', 'yellowbright');
				for (var f of files) {
					await fileDistribution.markSkipped(f.id, 'No FTN address');
					summary.skipped++;
				}
				continue;
			}

			// Get our system address for this network
			var sysAddr = await systemAddresses.getDefaultAddress(conn.network_id);
			var ourAddress = sysAddr ? sysAddr.address : '';

			if (!ourAddress) {
				alogger.writeAlog(2, '[TIC] No system address for network ' + conn.network_id + ' — skipping', 'yellowbright');
				for (var f of files) {
					await fileDistribution.markSkipped(f.id, 'No system address');
					summary.skipped++;
				}
				continue;
			}

			for (var distRow of files) {
				try {
					var sent = await stageOneOutboundFile(distRow, conn, cd, ourAddress, peerAddress, outDir);
					if (sent) {
						summary.sent++;
					} else {
						summary.errors++;
					}
				} catch (err) {
					alogger.writeAlog(2,
						'[TIC] Error staging ' + distRow.filename + ' for connection ' + cid + ': ' + err.message,
						'redbright'
					);
					await fileDistribution.markFailed(distRow.id, err.message);
					summary.errors++;
				}
			}

		} catch (connErr) {
			alogger.writeAlog(2, '[TIC] Error processing connection ' + cid + ': ' + connErr.message, 'redbright');
			for (var f of files) {
				await fileDistribution.markFailed(f.id, connErr.message);
				summary.errors++;
			}
		}
	}

	alogger.writeAlog(2,
		'[TIC] Outbound complete: ' + summary.sent + ' sent, ' +
		summary.skipped + ' skipped, ' + summary.errors + ' errors',
		summary.errors > 0 ? 'yellowbright' : 'greenbright'
	);

	// Signal the mailer to scan the BSO outbound directory for staged files.
	// Replaces the previous per-connection CRASH signalling.
	if (summary.sent > 0) {
		try {
			var jobsMod = await import('../../queues/jobs.js');
			await jobsMod.enqueueMailerBsoScan();
		} catch (scanErr) {
			alogger.writeAlog(3, '[TIC] BSO scan signal error: ' + scanErr.message, 'yellow');
		}
	}

	return summary;
}

/**
 * Stage one file + TIC descriptor for outbound delivery.
 */
async function stageOneOutboundFile(distRow, conn, cd, ourAddress, peerAddress, outDir) {
	// Resolve the file area for the areatag
	var areaMapping = await fileNetworkAreas.getNetworksByFileArea(distRow.area_id);
	var areatag = '';
	for (var mapping of areaMapping) {
		if (mapping.network_id === conn.network_id) {
			areatag = mapping.areatag;
			break;
		}
	}

	if (!areatag) {
		alogger.writeAlog(3, '[TIC] No areatag mapping for area ' + distRow.area_shortcode + ' on network ' + conn.network_id, 'yellow');
		await fileDistribution.markFailed(distRow.id, 'No areatag mapping');
		return false;
	}

	// Resolve the file on disk
	var dbarea = await fileAreas.getAreaByShortcode(distRow.area_shortcode);
	if (!dbarea) {
		await fileDistribution.markFailed(distRow.id, 'File area not found');
		return false;
	}
	var dbgroup = await fileGroups.getGroupByShortcode(dbarea.group_shortcode);
	var areaPath = fileAreas.resolveAreaPath(dbgroup, dbarea);
	var srcFilePath = path.join(areaPath, distRow.disk_path || distRow.filename);

	if (!fs.existsSync(srcFilePath)) {
		alogger.writeAlog(2, '[TIC] Source file not found: ' + srcFilePath, 'redbright');
		await fileDistribution.markFailed(distRow.id, 'Source file not found on disk');
		return false;
	}

	// Build source_data for path/seenby info
	var sourceData = distRow.source_data;
	if (typeof sourceData === 'string') {
		try { sourceData = JSON.parse(sourceData); } catch (_) { sourceData = {}; }
	}
	sourceData = sourceData || {};

	// Determine origin
	var origin = sourceData.tic_origin || ourAddress;

	// Build path — append our address to the existing path
	var ticPath = Array.isArray(sourceData.tic_path) ? sourceData.tic_path.slice() : [];
	var timestamp = Math.floor(Date.now() / 1000);
	ticPath.push(ourAddress + ' ' + timestamp);

	// Build seenby — existing + our address + destination
	var ticSeenby = Array.isArray(sourceData.tic_seenby) ? sourceData.tic_seenby.slice() : [];
	if (ticSeenby.indexOf(ourAddress) === -1) ticSeenby.push(ourAddress);
	if (ticSeenby.indexOf(peerAddress) === -1) ticSeenby.push(peerAddress);

	// Build long desc lines
	var ldescLines = [];
	if (distRow.long_desc) {
		ldescLines = distRow.long_desc.split('\n');
	} else if (Array.isArray(sourceData.tic_ldesc) && sourceData.tic_ldesc.length > 0) {
		ldescLines = sourceData.tic_ldesc;
	}

	// File date as unix timestamp
	var fileDateUnix = 0;
	if (distRow.file_date) {
		var d = new Date(distRow.file_date);
		fileDateUnix = Math.floor(d.getTime() / 1000);
	}

	var ticData = {
		area: areatag,
		file: distRow.filename,
		replaces: sourceData.tic_replaces || '',
		desc: distRow.short_desc || distRow.filename,
		ldesc: ldescLines,
		size: distRow.file_size || 0,
		date: fileDateUnix,
		crc: distRow.file_hash_crc32 || '',
		origin: origin,
		from: ourAddress,
		to: peerAddress,
		path: ticPath,
		seenby: ticSeenby,
		pw: cd.tic_password || '',
		magic: sourceData.tic_magic || ''
	};

	var ticContent = buildTicDescriptor(ticData);

	// Generate unique .tic filename
	var ticOutFilename = generateTicFilename(outDir, distRow.filename);
	var ticOutPath = path.join(outDir, ticOutFilename);

	// Write TIC descriptor
	fs.writeFileSync(ticOutPath, ticContent, 'utf8');

	// Copy attached file to outbound directory
	var attachedOutPath = path.join(outDir, distRow.filename);
	if (!fs.existsSync(attachedOutPath)) {
		// Try hard link first (faster, saves space), fall back to copy
		try {
			fs.linkSync(srcFilePath, attachedOutPath);
		} catch (_) {
			fs.copyFileSync(srcFilePath, attachedOutPath);
		}
	}

	// Mark as sent
	await fileDistribution.markSent(distRow.id);

	alogger.writeAlog(3, '[TIC] Staged: ' + distRow.filename + ' + ' + ticOutFilename + ' -> ' + peerAddress, 'cyan');

	return true;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Generate a unique .tic filename in the outbound directory.
 * Uses the attached filename base + sequential counter.
 */
function generateTicFilename(outDir, attachedFilename) {
	var base = path.basename(attachedFilename, path.extname(attachedFilename));
	// Truncate base to 8 chars for 8.3 compat
	base = base.substring(0, 8);
	var ticName = base + '.tic';

	if (!fs.existsSync(path.join(outDir, ticName))) {
		return ticName;
	}

	// Collision — try with counter
	for (var i = 0; i < 9999; i++) {
		var suffix = i.toString().padStart(2, '0');
		var shortBase = base.substring(0, 6);
		ticName = shortBase + suffix + '.tic';
		if (!fs.existsSync(path.join(outDir, ticName))) {
			return ticName;
		}
	}

	// Fallback: timestamp-based
	var ts = (Date.now() & 0xFFFFFFFF).toString(16).padStart(8, '0');
	return ts + '.tic';
}

async function moveToTossed(filePath, filename, tossedDir) {
	try {
		await fs.promises.rename(filePath, path.join(tossedDir, filename));
	} catch (err) {
		alogger.writeAlog(3, '[TIC] Could not move ' + filename + ' to tossed: ' + err.message, 'yellow');
	}
}

async function moveToBad(filePath, filename, badDir) {
	try {
		await fs.promises.rename(filePath, path.join(badDir, filename));
	} catch (err) {
		alogger.writeAlog(3, '[TIC] Could not move ' + filename + ' to bad: ' + err.message, 'yellow');
	}
	try {
		var notif = await import('../../models/notifications.js');
		await notif.createSysop('tic_error', 'Bad TIC file: ' + filename, 'Moved to ' + badDir, {
			severity: 'danger', icon: 'exclamation-triangle'
		});
	} catch (_) {}
}

/**
 * Find a file entry by filename in an area (for Replaces handling).
 */
async function findEntryByFilename(areaId, filename) {
	var postgres = await import('../../middleware/db/postgres.js');
	var row = await postgres.queryOne(
		'SELECT * FROM file_entries WHERE area_id = $1 AND LOWER(filename) = LOWER($2) AND active = true',
		[areaId, filename]
	);
	return row || null;
}

export {
	parseTicFile,
	buildTicDescriptor,
	tossInbound,
	tossOutbound
};
