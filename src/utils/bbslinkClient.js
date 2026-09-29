// bbslinkClient.js -- a caller's session on BBSLink (#89).
//
// From BBSLink's own connector scripts (bbslink.net/sysop; not bundled, they
// ask not to be redistributed, so this is a reimplementation):
//
//   1. xkey: 6 random letters and digits
//   2. GET <http_base>/token.php?key=<xkey>                 -> token (trimmed)
//   3. GET <http_base>/auth.php?key=<xkey> with headers
//        X-User     the caller's user number here (BBSLink knows players by
//                   system code + this number, so it must never change;
//                   users.id does not)
//        X-System   system code
//        X-Auth     md5(auth code + token), hex
//        X-Code     md5(scheme code + token), hex
//        X-Rows     screen rows
//        X-Key, X-Door (door code, lower case; "menu" for every game),
//        X-Token, X-Type ("Canectic"), X-Version
//      a body of exactly "complete" means go on; anything else is the reason
//   4. telnet to <host>:<telnet_port> straight away, from the same address
//
// The telnet side is answered minimally: agree to the server's ECHO, SGA and
// BINARY, send our terminal type and window size if asked, refuse the rest,
// strip every IAC sequence from the output and double 0xFF in the input.
// Output is CP437 (`cp437: true`).

import { EventEmitter } from 'events';
import net from 'net';
import crypto from 'crypto';

var IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
var OPT_BINARY = 0, OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;
var CONNECT_TIMEOUT_MS = 20000;

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function xkey() {
	var a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', out = '';
	for (var b of crypto.randomBytes(6)) out += a[b % a.length];
	return out;
}

/** The auth request's headers. Pure. */
function authHeaders(settings, secrets, p) {
	return {
		'X-User': String(p.userNumber), 'X-System': settings.system_code,
		'X-Auth': md5((secrets.auth_code || '') + p.token), 'X-Code': md5((secrets.scheme_code || '') + p.token),
		'X-Rows': String(p.rows || 24), 'X-Key': p.key, 'X-Door': String(p.door || 'menu').toLowerCase(),
		'X-Token': p.token, 'X-Type': 'Canectic', 'X-Version': p.version || '1'
	};
}

/**
 * A minimal telnet client layer. feed(Buffer) returns the data bytes with
 * every IAC sequence removed, and calls reply(Buffer) for each answer to the
 * server's negotiation. Pure apart from the callback.
 */
function createTelnet(reply, term) {
	var state = 0, verb = 0, sb = [];
	var t = term || {};
	function answer(v, opt) {
		if (v === DO) {
			if (opt === OPT_TTYPE || opt === OPT_NAWS || opt === OPT_BINARY || opt === OPT_SGA) {
				reply(Buffer.from([IAC, WILL, opt]));
				if (opt === OPT_NAWS) {
					var w = t.width || 80, h = t.height || 24;
					reply(Buffer.from([IAC, SB, OPT_NAWS, (w >> 8) & 255, w & 255, (h >> 8) & 255, h & 255, IAC, SE]));
				}
			} else reply(Buffer.from([IAC, WONT, opt]));
		} else if (v === WILL) {
			reply(Buffer.from([IAC, (opt === OPT_ECHO || opt === OPT_SGA || opt === OPT_BINARY) ? DO : DONT, opt]));
		}
		// DONT / WONT need no answer
	}
	function subneg(bytes) {
		// TTYPE SEND (1) -> TTYPE IS (0) "ANSI"
		if (bytes[0] === OPT_TTYPE && bytes[1] === 1) {
			reply(Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, 0]), Buffer.from(t.type || 'ANSI', 'latin1'), Buffer.from([IAC, SE])]));
		}
	}
	return {
		feed: function (buf) {
			var out = [];
			for (var b of buf) {
				if (state === 0) { if (b === IAC) state = 1; else out.push(b); }
				else if (state === 1) {
					if (b === IAC) { out.push(IAC); state = 0; }
					else if (b === DO || b === DONT || b === WILL || b === WONT) { verb = b; state = 2; }
					else if (b === SB) { sb = []; state = 3; }
					else state = 0;
				} else if (state === 2) { answer(verb, b); state = 0; }
				else if (state === 3) { if (b === IAC) state = 4; else sb.push(b); }
				else if (state === 4) {
					if (b === SE) { subneg(sb); state = 0; }
					else { sb.push(b); state = 3; }
				}
			}
			return Buffer.from(out);
		}
	};
}

/** Input to the server: a 0xFF byte is sent as IAC IAC. */
function escapeIac(buf) {
	if (buf.indexOf(IAC) === -1) return buf;
	var out = [];
	for (var b of buf) { out.push(b); if (b === IAC) out.push(IAC); }
	return Buffer.from(out);
}

/**
 * Open a session. deps (tests): { fetch, connect(port, host), version }.
 */
async function openBbslink(remote, settings, secrets, opts, deps) {
	var d = deps || {};
	var doFetch = d.fetch || globalThis.fetch;
	var ev = new EventEmitter();
	ev.kind = 'bbslink';
	ev.cp437 = true;
	var closed = false, streaming = false, sock = null;
	var finish = function () {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		try { if (sock) sock.end(); } catch (_) {}
		ev.emit('close');
	};
	var fail = function (reason) { if (closed) return; ev.emit('error', reason); finish(); };
	ev.send = function (buf) { if (streaming && sock && !closed) sock.write(escapeIac(Buffer.from(buf))); };
	ev.launch = function () {};
	ev.close = finish;
	var timer = setTimeout(function () { if (!streaming) fail('no answer from BBSLink'); }, CONNECT_TIMEOUT_MS);

	setImmediate(async function () {
		try {
			if (!opts.user || !opts.user.id) { fail('BBSLink needs a logged-in caller'); return; }
			var key = xkey();
			var base = String(settings.http_base || 'http://games.bbslink.net').replace(/\/+$/, '');
			var tr = await doFetch(base + '/token.php?key=' + key);
			var token = String(await tr.text()).trim();
			if (!/^[A-Za-z0-9]+$/.test(token)) { fail('BBSLink did not give a token'); return; }
			var ar = await doFetch(base + '/auth.php?key=' + key, {
				headers: authHeaders(settings, secrets, { userNumber: opts.user.id, token: token, key: key, door: opts.door || 'menu', rows: opts.term && opts.term.height, version: d.version })
			});
			var answer = String(await ar.text()).trim();
			if (answer !== 'complete') { fail('BBSLink refused: ' + (answer || ('HTTP ' + ar.status))); return; }
			if (closed) return;
			var telnet = createTelnet(function (b) { if (sock && !closed) sock.write(b); }, opts.term);
			sock = (d.connect || function (port, host) { return net.connect(port, host); })(settings.telnet_port || 23, settings.host || 'games.bbslink.net');
			sock.once('connect', function () {
				streaming = true;
				clearTimeout(timer);
				ev.emit('launch_ok', opts.door || 'menu');
			});
			sock.on('data', function (chunk) {
				if (closed) return;
				var data = telnet.feed(Buffer.from(chunk));
				if (data.length) ev.emit('data', data);
			});
			sock.on('close', finish);
			sock.on('end', finish);
			sock.on('error', function (err) { fail('cannot reach ' + (settings.host || 'BBSLink') + ': ' + (err.code || err.message)); });
		} catch (err) {
			fail('BBSLink: ' + (err.message || String(err)));
		}
	});
	return ev;
}

export { openBbslink, authHeaders, createTelnet, escapeIac, md5 };
