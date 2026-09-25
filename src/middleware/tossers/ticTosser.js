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

// File echo processing logs to its own file, logs/<env>/tic.log, so what
// happened to each file can be read without the rest of the system log.
// Failures, refusals and each run's summary ALSO go to the system log, marked
// SYSTEM_TOO: when every file an uplink sent was being refused as a loop, the
// only sign was a routine-looking line in the system log, and moving TIC
// lines out of it entirely would have left not even that.
var TIC_LOG    = 'tic';
var SYSTEM_TOO = true;

function ticLog(level, message, colour, alsoSystem) {
	alogger.writeAlog(level, message, colour, false, alsoSystem ? [TIC_LOG, null] : TIC_LOG);
}

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

// BSO zone-aware outbound directory (matches ftnTosser pattern)
function getOutboundDirForZone(zone) {
	var baseDir = getOutboundDir();
	var z = parseInt(zone) || 1;
	if (z === 1) return baseDir;
	var zoneHex = z.toString(16).padStart(3, '0');
	return baseDir + '.' + zoneHex;
}

function _parseAddress(addr) {
	try {
		var zsplit  = addr.split(':');
		var nnsplit = zsplit[1] ? zsplit[1].split('/') : [];
		var npsplit = nnsplit[1] ? nnsplit[1].split('.') : [];
		var zone  = parseInt(zsplit[0]);
		var net   = parseInt(nnsplit[0]);
		var node  = parseInt(npsplit[0]);
		if (isNaN(zone) || isNaN(net) || isNaN(node)) return null;
		return { zone, net, node };
	} catch (_) {
		return null;
	}
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

	// Normalised, like the loop check and forwarding exclusions: a From of
	// 1:153/757@fidonet or 1:153/757.0 is the same peer, and missing it skips
	// the TIC password check and forwards the file back to its sender.
	var from = normaliseAddress(fromAddress);
	var ftnConnections = await peerConnections.getActiveConnectionsByNetworkType('FTN');
	for (var conn of ftnConnections) {
		var cd = conn.connection_data || {};
		if (cd.address && normaliseAddress(cd.address) === from) {
			return conn;
		}
	}
	return null;
}

/**
 * Normalise an FTN address for loop comparison.
 *
 * Bare, lowercase, no domain, no `.0` point suffix. A system writes itself in
 * with a domain on one hop and without it on the next, and `1:123/456` and
 * `1:123/456.0` are the same node, so comparing the strings as they arrive
 * misses the match that matters.
 */
function normaliseAddress(addr) {
	if (!addr) return '';
	var a = String(addr).trim().toLowerCase();
	var at = a.indexOf('@');
	if (at !== -1) a = a.slice(0, at);
	a = a.replace(/\.0$/, '');
	return a;
}

/**
 * Have we already handled this file?
 *
 * A TIC carries Path (systems it travelled through) and Seenby (systems it
 * has been SENT to). Only Path answers this question. A sender adds each
 * recipient to Seenby before sending, so a downlink always finds itself
 * there: we do it ourselves in the outbound builder, and so does every
 * uplink. Checking Seenby refused every file an uplink sent, as a "loop",
 * from 0.9.7a until this was found on the hub (daily nodelists from
 * 1:153/757 all listed 1:134/100 in Seenby and never reached the area).
 * Seenby is for choosing who not to forward to, and is read for that below.
 *
 * We stamp Path on every file we send, so our address arriving back in it
 * means the file has been round to us before, and passing it on again is how
 * a mesh becomes a carousel.
 *
 * This is the guard FTN relies on, and it was absent: the only thing standing
 * between this system and a loop was the dupe check, which is a different
 * question (do we hold this file) asked of a table that retention prunes.
 *
 * Pure, and exported, because the addresses come from the database and the
 * rule should be testable without one.
 *
 * @param {object} tic - parsed TIC with a `path` array
 * @param {string[]} ourAddresses - our system addresses on this network
 * @returns {string|null} the address that matched, or null
 */
function ticHasPassedThrough(tic, ourAddresses) {
	if (!tic || !ourAddresses || ourAddresses.length === 0) return null;

	var mine = new Set();
	for (var a of ourAddresses) {
		var n = normaliseAddress(a);
		if (n) mine.add(n);
	}
	if (mine.size === 0) return null;

	for (var p of (tic.path || [])) {
		// Path entries are "address timestamp"; the address is the first token.
		var pAddr = normaliseAddress(String(p).split(/\s+/)[0]);
		if (pAddr && mine.has(pAddr)) return pAddr;
	}
	return null;
}

/**
 * The systems an inbound file must not be forwarded to: everything in its
 * Seenby and Path, and whoever handed it to us.
 *
 * Normalised with normaliseAddress, as the loop check is. The raw strings
 * used to be compared, so a downlink written `1:229/426@fidonet` in a Path,
 * or `1:153/757.0`, did not match its own connection address and was sent a
 * file it had already had.
 *
 * @param {object} tic - parsed TIC
 * @returns {Set<string>} normalised addresses
 */
function forwardExclusions(tic) {
	var excluded = new Set();
	function add(a) {
		var n = normaliseAddress(a);
		if (n) excluded.add(n);
	}
	for (var sb of (tic && tic.seenby) || []) add(sb);
	// Path entries are "address timestamp ..."; the address is the first token.
	for (var p of (tic && tic.path) || []) add(String(p).trim().split(/\s+/)[0]);
	if (tic && tic.from) add(tic.from);
	return excluded;
}

/**
 * Put an inbound file into its area directory, displacing the files of the
 * entries it replaces, in a way that can be undone.
 *
 * A file that replaces one of the same name (an infopack re-released under
 * its own name, or NODELIST.Z68 a year after the last) used to collide with
 * the replaced file, which Replaces deactivated in the database but left on
 * disk. The new file was saved as NAME_1.EXT and recorded under that name,
 * so the next release's Replaces could not find it, and the area filled with
 * active _1, _2, _3 copies. A replaced file is now moved aside first, so the
 * new one takes its name; a file of the same name that is NOT being replaced
 * still gets a _N name rather than being overwritten.
 *
 * Nothing is deleted until the caller has recorded the new file: commit()
 * removes the displaced files, rollback() puts the new file back where it
 * came from and restores them.
 *
 * @param {object} opts
 * @param {string} opts.sourcePath - the received file
 * @param {string} opts.areaPath - the area's directory
 * @param {string} opts.filename - the name to file it under
 * @param {object[]} [opts.replaced] - entries being replaced ({disk_path})
 * @returns {Promise<{destFilePath: string, renamed: boolean, commit: Function, rollback: Function}>}
 */
async function placeInboundFile(opts) {
	var areaPath = opts.areaPath;
	var displaced = [];

	for (var entry of opts.replaced || []) {
		if (!entry || !entry.disk_path) continue;
		var oldPath = path.join(areaPath, path.basename(entry.disk_path));
		if (!fs.existsSync(oldPath)) continue;
		var aside = path.join(areaPath, '.' + path.basename(oldPath) + '.replaced-' + process.pid + '-' + Date.now());
		await fs.promises.rename(oldPath, aside);
		displaced.push({ from: oldPath, aside: aside });
	}

	async function restoreDisplaced() {
		for (var d of displaced) {
			try { await fs.promises.rename(d.aside, d.from); } catch (_) {}
		}
	}

	var destFilePath = path.join(areaPath, opts.filename);
	var renamed = false;
	if (fs.existsSync(destFilePath)) {
		var ext = path.extname(opts.filename);
		var base = path.basename(opts.filename, ext);
		for (var counter = 1; fs.existsSync(destFilePath); counter++) {
			destFilePath = path.join(areaPath, base + '_' + counter + ext);
		}
		renamed = true;
	}

	try {
		await fs.promises.rename(opts.sourcePath, destFilePath);
	} catch (err) {
		await restoreDisplaced();
		throw err;
	}

	return {
		destFilePath: destFilePath,
		renamed: renamed,
		commit: async function () {
			for (var d of displaced) {
				try { await fs.promises.rm(d.aside, { force: true }); } catch (_) {}
			}
		},
		rollback: async function () {
			try { await fs.promises.rename(destFilePath, opts.sourcePath); } catch (_) {}
			await restoreDisplaced();
		}
	};
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
		ticLog(2, '[TIC] Cannot read inbound directory ' + inDir + ': ' + err.message, 'redbright', SYSTEM_TOO);
		return summary;
	}

	var ticFiles = filelist.filter(function(f) {
		return f.toLowerCase().endsWith('.tic');
	});

	if (ticFiles.length === 0) {
		ticLog(3, '[TIC] No .tic files in ' + inDir, 'cyan');
		return summary;
	}

	ticLog(2, '[TIC] Found ' + ticFiles.length + ' .tic file(s) in ' + inDir, 'cyan');

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
			ticLog(2, '[TIC] Unhandled error processing ' + ticFilename + ': ' + err.message, 'redbright', SYSTEM_TOO);
			summary.errors++;
			// Move to bad dir
			try {
				await fs.promises.rename(ticFilePath, path.join(badDir, ticFilename));
			} catch (_) {}
		}
	}

	ticLog(2,
		'[TIC] Inbound complete: ' + summary.processed + ' processed, ' +
		summary.dupes + ' dupes, ' + summary.skipped + ' skipped, ' +
		summary.errors + ' errors',
		summary.errors > 0 ? 'yellowbright' : 'greenbright', SYSTEM_TOO
	);

	// Forward what just arrived to our own downlinks.  processOneTicFile has
	// created the file_distribution rows by now; without this nothing consumes
	// them until somebody uploads a file locally or a sysop presses the admin
	// button, so a pure downlink of ours would never receive a thing.
	if (summary.processed > 0) {
		try {
			var jobsMod = await import('../../queues/jobs.js');
			await jobsMod.enqueueTicOutbound();
		} catch (fwdErr) {
			// The outbound sweep will pick the rows up regardless; this only
			// costs latency, so it must not fail the inbound toss.
			ticLog(3, '[TIC] Forward signal error: ' + fwdErr.message, 'yellow', SYSTEM_TOO);
		}
	}

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
		ticLog(2, '[TIC] Cannot read ' + ticFilename + ': ' + err.message, 'redbright', SYSTEM_TOO);
		return 'error';
	}

	var tic = parseTicFile(ticContent);

	if (!tic.file) {
		ticLog(2, '[TIC] ' + ticFilename + ': missing File field', 'redbright', SYSTEM_TOO);
		await moveToBad(ticFilePath, ticFilename, badDir);
		return 'error';
	}

	if (!tic.area) {
		ticLog(2, '[TIC] ' + ticFilename + ': missing Area field', 'redbright', SYSTEM_TOO);
		// Try to move the attached file too if the TIC named one.
		var orphanPath = tic.file ? path.join(inDir, tic.file) : null;
		await moveToBad(ticFilePath, ticFilename, badDir, orphanPath, tic.file);
		return 'error';
	}

	ticLog(3, '[TIC] Processing: ' + tic.file + ' in area ' + tic.area + ' from ' + tic.from, 'cyan');

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
			ticLog(2, '[TIC] ' + ticFilename + ': attached file ' + tic.file + ' not found in ' + inDir, 'redbright', SYSTEM_TOO);
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
				ticLog(2, '[TIC] ' + ticFilename + ': TIC password mismatch from ' + tic.from, 'redbright', SYSTEM_TOO);
				await moveToBad(ticFilePath, ticFilename, badDir, attachedFilePath, tic.file);
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
		ticLog(2, '[TIC] ' + ticFilename + ': area tag ' + tic.area + ' not mapped to any file area', 'yellowbright', SYSTEM_TOO);
		await moveToBad(ticFilePath, ticFilename, badDir, attachedFilePath, tic.file);
		return 'skipped';
	}

	var fileAreaId = areaMapping.area_id;
	var areaShortcode = areaMapping.shortcode;

	// 6. Validate To address
	if (tic.to && networkId) {
		var toValid = await validateToAddress(tic.to, networkId);
		if (!toValid) {
			ticLog(2, '[TIC] ' + ticFilename + ': To address ' + tic.to + ' does not match any system address', 'yellowbright', SYSTEM_TOO);
			// Not fatal — some TIC implementations omit or mis-set To
		}
	}

	// 7. Check peer subscription (if source connection known)
	if (sourceConn) {
		var subscribed = await filePeerSubscriptions.isSubscribed(sourceConn.id, fileAreaId);
		if (!subscribed) {
			ticLog(3, '[TIC] ' + ticFilename + ': area ' + tic.area + ' not subscribed for connection ' + sourceConn.id + ' — allowing anyway (inbound)', 'yellow');
			// Log but don't reject — many sysops want to receive first, subscribe later
		}
	}

	// 8. Verify CRC-32
	var hashes = computeHashes(attachedFilePath);
	if (tic.crc) {
		if (hashes.crc32 !== tic.crc.toUpperCase().padStart(8, '0')) {
			ticLog(2,
				'[TIC] ' + ticFilename + ': CRC mismatch — TIC says ' + tic.crc +
				', file is ' + hashes.crc32, 'redbright', SYSTEM_TOO
			);
			await moveToBad(ticFilePath, ticFilename, badDir, attachedFilePath, tic.file);
			return 'error';
		}
	}

	// 8b. Loop check. Our own address in Path means this file has
	// already been through here (Seenby does not: see ticHasPassedThrough), whatever the dupe table currently says. This
	// catches the case the dupe check cannot: a file we held, pruned by
	// retention, and were then sent again by a peer who still had it.
	if (networkId) {
		var ourAddrs = (await systemAddresses.getAddressesByNetwork(networkId) || [])
			.map(function (a) { return a.address; })
			.filter(Boolean);
		var loopedVia = ticHasPassedThrough(tic, ourAddrs);
		if (loopedVia) {
			ticLog(2, '[TIC] ' + ticFilename + ': loop — ' + tic.file +
				' already lists ' + loopedVia + ' in its Path, not importing or forwarding', 'yellowbright', SYSTEM_TOO);
			await moveToTossed(ticFilePath, ticFilename, tossedDir);
			try {
				await fs.promises.rename(attachedFilePath, path.join(tossedDir, tic.file));
			} catch (_) {}
			return 'dupe';
		}
	}

	// 9. Dupe check. Size as well as CRC, so the same bytes under a name a
	// chain has uppercased or truncated are still recognised.
	var inboundSize = 0;
	try { inboundSize = fs.statSync(attachedFilePath).size; } catch (_) { inboundSize = 0; }
	var isDupe = await fileEntries.checkDupe(fileAreaId, tic.file, hashes.crc32, inboundSize);
	if (isDupe) {
		ticLog(3, '[TIC] ' + ticFilename + ': dupe — ' + tic.file + ' already exists in area ' + areaShortcode, 'yellow');
		// Move TIC and attached file to tossed (not bad — it's a valid dupe)
		await moveToTossed(ticFilePath, ticFilename, tossedDir);
		try {
			await fs.promises.rename(attachedFilePath, path.join(tossedDir, tic.file));
		} catch (_) {}
		return 'dupe';
	}

	// 10. Replaces: find the entry this file supersedes. It is deactivated
	// only once the new file is recorded (step 12), so a failed import leaves
	// the old one in place.
	var oldEntries = [];
	if (tic.replaces) {
		var rp = replacesPattern(tic.replaces);
		if (rp.kind === 'refused') {
			ticLog(2, '[TIC] ' + ticFilename + ': ignoring Replaces ' + tic.replaces + ' (' + rp.reason + ')',
				'yellowbright', SYSTEM_TOO);
		} else {
			oldEntries = await findEntriesReplacedBy(fileAreaId, rp);
		}
	}

	// 11. Resolve area path and move file, displacing the replaced file so a
	// same-name replacement keeps its name (see placeInboundFile).
	var dbarea = await fileAreas.getAreaByShortcode(areaShortcode);
	var dbgroup = await fileGroups.getGroupByShortcode(dbarea.group_shortcode);
	var areaPath = fileAreas.resolveAreaPath(dbgroup, dbarea);
	ensureDirSync(areaPath);

	var placed = await placeInboundFile({
		sourcePath: attachedFilePath,
		areaPath: areaPath,
		filename: tic.file,
		replaced: oldEntries
	});
	var destFilePath = placed.destFilePath;
	if (placed.renamed) {
		ticLog(3, '[TIC] ' + tic.file + ' already exists in ' + areaShortcode +
			' and is not being replaced — saving as ' + path.basename(destFilePath), 'yellow');
	}

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
		ticLog(2, '[TIC] Failed to insert file entry for ' + tic.file + ': ' + addResult.errormessages.join(', '), 'redbright', SYSTEM_TOO);
		// Put everything back, then shelve the TIC with its file. Left in the
		// inbound directory it was retried on every toss, and after the file
		// had been moved it failed there as "attached file not found".
		await placed.rollback();
		await moveToBad(ticFilePath, ticFilename, badDir, attachedFilePath, tic.file);
		return 'error';
	}

	for (var oldEntry of oldEntries) {
		await fileEntries.deactivateEntry(oldEntry.id);
		ticLog(3, '[TIC] Replaced ' + oldEntry.filename + ' in ' + areaShortcode, 'cyan');
	}
	await placed.commit();

	// 13. Create distribution rows for all subscribed peers EXCEPT source
	var allSubscribers = await filePeerSubscriptions.getSubscribedConnections(fileAreaId);

	// A subscriber on a network this area carries no areatag for cannot be
	// sent to: the outbound pass needs the areatag to build the descriptor.
	// It used to create the row anyway, fail it on 'No areatag mapping', and
	// leave it failed for ever, one dead row per file per misconfigured peer.
	var areaNetworks = await fileNetworkAreas.getNetworksByFileArea(fileAreaId);
	var reachable = fileDistribution.partitionByAreatag(allSubscribers, areaNetworks);
	var subscribers = reachable.deliverable;

	for (var unreachable of reachable.undeliverable) {
		ticLog(2, '[TIC] ' + (unreachable.peer_name || 'connection ' + unreachable.peer_connection_id) +
			' is subscribed to ' + areaShortcode + ' but that area carries no areatag on network ' +
			unreachable.network_id + ' — map the area or unsubscribe the peer', 'yellowbright', SYSTEM_TOO);
	}

	// Everyone the file has been to or through, normalised (forwardExclusions)
	var seenbySet = forwardExclusions(tic);

	var distConnIds = [];
	for (var sub of subscribers) {
		var subCd = sub.connection_data || {};
		var subAddr = normaliseAddress(subCd.address || '');

		// Skip source connection
		if (sourceConn && sub.peer_connection_id === sourceConn.id) continue;

		// Skip if already in seenby
		if (subAddr && seenbySet.has(subAddr)) continue;

		distConnIds.push(sub.peer_connection_id);
	}

	if (distConnIds.length > 0) {
		await fileDistribution.createDistributionRows(addResult.entryId, distConnIds, 'tic');
		ticLog(3, '[TIC] Created ' + distConnIds.length + ' distribution row(s) for ' + tic.file, 'cyan');
	}

	// 14. Move .tic to tossed
	await moveToTossed(ticFilePath, ticFilename, tossedDir);

	// 15. Update area stats
	await fileAreas.updateStatsForArea(areaShortcode);

	ticLog(2, '[TIC] Imported: ' + tic.file + ' -> ' + areaShortcode + ' (' + hashes.crc32 + ')', 'greenbright');

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
		ticLog(3, '[TIC] No pending outbound distributions', 'cyan');
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
	ticLog(2, '[TIC] Outbound: ' + pendingRows.length + ' file(s) for ' + connIds.length + ' connection(s)', 'cyan');

	for (var cid of connIds) {
		var files = grouped[cid];
		var conn = null;

		try {
			// Resolve connection
			conn = await peerConnections.getConnectionById(parseInt(cid));
			if (!conn || !conn.active) {
				ticLog(3, '[TIC] Skipping inactive connection ' + cid, 'yellow');
				for (var f of files) {
					await fileDistribution.markSkipped(f.id, 'Connection inactive');
					summary.skipped++;
				}
				continue;
			}

			var cd = conn.connection_data || {};
			var peerAddress = cd.address || '';
			if (!peerAddress) {
				ticLog(2, '[TIC] Connection ' + cid + ' has no FTN address — skipping', 'yellowbright', SYSTEM_TOO);
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
				ticLog(2, '[TIC] No system address for network ' + conn.network_id + ' — skipping', 'yellowbright', SYSTEM_TOO);
				for (var f of files) {
					await fileDistribution.markSkipped(f.id, 'No system address');
					summary.skipped++;
				}
				continue;
			}

			// Resolve zone-aware outbound directory for this peer
			var peerAddrParts = _parseAddress(peerAddress);
			var peerOutDir = peerAddrParts ? getOutboundDirForZone(peerAddrParts.zone) : outDir;
			ensureDirSync(peerOutDir);

			for (var distRow of files) {
				try {
					var sent = await stageOneOutboundFile(distRow, conn, cd, ourAddress, peerAddress, peerOutDir, peerAddrParts);
					if (sent) {
						summary.sent++;
					} else {
						summary.errors++;
					}
				} catch (err) {
					ticLog(2,
						'[TIC] Error staging ' + distRow.filename + ' for connection ' + cid + ': ' + err.message,
						'redbright', SYSTEM_TOO
					);
					await fileDistribution.markFailed(distRow.id, err.message);
					summary.errors++;
				}
			}

		} catch (connErr) {
			ticLog(2, '[TIC] Error processing connection ' + cid + ': ' + connErr.message, 'redbright', SYSTEM_TOO);
			for (var f of files) {
				await fileDistribution.markFailed(f.id, connErr.message);
				summary.errors++;
			}
		}
	}

	ticLog(2,
		'[TIC] Outbound complete: ' + summary.sent + ' sent, ' +
		summary.skipped + ' skipped, ' + summary.errors + ' errors',
		summary.errors > 0 ? 'yellowbright' : 'greenbright', SYSTEM_TOO
	);

	// Signal the mailer to scan the BSO outbound directory for staged files.
	// Replaces the previous per-connection CRASH signalling.
	if (summary.sent > 0) {
		try {
			var jobsMod = await import('../../queues/jobs.js');
			await jobsMod.enqueueMailerBsoScan();
		} catch (scanErr) {
			ticLog(3, '[TIC] BSO scan signal error: ' + scanErr.message, 'yellow', SYSTEM_TOO);
		}
	}

	return summary;
}

/**
 * Stage one file + TIC descriptor for outbound delivery.
 */
async function stageOneOutboundFile(distRow, conn, cd, ourAddress, peerAddress, outDir, peerAddrParts) {
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
		ticLog(3, '[TIC] No areatag mapping for area ' + distRow.area_shortcode + ' on network ' + conn.network_id, 'yellow');
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
		ticLog(2, '[TIC] Source file not found: ' + srcFilePath, 'redbright', SYSTEM_TOO);
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

	// Create .flo entries so the BSO scanner and mailer session can find these files.
	// Both the TIC descriptor and attached file need flow file entries.
	// ^ prefix = delete after send (these are outbound copies, not the originals).
	if (peerAddrParts) {
		var netHex  = peerAddrParts.net.toString(16).padStart(4, '0');
		var nodeHex = peerAddrParts.node.toString(16).padStart(4, '0');
		var destHex = netHex + nodeHex;
		var floPath = path.join(outDir, destHex + '.flo');

		try {
			var floLines = '^' + ticOutPath + '\r\n' + '^' + attachedOutPath + '\r\n';
			fs.appendFileSync(floPath, floLines);
		} catch (floErr) {
			ticLog(3, '[TIC] Failed to create .flo entry for ' + peerAddress + ': ' + floErr.message, 'redbright', SYSTEM_TOO);
		}
	}

	// Mark as sent
	await fileDistribution.markSent(distRow.id);

	ticLog(3, '[TIC] Staged: ' + distRow.filename + ' + ' + ticOutFilename + ' -> ' + peerAddress, 'cyan');

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
		ticLog(3, '[TIC] Could not move ' + filename + ' to tossed: ' + err.message, 'yellow', SYSTEM_TOO);
	}
}

async function moveToBad(filePath, filename, badDir, attachedFilePath, attachedFilename) {
	try {
		await fs.promises.rename(filePath, path.join(badDir, filename));
	} catch (err) {
		ticLog(3, '[TIC] Could not move ' + filename + ' to bad: ' + err.message, 'yellow', SYSTEM_TOO);
	}

	// Move the attached file alongside its TIC when we know where it is —
	// otherwise it sits orphaned in ftn/in/ and gets re-scanned forever.
	var movedAttachment = null;
	if (attachedFilePath && attachedFilename && fs.existsSync(attachedFilePath)) {
		var destPath = path.join(badDir, attachedFilename);
		if (fs.existsSync(destPath)) {
			var ext = path.extname(attachedFilename);
			var base = path.basename(attachedFilename, ext);
			var counter = 1;
			while (fs.existsSync(destPath)) {
				destPath = path.join(badDir, base + '_' + counter + ext);
				counter++;
			}
		}
		try {
			await fs.promises.rename(attachedFilePath, destPath);
			movedAttachment = path.basename(destPath);
		} catch (err) {
			ticLog(3, '[TIC] Could not move attached file ' + attachedFilename + ' to bad: ' + err.message, 'yellow', SYSTEM_TOO);
		}
	}

	try {
		var notif = await import('../../models/notifications.js');
		var body = 'Moved to ' + badDir;
		if (movedAttachment) body += ' (with attached file ' + movedAttachment + ')';
		await notif.createSysop('tic_error', 'Bad TIC file: ' + filename, body, {
			severity: 'danger', icon: 'exclamation-triangle'
		});
	} catch (_) {}
}

/**
 * Find a file entry by filename in an area (for Replaces handling).
 */
/**
 * What a TIC's Replaces line matches.
 *
 * The TIC convention allows DOS wildcards, `*` and `?`, so a hatch can
 * replace every earlier version (`Replaces NODELIST.*`, `Replaces Z1DAILY.Z*`).
 * Only an exact filename used to match, so a wildcard Replaces replaced
 * nothing and every version accumulated.
 *
 * Replaces deactivates AND deletes what it matches, so `*`, `*.*` or `*.ZIP`
 * from a misconfigured or hostile system would empty the area. A wildcard
 * pattern must therefore name enough of the file: at least
 * REPLACES_MIN_LITERALS literal characters in the part before the first dot,
 * wherever they sit, so `*FOO.ZIP` and `?ODELIST.*` are accepted while
 * `*.ZIP`, `*.TAR.GZ` and `A*.ZIP` are not. The extension does not count,
 * since it names a kind of file, not a family. Refused patterns are logged
 * and the file imported without replacing anything.
 *
 * Pure. Returns { kind: 'exact', name } | { kind: 'wildcard', like } |
 * { kind: 'refused', reason }, where `like` is a pattern for ILIKE with the
 * SQL wildcards in the name escaped.
 */
var REPLACES_MIN_LITERALS = 3;

function replacesPattern(replaces) {
	var name = String(replaces || '').trim();
	if (!name) return { kind: 'refused', reason: 'empty' };
	if (/[\\/]/.test(name)) return { kind: 'refused', reason: 'contains a path' };
	if (!/[*?]/.test(name)) return { kind: 'exact', name: name };
	var stem = name.split('.')[0];
	if (stem.replace(/[*?]/g, '').length < REPLACES_MIN_LITERALS) {
		return { kind: 'refused', reason: 'a wildcard Replaces must name at least ' + REPLACES_MIN_LITERALS +
			' characters of the filename before its extension' };
	}
	var like = name
		.replace(/[\\%_]/g, function (c) { return '\\' + c; })
		.replace(/\*/g, '%')
		.replace(/\?/g, '_');
	return { kind: 'wildcard', like: like };
}

/**
 * The active entries in an area that a Replaces pattern names.
 */
async function findEntriesReplacedBy(areaId, pattern) {
	var postgres = await import('../../middleware/db/postgres.js');
	var rows;
	if (pattern.kind === 'exact') {
		rows = await postgres.query(
			'SELECT * FROM file_entries WHERE area_id = $1 AND LOWER(filename) = LOWER($2) AND active = true',
			[areaId, pattern.name]
		);
	} else if (pattern.kind === 'wildcard') {
		rows = await postgres.query(
			"SELECT * FROM file_entries WHERE area_id = $1 AND filename ILIKE $2 ESCAPE '\\' AND active = true",
			[areaId, pattern.like]
		);
	}
	return rows || [];
}

export {
	parseTicFile,
	buildTicDescriptor,
	tossInbound,
	tossOutbound,
	ticHasPassedThrough,
	normaliseAddress,
	forwardExclusions,
	placeInboundFile,
	replacesPattern
};
