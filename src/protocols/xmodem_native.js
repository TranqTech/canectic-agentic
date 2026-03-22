// protocols/xmodem_native.js — Terminal XMODEM wrapper.
//
// Bridges the native XmodemEngine to a terminal call object.
// Provides the same send()/receive() API as the ZMODEM protocol wrappers
// so callers (fileBrowser, fileBatchDownload, etc.) can use it without changes.
//
// During transfer:
// - Inactivity timeouts are cleared and reset on each data event to prevent
//   "Are you there?" messages from corrupting the XMODEM stream.
// - Non-protocol terminal output is suppressed via _send guard since XMODEM
//   has no escaping layer and any stray byte corrupts the stream.

import { XmodemEngine } from '../transfers/xmodem.js';

class NativeXmodemProtocol {
	constructor(call, options) {
		this._call = call;
		this._opts = options || {};
		this._engine = null;
		this._previousRawmode = false;
		this._previousRawtarget = null;
		this._previousSend = null;
		this._transferActive = false;
	}

	async send(filePaths) {
		if (!filePaths || filePaths.length === 0) {
			return { success: false, error: 'No files to send' };
		}

		for (var i = 0; i < filePaths.length; i++) {
			var adapter = this._createAdapter();
			this._engine = new XmodemEngine(adapter, {
				blockSize: this._opts.blockSize || 1024,
				timeout: this._opts.timeout || 10000,
			});

			var result = await this._engine.send(filePaths[i]);
			this._restore();

			if (!result.success) return result;
		}

		return { success: true };
	}

	async receive(targetDir, fileName) {
		var adapter = this._createAdapter();
		this._engine = new XmodemEngine(adapter, {
			blockSize: this._opts.blockSize || 1024,
			timeout: this._opts.timeout || 10000,
		});

		var result = await this._engine.receive(targetDir, fileName);
		this._restore();
		return result;
	}

	abort() {
		if (this._engine) this._engine.abort();
		this._restore();
	}

	_resetInactivity() {
		var handler = this._call && this._call.currentHandler;
		if (handler && typeof handler.resetInactivityTimeouts === 'function') {
			handler.resetInactivityTimeouts();
		}
	}

	_createAdapter() {
		var call = this._call;
		var self = this;

		// Clear inactivity timeouts at start of transfer
		self._resetInactivity();

		// Suppress non-protocol terminal output (XMODEM has no escaping)
		self._previousSend = call.cmds._send.bind(call.cmds);
		self._transferActive = true;
		call.cmds._send = function() {
			// Block all non-adapter writes during transfer
		};

		return {
			write: function(buf) {
				if (self._previousSend) {
					self._previousSend(Buffer.from(buf));
				}
			},
			onData: function(cb) {
				if (!call) return;
				self._previousRawmode = call.rawmode;
				self._previousRawtarget = call.rawtarget;
				call.rawmode = true;
				call.rawtarget = function(data) {
					// Reset inactivity on each incoming data event
					self._resetInactivity();
					cb(Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary'));
				};
			},
			offData: function() {
				self._restore();
			}
		};
	}

	_restore() {
		if (this._call) {
			this._call.rawmode = this._previousRawmode;
			this._call.rawtarget = this._previousRawtarget;
			if (this._previousSend) {
				this._call.cmds._send = this._previousSend;
				this._previousSend = null;
			}
			this._transferActive = false;
			// Restore inactivity timeouts
			this._resetInactivity();
		}
	}
}

export { NativeXmodemProtocol };
