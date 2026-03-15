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
		this._inboundDir  = this.options.inboundDir  || process.env.MAILER_INBOUND_DIR  || './ftn/in';
		this._outboundDir = this.options.outboundDir  || process.env.MAILER_OUTBOUND_DIR || process.env.ftnoutbound || '/var/bbs/ftn/outbound';
		this._tempDir     = this.options.tempDir      || process.env.MAILER_TEMP_DIR     || './ftn/tmp';
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

		// Create protocol
		this.protocol = new BinkpProtocol(this.transport, protocolOpts);

		// Wire protocol events
		this.protocol.on('authenticated', (info) => this._onAuthenticated(info));
		this.protocol.on('passwordReceived', (info) => this._onPasswordReceived(info));
		this.protocol.on('remoteEOB', () => this._onRemoteEOB());
		this.protocol.on('sessionEnd', () => this._onSessionEnd());
		this.protocol.on('error', (err) => this._onError(err));

		// Start the handshake
		this.protocol.startSession(this.role);

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

	async _buildOutboundList() {
		if (!this.peerConnection) return;

		var cd = this.peerConnection.connection_data || {};
		var peerAddr = cd.address || '';
		if (!peerAddr) return;

		// Parse peer address to generate the BSO hex filename stem
		var addrParts = this._parseAddress(peerAddr);
		if (!addrParts) return;

		var netHex  = addrParts.net.toString(16).padStart(4, '0');
		var nodeHex = addrParts.node.toString(16).padStart(4, '0');
		var desthex = netHex + nodeHex;

		// Look for flow files (.flo, .clo, .dlo, .hlo, .ilo)
		var floExtensions = ['.flo', '.clo', '.dlo', '.hlo', '.ilo'];
		for (var ext of floExtensions) {
			var floPath = path.join(this._outboundDir, desthex + ext);
			if (fs.existsSync(floPath)) {
				this._processFlowFile(floPath);
			}
		}

		// Also look for direct .pkt/.out/.cut/.hut files in the outbound dir
		var pktExtensions = ['.out', '.cut', '.hut'];
		for (var pktExt of pktExtensions) {
			var pktPath = path.join(this._outboundDir, desthex + pktExt);
			if (fs.existsSync(pktPath)) {
				this.transfer.queueFile(pktPath);
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
					this.transfer.queueFile(filepath);
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
		// Get all active FTN connections
		var connections = await peerConnections.getActiveConnectionsByNetworkType('FTN');
		if (!connections || connections.length === 0) return null;

		// For each presented address, find a matching connection
		for (var addr of addresses) {
			for (var conn of connections) {
				var cd = conn.connection_data || {};
				if (cd.address && cd.address.toLowerCase() === addr.toLowerCase()) {
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
				addresses = netAddrs.map(a => a.address);
			}
			// Fallback: get all active FTN addresses
			if (addresses.length === 0) {
				var allAddrs = await systemAddresses.getActiveAddresses();
				addresses = allAddrs
					.filter(a => a.address_zone && a.address_net && a.address_node) // FTN only
					.map(a => a.address);
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
