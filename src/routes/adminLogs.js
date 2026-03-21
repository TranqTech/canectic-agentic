// src/routes/adminLogs.js — Admin log viewer API and WebSocket bridge.
//
// Provides (mounted at /adminlogs):
//   GET /adminlogs                  — log viewer page (pug view)
//   GET /adminlogs/history/:process — JSON history from Redis sorted sets
//   GET /adminlogs/history          — JSON history for all processes
//   WebSocket at /ws/adminlogs      — real-time log stream via alog:stream pub/sub
//
// The WebSocket bridge subscribes to the alog:stream Redis channel and
// forwards entries to connected admin clients.  Filtering by process and
// level is done client-side for instant responsiveness.

import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import * as redis from '../middleware/db/redis.js';
import * as alogger from '../utils/alogger.js';
import * as sessionStore from '../middleware/db/sessionstore.js';
import * as privateMessages from '../models/privateMessages.js';
import appConfig from "../config/appConfig.js";

const router = express.Router();
router.use(cookieParser());

const VALID_PROCESSES = ['gateway', 'worker', 'mailer'];

// ---------------------------------------------------------------------------
// Shared middleware — inject common locals (same pattern as admin.js)
// ---------------------------------------------------------------------------

router.use(async function(req, res, next) {
	res.locals.boardname    = appConfig.get('boardname', 'BBS Admin');
	res.locals.faviconlink  = appConfig.get('faviconlink', '/images/favicon.ico');
	res.locals.currentPath  = '/adminlogs' + req.path;
	res.locals.activelink   = 'logs';
	if (req.cookies.sessionid) {
		await sessionStore.sessionRenew(req.cookies.sessionid);
		var pmSession = await sessionStore.sessionGet(req.cookies.sessionid);
		if (pmSession) {
			var pmUid = parseInt(pmSession.id);
			if (pmUid && pmUid > 0) {
				res.locals.pmUnreadCount = await privateMessages.getUnreadCount(pmUid);
			}
		}
	}
	next();
});

// ---------------------------------------------------------------------------
// Helpers (same as admin.js)
// ---------------------------------------------------------------------------

async function getCurrentUser(req) {
	return await sessionStore.sessionGet(req.cookies.sessionid) || null;
}

function checkAdminAccess(user) {
	if (!user) return false;
	var security = parseInt(user.security) || 0;
	if (security < appConfig.getNumber('adminsecurity', 200)) return false;
	var perms = Array.isArray(user.permissionflags) ? user.permissionflags : [];
	return perms.includes('Sysop');
}

async function requireAdmin(req, res, next) {
	var currentuser      = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	if (sufficientAccess) return next();
	alogger.writeAlog(3, "Unauthorized admin log access attempt: " + req.path + " by " + (currentuser ? currentuser.username : 'unauthenticated'), "redbright");
	return res.status(403).json({ error: 'Unauthorized' });
}

// ---------------------------------------------------------------------------
// GET / (mounted as /adminlogs) — log viewer page
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
	var currentuser = await getCurrentUser(req);
	var sufficientAccess = checkAdminAccess(currentuser);
	res.render('admin/logs/index', {
		sufficientAccess: sufficientAccess,
		title: 'System Logs',
		activelink: 'logs',
		currentuser: currentuser,
		sessionId: req.cookies ? req.cookies.sessionid || '' : ''
	});
});

// ---------------------------------------------------------------------------
// GET /history/:process — JSON history for a single process
// ---------------------------------------------------------------------------

router.get('/history/:process', requireAdmin, async (req, res) => {
	var proc = req.params.process.toLowerCase();
	if (!VALID_PROCESSES.includes(proc)) {
		return res.status(400).json({ error: 'Invalid process name. Valid: ' + VALID_PROCESSES.join(', ') });
	}

	var retentionMs = appConfig.getNumber('LOG_BUS_RETENTION_HOURS', 8) * 60 * 60 * 1000;
	var since = parseInt(req.query.since) || (Date.now() - retentionMs);
	var limit = Math.min(parseInt(req.query.limit) || 500, 2000);

	try {
		var rc = await redis.getClient();
		var key = alogger.HISTORY_PREFIX + proc;

		// Query newest entries first (REV), then reverse to chronological order.
		// Without REV, LIMIT would return the oldest N and cut off recent entries.
		var entries = await rc.zRange(key, '+inf', since, {
			BY: 'SCORE', REV: true, LIMIT: { offset: 0, count: limit }
		});

		var parsed = [];
		for (var i = entries.length - 1; i >= 0; i--) {
			try {
				parsed.push(JSON.parse(entries[i]));
			} catch (_) {}
		}

		res.json({
			process: proc,
			since: since,
			count: parsed.length,
			entries: parsed
		});
	} catch (err) {
		res.status(500).json({ error: 'Failed to read log history: ' + err.message });
	}
});

// ---------------------------------------------------------------------------
// GET /history — JSON history for ALL processes (initial page load)
// ---------------------------------------------------------------------------

router.get('/history', requireAdmin, async (req, res) => {
	var retentionMs = appConfig.getNumber('LOG_BUS_RETENTION_HOURS', 8) * 60 * 60 * 1000;
	var since = parseInt(req.query.since) || (Date.now() - retentionMs);
	var limit = Math.min(parseInt(req.query.limit) || 500, 2000);

	try {
		var rc = await redis.getClient();
		var result = {};

		for (var proc of VALID_PROCESSES) {
			var key = alogger.HISTORY_PREFIX + proc;
			// Newest first (REV), then reverse to chronological order
			var entries = await rc.zRange(key, '+inf', since, {
				BY: 'SCORE', REV: true, LIMIT: { offset: 0, count: limit }
			});

			result[proc] = [];
			for (var i = entries.length - 1; i >= 0; i--) {
				try {
					result[proc].push(JSON.parse(entries[i]));
				} catch (_) {}
			}
		}

		res.json({
			since: since,
			processes: result
		});
	} catch (err) {
		res.status(500).json({ error: 'Failed to read log history: ' + err.message });
	}
});

// ---------------------------------------------------------------------------
// WebSocket bridge
//
// Call registerLogWebSocket(wsManager) from gateway startup to register
// the /ws/adminlogs path.
//
// IMPORTANT: This does NOT use WsPool/WsConnection — those are designed
// for terminal connections and will close sockets that don't have a
// CallPool.  Instead we create a raw WebSocketServer and register a
// lightweight adapter on the WsManager's pathMap, which only needs a
// handleUpgrade(request, socket, head) method.
//
// Auth: the client sends { type: 'auth', sessionId: '...' } within 5
// seconds of connecting.  The session is validated against sessionStore
// using the same checkAdminAccess() check as HTTP routes.
// ---------------------------------------------------------------------------

var _logSubscriber = null;
var _logWss = null;          // raw WebSocketServer (noServer mode)
var _logClients = new Set(); // authenticated WebSocket clients

async function registerLogWebSocket(wsManager) {
	// Create a raw WebSocketServer — no WsPool, no WsConnection
	_logWss = new WebSocketServer({ noServer: true });

	// Register on WsManager's pathMap as a lightweight adapter.
	// The WsManager upgrade handler calls pool.handleUpgrade() —
	// our adapter does the same thing but skips WsConnection creation.
	wsManager.pathMap.set('/ws/adminlogs', {
		handleUpgrade(request, socket, head) {
			_logWss.handleUpgrade(request, socket, head, (ws) => {
				_logWss.emit('connection', ws, request);
			});
		}
	});

	// Handle new connections — require auth before streaming
	_logWss.on('connection', (ws) => {
		ws._logAuthed = false;

		var authTimer = setTimeout(() => {
			if (!ws._logAuthed) {
				ws.close(4001, 'Authentication timeout');
			}
		}, 5000);

		ws.on('message', async (data) => {
			try {
				var msg = JSON.parse(data.toString());

				if (msg.type === 'auth' && msg.sessionId) {
					var session = await sessionStore.sessionGet(msg.sessionId);
					if (checkAdminAccess(session)) {
						ws._logAuthed = true;
						clearTimeout(authTimer);
						_logClients.add(ws);
						ws.send(JSON.stringify({ type: 'auth', status: 'ok' }));
					} else {
						ws.close(4003, 'Insufficient permissions');
					}
				}
			} catch (_) {}
		});

		ws.on('close', () => {
			clearTimeout(authTimer);
			_logClients.delete(ws);
		});

		ws.on('error', () => {
			_logClients.delete(ws);
		});
	});

	// Subscribe to the alog:stream Redis channel
	try {
		var subscriberClient = await redis.getClient();

		// The redis npm package needs a duplicate client for subscribe mode
		_logSubscriber = subscriberClient.duplicate();
		await _logSubscriber.connect();

		await _logSubscriber.subscribe(alogger.LOG_CHANNEL, (payload) => {
			for (var ws of _logClients) {
				try {
					ws.send(payload);
				} catch (_) {
					_logClients.delete(ws);
				}
			}
		});

		alogger.writeAlog(2, "  Admin log WebSocket bridge started at /ws/adminlogs", "cyan");
	} catch (err) {
		alogger.writeAlog(2, "  Admin log WebSocket bridge failed: " + err.message, "redbright");
	}
}

function shutdownLogWebSocket() {
	if (_logSubscriber) {
		try {
			_logSubscriber.unsubscribe(alogger.LOG_CHANNEL);
			_logSubscriber.disconnect();
		} catch (_) {}
		_logSubscriber = null;
	}
	// Close all connected clients
	for (var ws of _logClients) {
		try { ws.close(1001, 'Server shutting down'); } catch (_) {}
	}
	_logClients.clear();
}

export { router, registerLogWebSocket, shutdownLogWebSocket };
