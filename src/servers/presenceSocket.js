// presenceSocket.js - WebSocket presence/heartbeat server.
//
// Lightweight WebSocket endpoint for web client presence tracking.
// Clients connect with their session cookie, server validates and
// tracks them as "online". Heartbeat interval keeps presence alive.
// Future: user-to-user instant messaging via this channel.

import { WebSocketServer } from 'ws';
import * as sessionStore from '../middleware/db/sessionstore.js';
import { markOnline, markOffline } from '../middleware/webActivity.js';
import * as alogger from '../utils/alogger.js';
import cookie from 'cookie-parser';

var HEARTBEAT_INTERVAL = 60000; // expect client heartbeat every 60s
var CHECK_INTERVAL = 30000;     // check for dead connections every 30s

class PresenceServer {
	constructor() {
		this.wss = null;
		this.clients = new Map(); // ws -> { userId, username, alive }
		this._checkTimer = null;
	}

	// Attach to the HTTP server's upgrade path via WsManager or directly
	init(httpServer) {
		this.wss = new WebSocketServer({ noServer: true });

		this.wss.on('connection', (ws, req) => {
			this._onConnection(ws, req);
		});

		// Periodic dead connection cleanup
		this._checkTimer = setInterval(() => {
			this._pruneDeadConnections();
		}, CHECK_INTERVAL);
	}

	// Called by WsManager or HTTP upgrade handler
	handleUpgrade(request, socket, head) {
		this.wss.handleUpgrade(request, socket, head, (ws) => {
			this.wss.emit('connection', ws, request);
		});
	}

	async _onConnection(ws, req) {
		// Parse session cookie from the upgrade request
		var sessionid = null;
		if (req.headers.cookie) {
			var cookies = {};
			req.headers.cookie.split(';').forEach(function(c) {
				var parts = c.trim().split('=');
				if (parts.length === 2) cookies[parts[0]] = parts[1];
			});
			sessionid = cookies.sessionid;
		}

		if (!sessionid) {
			ws.close(4001, 'No session');
			return;
		}

		var session = await sessionStore.sessionGet(sessionid);
		if (!session || !session.id) {
			ws.close(4001, 'Invalid session');
			return;
		}

		var userId = parseInt(session.id);
		var username = session.username || 'Unknown';

		this.clients.set(ws, {
			userId: userId,
			username: username,
			alive: true,
			sessionid: sessionid
		});

		// Mark online immediately
		await markOnline(userId, username);

		alogger.writeAlog(5, 'Presence: ' + username + ' connected (' + this.clients.size + ' web clients)', 'cyan');

		ws.on('message', (data) => {
			this._onMessage(ws, data);
		});

		ws.on('close', () => {
			this._onClose(ws);
		});

		ws.on('error', () => {
			this._onClose(ws);
		});

		// Send initial state
		ws.send(JSON.stringify({ type: 'connected', username: username }));
	}

	_onMessage(ws, data) {
		var client = this.clients.get(ws);
		if (!client) return;

		client.alive = true;

		try {
			var msg = JSON.parse(data.toString());
			switch (msg.type) {
				case 'heartbeat':
					// Refresh presence
					markOnline(client.userId, client.username);
					ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
					break;
				// Future: instant message handling
				// case 'im':
				//   break;
			}
		} catch (_) {
			// Non-JSON heartbeat (plain ping)
			markOnline(client.userId, client.username);
		}
	}

	async _onClose(ws) {
		var client = this.clients.get(ws);
		if (client) {
			await markOffline(client.userId);
			this.clients.delete(ws);
			alogger.writeAlog(5, 'Presence: ' + client.username + ' disconnected (' + this.clients.size + ' web clients)', 'cyan');
		}
	}

	_pruneDeadConnections() {
		for (var [ws, client] of this.clients) {
			if (!client.alive) {
				ws.terminate();
				this.clients.delete(ws);
				markOffline(client.userId);
				continue;
			}
			client.alive = false;
		}
	}

	getOnlineCount() {
		return this.clients.size;
	}

	shutdown() {
		if (this._checkTimer) {
			clearInterval(this._checkTimer);
			this._checkTimer = null;
		}
		for (var [ws, client] of this.clients) {
			markOffline(client.userId);
			ws.close();
		}
		this.clients.clear();
		if (this.wss) {
			this.wss.close();
		}
	}
}

export { PresenceServer };
