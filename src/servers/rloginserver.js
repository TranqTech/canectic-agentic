// rloginserver.js -- RLogin access to the door server, for BBS software that
// can open an RLogin connection but cannot run the WebSocket client (#86,
// phase E). Off unless doorserver_rlogin_enabled; restart to apply.
//
// RFC 1282 handshake, "\0<client user>\0<server user>\0<terminal>/<speed>\0",
// answered with a single "\0". Door-server convention for the fields:
//
//   client user   the system's secret
//   server user   <SYSTEM_ID>:<username>
//   terminal      a door slug to go straight to it, or a terminal type
//                 (ansi, vt100, xterm...) for the door list
//
// The connection then becomes an ordinary call in the Doorserver pool: this
// wrapper speaks canectic-doorserver/1 to the door_auth stage on the RLogin
// client's behalf (an auth frame built from the handshake, a numbered menu
// turned into a launch frame) and never passes the JSON to the client. So
// login, per-system limits, door availability, the caller log and fail2ban
// logging are exactly the WebSocket path's.

import * as net from 'net';
import { v4 as uuidv4 } from 'uuid';
import * as alogger from '../utils/alogger.js';

var TERMINAL_TYPES = /^(ansi|ansi-bbs|pc-ansi|scoansi|vt\d+|xterm.*|linux|dumb|syncterm|netrunner|screen.*|tmux.*|cp437|utf-?8)$/i;

/**
 * Parse the handshake from the front of a buffer.
 * returns null while incomplete, else { clientUser, serverUser, terminal,
 * speed, rest (Buffer) }.
 */
function parseHandshake(buf) {
	var start = buf[0] === 0 ? 1 : 0;
	var fields = [], pos = start;
	for (var n = 0; n < 3; n++) {
		var end = buf.indexOf(0, pos);
		if (end === -1) return null;
		fields.push(buf.slice(pos, end).toString('latin1'));
		pos = end + 1;
	}
	var ts = fields[2].split('/');
	return { clientUser: fields[0], serverUser: fields[1], terminal: ts[0] || '', speed: parseInt(ts[1]) || 0, rest: buf.slice(pos) };
}

/** The door-server auth frame a handshake stands for. */
function authFromHandshake(h) {
	var su = String(h.serverUser || '');
	var idx = su.indexOf(':');
	var systemId = idx === -1 ? '' : su.slice(0, idx).trim();
	var username = (idx === -1 ? su : su.slice(idx + 1)).trim();
	var term = String(h.terminal || '').trim();
	var door = term && !TERMINAL_TYPES.test(term) ? term : '';
	return {
		type: 'auth', system_id: systemId, secret: h.clientUser, user: { name: username, real_name: username },
		door: door || undefined, term: { width: 80, height: 24, encoding: 'cp437', type: 'ansi' }
	};
}

class RloginConnection {
	constructor(socket, callPool) {
		this.uuid = uuidv4();
		this.connectionType = "RLogin";
		this.socket = socket;
		this.callPool = callPool;
		this.loggingId = "RLogin: " + socket.remoteAddress + ":" + socket.remotePort;
		this.callerId = socket.remoteAddress;
		this.callhandler = null;
		this.handshake = Buffer.alloc(0);
		this.phase = 'handshake';   // handshake -> auth -> choosing -> streaming
		this.auth = null;
		this.doors = [];
		this.typed = '';

		socket.on('data', (data) => this._onData(data));
		socket.once('close', () => this.announceClose());
		socket.on('error', () => {});
		socket.setKeepAlive(true, 30000);
		// A client that never finishes the handshake
		this._handshakeTimer = setTimeout(() => { if (this.phase === 'handshake') socket.destroy(); }, 15000);
	}

	_onData(data) {
		if (this.phase === 'handshake') {
			this.handshake = Buffer.concat([this.handshake, data]);
			if (this.handshake.length > 1024) { this.socket.destroy(); return; }
			var h = parseHandshake(this.handshake);
			if (!h) return;
			clearTimeout(this._handshakeTimer);
			this.socket.write(Buffer.from([0]));
			this.auth = authFromHandshake(h);
			alogger.writeAlog(3, this.loggingId + "\n  RLogin door-server connection for " + (this.auth.system_id || '?'), "magenta");
			this.phase = 'auth';
			this.callhandler = this.callPool.createCall(this);
			this.callhandler.setupCall();
			return;
		}
		if (this.phase === 'streaming') { if (this.callhandler) this.callhandler.handleData(data); return; }
		if (this.phase !== 'choosing') return;
		for (var ch of data.toString('latin1')) {
			if (ch === 'q' || ch === 'Q') { this.socket.end("\r\n"); return; }
			if (ch === '\r' || ch === '\n') {
				var pick = this.doors[parseInt(this.typed) - 1];
				this.typed = '';
				if (!pick) { this.socket.write("\r\nChoose a number (Q to quit): "); continue; }
				this.socket.write("\r\n");
				this.phase = 'auth';
				this.callhandler.handleData(Buffer.from(JSON.stringify({ type: 'launch', door: pick.slug })));
				return;
			}
			if (/[0-9]/.test(ch) && this.typed.length < 3) { this.typed += ch; this.socket.write(ch); }
		}
	}

	// Until the door starts, what the call sends is protocol for us, not
	// screen for the client.
	_fromCall(text) {
		var lines = String(text).split('\n');
		for (var line of lines) {
			var t = line.trim();
			if (!t.startsWith('{')) { if (t && this.phase === 'streaming') this.socket.write(line); continue; }
			var f; try { f = JSON.parse(t); } catch (_) { continue; }
			if (f.type === 'hello') {
				this.callhandler.handleData(Buffer.from(JSON.stringify(this.auth)));
			} else if (f.type === 'auth_fail') {
				this.socket.write("\r\nThe door server refused the connection: " + f.reason + "\r\n");
			} else if (f.type === 'auth_ok' && !this.auth.door) {
				this.doors = f.doors || [];
				this.phase = 'choosing';
				this.socket.write("\r\nDoors on this server:\r\n\r\n");
				this.doors.forEach((d, n) => this.socket.write("  " + String(n + 1).padStart(2) + ") " + d.name + "\r\n"));
				this.socket.write("\r\nChoose a number (Q to quit): ");
			} else if (f.type === 'launch_ok') {
				this.phase = 'streaming';
			} else if (f.type === 'error') {
				this.socket.write("\r\n" + f.reason + "\r\n");
			}
		}
	}

	sendtext(text) { this.sendString(text); }
	sendString(stringdata) {
		if (this.socket.destroyed) return;
		if (this.phase === 'streaming') this.socket.write(stringdata);
		else this._fromCall(stringdata);
	}
	sendData(data) {
		if (this.socket.destroyed) return;
		if (this.phase === 'streaming') this.socket.write(Buffer.from(data));
	}

	hangUpCall() {
		if (!this.socket.destroyed) this.socket.end("\r\n");
	}

	announceClose() {
		clearTimeout(this._handshakeTimer);
		if (this.callhandler) this.callhandler.connectionClosed(this);
		this.callhandler = null;
	}
}

class RloginServer {
	constructor(port, callPool) {
		this.port = port;
		this.callPool = callPool;
		this.server = null;
	}
	start() {
		this.server = net.createServer((socket) => new RloginConnection(socket, this.callPool));
		this.server.on('error', (err) => {
			alogger.writeAlog(1, "RLogin door server could not listen on port " + this.port + ": " + err.message +
				(err.code === 'EACCES' ? " (ports below 1024 need root; choose another doorserver_rlogin_port)" : ""), "redbright");
		});
		this.server.listen(this.port, () => {
			alogger.writeAlog(1, "RLogin door server listening on port " + this.port, "bluebright");
		});
	}
	stop() { if (this.server) this.server.close(); }
}

export { RloginServer, RloginConnection, parseHandshake, authFromHandshake };
