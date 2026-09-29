// terminalGate.js -- run the terminal screen (terminalScreen.js) on a new
// TCP or Telnet connection and hand it to the call pool only if it passes.
//
// Used by TelnetConnection and TcpConnection in announceConnection, after the
// maintenance refusal and before createCall, so a scanner never gets a node,
// a caller log line or a login handler. Settings (security category):
// terminal_screen_enabled, terminal_screen_timeout (seconds),
// terminal_screen_prompt. A bot's line is written to security.log as a
// [HONEYPOT] attempt (when honeypot_enabled), the form the shipped fail2ban
// honeypot filter matches, so an existing jail bans scanners unchanged.
// Outcomes are counted per day in Redis (terminalscreen:<date>:<outcome>)
// for the admin dashboard.

import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';
import { createScreen } from './terminalScreen.js';

var COUNT_DAYS = 40;

function today() { return new Date().toISOString().slice(0, 10); }

async function count(outcome) {
	try {
		var redis = await import('../middleware/db/redis.js');
		var c = await redis.getClient();
		var key = 'terminalscreen:' + today() + ':' + outcome;
		await c.incr(key);
		await c.expire(key, COUNT_DAYS * 86400);
	} catch (_) { /* counting is diagnostic only */ }
}

/** Counts for the last `days` days: [{ date, passed, bot, timeout }], newest first. */
async function screenCounts(days) {
	var out = [];
	try {
		var redis = await import('../middleware/db/redis.js');
		var c = await redis.getClient();
		for (var i = 0; i < (days || 7); i++) {
			var d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
			var vals = await Promise.all(['passed', 'bot', 'timeout'].map(function (o) { return c.get('terminalscreen:' + d + ':' + o); }));
			out.push({ date: d, passed: parseInt(vals[0]) || 0, bot: parseInt(vals[1]) || 0, timeout: parseInt(vals[2]) || 0 });
		}
	} catch (_) {}
	return out;
}

function ipOf(conn) { return String((conn.socket && conn.socket.remoteAddress) || conn.callerId || '').replace(/^::ffff:/i, ''); }

/**
 * Screen `conn`, then call admit() if it passes; a failing connection is
 * closed here. conn needs sendString(text) and socket. Sets conn.screen so
 * the connection's handleData can feed it until then. deps.count (tests)
 * replaces the Redis daily count.
 */
function screenThenAdmit(conn, admit, cfg, deps) {
	var c = cfg || appConfig;
	var tally = (deps && deps.count) || count;
	if (!c.getBoolean('terminal_screen_enabled', true)) { admit(); return; }
	var ip = ipOf(conn);
	var kind = conn.connectionType || 'terminal';
	var close = function () {
		conn.screen = null;
		try { if (conn.socket && !conn.socket.destroyed) conn.socket.end(); } catch (_) {}
	};
	var honeypots = String(c.get('honeypot_usernames', '') || '').split(',');
	conn.screen = createScreen({
		send: function (t) { try { conn.sendString(t); } catch (_) {} },
		timeoutMs: (c.getNumber('terminal_screen_timeout', 15) || 15) * 1000,
		prompt: c.get('terminal_screen_prompt', 'Press ESC twice to continue.'),
		botWords: honeypots,
		onPass: function () {
			conn.screen = null;
			tally('passed');
			alogger.writeAlog(3, kind + " caller from " + ip + " passed the terminal screen", "magenta");
			admit();
		},
		onBot: function (reason, line) {
			tally('bot');
			alogger.writeAlog(4, "Terminal screen: dropped a bot from " + ip + " (" + reason + ")", "yellow");
			if (c.getBoolean('honeypot_enabled', true)) {
				var name = String(line || reason).replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 40);
				alogger.writeClog(1, '[HONEYPOT] Login attempt with banned username "' + name + '" from ' + ip + ' via terminal screen', 'security', 'redbright');
			}
			close();
		},
		onTimeout: function () {
			tally('timeout');
			alogger.writeAlog(4, "Terminal screen: " + ip + " neither answered nor pressed ESC; closed", "yellow");
			close();
		}
	});
	conn.screen.start();
}

export { screenThenAdmit, screenCounts };
