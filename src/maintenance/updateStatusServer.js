// updateStatusServer.js -- the updater answering on the web port while the BBS
// is stopped.
//
// From the stop to the start, nothing serves the board's web port, which is
// most of an update and all of its risk. So the updater takes the port over
// itself, the SAME port the gateway uses, so that it answers through whatever
// reverse proxy sits in front of the board, and gives it back before starting
// the BBS again:
//
//   a sysop's browser   the update's progress, the same page the gateway serves
//                       at /admin/update/progress, so it carries straight on
//   everybody else      the maintenance page, as a 503 like the gateway's
//   WebSocket upgrades  a 503 and a closed socket
//
// Who is a sysop comes from the hashes the gateway wrote when the update was
// started (sysopSessions.js). Nothing here can ask Redis.
//
// It is a service inside a batch process, which brings rules a batch process
// never had:
//
//   - a bind failure never fails the update. It is retried for a few seconds
//     (the gateway's socket can take a moment to go), then the update carries
//     on without the page
//   - it never keeps the process alive: unref()d, and closed explicitly
//   - closing destroys open connections too. A browser holding a keep-alive
//     connection would otherwise keep the port bound, and the gateway starting
//     next would fail to take it
//
// NODE BUILTINS ONLY, like updateProgress.js: this runs while the dependencies
// phase is replacing node_modules. tests/installPath.test.js holds it to that.

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import {
	hashSessionId, parseCookies, progressSnapshot, renderProgressPage, renderMaintenancePage
} from './updateProgress.js';

var PROGRESS_JSON = '/admin/update/progress.json';
var CUSTOM_CSS = '/css/custom.css';

/**
 * What to answer. Pure.
 * @param {object} o  { path, isSysop }
 * @returns {string} css | json | forbidden | progress | maintenance
 */
function route(o) {
	var p = o.path || '/';
	if (p === CUSTOM_CSS) return 'css';
	if (p === PROGRESS_JSON) return o.isSysop ? 'json' : 'forbidden';
	return o.isSysop ? 'progress' : 'maintenance';
}

function send(res, status, type, body, extra, headOnly) {
	var headers = Object.assign({
		'Content-Type': type,
		'Cache-Control': 'no-store',
		'Content-Length': Buffer.byteLength(body)
	}, extra || {});
	res.writeHead(status, headers);
	res.end(headOnly ? undefined : body);
}

/**
 * Take over the web port and answer until closed.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} [opts.host]
 * @param {string} opts.root          install root, for the sysop's custom.css
 * @param {Set<string>} opts.sysopHashes
 * @param {function} opts.getState    the run state, current
 * @param {function} opts.getLog      recent log lines
 * @param {object} [opts.info]        { boardName, reason }
 * @param {function} [opts.log]
 * @param {number} [opts.attempts]    bind attempts, default 20
 * @param {number} [opts.retryMs]     between attempts, default 500
 * @returns {Promise<{port:number, close:function}|null>} null when it could not bind
 */
function startUpdateStatusServer(opts) {
	var o = opts || {};
	var say = typeof o.log === 'function' ? o.log : function () {};
	var hashes = o.sysopHashes || new Set();
	var info = o.info || {};
	var attempts = o.attempts || 20;
	var retryMs = o.retryMs || 500;
	var sockets = new Set();

	var server = http.createServer(function (req, res) {
		try {
			var cookies = parseCookies(req.headers.cookie);
			var isSysop = !!cookies.sessionid && hashes.has(hashSessionId(cookies.sessionid));
			var p = String(req.url || '/').split('?')[0];
			var headOnly = req.method === 'HEAD';
			switch (route({ path: p, isSysop: isSysop })) {
				case 'css': {
					// The sysop's own stylesheet, so both pages carry the board's
					// branding. An update never overwrites it, so reading it while
					// the files phase runs is safe; every other asset is mid-write.
					var css = '';
					try { css = fs.readFileSync(path.join(o.root || process.cwd(), 'public', 'css', 'custom.css'), 'utf8'); } catch (_) {}
					return send(res, 200, 'text/css; charset=utf-8', css, null, headOnly);
				}
				case 'json':
					return send(res, 200, 'application/json; charset=utf-8',
						JSON.stringify(snapshot()), null, headOnly);
				case 'forbidden':
					return send(res, 403, 'application/json; charset=utf-8',
						JSON.stringify({ error: 'forbidden' }), null, headOnly);
				case 'progress':
					return send(res, 200, 'text/html; charset=utf-8', renderProgressPage(snapshot()), null, headOnly);
				default:
					return send(res, 503, 'text/html; charset=utf-8', renderMaintenancePage(info),
						{ 'Retry-After': '300' }, headOnly);
			}
		} catch (err) {
			try { send(res, 500, 'text/plain; charset=utf-8', 'The updater could not answer: ' + err.message); } catch (_) {}
		}
	});

	function snapshot() {
		return progressSnapshot(o.getState ? o.getState() : null, {
			log: o.getLog ? o.getLog() : [],
			servedBy: 'updater',
			boardName: info.boardName || null
		});
	}

	// The web terminal, presence and door sockets all come here too. There is
	// nothing to connect them to.
	server.on('upgrade', function (req, socket) {
		try {
			socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 300\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
		} catch (_) {}
	});

	server.on('connection', function (socket) {
		sockets.add(socket);
		socket.on('close', function () { sockets.delete(socket); });
	});

	function listenOnce() {
		return new Promise(function (resolve) {
			function onError(err) {
				server.removeListener('listening', onListening);
				resolve(err);
			}
			function onListening() {
				server.removeListener('error', onError);
				resolve(null);
			}
			server.once('error', onError);
			server.once('listening', onListening);
			if (o.host) server.listen(o.port, o.host);
			else server.listen(o.port);
		});
	}

	function wait(ms) {
		return new Promise(function (resolve) { var t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
	}

	var closed = false;
	function close() {
		if (closed) return Promise.resolve();
		closed = true;
		return new Promise(function (resolve) {
			server.close(function () { resolve(); });
			// Keep-alive connections would hold the port open and stop the
			// gateway taking it back.
			if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
			for (var s of sockets) { try { s.destroy(); } catch (_) {} }
			sockets.clear();
		});
	}

	return (async function () {
		for (var i = 1; i <= attempts; i++) {
			var err = await listenOnce();
			if (!err) {
				if (server.unref) server.unref();
				var bound = server.address();
				say('progress page: answering on port ' + (bound && bound.port ? bound.port : o.port) +
					' while the BBS is stopped (' + hashes.size + ' sysop session(s) recognised)');
				return { port: bound && bound.port ? bound.port : o.port, close: close };
			}
			if (err.code !== 'EADDRINUSE' || i === attempts) {
				say('progress page: could not take port ' + o.port + ' (' + (err.code || err.message) +
					'); the update carries on without it');
				return null;
			}
			await wait(retryMs);
			// Node's documented retry: close, then listen again.
			try { server.close(); } catch (_) {}
		}
		return null;
	})();
}

export {
	PROGRESS_JSON,
	route,
	startUpdateStatusServer
};
