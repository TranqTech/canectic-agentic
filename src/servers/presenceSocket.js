// presenceSocket.js - WebSocket presence/heartbeat server + real-time chat.
//
// Lightweight WebSocket endpoint for web client presence tracking.
// Clients connect with their session cookie, server validates and
// tracks them as "online". Heartbeat interval keeps presence alive.
//
// Chat: sysop-to-web-user chat (and future user-to-user IMs) routed
// through this same socket. Chat sessions persisted in Redis so they
// survive page navigations and brief reconnects.

import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as redis from '../middleware/db/redis.js';
import * as sessionStore from '../middleware/db/sessionstore.js';
import { markOnline, markOffline, setActivity } from '../middleware/webActivity.js';
import appConfig from '../config/appConfig.js';
import * as alogger from '../utils/alogger.js';

var HEARTBEAT_INTERVAL = 60000; // expect client heartbeat every 60s
var CHECK_INTERVAL = 30000;     // check for dead connections every 30s
var CHAT_TTL = 3600;            // Redis TTL for chat sessions (1 hour safety net)
var CHAT_PREFIX = 'chat:';
var CHAT_USER_PREFIX = 'chat:user:';

class PresenceServer {
	constructor() {
		this.wss = null;
		this.clients = new Map();      // ws -> { userId, username, alive, sessionid }
		this.userSockets = new Map();  // userId -> Set<ws>
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

		// Check sysop status for notification routing
		var isSysop = false;
		var perms = Array.isArray(session.permissionflags) ? session.permissionflags : [];
		var security = parseInt(session.security) || 0;
		if (security >= appConfig.getNumber('adminsecurity', 200) && perms.includes('Sysop')) {
			isSysop = true;
		}

		this.clients.set(ws, {
			userId: userId,
			username: username,
			alive: true,
			sessionid: sessionid,
			_isSysop: isSysop
		});

		// Add to reverse index
		if (!this.userSockets.has(userId)) {
			this.userSockets.set(userId, new Set());
		}
		this.userSockets.get(userId).add(ws);

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

		// Send unread notification count + recent notifications to populate dropdown
		this._sendNotificationCount(ws, userId, isSysop, true);

		// Check for active chat session to restore
		this._restoreChat(ws, userId);
	}

	async _onMessage(ws, data) {
		var client = this.clients.get(ws);
		if (!client) return;

		client.alive = true;

		var msg;
		try {
			msg = JSON.parse(data.toString());
		} catch (_) {
			// Non-JSON heartbeat (plain ping)
			markOnline(client.userId, client.username);
			return;
		}

		try {
			switch (msg.type) {
				case 'heartbeat': {
					// Validate session still exists (catches mid-session expiry)
					var hbSession = await sessionStore.sessionGet(client.sessionid);
					if (!hbSession || !hbSession.id) {
						ws.close(4001, 'Session expired');
						return;
					}
					markOnline(client.userId, client.username);
					ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
					break;
				}

				case 'chat_initiate':
					await this._handleChatInitiate(ws, client, msg);
					break;

				case 'chat_msg':
					await this._handleChatMsg(ws, client, msg);
					break;

				case 'chat_typing':
					this._handleChatTyping(ws, client, msg);
					break;

				case 'chat_end':
					await this._handleChatEnd(ws, client, msg);
					break;

				case 'notification_read':
					await this._handleNotificationRead(ws, client, msg);
					break;

				case 'notification_read_all':
					await this._handleNotificationReadAll(ws, client);
					break;
			}
		} catch (err) {
			alogger.writeAlog(3, 'PresenceSocket message handler error: ' + err.message, 'redbright');
			this._sendJson(ws, { type: 'chat_error', error: 'Server error' });
		}
	}

	async _onClose(ws) {
		var client = this.clients.get(ws);
		if (client) {
			// Remove from reverse index
			var sockets = this.userSockets.get(client.userId);
			if (sockets) {
				sockets.delete(ws);
				if (sockets.size === 0) {
					this.userSockets.delete(client.userId);
				}
			}

			// Only mark offline if this was the last socket for this user
			if (!this.userSockets.has(client.userId)) {
				await markOffline(client.userId);
			}

			this.clients.delete(ws);
			alogger.writeAlog(5, 'Presence: ' + client.username + ' disconnected (' + this.clients.size + ' web clients)', 'cyan');
		}
	}

	_pruneDeadConnections() {
		for (var [ws, client] of this.clients) {
			if (!client.alive) {
				// Allow 5 missed cycles (~2.5 min) before terminating.
				// Keeps presence stable across tab switches and brief backgrounding.
				if (client._missedChecks >= 5) {
					ws.terminate();
					continue;
				}
				client._missedChecks = (client._missedChecks || 0) + 1;
				continue;
			}
			client.alive = false;
			client._missedChecks = 0;
		}
	}

	// -----------------------------------------------------------------------
	// Chat: initiate
	// -----------------------------------------------------------------------

	async _handleChatInitiate(ws, client, msg) {
		// mode: 'sysop' (default, requires admin) or 'telegram' (any user)
		var mode = (msg.mode === 'telegram') ? 'telegram' : 'sysop';

		alogger.writeAlog(3, 'WebChat: chat_initiate (' + mode + ') from ' + client.username + ' (userId=' + client.userId + ') targeting userId=' + msg.targetUserId, 'cyan');

		if (!appConfig.getBoolean('web_chat_enabled', true)) {
			this._sendJson(ws, { type: 'chat_error', error: 'Chat is disabled' });
			return;
		}

		// Permission check: sysop mode requires admin, telegram mode requires authentication (already guaranteed by socket)
		if (mode === 'sysop') {
			var session = await sessionStore.sessionGet(client.sessionid);
			if (!this._checkSysopAccess(session)) {
				alogger.writeAlog(3, 'WebChat: permission denied for ' + client.username + ' (security=' + (session && session.security) + ')', 'yellow');
				this._sendJson(ws, { type: 'chat_error', error: 'Insufficient permissions' });
				return;
			}
		}

		var targetUserId = parseInt(msg.targetUserId);
		if (!targetUserId || targetUserId === client.userId) {
			this._sendJson(ws, { type: 'chat_error', error: 'Invalid target' });
			return;
		}

		// Check target is online (has at least one socket)
		var targetSockets = this.userSockets.get(targetUserId);
		if (!targetSockets || targetSockets.size === 0) {
			alogger.writeAlog(3, 'WebChat: target userId=' + targetUserId + ' has no active sockets (userSockets keys: ' + Array.from(this.userSockets.keys()).join(',') + ')', 'yellow');
			this._sendJson(ws, { type: 'chat_error', error: 'User is not online' });
			return;
		}

		// Check if either party already has an active chat
		var rc = await redis.getClient();
		var existingInitiator = await rc.get(CHAT_USER_PREFIX + client.userId);
		if (existingInitiator) {
			this._sendJson(ws, { type: 'chat_error', error: 'You already have an active chat' });
			return;
		}
		var existingTarget = await rc.get(CHAT_USER_PREFIX + targetUserId);
		if (existingTarget) {
			this._sendJson(ws, { type: 'chat_error', error: 'User is already in a chat' });
			return;
		}

		// Resolve target username
		var targetUsername = null;
		for (var [, c] of this.clients) {
			if (c.userId === targetUserId) {
				targetUsername = c.username;
				break;
			}
		}
		if (!targetUsername) targetUsername = 'User';

		// Create chat session in Redis
		var chatId = uuidv4();
		var chatData = {
			chatId: chatId,
			initiatorUserId: client.userId,
			initiatorName: client.username,
			targetUserId: targetUserId,
			targetName: targetUsername,
			mode: mode,
			startedAt: Date.now()
		};

		await rc.set(CHAT_PREFIX + chatId, JSON.stringify(chatData), { EX: CHAT_TTL });
		await rc.set(CHAT_USER_PREFIX + client.userId, chatId, { EX: CHAT_TTL });
		await rc.set(CHAT_USER_PREFIX + targetUserId, chatId, { EX: CHAT_TTL });

		// Initialize empty message list
		await rc.del(CHAT_PREFIX + chatId + ':msgs');

		// Update activity
		var activityLabel = (mode === 'sysop') ? 'Sysop Chat' : 'Chatting';
		await setActivity(targetUserId, activityLabel);
		await setActivity(client.userId, activityLabel);

		alogger.writeAlog(2, 'WebChat: ' + client.username + ' started ' + mode + ' chat with ' + targetUsername, 'cyanbright');

		// Set chat peer references for typing routing
		this._setChatPeer(client.userId, targetUserId);
		this._setChatPeer(targetUserId, client.userId);

		// Notify initiator
		this._sendJson(ws, { type: 'chat_start', chatId: chatId, targetName: targetUsername, mode: mode });

		// Notify target
		this._sendToUser(targetUserId, { type: 'chat_start', chatId: chatId, peerName: client.username, mode: mode });
	}

	// -----------------------------------------------------------------------
	// Chat: message
	// -----------------------------------------------------------------------

	async _handleChatMsg(ws, client, msg) {
		var text = (msg.text || '').substring(0, 500).trim();
		if (!text) return;

		var chatId = msg.chatId;
		if (!chatId) return;

		var rc = await redis.getClient();
		var chatRaw = await rc.get(CHAT_PREFIX + chatId);
		if (!chatRaw) return;

		var chat = JSON.parse(chatRaw);

		// Verify sender is a participant
		var isInitiator = (client.userId === chat.initiatorUserId);
		var isTarget = (client.userId === chat.targetUserId);
		if (!isInitiator && !isTarget) return;

		var from = isInitiator ? 'initiator' : 'target';
		var name = isInitiator ? chat.initiatorName : chat.targetName;

		// Store message in Redis
		var msgObj = { from: from, name: name, text: text, ts: Date.now() };
		await rc.rPush(CHAT_PREFIX + chatId + ':msgs', JSON.stringify(msgObj));
		await rc.expire(CHAT_PREFIX + chatId + ':msgs', CHAT_TTL);
		await rc.expire(CHAT_PREFIX + chatId, CHAT_TTL);
		await rc.expire(CHAT_USER_PREFIX + chat.initiatorUserId, CHAT_TTL);
		await rc.expire(CHAT_USER_PREFIX + chat.targetUserId, CHAT_TTL);

		// Send to the other party (all their sockets)
		var peerUserId = isInitiator ? chat.targetUserId : chat.initiatorUserId;
		this._sendToUser(peerUserId, { type: 'chat_msg', chatId: chatId, from: from, name: name, text: text });

		// Echo back to sender (for other tabs)
		this._sendToUser(client.userId, { type: 'chat_msg', chatId: chatId, from: from, name: name, text: text }, ws);
	}

	// -----------------------------------------------------------------------
	// Chat: typing indicator
	// -----------------------------------------------------------------------

	_handleChatTyping(ws, client, msg) {
		var chatId = msg.chatId;
		if (!chatId) return;

		// Find the chat in-memory by checking the user's active chat
		// (Don't hit Redis for every keystroke -- just route to peer sockets)
		var text = (msg.text || '').substring(0, 200);

		// We need the peer userId. Quick lookup: check all clients for the chatId.
		// Since we can't avoid some lookup, use Redis sparingly.
		// Strategy: the client-side JS knows the peer, so we trust chatId routing.
		// But we need the peer userId. Store it on the client map during chat_start.
		var chatPeer = client._chatPeer;
		if (chatPeer) {
			this._sendToUser(chatPeer, { type: 'chat_typing', chatId: chatId, text: text });
		}
	}

	// -----------------------------------------------------------------------
	// Chat: end
	// -----------------------------------------------------------------------

	async _handleChatEnd(ws, client, msg) {
		var chatId = msg.chatId;
		if (!chatId) {
			// Try to find active chat for this user
			var rc = await redis.getClient();
			chatId = await rc.get(CHAT_USER_PREFIX + client.userId);
		}
		if (!chatId) return;

		await this._teardownChat(chatId, client.username + ' ended chat');
	}

	// -----------------------------------------------------------------------
	// Chat: restore on reconnect
	// -----------------------------------------------------------------------

	async _restoreChat(ws, userId) {
		try {
			var rc = await redis.getClient();
			var chatId = await rc.get(CHAT_USER_PREFIX + userId);
			if (!chatId) return;

			var chatRaw = await rc.get(CHAT_PREFIX + chatId);
			if (!chatRaw) {
				// Orphaned user key -- clean up
				await rc.del(CHAT_USER_PREFIX + userId);
				return;
			}

			var chat = JSON.parse(chatRaw);

			// Load message history
			var msgsRaw = await rc.lRange(CHAT_PREFIX + chatId + ':msgs', 0, -1);
			var messages = [];
			for (var raw of (msgsRaw || [])) {
				try { messages.push(JSON.parse(raw)); } catch (_) {}
			}

			// Determine peer name and role based on which side we are
			var isInitiator = (userId === chat.initiatorUserId);
			var peerName = isInitiator ? chat.targetName : chat.initiatorName;
			var role = isInitiator ? 'initiator' : 'target';

			// Store peer reference for typing routing
			var client = this.clients.get(ws);
			if (client) {
				client._chatPeer = isInitiator ? chat.targetUserId : chat.initiatorUserId;
			}

			this._sendJson(ws, {
				type: 'chat_restore',
				chatId: chatId,
				peerName: peerName,
				role: role,
				mode: chat.mode || 'sysop',
				messages: messages
			});
		} catch (err) {
			alogger.writeAlog(4, 'Chat restore error for user ' + userId + ': ' + err.message, 'yellow');
		}
	}

	// -----------------------------------------------------------------------
	// Chat: teardown
	// -----------------------------------------------------------------------

	async _teardownChat(chatId, reason) {
		try {
			var rc = await redis.getClient();
			var chatRaw = await rc.get(CHAT_PREFIX + chatId);
			if (!chatRaw) return;

			var chat = JSON.parse(chatRaw);

			// Notify both parties
			var endMsg = { type: 'chat_end', chatId: chatId, reason: reason || 'Chat ended' };
			this._sendToUser(chat.initiatorUserId, endMsg);
			this._sendToUser(chat.targetUserId, endMsg);

			// Clear peer references
			this._clearChatPeer(chat.initiatorUserId);
			this._clearChatPeer(chat.targetUserId);

			// Clear activity
			await setActivity(chat.initiatorUserId, null);
			await setActivity(chat.targetUserId, null);

			// Remove Redis keys
			await rc.del(CHAT_PREFIX + chatId);
			await rc.del(CHAT_PREFIX + chatId + ':msgs');
			await rc.del(CHAT_USER_PREFIX + chat.initiatorUserId);
			await rc.del(CHAT_USER_PREFIX + chat.targetUserId);

			alogger.writeAlog(2, 'WebChat: ended between ' + chat.initiatorName + ' and ' + chat.targetName + ' (' + reason + ')', 'cyan');
		} catch (err) {
			alogger.writeAlog(3, 'Chat teardown error: ' + err.message, 'redbright');
		}
	}

	// -----------------------------------------------------------------------
	// -----------------------------------------------------------------------
	// Notifications
	// -----------------------------------------------------------------------

	async _sendNotificationCount(ws, userId, isSysop, includeRecent) {
		try {
			var notifMod = await import('../models/notifications.js');
			var count = await notifMod.getUnreadCount(userId, isSysop);
			this._sendJson(ws, { type: 'notification_count', count: count });

			// On connect, also send recent unread notifications to populate the
			// dropdown. Each replay item carries `initial: true` so the client
			// renders it into the dropdown WITHOUT incrementing the badge --
			// the authoritative count was already set by the notification_count
			// message above. Without this flag the badge ends up at 2x the
			// real count (one from notification_count, one increment per replay).
			if (includeRecent && count > 0) {
				var recent = await notifMod.getUnread(userId, isSysop, 10);
				for (var n of recent) {
					this._sendJson(ws, {
						type: 'notification',
						id: n.id,
						notifType: n.type,
						title: n.title,
						body: n.body,
						link: n.link,
						icon: n.icon,
						severity: n.severity,
						initial: true
					});
				}
			}
		} catch (_) {}
	}

	async _handleNotificationRead(ws, client, msg) {
		try {
			var notifMod = await import('../models/notifications.js');
			await notifMod.markRead(parseInt(msg.id), client.userId);
			// Send updated count
			await this._sendNotificationCount(ws, client.userId, client._isSysop);
		} catch (_) {}
	}

	async _handleNotificationReadAll(ws, client) {
		try {
			var notifMod = await import('../models/notifications.js');
			await notifMod.markAllRead(client.userId, client._isSysop);
			this._sendJson(ws, { type: 'notification_count', count: 0 });
		} catch (_) {}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	_checkSysopAccess(session) {
		if (!session) return false;
		var security = parseInt(session.security) || 0;
		if (security < appConfig.getNumber('adminsecurity', 200)) return false;
		var perms = Array.isArray(session.permissionflags) ? session.permissionflags : [];
		return perms.includes('Sysop');
	}

	_sendJson(ws, obj) {
		if (ws.readyState === 1) {
			ws.send(JSON.stringify(obj));
		}
	}

	// Send a message to all sockets for a given userId.
	// If excludeWs is provided, skip that socket (avoid double-echo to sender).
	_sendToUser(userId, obj, excludeWs) {
		var sockets = this.userSockets.get(userId);
		if (!sockets) return;
		var json = JSON.stringify(obj);
		for (var ws of sockets) {
			if (ws === excludeWs) continue;
			if (ws.readyState === 1) {
				ws.send(json);
			}
		}
	}

	_clearChatPeer(userId) {
		var sockets = this.userSockets.get(userId);
		if (!sockets) return;
		for (var ws of sockets) {
			var client = this.clients.get(ws);
			if (client) delete client._chatPeer;
		}
	}

	// Store chat peer reference on all sockets for a user (for typing routing).
	_setChatPeer(userId, peerUserId) {
		var sockets = this.userSockets.get(userId);
		if (!sockets) return;
		for (var ws of sockets) {
			var client = this.clients.get(ws);
			if (client) client._chatPeer = peerUserId;
		}
	}

	getOnlineCount() {
		return this.clients.size;
	}

	/** Send to every open page, whoever is logged in on it. */
	broadcast(obj) {
		var json = JSON.stringify(obj);
		for (var [ws] of this.clients) {
			if (ws.readyState === 1) ws.send(json);
		}
	}

	/** Users with at least one page open right now. */
	connectedUserIds() {
		return Array.from(this.userSockets.keys());
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
		this.userSockets.clear();
		if (this.wss) {
			this.wss.close();
		}
	}
}

export { PresenceServer };
