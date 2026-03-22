// mailer/transports/ws.js — WebSocket transport for FTN mailer sessions.
//
// Two modes:
//   1. Wrapping an accepted WebSocket (inbound — from WS server upgrade)
//   2. Connecting to a remote ws:// URL (outbound — initiated by mailer manager)
//
// Binkp frames map 1:1 to binary WebSocket messages. The ws library
// sends Buffer arguments as binary frames and delivers them as Buffers
// when binaryType is 'nodebuffer'.
//
// Emits: 'data', 'close', 'error', 'connect'

import WebSocket from 'ws';
import { BaseTransport } from './base.js';

class WsTransport extends BaseTransport {
	constructor() {
		super();
		this._ws = null;
		this._remoteAddr = 'unknown';
		this._paused = false;
		this._buffer = [];  // buffered messages while paused
	}

	// --- Factory: wrap an already-accepted WebSocket (inbound) ---

	static fromWebSocket(ws, request) {
		var transport = new WsTransport();
		transport._remoteAddr = request
			? (request.socket.remoteAddress || '?')
			: 'unknown';
		transport._attachWebSocket(ws);
		transport._connected = true;
		return transport;
	}

	// --- Factory: connect to a remote WebSocket URL (outbound) ---

	static connect(url, timeout) {
		var transport = new WsTransport();
		var connectTimeout = timeout || 30000;

		var ws = new WebSocket(url, {
			perMessageDeflate: false,
		});
		ws.binaryType = 'nodebuffer';

		var timer = setTimeout(function() {
			try { ws.terminate(); } catch (_) {}
			transport.emit('error', new Error('WS connection timeout after ' + connectTimeout + 'ms'));
		}, connectTimeout);

		ws.on('open', function() {
			clearTimeout(timer);
			transport._remoteAddr = url;
			transport._attachWebSocket(ws);
			transport._connected = true;
			transport.emit('connect');
		});

		ws.once('error', function(err) {
			clearTimeout(timer);
			transport._connected = false;
			transport.emit('error', err);
		});

		return transport;
	}

	// --- Flow control ---

	pause() {
		this._paused = true;
	}

	resume() {
		this._paused = false;
		while (this._buffer.length > 0 && !this._paused) {
			this.emit('data', this._buffer.shift());
		}
	}

	// --- Internal: wire WebSocket events ---

	_attachWebSocket(ws) {
		this._ws = ws;
		ws.binaryType = 'nodebuffer';

		ws.on('message', (data) => {
			var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			if (this._paused) {
				this._buffer.push(buf);
			} else {
				this.emit('data', buf);
			}
		});

		ws.on('close', () => {
			this._connected = false;
			this.emit('close', false);
		});

		ws.on('error', (err) => {
			this._connected = false;
			this.emit('error', err);
		});
	}

	// --- Transport interface ---

	write(buffer) {
		if (this._ws && this._ws.readyState === WebSocket.OPEN) {
			this._ws.send(buffer);
		}
	}

	close() {
		if (this._ws) {
			this._ws.close();
		}
		this._connected = false;
	}

	destroy() {
		if (this._ws) {
			this._ws.terminate();
		}
		this._connected = false;
	}

	get remoteAddress() {
		return this._remoteAddr || 'unknown';
	}
}

export { WsTransport };
