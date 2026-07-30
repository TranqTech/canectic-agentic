// mailer/transports/tcp.js — TCP transport for FTN mailer sessions.
//
// Two modes:
//   1. Wrapping an existing socket (inbound — accepted by the TCP server)
//   2. Connecting to a remote host:port (outbound — initiated by mailer manager)
//
// Emits: 'data', 'close', 'error', 'connect'

import * as net from 'net';
import { BaseTransport } from './base.js';
import * as alogger from '../../utils/alogger.js';

class TcpTransport extends BaseTransport {
	constructor() {
		super();
		this._socket = null;
	}

	// --- Factory: wrap an already-accepted socket (inbound) ---

	static fromSocket(socket) {
		var transport = new TcpTransport();
		// Pause the socket immediately so no data events fire
		// until the protocol layer is wired and calls resume().
		socket.pause();
		transport._attachSocket(socket);
		transport._connected = true;
		return transport;
	}

	// --- Factory: connect to a remote host (outbound) ---

	static connect(host, port, timeout) {
		var transport = new TcpTransport();
		var connectTimeout = timeout || 30000;

		var socket = net.createConnection({ host: host, port: port }, function() {
			clearTimeout(timer);
			transport._attachSocket(socket);
			transport._connected = true;
			transport.emit('connect');
		});

		// Connection timeout
		var timer = setTimeout(function() {
			socket.destroy();
			transport.emit('error', new Error('Connection timeout after ' + connectTimeout + 'ms'));
		}, connectTimeout);

		socket.once('error', function(err) {
			clearTimeout(timer);
			transport._connected = false;
			transport.emit('error', err);
		});

		return transport;
	}

	// --- Flow control ---

	pause() {
		if (this._socket) this._socket.pause();
	}

	resume() {
		if (this._socket) this._socket.resume();
	}

	// --- Internal: wire socket events ---

	_attachSocket(socket) {
		this._socket = socket;
		this._socket.setNoDelay(true);

		this._socket.on('data', (data) => {
			this.emit('data', data);
		});

		this._socket.on('end', () => {
			// Peer sent FIN (their half-close). Tells us the remote decided
			// the session was over. Re-emit as 'peerClose' so the session
			// controller can send its own FIN in response — the "healthy"
			// ordering under binkp/1.1.
			alogger.writeClog(2, '[binkp DIAG] socket.end (peer FIN) t=' + Date.now() + ' remote=' + this.remoteAddress, 'mailer', 'magentabright');
			this.emit('peerClose');
		});

		this._socket.on('close', (hadError) => {
			alogger.writeClog(2, '[binkp DIAG] socket.close t=' + Date.now() + ' hadError=' + hadError + ' remote=' + this.remoteAddress, 'mailer', 'magentabright');
			this._connected = false;
			this.emit('close', hadError);
		});

		this._socket.on('error', (err) => {
			this._connected = false;
			this.emit('error', err);
		});
	}

	// --- Transport interface ---

	write(buffer) {
		if (this._socket && !this._socket.destroyed) {
			this._socket.write(buffer);
		}
	}

	close() {
		if (this._socket && !this._socket.destroyed) {
			alogger.writeClog(2, '[binkp DIAG] transport.close -> socket.end() t=' + Date.now() + ' remote=' + this.remoteAddress, 'mailer', 'magentabright');
			this._socket.end();
		}
		this._connected = false;
	}

	destroy() {
		if (this._socket) {
			this._socket.destroy();
		}
		this._connected = false;
	}

	get remoteAddress() {
		if (this._socket) {
			return (this._socket.remoteAddress || '?') + ':' + (this._socket.remotePort || '?');
		}
		return 'not connected';
	}
}

export { TcpTransport };
