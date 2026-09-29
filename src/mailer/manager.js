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
import * as mailerSessions from '../models/mailerSessions.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';
import { outboundDirForZone } from '../utils/bsoPaths.js';

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
		this._nodelistBackoff = new Map(); // address -> { failures, nextAllowedAt }
		this._running       = false;
		this._maintenance   = false;     // closed for maintenance mode: no new sessions either way
		this._dials         = new Map(); // dial id -> started ms, connects not yet a session
		this._dialSeq       = 0;
	}

	// -----------------------------------------------------------------------
	// Maintenance mode
	//
	// Closed means no new sessions in either direction. Inbound callers get
	// M_BSY, which binkp mailers treat as "try later"; outbound mail stays in
	// the BSO outbound and goes when the board reopens. Sessions already
	// running are left to finish, and each has its own hard timeout.
	// -----------------------------------------------------------------------

	setMaintenance(active) {
		var was = this._maintenance;
		this._maintenance = !!active;
		if (was !== this._maintenance) {
			alogger.writeClog(2, this._maintenance
				? 'Mailer: closed for maintenance, no new sessions (' + this._sessions.length + ' still running)'
				: 'Mailer: maintenance over, accepting sessions again', 'mailer', 'yellowbright');
		}
	}

	isInMaintenance() {
		return this._maintenance;
	}

	/** End every running session, for when the maintenance grace runs out. */
	endSessionsForMaintenance() {
		for (var session of this._sessions) {
			if (session.protocol) session.protocol.sendERR('System closing for maintenance');
		}
	}

	/**
	 * What is still in flight, for the maintenance drain status. A connect that
	 * has not become a session yet counts too, until it is older than the
	 * connect timeout, so a dial that never reports back cannot hold the drain
	 * open for ever.
	 */
	drainCounts() {
		var limitMs = (appConfig.getNumber('MAILER_CONNECT_TIMEOUT', 30) + 10) * 1000;
		var now = Date.now();
		var dialing = 0;
		for (var [id, started] of this._dials) {
			if (now - started > limitMs) this._dials.delete(id);
			else dialing++;
		}
		return { 'binkp sessions': this._sessions.length, 'binkp connects': dialing };
	}

	_trackDial(transport) {
		var id = ++this._dialSeq;
		this._dials.set(id, Date.now());
		var done = () => { this._dials.delete(id); };
		transport.once('connect', done);
		transport.once('error', done);
	}

	_bsyFrame(text) {
		var msg = Buffer.from(text);
		var frame = Buffer.alloc(2 + 1 + msg.length);
		frame.writeUInt16BE(0x8000 | (1 + msg.length), 0);
		frame[2] = 8; // M_BSY
		msg.copy(frame, 3);
		return frame;
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

		if (this._maintenance) {
			alogger.writeClog(3, 'Mailer: rejecting inbound from ' + remoteAddr + ' (maintenance mode)', 'mailer', 'yellow');
			socket.write(this._bsyFrame('Closed for maintenance, try later'));
			socket.end();
			return;
		}

		if (this._sessions.length >= appConfig.getNumber('MAILER_MAX_SESSIONS', 10)) {
			alogger.writeClog(3, 'Mailer: rejecting inbound from ' + remoteAddr + ' (max sessions)', 'mailer', 'yellow');
			socket.write(this._bsyFrame('System busy, try later'));
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

		if (this._maintenance) {
			alogger.writeClog(3, 'Mailer: rejecting inbound WS from ' + remoteAddr + ' (maintenance mode)', 'mailer', 'yellow');
			ws.send(this._bsyFrame('Closed for maintenance, try later'));
			ws.close();
			return;
		}

		// This copy used to build the frame without copying the message into
		// it, so the peer received M_BSY followed by zero bytes.
		if (this._sessions.length >= appConfig.getNumber('MAILER_MAX_SESSIONS', 10)) {
			alogger.writeClog(3, 'Mailer: rejecting inbound WS from ' + remoteAddr + ' (max sessions)', 'mailer', 'yellow');
			ws.send(this._bsyFrame('System busy, try later'));
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

		// Backoff guard: skip scheduled polls to peers that recently failed.
		// Manual triggerPoll() bypasses this -- sysop intent wins.
		if (appConfig.getBoolean('mailer_backoff_enabled', true) && peerConnections.isInBackoff(conn)) {
			alogger.writeClog(5,
				'Mailer: skipping poll for ' + (cd.address || connectionUUID) +
				' — backoff in effect until ' + cd.next_allowed_poll_at +
				' (consecutive failures: ' + (cd.consecutive_failures || 0) + ')',
				'mailer', 'yellow');
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

		// Sysop intent wins over backoff.
		this._connectToPeer(conn, { force: true });
	}

	/**
	 * Open an outbound connection to a peer.
	 *
	 * @param {object} conn  peer_connections row
	 * @param {object} opts  { force } to bypass the backoff guard, which only
	 *                       a deliberate sysop action should do
	 */
	async _connectToPeer(conn, opts) {
		var options = opts || {};
		var cd = conn.connection_data || {};

		// Every outbound route ends here or in connectToNodelistAddress, so a
		// closed board is refused at the two choke points rather than at each
		// caller. Even a forced poll: a drain that a button press can break is
		// not a drain.
		if (this._maintenance) {
			alogger.writeClog(4, 'Mailer: not connecting to ' + (cd.address || conn.uuid) + ': maintenance mode', 'mailer', 'yellow');
			return;
		}

		// The backoff guard lives here rather than at each call site. It used
		// to be checked only in pollConnection, so the BSO scanner, which calls
		// this directly whenever there is mail waiting, retried a failing peer
		// every scan interval and the configured backoff did nothing at all.
		// Putting it where every caller has to come through means a new caller
		// cannot miss it.
		if (!options.force &&
		    appConfig.getBoolean('mailer_backoff_enabled', true) &&
		    peerConnections.isInBackoff(conn)) {
			alogger.writeClog(4,
				'Mailer: not connecting to ' + (cd.address || conn.uuid) +
				' — backoff until ' + cd.next_allowed_poll_at +
				' (' + (cd.consecutive_failures || 0) + ' consecutive failures)',
				'mailer', 'yellow');
			return;
		}

		var mailerTransport = cd.mailer_transport || 'tcp';
		var host = cd.mailer_host || cd.remote_host || '';
		var port = cd.mailer_port || cd.remote_port || BINKP_PORT;

		// If no host configured, try nodelist lookup for this address
		if (!host && cd.address) {
			try {
				var ftnNodelist = (await import('../models/ftnNodelist.js'));
				var addrParts = cd.address.split(':');
				var nnParts = (addrParts[1] || '').split('/');
				var zone = parseInt(addrParts[0]);
				var net  = parseInt(nnParts[0]);
				var node = parseInt(nnParts[1] || '0');
				if (!isNaN(zone) && !isNaN(net) && !isNaN(node) && conn.network_id) {
					var nlNode = await ftnNodelist.getNode(conn.network_id, zone, net, node, 0);
					if (nlNode && nlNode.hostname) {
						host = nlNode.hostname;
						port = nlNode.binkp_port || BINKP_PORT;
						alogger.writeClog(5, 'Mailer: resolved ' + cd.address + ' via nodelist: ' + host + ':' + port, 'mailer', 'cyan');
					}
				}
			} catch (err) {
				alogger.writeClog(5, 'Mailer: nodelist lookup failed for ' + cd.address + ': ' + err.message, 'mailer', 'yellow');
			}
		}

		if (!host) {
			alogger.writeClog(4, 'Mailer: no host configured for ' + (cd.address || conn.uuid) + ' and no nodelist entry — cannot connect', 'mailer', 'yellow');
			return;
		}

		if (this._sessions.length >= appConfig.getNumber('MAILER_MAX_SESSIONS', 10)) {
			alogger.writeClog(4, 'Mailer: cannot connect to ' + cd.address + ' — max sessions reached', 'mailer', 'yellow');
			return;
		}

		alogger.writeClog(5, 'Mailer: connecting to ' + (cd.address || conn.uuid) + ' at ' + host + ':' + port, 'mailer', 'cyan');

		if (mailerTransport === 'tcp') {
			var transport = TcpTransport.connect(host, port, appConfig.getNumber('MAILER_CONNECT_TIMEOUT', 30) * 1000);
			this._trackDial(transport);
			transport.once('connect', () => {
				this._createSession(transport, 'caller', { connectionUUID: conn.uuid });
			});
			transport.once('error', (err) => {
				alogger.writeClog(3, 'Mailer: outbound connect to ' + host + ':' + port + ' failed: ' + err.message, 'mailer', 'redbright');
				this.emit('pollFailed', { connectionUUID: conn.uuid, error: err.message });
				this._recordConnectFailure(conn, host, port, 'binkp', 'tcp: ' + err.message);
				// Record failure for backoff. Pre-session failures go here;
				// post-handshake failures are recorded in the sessionEnd
				// handler below.
				peerConnections.recordConnectFailure(conn.uuid, 'tcp: ' + err.message, {
					capHours: appConfig.getNumber('mailer_backoff_max_hours', 24)
				}).catch(() => {});
			});
		} else if (mailerTransport === 'websocket') {
			var wsUrl = cd.mailer_ws_url;
			if (!wsUrl) {
				alogger.writeClog(4, 'Mailer: no mailer_ws_url for ' + (cd.address || conn.uuid) + ' — cannot connect via WebSocket', 'mailer', 'yellow');
				return;
			}

			alogger.writeClog(5, 'Mailer: connecting via WebSocket to ' + (cd.address || conn.uuid) + ' at ' + wsUrl, 'mailer', 'cyan');

			var wsTransport = WsTransport.connect(wsUrl, appConfig.getNumber('MAILER_CONNECT_TIMEOUT', 30) * 1000);
			this._trackDial(wsTransport);
			wsTransport.once('connect', () => {
				this._createSession(wsTransport, 'caller', { connectionUUID: conn.uuid });
			});
			wsTransport.once('error', (err) => {
				alogger.writeClog(3, 'Mailer: outbound WS connect to ' + wsUrl + ' failed: ' + err.message, 'mailer', 'redbright');
				this.emit('pollFailed', { connectionUUID: conn.uuid, error: err.message });
				this._recordConnectFailure(conn, wsUrl, null, 'binkp', 'ws: ' + err.message);
				peerConnections.recordConnectFailure(conn.uuid, 'ws: ' + err.message, {
					capHours: appConfig.getNumber('mailer_backoff_max_hours', 24)
				}).catch(() => {});
			});
		}
	}

	// -----------------------------------------------------------------------
	// Backoff for nodelist-routed addresses
	// -----------------------------------------------------------------------
	//
	// A peer connection carries its backoff state in connection_data. An
	// address routed purely through the nodelist has no such row, so it had no
	// backoff of any kind: a node that refused connections was retried on every
	// BSO scan, for ever, because the mail never left the outbound.
	//
	// Kept in memory rather than persisted. These are transient routes rather
	// than configured links, the session history in mailer_sessions is the
	// durable record, and starting clean after a restart is the right default
	// for a route that may only exist for one batch of mail.

	_nodelistBackoffKey(address) {
		return String(address || '').trim().toLowerCase();
	}

	_isNodelistAddressInBackoff(address) {
		if (!appConfig.getBoolean('mailer_backoff_enabled', true)) return false;
		var entry = this._nodelistBackoff.get(this._nodelistBackoffKey(address));
		if (!entry) return false;
		if (entry.nextAllowedAt > Date.now()) return true;
		return false;
	}

	_recordNodelistFailure(address) {
		var key = this._nodelistBackoffKey(address);
		if (!key) return;

		var entry = this._nodelistBackoff.get(key) || { failures: 0, nextAllowedAt: 0 };
		entry.failures++;

		// Same shape as the peer backoff: double each time from the default
		// poll interval, capped, so a dead route stops costing a connection a
		// minute without ever giving up on it entirely. MAILER_POLL_INTERVAL
		// is in seconds; the backoff helper works in minutes.
		var baseMin = Math.max(1,
			Math.round(appConfig.getNumber('MAILER_POLL_INTERVAL', 900) / 60));
		var capHours = appConfig.getNumber('mailer_backoff_max_hours', 24);
		var delayMs = peerConnections.computeBackoffDelayMs(entry.failures, baseMin, capHours);
		entry.nextAllowedAt = Date.now() + delayMs;

		this._nodelistBackoff.set(key, entry);
		alogger.writeClog(4,
			'Mailer: nodelist route ' + address + ' failure #' + entry.failures +
			' — next attempt allowed in ' + Math.round(delayMs / 60000) + ' min',
			'mailer', 'yellow');
	}

	_clearNodelistBackoff(address) {
		var key = this._nodelistBackoffKey(address);
		if (key && this._nodelistBackoff.delete(key)) {
			alogger.writeClog(4, 'Mailer: nodelist route ' + address + ' recovered', 'mailer', 'greenbright');
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

		if (this._maintenance) {
			alogger.writeClog(4, 'Mailer: not connecting to ' + destinationAddress + ': maintenance mode', 'mailer', 'yellow');
			return;
		}

		if (this._sessions.length >= appConfig.getNumber('MAILER_MAX_SESSIONS', 10)) {
			alogger.writeClog(4, 'Mailer: cannot connect to ' + destinationAddress + ' — max sessions reached', 'mailer', 'yellow');
			return;
		}

		if (this._hasSessionForAddress(destinationAddress)) {
			alogger.writeClog(5, 'Mailer: skipping nodelist connect to ' + destinationAddress + ' — session already active', 'mailer', 'cyan');
			return;
		}

		if (this._isNodelistAddressInBackoff(destinationAddress)) {
			var nb = this._nodelistBackoff.get(this._nodelistBackoffKey(destinationAddress));
			alogger.writeClog(4,
				'Mailer: skipping nodelist connect to ' + destinationAddress +
				' — backoff after ' + nb.failures + ' failure(s), next attempt ' +
				new Date(nb.nextAllowedAt).toISOString(),
				'mailer', 'yellow');
			return;
		}

		alogger.writeClog(3,
			'Mailer: nodelist connect to ' + destinationAddress +
			' (' + (nodelistData.systemName || 'unknown') + ') at ' + host + ':' + port,
			'mailer', 'cyan'
		);

		var transport = TcpTransport.connect(host, port, appConfig.getNumber('MAILER_CONNECT_TIMEOUT', 30) * 1000);
		this._trackDial(transport);
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
			this._recordNodelistFailure(destinationAddress);
			// No peer record, so this lands in the unmatched list. Worth
			// keeping: it is a route we took without a configured peer.
			mailerSessions.record({
				direction: 'out', remoteAddress: destinationAddress,
				remoteHost: host + ':' + port, protocol: 'binkp',
				outcome: mailerSessions.OUTCOME_CONNECT_FAILED,
				reason: 'nodelist: ' + err.message,
				startedAt: new Date(), endedAt: new Date(), durationSeconds: 0
			}).catch(() => {});
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

			// History row. Written for every session either way round, so the
			// peer page can answer "what happened the last five times" without
			// anyone having to keep logs.
			this._recordSessionHistory(session, info);

			// Record backoff state for outbound (caller) sessions. Inbound
			// answerer sessions don't affect our outbound poll schedule.
			if (session.role === 'caller') {
				var outConnUUID = session.options.connectionUUID
					|| (session.peerConnection ? session.peerConnection.uuid : null);
				if (outConnUUID) {
					if (info.reason === 'complete') {
						peerConnections.recordConnectSuccess(outConnUUID).catch(() => {});
					} else {
						peerConnections.recordConnectFailure(outConnUUID, 'session: ' + info.reason, {
							capHours: appConfig.getNumber('mailer_backoff_max_hours', 24)
						}).catch(() => {});
					}
				} else if (session.options.nodelistAddress) {
					// A route with no peer record behind it. Without this, a
					// nodelist-routed node that answers and then fails every
					// session is retried on every scan for ever, because the
					// mail never leaves the outbound and nothing is counting.
					if (info.reason === 'complete') {
						this._clearNodelistBackoff(session.options.nodelistAddress);
					} else {
						this._recordNodelistFailure(session.options.nodelistAddress);
					}
				}
			}

			// Notify listeners that files arrived and need tossing.
			// connectionUUID comes from caller options (outbound) or
			// peer matching during handshake (inbound).
			// Only trigger toss for files that weren't wildcard-routed with skipToss.
			var filesToToss = info.filesToToss !== undefined ? info.filesToToss : info.filesReceived;
			if (filesToToss > 0) {
				var connectionUUID = session.options.connectionUUID
					|| (session.peerConnection ? session.peerConnection.uuid : null);
				this.emit('filesReceived', {
					connectionUUID: connectionUUID,
					fileCount:      filesToToss,
					sessionUUID:    info.uuid,
				});
			}
		});

		session.start();
		this.emit('sessionStart', session.getStatus());
	}

	// -----------------------------------------------------------------------
	// Session history
	// -----------------------------------------------------------------------

	_recordSessionHistory(session, info) {
		var conn = session.peerConnection || null;
		var addresses = info.peerAddresses || [];

		// The address we file it under: the configured one if we know the
		// peer, otherwise the first AKA the far end presented. Domains are
		// stripped so a row matches how addresses are stored everywhere else.
		var cd = conn ? (conn.connection_data || {}) : {};
		var address = cd.address || (addresses[0] || '').split('@')[0] || null;

		mailerSessions.record({
			uuid:             info.uuid,
			direction:        (info.role || session.role) === 'caller' ? 'out' : 'in',
			peerId:           conn ? conn.peer_id : null,
			peerConnectionId: conn ? conn.id : null,
			networkId:        conn ? conn.network_id : null,
			remoteAddress:    address,
			remoteAddresses:  addresses,
			remoteHost:       info.remoteHost,
			protocol:         info.protocol,
			peerSoftware:     info.peerSoftware,
			peerSystem:       info.peerSystem,
			peerSysop:        info.peerSysop,
			outcome:          info.reason === 'complete' ? 'complete' : this._classifyOutcome(info.reason),
			reason:           info.reason,
			filesSent:        info.filesSent,
			filesReceived:    info.filesReceived,
			bytesSent:        info.bytesSent,
			bytesReceived:    info.bytesReceived,
			startedAt:        info.startedAt,
			endedAt:          info.endedAt,
			durationSeconds:  info.duration
		}).catch(() => {});
	}

	// Session end reasons are free text from several places. Bucketing them
	// lets the dashboard group failures without losing the original string,
	// which is kept alongside in `reason`.
	_classifyOutcome(reason) {
		var r = String(reason || '').toLowerCase();
		if (r.indexOf('timeout') !== -1 || r.indexOf('timed out') !== -1) return 'timeout';
		if (r.indexOf('auth') !== -1 || r.indexOf('password') !== -1) return 'auth_failed';
		if (r.indexOf('busy') !== -1) return 'busy';
		return 'error';
	}

	// A connect that never became a session. These matter most: the peer that
	// is failing hardest is the one that never gets far enough to have a
	// session at all, and recording only completed handshakes would leave it
	// looking like the quietest node on the board.
	_recordConnectFailure(conn, host, port, protocol, message) {
		var cd = conn ? (conn.connection_data || {}) : {};
		mailerSessions.record({
			uuid:             null,
			direction:        'out',
			peerId:           conn ? conn.peer_id : null,
			peerConnectionId: conn ? conn.id : null,
			networkId:        conn ? conn.network_id : null,
			remoteAddress:    cd.address || null,
			remoteAddresses:  [],
			remoteHost:       host ? (host + (port ? ':' + port : '')) : null,
			protocol:         protocol || 'binkp',
			outcome:          mailerSessions.OUTCOME_CONNECT_FAILED,
			reason:           message,
			startedAt:        new Date(),
			endedAt:          new Date(),
			durationSeconds:  0
		}).catch(() => {});
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
			// Check all grouped connections (multi-address sessions)
			if (session.peerConnections && session.peerConnections.length > 0) {
				for (var conn of session.peerConnections) {
					var cd = conn.connection_data || {};
					if (cd.address && cd.address.split('@')[0].toLowerCase() === bareAddr) {
						return true;
					}
				}
			} else if (session.peerConnection) {
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
		return outboundDirForZone(zone);
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
