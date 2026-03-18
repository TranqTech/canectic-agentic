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
import { TransferEngine } from './transfer.js';
import * as peerConnections from '../models/peerConnections.js';
import * as systemAddresses from '../models/systemAddresses.js';
import * as alogger from '../utils/alogger.js';

const SESSION_TIMEOUT = parseInt(process.env.MAILER_SESSION_TIMEOUT) || 300;

class SessionController extends EventEmitter {
	constructor(transport, role, options) {
		super();
		this.uuid      = uuidv4();
		this.role      = role;        // 'caller' or 'answerer'
		this.state     = 'idle';      // idle, connecting, handshake, authenticated, transfer, done, error
		this.transport = transport;
		this.options   = options || {};

		// Peer info (populated during handshake)
		this.peerConnection = null;   // DB record from peer_connections
		this.peerAddresses  = [];     // FTN addresses presented by remote
		this.peerName       = '';     // System name from M_NUL

		// Protocol and transfer
		this.protocol  = null;
		this.transfer  = null;

		// Stats
		this.startTime     = Date.now();
		this.filesSent     = 0;
		this.filesReceived = 0;
		this.bytesSent     = 0;
		this.bytesReceived = 0;

		// Session timeout
		this._sessionTimer = null;

		// Directories
		this._inboundDir  = this.options.inboundDir  || process.env.MAILER_INBOUND_DIR  || process.env.ftninbound  || 'ftn/in';
		this._outboundDir = this.options.outboundDir  || process.env.MAILER_OUTBOUND_DIR || process.env.ftnoutbound || 'ftn/out';
		this._tempDir     = this.options.tempDir      || process.env.MAILER_TEMP_DIR     || 'ftn/tmp';
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	async start() {
		this.state = 'handshake';

		// Start session timeout
		this._sessionTimer = setTimeout(() => {
			alogger.writeClog(3, 'Session ' + this.uuid + ': timeout after ' + SESSION_TIMEOUT + 's', 'mailer', 'redbright');
			this._endSession('timeout');
		}, SESSION_TIMEOUT * 1000);

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
		var systemName = process.env.boardname || 'Canectic BBS';
		var sysopName  = process.env.sysopname || 'Sysop';

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
			var cd = conn.connection_data || {};
			protocolOpts.sessionPassword = cd.session_password || '';
		}

		// ---------------------------------------------------------------
		// Phase 2: Protocol creation + event wiring + handshake start.
		// All synchronous from here — no awaits, no event loop yields.
		// The transport data listener is wired in the BinkpProtocol
		// constructor, so frames arriving after this point are captured.
		// ---------------------------------------------------------------

		// Create protocol
		this.protocol = new BinkpProtocol(this.transport, protocolOpts);

		// Wire protocol events
		this.protocol.on('authenticated', (info) => this._onAuthenticated(info));
		this.protocol.on('passwordReceived', (info) => this._onPasswordReceived(info));
		this.protocol.on('remoteEOB', () => this._onRemoteEOB());
		this.protocol.on('sessionEnd', () => this._onSessionEnd());
		this.protocol.on('error', (err) => this._onError(err));

		// Start the handshake (sends our M_NUL + M_ADR)
		this.protocol.startSession(this.role);

		// Resume the transport — for inbound connections, the socket was
		// paused in TcpTransport.fromSocket() to prevent data loss during
		// async setup. Now that the protocol is wired and listening for
		// data events, we can let the buffered frames flow through.
		this.transport.resume();

		alogger.writeClog(5,
			'Session ' + this.uuid + ': started as ' + this.role +
			' via ' + this.transport.remoteAddress,
			'mailer', 'cyan'
		);
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

		alogger.writeClog(5,
			'Session ' + this.uuid + ': authenticated with ' +
			this.peerAddresses.join(', ') +
			(this.peerName ? ' (' + this.peerName + ')' : ''),
			'mailer', 'greenbright'
		);

		// Create transfer engine
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
	// File list — find outbound files for this peer
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
		if (!this.peerConnection) return;

		var cd = this.peerConnection.connection_data || {};
		var peerAddr = cd.address || '';
		if (!peerAddr) return;

		// Parse peer address to generate the BSO hex filename stem
		var addrParts = this._parseAddress(peerAddr);
		if (!addrParts) return;

		var outDir  = this._getOutboundDirForZone(addrParts.zone);
		var netHex  = addrParts.net.toString(16).padStart(4, '0');
		var nodeHex = addrParts.node.toString(16).padStart(4, '0');
		var desthex = netHex + nodeHex;

		if (!fs.existsSync(outDir)) return;

		// Look for flow files (.flo, .clo, .dlo, .hlo, .ilo)
		var floExtensions = ['.flo', '.clo', '.dlo', '.hlo', '.ilo'];
		for (var ext of floExtensions) {
			var floPath = path.join(outDir, desthex + ext);
			if (fs.existsSync(floPath)) {
				this._processFlowFile(floPath);
			}
		}

		// Also look for direct BSO-style packet files (.out, .cut, .hut)
		// These are deleted after successful send.
		var pktExtensions = ['.out', '.cut', '.hut'];
		for (var pktExt of pktExtensions) {
			var pktPath = path.join(outDir, desthex + pktExt);
			if (fs.existsSync(pktPath)) {
				this.transfer.queueFile(pktPath, { deleteAfterSend: true });
			}
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
			var addresses = [];
			// If the session has a specific connection, use its network's addresses
			if (this.peerConnection) {
				var netAddrs = await systemAddresses.getAddressesByNetwork(this.peerConnection.network_id);
				addresses = netAddrs.map(a => a.domain ? a.address + '@' + a.domain : a.address);
			}
			// Fallback: get all active FTN addresses
			if (addresses.length === 0) {
				var allAddrs = await systemAddresses.getActiveAddresses();
				addresses = allAddrs
					.filter(a => a.address_zone && a.address_net && a.address_node) // FTN only
					.map(a => a.domain ? a.address + '@' + a.domain : a.address);
			}
			return addresses;
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
