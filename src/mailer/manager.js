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
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import { TcpTransport } from './transports/tcp.js';
import { WsTransport } from './transports/ws.js';
import { SessionController } from './session.js';
import { BsoScanner } from './bsoScanner.js';
import * as peerConnections from '../models/peerConnections.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

// Bootstrap — these bind at startup and can't hot-reload
const MAILER_ENABLED        = process.env.MAILER_ENABLED === 'true';
const BINKP_PORT            = parseInt(process.env.MAILER_BINKP_PORT) || 24554;

class MailerManager extends EventEmitter {
	constructor(options) {
		super();
		this._options       = options || {};
		this._sessions      = [];        // Active SessionController instances
		this._tcpServer     = null;
		this._wsHttpServer  = null;      // HTTP server for WS upgrades (separate mode)
		this._wss           = null;      // WebSocketServer instance (separate mode)
		this._wsPool        = null;      // WsPool from WsManager (embedded mode)
		this._bsoScanner    = null;      // BsoScanner instance
		this._pollTimers    = new Map(); // connectionUUID -> timer
		this._running       = false;
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
			alogger.writeClog(1, 'Mailer: binkp TCP listening on port ' + BINKP_PORT, 'mailer', 'cyanbright');
		});

		// Start WebSocket listener for binkp (separate mode only —
		// embedded mode uses setWebSocketPool() from the gateway's WsManager)
		var wsPort = parseInt(process.env.MAILER_WS_PORT) || 24555;
		if (wsPort > 0 && !this._wsPool) {
			this._wsHttpServer = http.createServer(function(req, res) {
				res.writeHead(426); // Upgrade Required
				res.end();
			});

			this._wss = new WebSocketServer({ noServer: true });

			this._wsHttpServer.on('upgrade', (request, socket, head) => {
				var pathname = new URL(request.url, 'http://localhost').pathname;
				if (pathname === '/ws/mailer/binkp') {
					this._wss.handleUpgrade(request, socket, head, (ws) => {
						this._onInboundWebSocket(ws, request);
					});
				} else {
					socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
					socket.destroy();
				}
			});

			this._wsHttpServer.listen(wsPort, () => {
				alogger.writeClog(1, 'Mailer: binkp WebSocket listening on port ' + wsPort + ' (path: /ws/mailer/binkp)', 'mailer', 'cyanbright');
			});

			this._wsHttpServer.on('error', (err) => {
				alogger.writeClog(1, 'Mailer WS server error: ' + err.message, 'mailer', 'redbright');
			});
		}

		// Start BSO outbound directory scanner
		this._bsoScanner = new BsoScanner({
			outboundDir: appConfig.get('MAILER_OUTBOUND_DIR') || appConfig.get('ftnoutbound', 'ftn/out'),
			defaultZone: appConfig.getNumber('MAILER_DEFAULT_ZONE', 1),
			manager:     this
		});
		this._bsoScanner.start();

		alogger.writeClog(1, 'Mailer: started', 'mailer', 'cyanbright');
	}

	stop() {
		this._running = false;

		// Stop BSO scanner
		if (this._bsoScanner) {
			this._bsoScanner.stop();
			this._bsoScanner = null;
		}

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

		// Close WebSocket server
		if (this._wss) {
			this._wss.close();
			this._wss = null;
		}
		if (this._wsHttpServer) {
			this._wsHttpServer.close();
			this._wsHttpServer = null;
		}

		// End active sessions gracefully
		for (var session of this._sessions) {
			if (session.protocol) {
				session.protocol.sendERR('System shutting down');
			}
		}

		alogger.writeClog(1, 'Mailer: stopped', 'mailer', 'cyanbright');
	}

	// Accept inbound WebSocket connections from gateway's WsManager (embedded mode)
	setWebSocketPool(wsPool) {
		this._wsPool = wsPool;
		wsPool.wss.on('connection', (ws, request) => {
			this._onInboundWebSocket(ws, request);
		});
		alogger.writeClog(2, 'Mailer: WebSocket pool registered (embedded mode)', 'mailer', 'cyan');
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

		if (this._sessions.length >= appConfig.getNumber('MAILER_MAX_SESSIONS', 10)) {
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

	_onInboundWebSocket(ws, request) {
		if (!this._running) {
			ws.close();
			return;
		}

		var remoteAddr = (request && request.socket ? request.socket.remoteAddress : '?') || '?';

		if (this._sessions.length >= appConfig.getNumber('MAILER_MAX_SESSIONS', 10)) {
			alogger.writeClog(3, 'Mailer: rejecting inbound WS from ' + remoteAddr + ' (max sessions)', 'mailer', 'yellow');
			// Send a binkp M_BSY frame before closing
			var bsyMsg = Buffer.from('System busy, try later');
			var frame  = Buffer.alloc(2 + 1 + bsyMsg.length);
			frame.writeUInt16BE(0x8000 | (1 + bsyMsg.length), 0);
			frame[2] = 8; // M_BSY
			ws.send(frame);
			ws.close();
			return;
		}

		alogger.writeClog(5, 'Mailer: inbound WebSocket connection from ' + remoteAddr, 'mailer', 'cyan');

		var transport = WsTransport.fromWebSocket(ws, request);
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

		// Always connect — polling is for both sending and receiving.
		// Log whether we have outbound mail for visibility.
		var hasmail = this._hasOutboundMail(cd.address);
		alogger.writeClog(5,
			'Mailer: polling ' + (cd.address || connectionUUID) +
			(hasmail ? ' (outbound mail pending)' : ' (receive only)'),
			'mailer', 'cyan'
		);

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

	// Internal — initiate TCP/WS connection to a peer (from peer_connections record)
	_connectToPeer(conn) {
		var cd = conn.connection_data || {};
		var mailerTransport = cd.mailer_transport || 'tcp';
		var host = cd.mailer_host || cd.remote_host || '';
		var port = cd.mailer_port || cd.remote_port || BINKP_PORT;

		if (!host) {
			alogger.writeClog(4, 'Mailer: no host configured for ' + (cd.address || conn.uuid) + ' — cannot connect', 'mailer', 'yellow');
			return;
		}

		if (this._sessions.length >= appConfig.getNumber('MAILER_MAX_SESSIONS', 10)) {
			alogger.writeClog(4, 'Mailer: cannot connect to ' + cd.address + ' — max sessions reached', 'mailer', 'yellow');
			return;
		}

		alogger.writeClog(5, 'Mailer: connecting to ' + (cd.address || conn.uuid) + ' at ' + host + ':' + port, 'mailer', 'cyan');

		if (mailerTransport === 'tcp') {
			var transport = TcpTransport.connect(host, port, appConfig.getNumber('MAILER_CONNECT_TIMEOUT', 30) * 1000);
			transport.once('connect', () => {
				this._createSession(transport, 'caller', { connectionUUID: conn.uuid });
			});
			transport.once('error', (err) => {
				alogger.writeClog(3, 'Mailer: outbound connect to ' + host + ':' + port + ' failed: ' + err.message, 'mailer', 'redbright');
				this.emit('pollFailed', { connectionUUID: conn.uuid, error: err.message });
			});
		} else if (mailerTransport === 'websocket') {
			var wsUrl = cd.mailer_ws_url;
			if (!wsUrl) {
				alogger.writeClog(4, 'Mailer: no mailer_ws_url for ' + (cd.address || conn.uuid) + ' — cannot connect via WebSocket', 'mailer', 'yellow');
				return;
			}

			alogger.writeClog(5, 'Mailer: connecting via WebSocket to ' + (cd.address || conn.uuid) + ' at ' + wsUrl, 'mailer', 'cyan');

			var wsTransport = WsTransport.connect(wsUrl, appConfig.getNumber('MAILER_CONNECT_TIMEOUT', 30) * 1000);
			wsTransport.once('connect', () => {
				this._createSession(wsTransport, 'caller', { connectionUUID: conn.uuid });
			});
			wsTransport.once('error', (err) => {
				alogger.writeClog(3, 'Mailer: outbound WS connect to ' + wsUrl + ' failed: ' + err.message, 'mailer', 'redbright');
				this.emit('pollFailed', { connectionUUID: conn.uuid, error: err.message });
			});
		}
	}

	// Internal — initiate TCP connection to a nodelist-resolved address (no peer record)
	connectToNodelistAddress(nodelistData, destinationAddress) {
		if (!nodelistData || !nodelistData.hostname) {
			alogger.writeClog(3, 'Mailer: nodelist connect — no hostname for ' + destinationAddress, 'mailer', 'yellow');
			return;
		}

		var host = nodelistData.hostname;
		var port = nodelistData.binkpPort || BINKP_PORT;

		if (this._sessions.length >= appConfig.getNumber('MAILER_MAX_SESSIONS', 10)) {
			alogger.writeClog(4, 'Mailer: cannot connect to ' + destinationAddress + ' — max sessions reached', 'mailer', 'yellow');
			return;
		}

		if (this._hasSessionForAddress(destinationAddress)) {
			alogger.writeClog(5, 'Mailer: skipping nodelist connect to ' + destinationAddress + ' — session already active', 'mailer', 'cyan');
			return;
		}

		alogger.writeClog(3,
			'Mailer: nodelist connect to ' + destinationAddress +
			' (' + (nodelistData.systemName || 'unknown') + ') at ' + host + ':' + port,
			'mailer', 'cyan'
		);

		var transport = TcpTransport.connect(host, port, appConfig.getNumber('MAILER_CONNECT_TIMEOUT', 30) * 1000);
		transport.once('connect', () => {
			this._createSession(transport, 'caller', {
				connectionUUID: null,
				nodelistAddress: destinationAddress,
				nodelistData: nodelistData
			});
		});
		transport.once('error', (err) => {
			alogger.writeClog(3, 'Mailer: nodelist connect to ' + host + ':' + port + ' failed: ' + err.message, 'mailer', 'redbright');
			this.emit('pollFailed', { address: destinationAddress, error: err.message });
		});
	}

	// -----------------------------------------------------------------------
	// Session management
	// -----------------------------------------------------------------------

	_createSession(transport, role, options) {
		var session = new SessionController(transport, role, {
			...options,
			inboundDir:  appConfig.get('MAILER_INBOUND_DIR') || appConfig.get('ftninbound', 'ftn/in'),
			outboundDir: appConfig.get('MAILER_OUTBOUND_DIR') || appConfig.get('ftnoutbound', 'ftn/out'),
			tempDir:     appConfig.get('MAILER_TEMP_DIR', 'ftn/tmp')
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

			// Notify listeners that files arrived and need tossing.
			// connectionUUID comes from caller options (outbound) or
			// peer matching during handshake (inbound).
			if (info.filesReceived > 0) {
				var connectionUUID = session.options.connectionUUID
					|| (session.peerConnection ? session.peerConnection.uuid : null);
				this.emit('filesReceived', {
					connectionUUID: connectionUUID,
					fileCount:      info.filesReceived,
					sessionUUID:    info.uuid,
				});
			}
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
		var bareAddr = address.split('@')[0].toLowerCase();
		for (var session of this._sessions) {
			if (session.peerAddresses.some(a => a.split('@')[0].toLowerCase() === bareAddr)) {
				return true;
			}
			// Also check the target connection for outbound sessions
			if (session.peerConnection) {
				var cd = session.peerConnection.connection_data || {};
				if (cd.address && cd.address.split('@')[0].toLowerCase() === bareAddr) {
					return true;
				}
			}
		}
		return false;
	}

	// -----------------------------------------------------------------------
	// Outbound mail detection
	// -----------------------------------------------------------------------

	// Resolve the BSO outbound directory for a given zone.
	// Default zone (1): ftn/out/
	// Alternate zones:  ftn/out.002/, ftn/out.003/, etc.
	_getOutboundDirForZone(zone) {
		var outDir = appConfig.get('MAILER_OUTBOUND_DIR') || appConfig.get('ftnoutbound', 'ftn/out');
		var z = parseInt(zone) || 1;
		if (z === 1) {
			return outDir;
		}
		var zoneHex = z.toString(16).padStart(3, '0');
		return outDir + '.' + zoneHex;
	}

	_hasOutboundMail(peerAddress) {
		if (!peerAddress) return false;

		try {
			var parts = this._parseAddress(peerAddress);
			if (!parts) return false;

			var outDir  = this._getOutboundDirForZone(parts.zone);
			var netHex  = parts.net.toString(16).padStart(4, '0');
			var nodeHex = parts.node.toString(16).padStart(4, '0');
			var desthex = netHex + nodeHex;

			if (!fs.existsSync(outDir)) return false;

			// Check for flow files or direct packet files
			var extensions = ['.flo', '.clo', '.dlo', '.hlo', '.ilo', '.out', '.cut', '.hut'];
			for (var ext of extensions) {
				var filePath = path.join(outDir, desthex + ext);
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

	// Trigger an immediate BSO directory scan.
	// Called by the mailer queue consumer when a bso-scan job arrives.
	async scanOutboundNow() {
		if (this._bsoScanner) {
			return this._bsoScanner.scanNow();
		}
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
