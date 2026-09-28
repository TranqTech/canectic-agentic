// src/servers/qwkFtpServer.js: the FTP server a QWK node calls (#74).
//
// Compatible with a Synchronet hub's FTP server (ftpsrvr.cpp, main.cpp event
// thread) and so with node software that calls Synchronet hubs, such as the
// stock exec/qnet-ftp.js: log in with the node's QWK ID and password, upload
// the REP as <OUR_ID>.rep at the root, download the packet as <OUR_ID>.qwk at
// the root. What Synchronet does, and so this does:
//   - one FTP session at a time per node ("421 QWKnet accounts are limited to
//     one concurrent FTP session");
//   - RETR builds the packet when there is none waiting, and answers "550 No
//     QWK packet created (no new messages)" when there is nothing to send;
//   - the only upload accepted is <OUR_ID>.rep, otherwise "553 Invalid path
//     or filename"; it is imported afterwards.
// One difference, decided for #74: a packet is counted as delivered when its
// download completes (226), through the same commitNodePacket() as the HTTP
// hub, where Synchronet commits when it builds. Ours can only duplicate after
// a failure; Synchronet's can lose a packet deleted before it is fetched.
//
// A node is an active QWK connection on the hub transport with a password
// (qnetAuth.matchNode, as over HTTP); IDs are unique per role (#67), so the
// login names one connection. Off unless qwk_ftp_port is set. Plain FTP, like
// Synchronet's: passwords cross the wire in the clear, so over the internet the
// HTTP hub (behind HTTPS) is the better choice.

import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';
import * as peerConnections from '../models/peerConnections.js';
import * as systemAddresses from '../models/systemAddresses.js';
import * as qwkPacketBuilder from '../models/qwkPacketBuilder.js';
import * as networkTransfers from '../models/networkTransfers.js';
import { matchNode, looksLikeZip } from '../utils/qnetAuth.js';
import { qnetInDir, qnetOutDir } from '../utils/qnetPaths.js';
import { isActive as maintenanceActive } from '../maintenance/maintenanceFlag.js';
import { logAuthFail } from '../utils/authFailLog.js';

var IDLE_MS = 5 * 60 * 1000;
var DATA_WAIT_MS = 30 * 1000;
var MAX_BAD_LOGINS = 3;

// Node connections with a session open, by connection uuid.
var activeNodes = new Map();

/** Parse "50000-50100" into [lo, hi], or null for any port. Pure. */
function parsePortRange(value) {
	var m = String(value || '').trim().match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
	if (!m) return null;
	var lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
	if (lo < 1024 || hi > 65535 || lo > hi) return null;
	return [lo, hi];
}

/** The name a client asked for, without a leading "/" or "./". Pure. */
function bareName(arg) {
	return String(arg || '').trim().replace(/^(\.\/|\/)+/, '');
}

async function localQwkIdFor(conn) {
	var sa = null;
	if (conn.system_address_id) sa = await systemAddresses.getAddressById(conn.system_address_id);
	if (!sa && conn.network_id) sa = await systemAddresses.getDefaultAddress(conn.network_id);
	return sa && sa.address ? sa.address.trim().toUpperCase() : '';
}

class QwkFtpSession {
	constructor(socket, opts) {
		this.socket = socket;
		this.opts = opts;
		this.user = null;
		this.conn = null;
		this.localId = '';
		this.badLogins = 0;
		this.pasv = null;          // { server, socket, waiters }
		this.active = null;        // { host, port } for PORT/EPRT
		this.busy = Promise.resolve();
		this.buffer = '';
		this.ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');
		socket.setEncoding('latin1');
		socket.setTimeout(IDLE_MS, () => { this.reply(421, 'Idle timeout, closing'); this.close(); });
		socket.on('data', (d) => this.onData(d));
		socket.on('error', () => this.close());
		socket.on('close', () => this.cleanup());
		this.reply(220, 'Canectic QWK hub FTP ready');
	}

	reply(code, text) {
		if (this.socket.destroyed) return;
		var lines = String(text).split('\n');
		if (lines.length === 1) {
			this.socket.write(code + ' ' + lines[0] + '\r\n');
		} else {
			this.socket.write(code + '-' + lines[0] + '\r\n');
			for (var i = 1; i < lines.length - 1; i++) this.socket.write(' ' + lines[i] + '\r\n');
			this.socket.write(code + ' ' + lines[lines.length - 1] + '\r\n');
		}
	}

	onData(chunk) {
		this.buffer += chunk;
		if (this.buffer.length > 8192) { this.close(); return; }
		var idx;
		while ((idx = this.buffer.indexOf('\n')) !== -1) {
			var line = this.buffer.slice(0, idx).replace(/\r$/, '');
			this.buffer = this.buffer.slice(idx + 1);
			// One command at a time, in order: a transfer finishes before the next.
			this.busy = this.busy.then(() => this.command(line)).catch((err) => {
				alogger.writeAlog(2, 'QWK FTP: ' + err.message, 'redbright');
				this.reply(451, 'Local error');
			});
		}
	}

	async command(line) {
		var sp = line.indexOf(' ');
		var verb = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
		var arg = sp === -1 ? '' : line.slice(sp + 1);

		switch (verb) {
			case 'USER': this.user = arg.trim(); this.conn = null; return this.reply(331, 'Password required for ' + this.user);
			case 'PASS': return this.login(arg);
			case 'QUIT': this.reply(221, 'Goodbye'); return this.close();
			case 'NOOP': return this.reply(200, 'OK');
			case 'SYST': return this.reply(215, 'UNIX Type: L8');
			case 'FEAT': return this.reply(211, 'Features:\nSIZE\nMDTM\nEPSV\nPASV\nUTF8\nEnd');
			case 'OPTS': return this.reply(200, 'OK');
			case 'HELP': return this.reply(214, 'QWK hub: RETR <hub>.qwk, STOR <hub>.rep');
		}
		if (!this.conn) return this.reply(530, 'Not logged in');

		switch (verb) {
			case 'TYPE': case 'MODE': case 'STRU': case 'ALLO': return this.reply(200, 'OK');
			case 'PWD': case 'XPWD': return this.reply(257, '"/" is the current directory');
			case 'CWD': case 'XCWD':
				return ['', '/', '.', './'].indexOf(arg.trim()) !== -1
					? this.reply(250, 'Directory is /') : this.reply(550, 'No such directory');
			case 'CDUP': case 'XCUP': return this.reply(250, 'Directory is /');
			case 'PASV': return this.openPassive(false);
			case 'EPSV': return this.openPassive(true);
			case 'PORT': return this.setActive(arg, false);
			case 'EPRT': return this.setActive(arg, true);
			case 'SIZE': return this.size(arg);
			case 'MDTM': return this.mdtm(arg);
			case 'LIST': case 'NLST': return this.list(verb === 'NLST');
			case 'RETR': return this.retr(arg);
			case 'STOR': return this.stor(arg);
			// Older call-out scripts delete the packet after fetching it; it is
			// already committed and gone by then.
			case 'DELE': return this.isPacket(arg) ? this.reply(250, 'Deleted') : this.reply(550, 'No such file');
			case 'ABOR': return this.reply(226, 'No transfer to abort');
			default: return this.reply(502, 'Command not implemented');
		}
	}

	async login(pass) {
		if (!this.user) return this.reply(503, 'Send USER first');
		var conns = [];
		try { conns = await peerConnections.getActiveConnectionsByNetworkType('QWK'); } catch (_) {}
		var conn = matchNode({ user: this.user, pass: pass }, conns);
		if (!conn) {
			logAuthFail('failed', 'QWK node ' + this.user, this.ip, 'QWK FTP');
			this.badLogins++;
			this.reply(530, 'Login incorrect');
			if (this.badLogins >= MAX_BAD_LOGINS) this.close();
			return;
		}
		if (maintenanceActive(process.cwd())) {
			this.reply(421, 'The system is closed for maintenance, try again later');
			return this.close();
		}
		if (activeNodes.has(conn.uuid)) {
			this.reply(421, 'QWKnet accounts are limited to one concurrent FTP session');
			return this.close();
		}
		this.conn = conn;
		this.localId = await localQwkIdFor(conn);
		activeNodes.set(conn.uuid, this);
		alogger.writeAlog(4, 'QWK FTP: ' + conn.connection_data.remote_qwk_id + ' logged in from ' + this.ip, 'cyan');
		return this.reply(230, String(conn.connection_data.remote_qwk_id).toUpperCase() + ' logged in');
	}

	packetName() { return (this.localId || 'UNKNOWN') + '.qwk'; }
	isPacket(arg) { return bareName(arg).toUpperCase() === this.packetName().toUpperCase(); }
	waitingPacket() {
		var p = path.join(qnetOutDir(this.conn.connection_data), this.packetName());
		return fs.existsSync(p) ? p : null;
	}

	size(arg) {
		var p = this.isPacket(arg) ? this.waitingPacket() : null;
		if (!p) return this.reply(550, 'Size not available');
		return this.reply(213, String(fs.statSync(p).size));
	}

	mdtm(arg) {
		var p = this.isPacket(arg) ? this.waitingPacket() : null;
		if (!p) return this.reply(550, 'No such file');
		var d = fs.statSync(p).mtime;
		var pad = function (n) { return String(n).padStart(2, '0'); };
		return this.reply(213, d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
			pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()));
	}

	// ---- data connections ----

	async openPassive(extended) {
		this.closeData();
		var range = parsePortRange(this.opts.pasvPorts);
		var server = net.createServer();
		var state = { server: server, socket: null, waiters: [] };
		server.on('connection', (s) => {
			if (state.socket) { s.destroy(); return; }
			state.socket = s;
			s.on('error', () => {});
			server.close();
			for (var w of state.waiters.splice(0)) w(s);
		});
		server.on('error', () => {});
		var port = await listenInRange(server, range, this.socket.localAddress);
		if (!port) return this.reply(425, 'Cannot open a data port');
		this.pasv = state;
		if (extended) return this.reply(229, 'Entering Extended Passive Mode (|||' + port + '|)');
		var host = (this.opts.pasvAddress || this.socket.localAddress || '127.0.0.1').replace(/^::ffff:/, '');
		if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) host = '127.0.0.1';
		return this.reply(227, 'Entering Passive Mode (' + host.split('.').join(',') + ',' + (port >> 8) + ',' + (port & 255) + ')');
	}

	setActive(arg, extended) {
		this.closeData();
		var host, port;
		if (extended) {
			var parts = arg.split(arg.charAt(0));
			host = parts[2]; port = parseInt(parts[3], 10);
		} else {
			var n = arg.split(',').map(function (x) { return parseInt(x, 10); });
			if (n.length !== 6 || n.some(isNaN)) return this.reply(501, 'Bad PORT');
			host = n.slice(0, 4).join('.'); port = n[4] * 256 + n[5];
		}
		// Only back to the client that is logged in: PORT to anywhere else is
		// the FTP bounce attack.
		if (host.replace(/^::ffff:/, '') !== this.ip || !(port > 0 && port < 65536)) return this.reply(504, 'Data address must be your own');
		this.active = { host: host, port: port };
		return this.reply(200, 'OK');
	}

	dataSocket() {
		if (this.pasv) {
			var st = this.pasv;
			if (st.socket) return Promise.resolve(st.socket);
			return new Promise(function (resolve) {
				var t = setTimeout(function () { resolve(null); }, DATA_WAIT_MS);
				st.waiters.push(function (s) { clearTimeout(t); resolve(s); });
			});
		}
		if (this.active) {
			var a = this.active;
			return new Promise(function (resolve) {
				var s = net.connect(a.port, a.host, function () { resolve(s); });
				s.on('error', function () { resolve(null); });
				s.setTimeout(DATA_WAIT_MS, function () { s.destroy(); resolve(null); });
			});
		}
		return Promise.resolve(null);
	}

	closeData() {
		if (this.pasv) {
			try { this.pasv.server.close(); } catch (_) {}
			if (this.pasv.socket) this.pasv.socket.destroy();
			for (var w of this.pasv.waiters.splice(0)) w(null);
		}
		this.pasv = null;
		this.active = null;
	}

	async list(namesOnly) {
		var p = this.waitingPacket();
		var ds = await this.openDataFor('150 Here comes the listing');
		if (!ds) return;
		var body = '';
		if (p) {
			var st = fs.statSync(p);
			body = namesOnly ? this.packetName() + '\r\n'
				: '-r--r--r-- 1 hub hub ' + st.size + ' ' + st.mtime.toUTCString().slice(5, 16) + ' ' + this.packetName() + '\r\n';
		}
		ds.end(body, 'latin1');
		await new Promise(function (r) { ds.on('close', r); });
		this.closeData();
		return this.reply(226, 'Transfer complete');
	}

	async openDataFor(line) {
		var ds = await this.dataSocket();
		if (!ds) {
			this.closeData();
			this.reply(425, 'No data connection');
			return null;
		}
		this.socket.write(line + '\r\n');
		return ds;
	}

	// ---- the two files ----

	async retr(arg) {
		if (!this.isPacket(arg)) return this.reply(550, 'No such file');
		var startedAt = new Date();
		var built = await qwkPacketBuilder.buildQwkForNode(this.conn.uuid);
		if (!built.status) {
			await this.record('push', { status: false, stage: 'build', errormessages: built.errormessages }, startedAt);
			return this.reply(451, 'Packet could not be built');
		}
		if (!built.qwkPath) {
			this.closeData();
			return this.reply(550, 'No QWK packet created (no new messages)');
		}
		var size = fs.statSync(built.qwkPath).size;
		var ds = await this.openDataFor('150 Opening BINARY mode data connection for ' + this.packetName() + ' (' + size + ' bytes)');
		if (!ds) return;
		var ok = await new Promise(function (resolve) {
			var rs = fs.createReadStream(built.qwkPath);
			var failed = false;
			rs.on('error', function () { failed = true; ds.destroy(); });
			ds.on('error', function () { failed = true; });
			ds.on('close', function () { resolve(!failed); });
			rs.pipe(ds);
		});
		this.closeData();
		if (!ok) {
			await this.record('push', { status: false, stage: 'upload', bytes: size, errormessages: ['download not completed'] }, startedAt);
			return this.reply(426, 'Transfer aborted; the packet will be offered again');
		}
		// Delivered: count it now, the only acknowledgement FTP gives.
		if (built.packetId) await qwkPacketBuilder.commitNodePacket(this.conn.uuid, built.packetId);
		await this.record('push', { status: true, stage: 'upload', bytes: size, totalPosted: built.totalMessages }, startedAt);
		return this.reply(226, 'Transfer complete');
	}

	async stor(arg) {
		var name = bareName(arg);
		if (name.toUpperCase() !== (this.localId || '').toUpperCase() + '.REP' || !this.localId) {
			return this.reply(553, 'Invalid path or filename.');
		}
		var startedAt = new Date();
		var max = appConfig.getNumber('qnet_max_rep_bytes', 20 * 1024 * 1024);
		var inDir = qnetInDir(this.conn.connection_data);
		fs.mkdirSync(inDir, { recursive: true });
		var nodeId = String(this.conn.connection_data.remote_qwk_id).toUpperCase();
		var final = nodeId + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.rep';
		var tmp = path.join(inDir, '.' + final + '.part');
		var ds = await this.openDataFor('150 Ready for ' + name);
		if (!ds) return;
		var got = await new Promise(function (resolve) {
			var chunks = [], size = 0, over = false;
			ds.on('data', function (c) {
				size += c.length;
				if (size > max) { over = true; ds.destroy(); return; }
				chunks.push(c);
			});
			ds.on('error', function () {});
			ds.on('close', function () { resolve({ buf: Buffer.concat(chunks), size: size, over: over }); });
		});
		this.closeData();
		if (got.over) {
			await this.record('pull', { status: false, stage: 'download', bytes: got.size, errormessages: ['REP larger than qnet_max_rep_bytes (' + max + ')'] }, startedAt);
			return this.reply(552, 'REP larger than ' + max + ' bytes');
		}
		if (!looksLikeZip(got.buf)) {
			await this.record('pull', { status: false, stage: 'extract', bytes: got.size, errormessages: ['Upload is not a REP packet (not a ZIP archive)'] }, startedAt);
			return this.reply(553, 'Not a REP packet');
		}
		try {
			fs.writeFileSync(tmp, got.buf);
			fs.renameSync(tmp, path.join(inDir, final));
		} catch (err) {
			try { fs.unlinkSync(tmp); } catch (_) {}
			return this.reply(451, 'Could not store the REP');
		}
		try {
			// Injectable so a test can see the import queued without a worker
			// racing it; otherwise the same job the HTTP hub queues.
			if (this.opts.enqueueInbound) {
				await this.opts.enqueueInbound(this.conn.uuid);
			} else {
				var jobs = await import('../queues/jobs.js');
				await jobs.enqueueQwkHubInbound(this.conn.uuid);
			}
		} catch (err) {
			alogger.writeAlog(2, 'QWK FTP: stored ' + final + ' but could not queue its import: ' + err.message, 'redbright');
		}
		return this.reply(226, 'Transfer complete; the REP will be imported');
	}

	async record(direction, result, startedAt) {
		try {
			var r = Object.assign({ status: true, errormessages: [] }, result);
			var row = networkTransfers.rowFor('QWK', direction, this.conn.uuid, this.conn, r, startedAt, new Date());
			row.transport = 'ftp-hub';
			row.remote_host = this.ip;
			await networkTransfers.record(row);
		} catch (_) {}
	}

	close() {
		this.closeData();
		if (!this.socket.destroyed) this.socket.end();
		setTimeout(() => { if (!this.socket.destroyed) this.socket.destroy(); }, 1000).unref();
	}

	cleanup() {
		this.closeData();
		if (this.conn && activeNodes.get(this.conn.uuid) === this) activeNodes.delete(this.conn.uuid);
	}
}

function listenInRange(server, range, host) {
	var ports = [];
	if (range) {
		for (var p = range[0]; p <= range[1]; p++) ports.push(p);
		ports.sort(function () { return Math.random() - 0.5; });
	} else {
		ports.push(0);
	}
	return new Promise(function (resolve) {
		var i = 0;
		var tryNext = function () {
			if (i >= ports.length) return resolve(null);
			var port = ports[i++];
			server.once('error', tryNext);
			server.listen(port, host, function () {
				server.removeListener('error', tryNext);
				resolve(server.address().port);
			});
		};
		tryNext();
	});
}

/**
 * Start the QWK FTP hub. `opts`: { port, host, pasvAddress, pasvPorts, enqueueInbound }.
 * Resolves with { server, port, close() }.
 */
function startQwkFtpServer(opts) {
	var o = opts || {};
	var sessions = new Set();
	var server = net.createServer(function (socket) {
		var s = new QwkFtpSession(socket, o);
		sessions.add(s);
		socket.on('close', function () { sessions.delete(s); });
	});
	server.on('error', function (err) { alogger.writeAlog(1, 'QWK FTP server: ' + err.message, 'redbright'); });
	return new Promise(function (resolve, reject) {
		server.once('error', reject);
		server.listen(o.port || 0, o.host || undefined, function () {
			server.removeListener('error', reject);
			resolve({
				server: server,
				port: server.address().port,
				close: function () {
					for (var s of sessions) { s.closeData(); s.socket.destroy(); }
					return new Promise(function (r) { server.close(function () { r(); }); });
				}
			});
		});
	});
}

export { startQwkFtpServer, parsePortRange, bareName, activeNodes };
