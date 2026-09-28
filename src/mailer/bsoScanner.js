// mailer/bsoScanner.js — BSO (Binkley-Style Outbound) directory scanner.
//
// Periodically scans the BSO outbound directory tree for pending mail
// files and triggers mailer sessions to deliver them.  Decouples outbound
// mail detection from the tossers that create it — any process or tool
// that drops correctly-named files into the BSO structure will have them
// discovered and delivered.
//
// See docs/reference/BSO_SCANNER_DESIGN.md for the full design rationale.

import * as fs from 'fs';
import * as path from 'path';
import * as alogger from '../utils/alogger.js';
import * as ftnRouter from '../models/ftnRouter.js';
import * as peerConnections from '../models/peerConnections.js';
import appConfig from '../config/appConfig.js';
import { resolveFileboxPath } from '../utils/fileboxPath.js';
import * as floFile from '../utils/floFile.js';

// -------------------------------------------------------------------------
// BSO extension maps
// -------------------------------------------------------------------------

// Flavour prefix letter → flavour name
var FLAVOUR_MAP = {
	'f': 'Normal',
	'o': 'Normal',
	'c': 'Crash',
	'd': 'Direct',
	'h': 'Hold',
	'i': 'Immediate'
};

// Extension suffix → file type
// .?lo = flow file, .?ut = packet, .req = request
var TYPE_SUFFIXES = {
	'lo': 'flow',
	'ut': 'packet'
};

// Flavour priority for connection decisions (higher = more urgent)
var FLAVOUR_PRIORITY = {
	'Hold':      0,
	'Normal':    1,
	'Direct':    1,
	'Crash':     2,
	'Immediate': 2
};

// -------------------------------------------------------------------------
// Filename parsing
// -------------------------------------------------------------------------

/**
 * Parse a BSO filename into address components, type, and flavour.
 *
 * @param {string} filename — e.g. "0086002a.clo"
 * @param {number} zone     — zone derived from parent directory
 * @returns {object|null}   — { net, node, zone, type, flavour, filename } or null
 */
function parseBsoFilename(filename, zone) {
	if (!filename || filename.length < 12) return null;

	var dotPos = filename.lastIndexOf('.');
	if (dotPos === -1) return null;

	var stem = filename.substring(0, dotPos).toLowerCase();
	var ext  = filename.substring(dotPos + 1).toLowerCase();

	// Stem must be exactly 8 hex characters
	if (stem.length !== 8) return null;
	if (!/^[0-9a-f]{8}$/.test(stem)) return null;

	// Parse net and node from hex
	var netVal  = parseInt(stem.substring(0, 4), 16);
	var nodeVal = parseInt(stem.substring(4, 8), 16);
	if (isNaN(netVal) || isNaN(nodeVal)) return null;
	if (netVal > 65535 || nodeVal > 65535) return null;

	// Handle .req (file request — no flavour prefix)
	if (ext === 'req') {
		return {
			net:      netVal,
			node:     nodeVal,
			zone:     zone,
			type:     'request',
			flavour:  'Normal',
			filename: filename
		};
	}

	// Flow files (.?lo) and packet files (.?ut)
	if (ext.length !== 3) return null;

	var flavourChar = ext[0];
	var typeSuffix  = ext.substring(1);

	var flavour = FLAVOUR_MAP[flavourChar];
	var type    = TYPE_SUFFIXES[typeSuffix];

	if (!flavour || !type) return null;

	return {
		net:      netVal,
		node:     nodeVal,
		zone:     zone,
		type:     type,
		flavour:  flavour,
		filename: filename
	};
}

// -------------------------------------------------------------------------
// BsoScanner class
// -------------------------------------------------------------------------

class BsoScanner {
	constructor(options) {
		var opts = options || {};
		this._manager      = opts.manager;
		this._outboundDir  = opts.outboundDir || '';
		this._defaultZone  = opts.defaultZone || 1;
		this._timer        = null;
		this._scanInProgress = false;
		this._rescanRequested = false;
		this._scanPromise  = null;
	}

	// -------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------

	start() {
		var enabled = appConfig.getBoolean('MAILER_BSO_SCAN_ENABLED', true);
		if (!enabled) {
			alogger.writeClog(1, 'BSO Scanner: disabled via MAILER_BSO_SCAN_ENABLED', 'mailer', 'yellow');
			return;
		}

		var interval = appConfig.getNumber('MAILER_BSO_SCAN_INTERVAL', 60) * 1000;
		alogger.writeClog(1, 'BSO Scanner: started (interval ' + (interval / 1000) + 's)', 'mailer', 'cyanbright');

		// Run first scan immediately
		this.scanNow();

		// Set periodic timer
		this._timer = setInterval(() => {
			this.scanNow();
		}, interval);
		this._timer.unref();
	}

	stop() {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = null;
		}
		alogger.writeClog(1, 'BSO Scanner: stopped', 'mailer', 'cyanbright');
	}

	// -------------------------------------------------------------------
	// On-demand scan with debounce
	// -------------------------------------------------------------------

	scanNow() {
		if (this._scanInProgress) {
			this._rescanRequested = true;
			return this._scanPromise;
		}
		return this._executeScan();
	}

	async _executeScan() {
		this._scanInProgress = true;
		this._rescanRequested = false;

		try {
			this._scanPromise = this._scan();
			await this._scanPromise;
		} catch (err) {
			alogger.writeClog(2, 'BSO Scanner: scan error: ' + err.message, 'mailer', 'redbright');
		}

		this._scanInProgress = false;

		// If another scan was requested while we were running, do one more pass
		if (this._rescanRequested) {
			this._rescanRequested = false;
			return this._executeScan();
		}
	}

	// -------------------------------------------------------------------
	// Core scan logic
	// -------------------------------------------------------------------

	async _scan() {
		if (this._manager && !this._manager.isRunning()) return;
		// Closed for maintenance: leave the outbound where it is. It goes when
		// the board reopens, and scanning now would only log refusals.
		if (this._manager && typeof this._manager.isInMaintenance === 'function' && this._manager.isInMaintenance()) return;

		var baseDir = this._resolveOutboundDir();
		if (!baseDir) return;

		// Scan all zone directories and aggregate results
		var allAddresses = new Map();  // "zone:net/node" → { zone, net, node, flavour }

		// Scan the base directory (default zone)
		this._scanOneDirectory(baseDir, this._defaultZone, allAddresses);

		// Scan zone-specific sibling directories: <base>.002, <base>.003, etc.
		this._scanZoneDirectories(baseDir, allAddresses);

		// Scan per-peer outbound fileboxes
		var fileboxTriggered = await this._scanOutboundFileboxes(allAddresses);

		// Process discovered addresses
		var triggered = 0;
		var skipped = 0;
		var holdCount = 0;
		var noRoute = 0;
		var backedOff = 0;

		for (var [addr, info] of allAddresses) {
			if (this._manager && !this._manager.isRunning()) break;

			var result = await this._handleAddress(addr, info);
			if (result === 'triggered') triggered++;
			else if (result === 'skipped') skipped++;
			else if (result === 'hold') holdCount++;
			else if (result === 'noroute') noRoute++;
			else if (result === 'backoff') backedOff++;
		}

		if (allAddresses.size > 0) {
			alogger.writeClog(2,
				'BSO scan: ' + allAddresses.size + ' address(es) with pending mail, ' +
				triggered + ' connection(s) triggered' +
				(skipped > 0 ? ', ' + skipped + ' active session(s) skipped' : '') +
				(holdCount > 0 ? ', ' + holdCount + ' hold' : '') +
				(noRoute > 0 ? ', ' + noRoute + ' unroutable' : '') +
				(backedOff > 0 ? ', ' + backedOff + ' in backoff' : '') +
				(fileboxTriggered > 0 ? ', ' + fileboxTriggered + ' filebox(es)' : ''),
				'mailer', 'cyan'
			);
		} else {
			alogger.writeClog(5, 'BSO scan: no pending outbound mail', 'mailer', 'cyan');
		}
	}

	// -------------------------------------------------------------------
	// Directory scanning
	// -------------------------------------------------------------------

	_resolveOutboundDir() {
		// Allow constructor override, then appConfig, then legacy config key
		var dir = this._outboundDir
			|| appConfig.get('MAILER_OUTBOUND_DIR')
			|| appConfig.get('ftnoutbound', 'ftn/out');
		return dir;
	}

	_scanOneDirectory(dirPath, zone, addressMap) {
		try {
			if (!fs.existsSync(dirPath)) {
				alogger.writeClog(5, 'BSO scan: directory does not exist: ' + dirPath, 'mailer', 'cyan');
				return;
			}

			var entries = fs.readdirSync(dirPath);
			var fileCount = 0;

			for (var entry of entries) {
				var parsed = parseBsoFilename(entry, zone);
				if (!parsed) continue;

				// A flow file used to count as pending mail on its filename
				// alone. One with nothing left to send therefore triggered a
				// session every scan, the session found nothing, and nothing
				// removed the file, so it happened again a minute later for
				// ever, on a peer whose poll interval said hours. Look inside,
				// tidy it up, and skip it when there is genuinely nothing left.
				if (parsed.type === 'flow') {
					var pruned = floFile.pruneFlowFile(dirPath + '/' + entry);
					if (pruned.pending === 0) continue;
				}

				fileCount++;

				var addrKey = parsed.zone + ':' + parsed.net + '/' + parsed.node;

				var existing = addressMap.get(addrKey);
				if (existing) {
					// Keep the highest-priority flavour
					if (FLAVOUR_PRIORITY[parsed.flavour] > FLAVOUR_PRIORITY[existing.flavour]) {
						existing.flavour = parsed.flavour;
					}
				} else {
					addressMap.set(addrKey, {
						zone:    parsed.zone,
						net:     parsed.net,
						node:    parsed.node,
						flavour: parsed.flavour
					});
				}
			}

			alogger.writeClog(5,
				'BSO scan: scanning ' + dirPath + ' (zone ' + zone + '): ' + fileCount + ' BSO file(s)',
				'mailer', 'cyan'
			);
		} catch (err) {
			if (err.code === 'EACCES' || err.code === 'EPERM') {
				alogger.writeClog(2, 'BSO scan: permission denied reading ' + dirPath, 'mailer', 'redbright');
			} else if (err.code !== 'ENOENT') {
				alogger.writeClog(2, 'BSO scan: error reading ' + dirPath + ': ' + err.message, 'mailer', 'redbright');
			}
		}
	}

	_scanZoneDirectories(baseDir, addressMap) {
		// Look for sibling directories matching <basename>.NNN (hex zone suffix)
		var parentDir = path.dirname(baseDir);
		var baseName  = path.basename(baseDir);

		try {
			if (!fs.existsSync(parentDir)) return;
			var siblings = fs.readdirSync(parentDir);

			var pattern = new RegExp('^' + escapeRegex(baseName) + '\\.([0-9a-fA-F]{3})$');

			for (var sibling of siblings) {
				var match = sibling.match(pattern);
				if (!match) continue;

				var zone = parseInt(match[1], 16);
				if (isNaN(zone) || zone === 0) continue;

				// Skip the default zone if it matches (already scanned as base)
				if (zone === this._defaultZone) continue;

				var zoneDirPath = path.join(parentDir, sibling);
				try {
					var stat = fs.statSync(zoneDirPath);
					if (stat.isDirectory()) {
						this._scanOneDirectory(zoneDirPath, zone, addressMap);
					}
				} catch (_) {
					// Skip unreadable entries
				}
			}
		} catch (err) {
			if (err.code !== 'ENOENT') {
				alogger.writeClog(3, 'BSO scan: error scanning zone directories in ' + parentDir + ': ' + err.message, 'mailer', 'yellow');
			}
		}
	}

	// -------------------------------------------------------------------
	// Outbound filebox scanning
	// -------------------------------------------------------------------

	async _scanOutboundFileboxes(addressMap) {
		var fileboxCount = 0;
		try {
			var allConns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
			if (!allConns) return 0;

			for (var conn of allConns) {
				var cd = conn.connection_data || {};
				if (!cd.outbox_dir || !cd.address) continue;

				var outboxPath = resolveFileboxPath(cd.outbox_dir);
				if (!outboxPath) continue;

				try {
					if (!fs.existsSync(outboxPath)) continue;
					var stat = fs.statSync(outboxPath);
					if (!stat.isDirectory()) continue;

					var entries = fs.readdirSync(outboxPath);
					var fileCount = 0;
					for (var entry of entries) {
						try {
							var entStat = fs.statSync(path.join(outboxPath, entry));
							if (entStat.isFile()) fileCount++;
						} catch (_) {}
					}

					if (fileCount === 0) continue;

					// Add this address to the address map so _handleAddress triggers a session
					var addrKey = cd.address;
					// Normalize to zone:net/node format
					if (!addressMap.has(addrKey)) {
						// Use the connection's status as the flavour
						var flavour = cd.status === 'CRASH' ? 'Crash' : cd.status === 'HOLD' ? 'Hold' : 'Normal';
						var addrParts = this._parseAddress(cd.address);
						if (addrParts) {
							var normalKey = addrParts.zone + ':' + addrParts.net + '/' + addrParts.node;
							if (!addressMap.has(normalKey)) {
								addressMap.set(normalKey, {
									zone:    addrParts.zone,
									net:     addrParts.net,
									node:    addrParts.node,
									flavour: flavour
								});
							}
						}
					}

					fileboxCount++;
					alogger.writeClog(5,
						'BSO scan: filebox for ' + cd.address + ' has ' + fileCount + ' file(s) in ' + outboxPath,
						'mailer', 'cyan'
					);
				} catch (err) {
					if (err.code !== 'ENOENT') {
						alogger.writeClog(3, 'BSO scan: error scanning filebox ' + outboxPath + ': ' + err.message, 'mailer', 'yellow');
					}
				}
			}
		} catch (err) {
			alogger.writeClog(3, 'BSO scan: filebox scan error: ' + err.message, 'mailer', 'yellow');
		}
		return fileboxCount;
	}

	// Parse a FTN address string into components
	_parseAddress(addr) {
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

	// -------------------------------------------------------------------
	// Address handling
	// -------------------------------------------------------------------

	async _handleAddress(addrString, info) {
		// Hold-flavoured mail is never actively delivered
		if (info.flavour === 'Hold') {
			alogger.writeClog(4, 'BSO scan: Hold mail for ' + addrString + ' — waiting for inbound call', 'mailer', 'cyan');
			return 'hold';
		}

		// Check for active session
		if (this._manager && this._manager._hasSessionForAddress(addrString)) {
			alogger.writeClog(5, 'BSO scan: ' + addrString + ' — session already active, skipping', 'mailer', 'cyan');
			return 'skipped';
		}

		// Resolve route
		try {
			var route = await ftnRouter.resolveRoute(addrString);

			if (!route) {
				alogger.writeClog(3, 'BSO scan: no route for ' + addrString + ' — mail pending but undeliverable', 'mailer', 'yellow');
				return 'noroute';
			}

			// Route via peer connection
			if (route.connectionUUID) {
				var conn = await peerConnections.getConnectionByUUIDWithNetwork(route.connectionUUID);
				if (!conn) {
					alogger.writeClog(3, 'BSO scan: peer connection ' + route.connectionUUID + ' not found for ' + addrString, 'mailer', 'yellow');
					return 'noroute';
				}
				if (!conn.active) {
					alogger.writeClog(3, 'BSO scan: peer connection for ' + addrString + ' is inactive', 'mailer', 'yellow');
					return 'noroute';
				}

				// Check if peer status is HOLD — do not actively connect
				var cd = conn.connection_data || {};
				if (cd.status === 'HOLD') {
					alogger.writeClog(4, 'BSO scan: peer ' + addrString + ' has HOLD status — waiting for inbound', 'mailer', 'cyan');
					return 'hold';
				}

				// Respect backoff, which pollConnection checks and this path did
				// not. A peer that is refusing connections was being retried
				// every scan interval, so the backoff a sysop configured did
				// nothing at all whenever there was mail waiting.
				if (appConfig.getBoolean('mailer_backoff_enabled', true) &&
				    peerConnections.isInBackoff(conn)) {
					alogger.writeClog(4,
						'BSO scan: ' + addrString + ' has mail waiting but is in backoff until ' +
						(cd.next_allowed_poll_at || 'unknown') +
						' (' + (cd.consecutive_failures || 0) + ' consecutive failures)',
						'mailer', 'yellow'
					);
					return 'backoff';
				}

				alogger.writeClog(3,
					'BSO scan: triggering connection to ' + addrString + ' (' + info.flavour + ') via peer ' + route.connectionUUID.substring(0, 8),
					'mailer', 'cyan'
				);
				this._manager._connectToPeer(conn);
				return 'triggered';
			}

			// Route via nodelist
			if (route.nodelistData) {
				alogger.writeClog(3,
					'BSO scan: triggering connection to ' + addrString + ' (' + info.flavour + ') via nodelist (' +
					(route.nodelistData.systemName || 'unknown') + ')',
					'mailer', 'cyan'
				);
				this._manager.connectToNodelistAddress(route.nodelistData, route.nextHop || addrString);
				return 'triggered';
			}

			alogger.writeClog(3, 'BSO scan: no route for ' + addrString + ' — mail pending but undeliverable', 'mailer', 'yellow');
			return 'noroute';
		} catch (err) {
			alogger.writeClog(3, 'BSO scan: route resolution error for ' + addrString + ': ' + err.message, 'mailer', 'yellow');
			return 'noroute';
		}
	}
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -------------------------------------------------------------------------
// Exports
// -------------------------------------------------------------------------

export { BsoScanner, parseBsoFilename };
