// mailer/transports/base.js — Abstract transport interface.
// All transports (TCP, WebSocket) extend this class and implement
// write(), close(), destroy(), and the remoteAddress getter.
// The protocol layer sees only this interface.

import { EventEmitter } from 'node:events';

class BaseTransport extends EventEmitter {
	constructor() {
		super();
		this._connected = false;
	}

	// Send raw bytes to the remote side.
	write(buffer) {
		throw new Error('BaseTransport.write() must be implemented by subclass');
	}

	// Graceful close — flush pending data, then disconnect.
	close() {
		throw new Error('BaseTransport.close() must be implemented by subclass');
	}

	// Immediate teardown — no flush.
	destroy() {
		throw new Error('BaseTransport.destroy() must be implemented by subclass');
	}

	// String identifying the remote end (IP:port, WS URL, etc.)
	get remoteAddress() {
		return 'unknown';
	}

	get isConnected() {
		return this._connected;
	}
}

export { BaseTransport };
