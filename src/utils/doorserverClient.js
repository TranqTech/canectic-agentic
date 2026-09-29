// doorserverClient.js -- this board as a client of another Canectic door
// server (#86, phase D), speaking canectic-doorserver/1
// (docs/reference/DOORSERVER_DESIGN.md).
//
// One implementation for the two users of it: the remote-door runner, which
// bridges a caller's session to a door on another board, and the admin
// "Test connection" button, which only asks for the door list. The shipped
// bin/doorclient.js is the same protocol for other BBS software; it stays a
// separate single file because it is copied to boards that do not run
// Canectic.
//
// Uses Node's built-in WebSocket (22+), named through globalThis.

import { EventEmitter } from 'node:events';

/** Split JSON lines off the front of text; returns { frames, rest }. */
function takeJsonLines(text) {
	var frames = [];
	var rest = text;
	for (;;) {
		var nl = rest.indexOf('\n');
		if (nl === -1) break;
		var line = rest.slice(0, nl).trim();
		if (!line.startsWith('{')) break;
		try { frames.push(JSON.parse(line)); } catch (_) { break; }
		rest = rest.slice(nl + 1);
	}
	return { frames: frames, rest: rest };
}

/**
 * Open a session.
 *
 * opts: { url, systemId, secret, user: {name, real_name},
 *         term: {width, height, encoding, type}, door?, list?, timeoutMs? }
 *
 * Events: 'auth_ok' (doors, collections), 'auth_fail' (reason), 'launch_ok' (slug),
 *         'error_frame' (reason), 'data' (Buffer, the door's screen),
 *         'close' (), 'error' (message)
 * Methods: launch(slug), send(Buffer|string), close()
 */
function openSession(opts) {
	var o = opts || {};
	var ev = new EventEmitter();
	var streaming = false, pending = '', closed = false;
	var WS = globalThis.WebSocket;
	if (typeof WS !== 'function') {
		setImmediate(function () { ev.emit('error', 'this Node has no built-in WebSocket (needs 22 or later)'); ev.emit('close'); });
		ev.launch = ev.send = ev.close = function () {};
		return ev;
	}

	var ws;
	try { ws = new WS(o.url); }
	catch (err) {
		setImmediate(function () { ev.emit('error', 'bad address: ' + err.message); ev.emit('close'); });
		ev.launch = ev.send = ev.close = function () {};
		return ev;
	}
	ws.binaryType = 'arraybuffer';

	// No answer at all within the timeout (unreachable host, wrong path)
	var timer = setTimeout(function () {
		if (!streaming && !closed) { ev.emit('error', 'no answer from ' + o.url); try { ws.close(); } catch (_) {} }
	}, o.timeoutMs || 15000);

	ws.onerror = function () { if (!closed) ev.emit('error', 'cannot reach ' + o.url); };
	ws.onclose = function () {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		ev.emit('close');
	};
	ws.onmessage = function (msg) {
		var buf = typeof msg.data === 'string' ? Buffer.from(msg.data, 'utf8') : Buffer.from(new Uint8Array(msg.data));
		if (streaming) { ev.emit('data', buf); return; }
		var parsed = takeJsonLines(pending + buf.toString('latin1'));
		pending = parsed.rest;
		for (var f of parsed.frames) {
			if (f.type === 'hello') {
				ws.send(JSON.stringify({
					type: 'auth', system_id: o.systemId, secret: o.secret, user: o.user || {},
					door: o.door || undefined, list: o.list || undefined, term: o.term || {}
				}));
			} else if (f.type === 'auth_ok') {
				clearTimeout(timer);
				ev.emit('auth_ok', f.doors || [], f.collections || []);
			} else if (f.type === 'auth_fail') {
				clearTimeout(timer);
				ev.emit('auth_fail', f.reason || 'refused');
			} else if (f.type === 'launch_ok') {
				streaming = true;
				ev.emit('launch_ok', f.door);
				if (pending) { ev.emit('data', Buffer.from(pending, 'latin1')); pending = ''; }
			} else if (f.type === 'error') {
				ev.emit('error_frame', f.reason || 'error');
			}
		}
		// Non-JSON text after a refusal is the server's goodbye; drop it
		if (!streaming && pending && !pending.startsWith('{')) pending = '';
	};

	ev.launch = function (slug) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'launch', door: slug })); };
	ev.send = function (data) { if (streaming && ws.readyState === 1) ws.send(data); };
	ev.close = function () { try { ws.close(); } catch (_) {} };
	return ev;
}

/** Ask a door server for its door list. Resolves { ok, doors, reason }. */
function listDoors(opts) {
	return new Promise(function (resolve) {
		var done = false;
		var finish = function (r) { if (done) return; done = true; s.close(); resolve(r); };
		var s = openSession(Object.assign({}, opts, { list: true, user: { name: 'doorlist' }, term: { width: 80, height: 25, encoding: 'cp437' } }));
		s.on('auth_ok', function (doors, collections) { finish({ ok: true, doors: doors, collections: collections || [], reason: '' }); });
		s.on('auth_fail', function (reason) { finish({ ok: false, doors: [], reason: reason }); });
		s.on('error', function (reason) { finish({ ok: false, doors: [], reason: reason }); });
		s.on('close', function () { finish({ ok: false, doors: [], reason: 'closed without an answer' }); });
	});
}

export { openSession, listDoors, takeJsonLines };
