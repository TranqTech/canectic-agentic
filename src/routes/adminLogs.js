// src/routes/adminLogs.js — Admin log viewer API and WebSocket bridge.
//
// Provides (mounted at /adminlogs):
//   GET /adminlogs/history/:process — JSON history from Redis sorted sets
//   GET /adminlogs/history          — JSON history for all processes
//   WebSocket at /ws/adminlogs      — real-time log stream via alog:stream pub/sub
//
// The WebSocket bridge subscribes to the alog:stream Redis channel and
// forwards entries to connected admin clients.  Filtering by process and
// level is done client-side for instant responsiveness.

import express from 'express';
import * as redis from '../middleware/db/redis.js';
import * as alogger from '../utils/alogger.js';
import * as sessionStore from '../middleware/db/sessionstore.js';

const router = express.Router();

const VALID_PROCESSES = ['gateway', 'worker', 'mailer'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCurrentUser(req) {
	if (!req.cookies || !req.cookies.sessionId) return null;
	return await sessionStore.sessionGet(req.cookies.sessionId);
}

function requireAdmin(req, res, next) {
	getCurrentUser(req).then(user => {
		var adminSecurity = parseInt(process.env.adminsecurity) || 200;
		if (!user || (parseInt(user.security) || 0) < adminSecurity) {
			return res.status(403).json({ error: 'Unauthorized' });
		}
		next();
	}).catch(() => res.status(403).json({ error: 'Unauthorized' }));
}

// ---------------------------------------------------------------------------
// GET /adminlogs/history/:process
//
// Returns JSON array of log entries from the Redis sorted set.
// Query params:
//   since  — epoch ms timestamp, return entries after this (default: 8h ago)
//   limit  — max entries to return (default: 500)
// ---------------------------------------------------------------------------

router.get('/history/:process', requireAdmin, async (req, res) => {
	var proc = req.params.process.toLowerCase();
	if (!VALID_PROCESSES.includes(proc)) {
		return res.status(400).json({ error: 'Invalid process name. Valid: ' + VALID_PROCESSES.join(', ') });
	}

	var retentionMs = (parseInt(process.env.LOG_BUS_RETENTION_HOURS) || 8) * 60 * 60 * 1000;
	var since = parseInt(req.query.since) || (Date.now() - retentionMs);
	var limit = Math.min(parseInt(req.query.limit) || 500, 2000);

	try {
		var rc = await redis.getClient();
		var key = alogger.HISTORY_PREFIX + proc;

		// ZRANGEBYSCORE with score range, limited
		var entries = await rc.zRangeByScore(key, since, '+inf', {
			LIMIT: { offset: 0, count: limit }
		});

		var parsed = [];
		for (var entry of entries) {
			try {
				parsed.push(JSON.parse(entry));
			} catch (_) {
				// skip malformed entries
			}
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
// GET /adminlogs/history
//
// Returns history for ALL processes in one call (for initial page load).
// ---------------------------------------------------------------------------

router.get('/history', requireAdmin, async (req, res) => {
	var retentionMs = (parseInt(process.env.LOG_BUS_RETENTION_HOURS) || 8) * 60 * 60 * 1000;
	var since = parseInt(req.query.since) || (Date.now() - retentionMs);
	var limit = Math.min(parseInt(req.query.limit) || 500, 2000);

	try {
		var rc = await redis.getClient();
		var result = {};

		for (var proc of VALID_PROCESSES) {
			var key = alogger.HISTORY_PREFIX + proc;
			var entries = await rc.zRangeByScore(key, since, '+inf', {
				LIMIT: { offset: 0, count: limit }
			});

			result[proc] = [];
			for (var entry of entries) {
				try {
					result[proc].push(JSON.parse(entry));
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
// WebSocket bridge setup
//
// Call registerLogWebSocket(wsManager) from gateway startup to register
// the /ws/adminlogs pool.  Admin clients connect here for real-time
// log streaming.
//
// Auth: the client must send a { type: 'auth', sessionId: '...' } message
// within 5 seconds of connecting.  The session is validated against
// sessionStore.  Unauthenticated connections are closed.
// ---------------------------------------------------------------------------

var _logSubscriber = null;
var _logWsPool = null;

async function registerLogWebSocket(wsManager) {
	// Create a WsPool at /ws/adminlogs — no CallPool link
	_logWsPool = wsManager.createNewPool('/ws/adminlogs', 'Admin Log Stream');
	// Don't setCallPool — we handle connections directly

	// Subscribe to the alog:stream Redis channel
	try {
		var subscriberClient = await redis.getClient();

		// The redis npm package needs a duplicate client for subscribe mode
		_logSubscriber = subscriberClient.duplicate();
		await _logSubscriber.connect();

		await _logSubscriber.subscribe(alogger.LOG_CHANNEL, (payload) => {
			// Broadcast raw JSON payload to all connected admin WS clients
			if (_logWsPool && _logWsPool.connections) {
				for (var conn of _logWsPool.connections) {
					if (conn._logAuthed) {
						try {
							conn.ws.send(payload);
						} catch (_) {}
					}
				}
			}
		});

		alogger.writeAlog(2, "  Admin log WebSocket bridge started at /ws/adminlogs", "cyan");
	} catch (err) {
		alogger.writeAlog(2, "  Admin log WebSocket bridge failed: " + err.message, "redbright");
	}

	// Handle new connections — require auth before streaming
	if (_logWsPool && _logWsPool.wss) {
		_logWsPool.wss.on('connection', (ws) => {
			ws._logAuthed = false;

			// Auth timeout — close if not authenticated within 5s
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
						var adminSecurity = parseInt(process.env.adminsecurity) || 200;

						if (session && (parseInt(session.security) || 0) >= adminSecurity) {
							ws._logAuthed = true;
							clearTimeout(authTimer);
							ws.send(JSON.stringify({ type: 'auth', status: 'ok' }));
						} else {
							ws.close(4003, 'Insufficient permissions');
						}
					}
				} catch (_) {}
			});

			ws.on('close', () => {
				clearTimeout(authTimer);
			});
		});
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
}

export { router, registerLogWebSocket, shutdownLogWebSocket };
