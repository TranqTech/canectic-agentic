// mailer/manager.js — Mailer manager.
//
// Top-level coordinator for the FTN mailer system. Manages:
//   - TCP server listener for inbound binkp connections
//   - WebSocket pool integration (via WsManager — Phase 3)
//   - Session pool (active inbound + outbound sessions)
//   - Outbound poll scheduling and manual triggers
//
// The manager does not speak binkp — it creates SessionController
// instances and lets them handle the protocol.

import { EventEmitter } from 'node:events';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { TcpTransport } from './transports/tcp.js';
import { SessionController } from './session.js';
import * as peerConnections from '../models/peerConnections.js';
import * as alogger from '../utils/alogger.js';

const MAILER_ENABLED        = process.env.MAILER_ENABLED === 'true';
const BINKP_PORT            = parseInt(process.env.MAILER_BINKP_PORT) || 24554;
const MAX_SESSIONS          = parseInt(process.env.MAILER_MAX_SESSIONS) || 10;
const CONNECT_TIMEOUT       = (parseInt(process.env.MAILER_CONNECT_TIMEOUT) || 30) * 1000;
const POLL_INTERVAL         = (parseInt(process.env.MAILER_POLL_INTERVAL) || 900) * 1000;
const INBOUND_DIR           = process.env.MAILER_INBOUND_DIR  || './ftn/in';
const OUTBOUND_DIR          = process.env.MAILER_OUTBOUND_DIR || process.env.ftnoutbound || '/var/bbs/ftn/outbound';
const TEMP_DIR              = process.env.MAILER_TEMP_DIR     || './ftn/tmp';

class MailerManager extends EventEmitter {
	constructor(options) {
		super();
		this._options    = options || {};
		this._sessions   = [];        // Active SessionController instances
		this._tcpServer  = null;
		this._wsPool     = null;      // WsPool from WsManager (Phase 3)
		this._pollTimers = new Map(); // connectionUUID -> timer
		this._running    = false;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	start() {
		if (!MAILER_ENABLED) {
			alogger.writeClog(3, 'Mailer: disabled (set MAILER_ENABLED=true to enable)', 'mailer', 'yellow');
			return;
		}

		this._running = true;

		// Start TCP listener for binkp
		this._tcpServer = net.createServer((socket) => {
			this._onInboundTcp(socket);
		});

		this._tcpServer.on('error', (err) => {
			alogger.writeClog(1, 'Mailer TCP server error: ' + err.message, 'mailer', 'redbright');
		});

		this._tcpServer.listen(BINKP_PORT, () => {
			alogger.writeClog(1, 'Mailer: binkp listening on port ' + BINKP_PORT, 'mailer', 'cyanbright');
		});

		// Start poll scheduling for active FTN connections
		this._startPollScheduling();

		alogger.writeClog(1, 'Mailer: started', 'mailer', 'cyanbright');
	}

	stop() {
		this._running = false;

		// Stop poll timers
		for (var [uuid, timer] of this._pollTimers) {
			clearInterval(timer);
		}
		this._pollTimers.clear();

		// Close TCP server
		if (this._tcpServer) {
			this._tcpServer.close();
			this._tcpServer = null;
		}

		// End active sessions gracefully
		for (var session of this._sessions) {
			if (session.protocol) {
				session.protocol.sendERR('System shutting down');
			}
		}

		alogger.writeClog(1, 'Mailer: stopped', 'mailer', 'cyanbright');
	}

	// Phase 3: accept inbound WebSocket connections from existing WsManager
	setWebSocketPool(wsPool) {
		this._wsPool = wsPool;
		// TODO: wire wsPool connection events to _onInboundWebSocket()
		alogger.writeClog(2, 'Mailer: WebSocket pool registered', 'mailer', 'cyan');
	}

	// -----------------------------------------------------------------------
	// Inbound connection handling
	// -----------------------------------------------------------------------

	_onInboundTcp(socket) {
		if (!this._running) {
			socket.destroy();
			return;
		}

		var remoteAddr = (socket.remoteAddress || '?') + ':' + (socket.remotePort || '?');

		if (this._sessions.length >= MAX_SESSIONS) {
			alogger.writeClog(3, 'Mailer: rejecting inbound from ' + remoteAddr + ' (max sessions)', 'mailer', 'yellow');
			// Send a binkp M_BSY frame before closing
			var bsyMsg = Buffer.from('System busy, try later');
			var frame  = Buffer.alloc(2 + 1 + bsyMsg.length);
			frame.writeUInt16BE(0x8000 | (1 + bsyMsg.length), 0);
			frame[2] = 8; // M_BSY
			bsyMsg.copy(frame, 3);
			socket.write(frame);
			socket.end();
			return;
		}

		alogger.writeClog(5, 'Mailer: inbound TCP connection from ' + remoteAddr, 'mailer', 'cyan');

		var transport = TcpTransport.fromSocket(socket);
		this._createSession(transport, 'answerer', {});
	}

	// -----------------------------------------------------------------------
	// Outbound connection handling
	// -----------------------------------------------------------------------

	async pollConnection(connectionUUID) {
		if (!this._running) return;

		// Check if we already have a session to this peer
		var conn = await peerConnections.getConnectionByUUIDWithNetwork(connectionUUID);
		if (!conn) {
			alogger.writeClog(3, 'Mailer: poll — connection not found: ' + connectionUUID, 'mailer', 'redbright');
			return;
		}
		if (!conn.active) {
			return;
		}

		var cd = conn.connection_data || {};

		// Check for existing session to this peer
		if (this._hasSessionForAddress(cd.address)) {
			alogger.writeClog(5, 'Mailer: skipping poll for ' + cd.address + ' — session already active', 'mailer', 'cyan');
			return;
		}

		// Check if there's actually outbound mail
		if (!this._hasOutboundMail(cd.address)) {
			alogger.writeClog(5, 'Mailer: no outbound mail for ' + cd.address + ' — skipping poll', 'mailer', 'cyan');
			return;
		}

		this._connectToPeer(conn);
	}

	// Manual poll trigger — bypasses _running and outbound mail checks.
	// Always initiates a connection. Used by admin routes and test scripts.
	async triggerPoll(connectionUUID) {
		var conn = await peerConnections.getConnectionByUUIDWithNetwork(connectionUUID);
		if (!conn) {
			alogger.writeClog(3, 'Mailer: triggerPoll — connection not found: ' + connectionUUID, 'mailer', 'redbright');
			return;
		}

		var cd = conn.connection_data || {};

		// Check for existing session to this peer
		if (this._hasSessionForAddress(cd.address)) {
			alogger.writeClog(5, 'Mailer: skipping triggerPoll for ' + cd.address + ' — session already active', 'mailer', 'cyan');
			return;
		}

		var hasmail = this._hasOutboundMail(cd.address);
		alogger.writeClog(5,
			'Mailer: triggerPoll for ' + (cd.address || connectionUUID) +
			(hasmail ? ' (outbound mail pending)' : ' (no outbound mail — session-only)'),
			'mailer', 'cyan'
		);

		this._connectToPeer(conn);
	}

	// Internal — initiate TCP/WS connection to a peer
	_connectToPeer(conn) {
		var cd = conn.connection_data || {};
		var mailerTransport = cd.mailer_transport || 'tcp';
		var host = cd.mailer_host || cd.remote_host || '';
		var port = cd.mailer_port || cd.remote_port || BINKP_PORT;

		if (!host) {
			alogger.writeClog(4, 'Mailer: no host configured for ' + (cd.address || conn.uuid) + ' — cannot connect', 'mailer', 'yellow');
			return;
		}

		if (this._sessions.length >= MAX_SESSIONS) {
			alogger.writeClog(4, 'Mailer: cannot connect to ' + cd.address + ' — max sessions reached', 'mailer', 'yellow');
			return;
		}

		alogger.writeClog(5, 'Mailer: connecting to ' + (cd.address || conn.uuid) + ' at ' + host + ':' + port, 'mailer', 'cyan');

		if (mailerTransport === 'tcp') {
			var transport = TcpTransport.connect(host, port, CONNECT_TIMEOUT);
			transport.once('connect', () => {
				this._createSession(transport, 'caller', { connectionUUID: conn.uuid });
			});
			transport.once('error', (err) => {
				alogger.writeClog(3, 'Mailer: outbound connect to ' + host + ':' + port + ' failed: ' + err.message, 'mailer', 'redbright');
				this.emit('pollFailed', { connectionUUID: conn.uuid, error: err.message });
			});
		}
		// WebSocket transport: Phase 3
	}

	// -----------------------------------------------------------------------
	// Session management
	// -----------------------------------------------------------------------

	_createSession(transport, role, options) {
		var session = new SessionController(transport, role, {
			...options,
			inboundDir:  INBOUND_DIR,
			outboundDir: OUTBOUND_DIR,
			tempDir:     TEMP_DIR
		});

		this._sessions.push(session);

		session.on('sessionEnd', (info) => {
			this._removeSession(session);
			alogger.writeClog(5,
				'Mailer: session ' + info.uuid + ' ended (' + info.reason + ') — ' +
				'sent: ' + info.filesSent + ', received: ' + info.filesReceived +
				', duration: ' + info.duration + 's',
				'mailer', 'cyan'
			);
			this.emit('sessionEnd', info);
		});

		session.start();
		this.emit('sessionStart', session.getStatus());
	}

	_removeSession(session) {
		var idx = this._sessions.indexOf(session);
		if (idx !== -1) {
			this._sessions.splice(idx, 1);
		}
	}

	_hasSessionForAddress(address) {
		if (!address) return false;
		var addrLower = address.toLowerCase();
		for (var session of this._sessions) {
			if (session.peerAddresses.some(a => a.toLowerCase() === addrLower)) {
				return true;
			}
			// Also check the target connection for outbound sessions
			if (session.peerConnection) {
				var cd = session.peerConnection.connection_data || {};
				if (cd.address && cd.address.toLowerCase() === addrLower) {
					return true;
				}
			}
		}
		return false;
	}

	// -----------------------------------------------------------------------
	// Outbound mail detection
	// -----------------------------------------------------------------------

	_hasOutboundMail(peerAddress) {
		if (!peerAddress) return false;

		try {
			var parts = this._parseAddress(peerAddress);
			if (!parts) return false;

			var netHex  = parts.net.toString(16).padStart(4, '0');
			var nodeHex = parts.node.toString(16).padStart(4, '0');
			var desthex = netHex + nodeHex;

			// Check for flow files or direct packet files
			var extensions = ['.flo', '.clo', '.dlo', '.hlo', '.ilo', '.out', '.cut', '.hut'];
			for (var ext of extensions) {
				var filePath = path.join(OUTBOUND_DIR, desthex + ext);
				if (fs.existsSync(filePath)) {
					return true;
				}
			}

			return false;
		} catch (_) {
			return false;
		}
	}

	// -----------------------------------------------------------------------
	// Poll scheduling
	// -----------------------------------------------------------------------

	async _startPollScheduling() {
		try {
			var connections = await peerConnections.getActiveConnectionsByNetworkType('FTN');
			if (!connections) return;

			for (var conn of connections) {
				var cd = conn.connection_data || {};

				// HOLD connections are passive — never poll
				if (cd.status === 'HOLD') continue;

				// Need a host to poll
				var host = cd.mailer_host || cd.remote_host;
				if (!host) continue;

				// CRASH connections are event-driven only (no timed poll)
				if (cd.status === 'CRASH') continue;

				// NORMAL connections get timed polling
				var interval = POLL_INTERVAL;
				var timer = setInterval(() => {
					this.pollConnection(conn.uuid);
				}, interval);

				this._pollTimers.set(conn.uuid, timer);
				alogger.writeClog(5,
					'Mailer: scheduled polling for ' + (cd.address || conn.uuid) +
					' every ' + Math.floor(interval / 1000) + 's',
					'mailer', 'cyan'
				);
			}
		} catch (err) {
			alogger.writeClog(3, 'Mailer: poll scheduling error: ' + err.message, 'mailer', 'redbright');
		}
	}

	// Notify the mailer that new outbound mail exists for a connection.
	// Called by the tosser after TossOutbound() completes.
	async signalOutbound(connectionUUID) {
		if (!this._running) return;

		var conn = await peerConnections.getConnectionByUUIDWithNetwork(connectionUUID);
		if (!conn || !conn.active) return;

		var cd = conn.connection_data || {};

		// CRASH = immediate delivery attempt
		if (cd.status === 'CRASH') {
			alogger.writeClog(5, 'Mailer: CRASH delivery for ' + (cd.address || connectionUUID), 'mailer', 'cyan');
			await this.pollConnection(connectionUUID);
		}
		// NORMAL = will be picked up by the next poll cycle
		// HOLD = wait for inbound call
	}

	// -----------------------------------------------------------------------
	// Status
	// -----------------------------------------------------------------------

	getActiveSessions() {
		return this._sessions.map(s => s.getStatus());
	}

	isRunning() {
		return this._running;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

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
}

export { MailerManager };
