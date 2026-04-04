// mailer/session.js — Session controller for a single mailer connection.
//
// Manages the lifecycle of one mailer session: connect → handshake →
// transfer → disconnect. Orchestrates the protocol module and transfer
// engine. Handles peer matching for inbound, and file list building for
// outbound.
//
// Does not parse frames or manage sockets — delegates to the protocol
// module (binkp) and transport (tcp/ws).

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { BinkpProtocol, verifyCramMD5 } from './protocols/binkp.js';
import { EmsiProtocol } from './protocols/emsi.js';
import { TransferEngine } from './transfer.js';
import { WazooTransferEngine } from './wazooTransfer.js';
import * as peerConnections from '../models/peerConnections.js';
import * as systemAddresses from '../models/systemAddresses.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

class SessionController extends EventEmitter {
	constructor(transport, role, options) {
		super();
		this.uuid      = uuidv4();
		this.role      = role;        // 'caller' or 'answerer'
		this.state     = 'idle';      // idle, connecting, handshake, authenticated, transfer, done, error
		this.transport = transport;
		this.options   = options || {};

		// Peer info (populated during handshake)
		this.peerConnection  = null;  // Primary DB record from peer_connections
		this.peerConnections = [];    // All matched + password-verified connections
		this.peerAddresses   = [];    // FTN addresses presented by remote
		this.peerName        = '';    // System name from M_NUL

		// Protocol and transfer
		this.protocol     = null;
		this.protocolType = null;   // 'binkp' or 'emsi' — set during start()
		this.transfer     = null;

		// Stats
		this.startTime     = Date.now();
		this.filesSent     = 0;
		this.filesReceived = 0;
		this.bytesSent     = 0;
		this.bytesReceived = 0;

		// Session timeout
		this._sessionTimer = null;

		// Directories
		this._inboundDir  = this.options.inboundDir  || appConfig.get('MAILER_INBOUND_DIR')  || appConfig.get('ftninbound', 'ftn/in');
		this._outboundDir = this.options.outboundDir  || appConfig.get('MAILER_OUTBOUND_DIR') || appConfig.get('ftnoutbound', 'ftn/out');
		this._tempDir     = this.options.tempDir      || appConfig.get('MAILER_TEMP_DIR', 'ftn/tmp');
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	async start() {
		this.state = 'handshake';

		// Start session timeout
		var sessionTimeout = appConfig.getNumber('MAILER_SESSION_TIMEOUT', 300);
		this._sessionTimer = setTimeout(() => {
			alogger.writeClog(3, 'Session ' + this.uuid + ': timeout after ' + sessionTimeout + 's', 'mailer', 'redbright');
			this._endSession('timeout');
		}, sessionTimeout * 1000);

		// ---------------------------------------------------------------
		// Phase 1: All async work happens here — before the protocol is
		// created. This prevents a race where the remote sends M_ADR and
		// M_PWD while we're yielded on an await and no data listener
		// exists yet.
		// ---------------------------------------------------------------

		// Resolve our local FTN addresses
		var localAddresses = await this._getLocalAddresses();
		if (localAddresses.length === 0) {
			alogger.writeClog(3, 'Session ' + this.uuid + ': no local FTN addresses configured', 'mailer', 'redbright');
			this._endSession('no local addresses');
			return;
		}

		// Resolve system name and sysop from env
		var systemName = appConfig.get('boardname', 'Canectic BBS');
		var sysopName  = appConfig.get('sysopname', 'Sysop');

		// Build protocol options
		var protocolOpts = {
			localAddresses: localAddresses,
			systemName:     systemName,
			sysopName:      sysopName,
			sessionPassword: ''
		};

		// For caller, load the session password from the target connection
		if (this.role === 'caller' && this.options.connectionUUID) {
			var conn = await peerConnections.getConnectionByUUIDWithNetwork(this.options.connectionUUID);
			if (!conn) {
				alogger.writeClog(3, 'Session ' + this.uuid + ': target connection not found', 'mailer', 'redbright');
				this._endSession('connection not found');
				return;
			}
			this.peerConnection = conn;
			this.peerConnections = [conn];
			var cd = conn.connection_data || {};
			protocolOpts.sessionPassword = cd.session_password || '';
		}

		// ---------------------------------------------------------------
		// Phase 2: Determine protocol type.
		// Outbound: read from connection_data.mailer_protocol
		// Inbound: auto-detect by peeking at first bytes from remote
		// ---------------------------------------------------------------

		if (this.role === 'caller') {
			// Outbound — use configured protocol
			var cd = this.peerConnection ? (this.peerConnection.connection_data || {}) : {};
			this.protocolType = cd.mailer_protocol || 'binkp';

			this._createProtocol(protocolOpts);
			this.protocol.startSession(this.role);
			this.transport.resume();

			alogger.writeClog(5,
				'Session ' + this.uuid + ': started as caller (' + this.protocolType +
				') via ' + this.transport.remoteAddress,
				'mailer', 'cyan'
			);
		} else {
			// Inbound — auto-detect protocol from first bytes
			this.state = 'detecting';
			this._detectProtocol(protocolOpts);
		}
	}

	// -----------------------------------------------------------------------
	// Protocol detection (inbound) and creation
	// -----------------------------------------------------------------------

	_detectProtocol(protocolOpts) {
		var self = this;
		var detected = false;

		function onFirstData(data) {
			if (detected) return;
			detected = true;
			clearTimeout(detectTimer);
			self.transport.removeListener('data', onFirstData);

			// Peek at first byte to determine protocol:
			// - Byte >= 0x80: binkp (binary frame with command flag bit set)
			// - Byte == 0x2A (*): EMSI (ASCII **EMSI_INQ or **EMSI_REQ)
			if (data.length > 0 && data[0] >= 0x80) {
				self.protocolType = 'binkp';
			} else if (data.length > 0 && data[0] === 0x2A) {
				self.protocolType = 'emsi';
			} else {
				// Default to binkp for unrecognized data
				self.protocolType = 'binkp';
			}

			alogger.writeClog(5,
				'Session ' + self.uuid + ': detected ' + self.protocolType +
				' from ' + self.transport.remoteAddress +
				' (first byte: 0x' + data[0].toString(16) + ')',
				'mailer', 'cyan'
			);

			// Create protocol and feed it the peeked data
			self._createProtocol(protocolOpts);
			self.protocol.startSession(self.role);

			// Feed the peeked data into the protocol — it contains the
			// remote's first frame/packet that triggered detection.
			// Both protocols wire transport.on('data'), so re-emit through
			// the transport to reach the protocol's handler.
			if (self.protocolType === 'emsi' && self.protocol.pushInitialData) {
				self.protocol.pushInitialData(data);
			} else {
				self.transport.emit('data', data);
			}
		}

		// Resume transport and listen for first data
		this.transport.on('data', onFirstData);
		this.transport.resume();

		// Timeout: default to binkp if no data arrives
		var detectTimer = setTimeout(function() {
			if (detected) return;
			detected = true;
			self.transport.removeListener('data', onFirstData);

			alogger.writeClog(5,
				'Session ' + self.uuid + ': no data during detection, defaulting to binkp',
				'mailer', 'cyan'
			);

			self.protocolType = 'binkp';
			self._createProtocol(protocolOpts);
			self.protocol.startSession(self.role);
		}, 5000);
	}

	_createProtocol(protocolOpts) {
		this.state = 'handshake';

		if (this.protocolType === 'emsi') {
			this.protocol = new EmsiProtocol(this.transport, protocolOpts);
		} else {
			this.protocol = new BinkpProtocol(this.transport, protocolOpts);
		}

		// Wire protocol events — same interface for both protocols
		this.protocol.on('authenticated', (info) => this._onAuthenticated(info));
		this.protocol.on('passwordReceived', (info) => this._onPasswordReceived(info));
		this.protocol.on('sessionEnd', () => this._onSessionEnd());
		this.protocol.on('error', (err) => this._onError(err));

		// binkp-specific events (EMSI doesn't use these)
		if (this.protocolType === 'binkp') {
			this.protocol.on('remoteEOB', () => this._onRemoteEOB());
		}
	}

	getStatus() {
		return {
			uuid:           this.uuid,
			role:           this.role,
			state:          this.state,
			remoteAddress:  this.transport ? this.transport.remoteAddress : 'n/a',
			peerAddresses:  this.peerAddresses,
			peerName:       this.peerName,
			filesSent:      this.filesSent,
			filesReceived:  this.filesReceived,
			bytesSent:      this.bytesSent,
			bytesReceived:  this.bytesReceived,
			duration:       Math.floor((Date.now() - this.startTime) / 1000)
		};
	}

	// -----------------------------------------------------------------------
	// Handshake — inbound (answerer) password validation
	// -----------------------------------------------------------------------

	async _onPasswordReceived(info) {
		// Match presented addresses against peer_connections
		var matched = await this._matchPeer(info.addresses);
		if (!matched) {
			alogger.writeClog(3,
				'Session ' + this.uuid + ': no matching peer for addresses: ' +
				info.addresses.join(', '),
				'mailer', 'redbright'
			);
			this.protocol.sendERR('Authentication failed — unknown address');
			this._endSession('auth failed');
			return;
		}

		this.peerConnection = matched;
		this.peerConnections = [matched];
		var cd = matched.connection_data || {};
		var expectedPassword = cd.session_password || '';

		// Validate password
		var passwordOK = false;
		if (info.isCramMD5 && info.challenge) {
			passwordOK = verifyCramMD5(expectedPassword, info.challenge, info.password);
		} else {
			// Plain text comparison
			passwordOK = (info.password === expectedPassword) ||
			             (info.password === '-' && !expectedPassword);
		}

		if (!passwordOK) {
			alogger.writeClog(3,
				'Session ' + this.uuid + ': password mismatch for ' +
				info.addresses.join(', '),
				'mailer', 'redbright'
			);
			this.protocol.sendERR('Authentication failed — bad password');
			this._endSession('auth failed');
			return;
		}

		// Discover additional connections matching remote's other addresses.
		// Only group if their session_password matches the authenticated password
		// and is non-empty (security: no free ride on unverified addresses).
		if (info.addresses.length > 1 && expectedPassword) {
			var allConns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
			var primaryAddr = (cd.address || '').toLowerCase();

			for (var extraAddr of info.addresses) {
				var bareAddr = extraAddr.split('@')[0].toLowerCase();
				if (bareAddr === primaryAddr) continue;

				for (var extraConn of (allConns || [])) {
					var extraCd = extraConn.connection_data || {};
					if (!extraCd.address || extraCd.address.toLowerCase() !== bareAddr) continue;
					if (!extraCd.session_password) continue;
					if (extraCd.session_password !== expectedPassword) continue;
					// Password matches -- safe to group
					this.peerConnections.push(extraConn);
					alogger.writeClog(5, 'Session ' + this.uuid + ': grouped additional connection for ' + bareAddr, 'mailer', 'cyan');
					break;
				}
			}
		}

		// Success
		this.protocol.confirmAuth();
	}

	// -----------------------------------------------------------------------
	// Post-authentication — start file transfer
	// -----------------------------------------------------------------------

	async _onAuthenticated(info) {
		this.state         = 'transfer';
		this.peerAddresses = info.addresses || [];
		this.peerName      = (info.options && info.options.systemName) || '';

		// For caller sessions: discover additional connections matching remote's addresses
		if (this.role === 'caller' && this.peerConnection && this.peerAddresses.length > 1) {
			if (!this.peerConnections.length) {
				this.peerConnections = [this.peerConnection];
			}
			var callerCd = this.peerConnection.connection_data || {};
			var callerPassword = callerCd.session_password || '';
			var callerPrimaryAddr = (callerCd.address || '').toLowerCase();

			if (callerPassword) {
				var allConns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
				for (var rAddr of this.peerAddresses) {
					var bareAddr = rAddr.split('@')[0].toLowerCase();
					if (bareAddr === callerPrimaryAddr) continue;

					for (var extraConn of (allConns || [])) {
						var extraCd = extraConn.connection_data || {};
						if (!extraCd.address || extraCd.address.toLowerCase() !== bareAddr) continue;
						if (!extraCd.session_password || extraCd.session_password !== callerPassword) continue;
						// Already in list?
						if (this.peerConnections.some(function(c) { return c.id === extraConn.id; })) continue;
						this.peerConnections.push(extraConn);
						alogger.writeClog(5, 'Session ' + this.uuid + ': grouped additional connection for ' + bareAddr + ' (caller)', 'mailer', 'cyan');
						break;
					}
				}
			}
		}

		alogger.writeClog(5,
			'Session ' + this.uuid + ': authenticated (' + this.protocolType + ') with ' +
			this.peerAddresses.join(', ') +
			(this.peerConnections.length > 1 ? ' [' + this.peerConnections.length + ' connections]' : '') +
			(this.peerName ? ' (' + this.peerName + ')' : ''),
			'mailer', 'greenbright'
		);

		if (this.protocolType === 'emsi') {
			// EMSI/Wazoo — detach EMSI parser and start Wazoo batch transfer
			this.protocol.detachTransport();
			await this._runWazooTransfer();
			return;
		}

		// binkp — use the existing TransferEngine
		this.transfer = new TransferEngine(this.protocol, {
			inboundDir: this._inboundDir,
			tempDir:    this._tempDir,
			sessionId:  this.uuid
		});

		this.transfer.on('sendComplete', (info) => {
			this.filesSent++;
			alogger.writeClog(5, 'Session ' + this.uuid + ': sent ' + info.name, 'mailer', 'green');
		});
		this.transfer.on('receiveComplete', (info) => {
			this.filesReceived++;
			this.bytesReceived += info.size;
			alogger.writeClog(5, 'Session ' + this.uuid + ': received ' + info.name + ' (' + info.size + ' bytes)', 'mailer', 'green');

			// FREQ: if we received a .req file, process it
			if (info.name && info.name.toLowerCase().endsWith('.req') && info.path) {
				this._processFreqRequest(info.path);
			}
		});
		this.transfer.on('allSent', () => {
			this.protocol.sendEOB();
		});

		// Build outbound file list and start sending
		await this._buildOutboundList();
		this.transfer.markAllQueued();
		this.transfer.startSending();
	}

	// -----------------------------------------------------------------------
	// Wazoo transfer (EMSI sessions)
	// -----------------------------------------------------------------------

	async _runWazooTransfer() {
		// Build outbound file list (reuses the same BSO scanning logic)
		var outboundFiles = await this._buildOutboundFileList();

		alogger.writeClog(5,
			'Session ' + this.uuid + ': starting Wazoo transfer (' +
			outboundFiles.length + ' outbound file(s))',
			'mailer', 'cyan'
		);

		var wazoo = new WazooTransferEngine(this.transport, {
			role: this.role,
			inboundDir: this._inboundDir,
			tempDir: this._tempDir,
			outboundFiles: outboundFiles,
			sessionId: this.uuid
		});

		wazoo.on('sendComplete', (info) => {
			this.filesSent++;
			alogger.writeClog(5, 'Session ' + this.uuid + ': Wazoo sent ' + info.name, 'mailer', 'green');
		});
		wazoo.on('receiveComplete', (info) => {
			this.filesReceived++;
			this.bytesReceived += info.size;
			alogger.writeClog(5, 'Session ' + this.uuid + ': Wazoo received ' + info.name +
				' (' + info.size + ' bytes)', 'mailer', 'green');
		});

		var result = await wazoo.run();

		if (result.success) {
			this._endSession('complete');
		} else {
			this._endSession(result.error || 'wazoo error');
		}
	}

	// Build outbound file list as an array of { path } objects for WazooTransferEngine
	async _buildOutboundFileList() {
		if (!this.peerConnection) return [];

		// Reuse the existing BSO file scanning logic
		var cd = this.peerConnection.connection_data || {};
		var peerAddr = cd.address || '';
		if (!peerAddr) return [];

		var addrParts = this._parseAddress(peerAddr);
		if (!addrParts) return [];

		var outDir = this._getOutboundDirForZone(addrParts.zone);
		var netHex = addrParts.net.toString(16).padStart(4, '0');
		var nodeHex = addrParts.node.toString(16).padStart(4, '0');
		var desthex = netHex + nodeHex;

		var files = [];
		var fs = await import('fs');

		if (!fs.existsSync(outDir)) return [];

		// Flow files (.flo, .clo, .dlo, .hlo, .ilo)
		var floExtensions = ['.flo', '.clo', '.dlo', '.hlo', '.ilo'];
		for (var ext of floExtensions) {
			var floPath = outDir + '/' + desthex + ext;
			if (fs.existsSync(floPath)) {
				var content = fs.readFileSync(floPath, 'utf8');
				var lines = content.split('\n').map(l => l.trim()).filter(Boolean);
				for (var line of lines) {
					var prefix = '';
					var filepath = line;
					if (line[0] === '^' || line[0] === '#' || line[0] === '~') {
						prefix = line[0];
						filepath = line.substring(1).trim();
					}
					if (prefix === '~') continue;
					filepath = filepath.replace(/\r/g, '');
					if (filepath && fs.existsSync(filepath)) {
						files.push({ path: filepath });
					}
				}
			}
		}

		// Direct packet files (.out, .cut, .hut)
		var pktExtensions = ['.out', '.cut', '.hut'];
		for (var pktExt of pktExtensions) {
			var pktPath = outDir + '/' + desthex + pktExt;
			if (fs.existsSync(pktPath)) {
				files.push({ path: pktPath });
			}
		}

		return files;
	}

	// -----------------------------------------------------------------------
	// File list — find outbound files for this peer (binkp)
	// -----------------------------------------------------------------------

	// Resolve the BSO outbound directory for a given zone.
	// Default zone (1): ftn/out/
	// Alternate zones:  ftn/out.002/, ftn/out.003/, etc.
	_getOutboundDirForZone(zone) {
		var z = parseInt(zone) || 1;
		if (z === 1) {
			return this._outboundDir;
		}
		// BSO convention: base dir name + '.' + 3-digit hex zone
		var zoneHex = z.toString(16).padStart(3, '0');
		return this._outboundDir + '.' + zoneHex;
	}

	async _buildOutboundList() {
		var connections = this.peerConnections.length > 0 ? this.peerConnections : (this.peerConnection ? [this.peerConnection] : []);
		if (connections.length === 0) return;

		for (var conn of connections) {
			var cd = conn.connection_data || {};
			var peerAddr = cd.address || '';
			if (!peerAddr) continue;

			var addrParts = this._parseAddress(peerAddr);
			if (!addrParts) continue;

			var outDir  = this._getOutboundDirForZone(addrParts.zone);
			var netHex  = addrParts.net.toString(16).padStart(4, '0');
			var nodeHex = addrParts.node.toString(16).padStart(4, '0');
			var desthex = netHex + nodeHex;

			if (!fs.existsSync(outDir)) continue;

			// Look for flow files (.flo, .clo, .dlo, .hlo, .ilo)
			var floExtensions = ['.flo', '.clo', '.dlo', '.hlo', '.ilo'];
			for (var ext of floExtensions) {
				var floPath = path.join(outDir, desthex + ext);
				if (fs.existsSync(floPath)) {
					this._processFlowFile(floPath);
				}
			}

			// Direct BSO-style packet files (.out, .cut, .hut)
			var pktExtensions = ['.out', '.cut', '.hut'];
			for (var pktExt of pktExtensions) {
				var pktPath = path.join(outDir, desthex + pktExt);
				if (fs.existsSync(pktPath)) {
					this.transfer.queueFile(pktPath, { deleteAfterSend: true });
				}
			}

			// FREQ .req files
			var reqPath = path.join(outDir, desthex + '.req');
			if (fs.existsSync(reqPath)) {
				this.transfer.queueFile(reqPath, { deleteAfterSend: true });
				alogger.writeClog(5, 'Session ' + this.uuid + ': queued FREQ request ' + path.basename(reqPath) + ' for ' + peerAddr, 'mailer', 'cyan');
			}
		}

		if (connections.length > 1) {
			alogger.writeClog(5, 'Session ' + this.uuid + ': built outbound list for ' + connections.length + ' connection(s)', 'mailer', 'cyan');
		}
	}

	_processFlowFile(floPath) {
		try {
			var content = fs.readFileSync(floPath, 'utf8');
			var lines   = content.split('\n').map(l => l.trim()).filter(Boolean);

			for (var line of lines) {
				// Flow file line formats:
				//   ^/path/to/file  — send and delete
				//   #/path/to/file  — send and truncate
				//   /path/to/file   — send and leave
				//   ~/path/to/file  — skip (already sent)
				var prefix   = '';
				var filepath = line;

				if (line[0] === '^' || line[0] === '#' || line[0] === '~') {
					prefix   = line[0];
					filepath = line.substring(1).trim();
				}

				if (prefix === '~') continue; // Already sent, skip

				// Remove \r if present (Windows line endings in flo files)
				filepath = filepath.replace(/\r/g, '');

				if (filepath && fs.existsSync(filepath)) {
					this.transfer.queueFile(filepath, {
						floFile:   floPath,
						floPrefix: prefix
					});
				}
			}
		} catch (err) {
			alogger.writeClog(3, 'Session ' + this.uuid + ': error reading flow file ' + floPath + ': ' + err.message, 'mailer', 'redbright');
		}
	}

	// -----------------------------------------------------------------------
	// FREQ processing
	// -----------------------------------------------------------------------

	async _processFreqRequest(reqFilePath) {
		try {
			var freqMod = await import('../models/freq.js');
			var appCfg = (await import('../config/appConfig.js')).default;

			if (!appCfg.getBoolean('freq_enabled', true)) {
				alogger.writeClog(3, 'Session ' + this.uuid + ': FREQ disabled, ignoring .req', 'mailer', 'yellow');
				return;
			}

			var connectionId = this.peerConnection ? this.peerConnection.id : null;
			var results = await freqMod.resolveRequest(reqFilePath, connectionId);

			var foundCount = 0;
			var missCount = 0;

			for (var r of results) {
				if (r.found) {
					this.transfer.queueFile(r.filePath, { deleteAfterSend: false });
					foundCount++;
					alogger.writeClog(5, 'Session ' + this.uuid + ': FREQ serving ' + r.filename + ' (' + r.source + ')', 'mailer', 'green');
				} else {
					missCount++;
					alogger.writeClog(5, 'Session ' + this.uuid + ': FREQ not found: ' + r.filename + (r.reason ? ' (' + r.reason + ')' : ''), 'mailer', 'yellow');
				}
			}

			alogger.writeClog(3, 'Session ' + this.uuid + ': FREQ processed — ' + foundCount + ' found, ' + missCount + ' not found', 'mailer', foundCount > 0 ? 'greenbright' : 'yellow');

			// Delete the .req file from inbound (it's been processed)
			try { fs.unlinkSync(reqFilePath); } catch (_) {}

			// If we queued new files, restart sending (in case EOB was already sent)
			if (foundCount > 0) {
				this.transfer.startSending();
			}
		} catch (err) {
			alogger.writeClog(3, 'Session ' + this.uuid + ': FREQ processing error: ' + err.message, 'mailer', 'redbright');
		}
	}

	// -----------------------------------------------------------------------
	// Session end
	// -----------------------------------------------------------------------

	_onRemoteEOB() {
		alogger.writeClog(5, 'Session ' + this.uuid + ': remote sent EOB', 'mailer', 'cyan');
	}

	_onSessionEnd() {
		alogger.writeClog(5,
			'Session ' + this.uuid + ': complete — sent ' + this.filesSent +
			', received ' + this.filesReceived,
			'mailer', 'greenbright'
		);
		this._endSession('complete');
	}

	_onError(err) {
		alogger.writeClog(3, 'Session ' + this.uuid + ': error — ' + err.message, 'mailer', 'redbright');
		this._endSession('error');
	}

	_endSession(reason) {
		if (this.state === 'done' || this.state === 'error') return; // Already ended

		this.state = reason === 'complete' ? 'done' : 'error';

		// Clear timeout
		if (this._sessionTimer) {
			clearTimeout(this._sessionTimer);
			this._sessionTimer = null;
		}

		// Cleanup transfer engine
		if (this.transfer) {
			this.transfer.cleanup();
		}

		// Close transport
		if (this.transport && this.transport.isConnected) {
			this.transport.close();
		}

		this.emit('sessionEnd', {
			uuid:          this.uuid,
			reason:        reason,
			filesSent:     this.filesSent,
			filesReceived: this.filesReceived,
			duration:      Math.floor((Date.now() - this.startTime) / 1000)
		});
	}

	// -----------------------------------------------------------------------
	// Peer matching (inbound connections)
	// -----------------------------------------------------------------------

	async _matchPeer(addresses) {
		// Get all active FTN connections (joined with message_networks — has .domain)
		var connections = await peerConnections.getActiveConnectionsByNetworkType('FTN');
		if (!connections || connections.length === 0) return null;

		// Remote binkd presents addresses like "1:134/101@fidonet".
		// We store address "1:134/101" and domain "fidonet" separately.
		// First pass: match both address AND domain for strongest match.
		// Second pass: match address only (for remotes that don't send @domain).
		for (var addr of addresses) {
			var parts    = addr.split('@');
			var bareAddr = parts[0].toLowerCase();
			var domain   = parts.length > 1 ? parts[1].toLowerCase() : null;

			if (domain) {
				for (var conn of connections) {
					var cd = conn.connection_data || {};
					if (cd.address && cd.address.toLowerCase() === bareAddr &&
						conn.domain && conn.domain.toLowerCase() === domain) {
						return conn;
					}
				}
			}
		}

		// Second pass — address-only match (no domain or domain didn't match)
		for (var addr of addresses) {
			var bareAddr = addr.split('@')[0].toLowerCase();
			for (var conn of connections) {
				var cd = conn.connection_data || {};
				if (cd.address && cd.address.toLowerCase() === bareAddr) {
					return conn;
				}
			}
		}

		return null;
	}

	// -----------------------------------------------------------------------
	// Address helpers
	// -----------------------------------------------------------------------

	async _getLocalAddresses() {
		try {
			// Advertise all active FTN addresses across all networks.
			// Default addresses first (is_default = true per network), then non-defaults.
			var allAddrs = await systemAddresses.getActiveAddresses();
			var ftnAddrs = allAddrs.filter(a => a.address_zone && a.address_net && a.address_node);

			// Sort: defaults first, then by network
			ftnAddrs.sort(function(a, b) {
				if (a.is_default && !b.is_default) return -1;
				if (!a.is_default && b.is_default) return 1;
				return (a.network_id || 0) - (b.network_id || 0);
			});

			return ftnAddrs.map(a => a.domain ? a.address + '@' + a.domain : a.address);
		} catch (err) {
			alogger.writeClog(3, 'Session: failed to load local addresses: ' + err.message, 'mailer', 'redbright');
			return [];
		}
	}

	_parseAddress(addr) {
		// Parse "zone:net/node" or "zone:net/node.point"
		try {
			var zsplit  = addr.split(':');
			var nnsplit = zsplit[1] ? zsplit[1].split('/') : [];
			var npsplit = nnsplit[1] ? nnsplit[1].split('.') : [];

			var zone  = parseInt(zsplit[0]);
			var net   = parseInt(nnsplit[0]);
			var node  = parseInt(npsplit[0]);
			var point = npsplit.length > 1 ? parseInt(npsplit[1]) : 0;

			if (isNaN(zone) || isNaN(net) || isNaN(node)) return null;
			return { zone, net, node, point };
		} catch (_) {
			return null;
		}
	}
}

export { SessionController };
