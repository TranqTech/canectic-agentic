// protocols/zmodem_native.js — Terminal ZMODEM wrapper (native engine).
//
// Bridges the native ZmodemEngine to a terminal call object.
// Provides the same send() API as the existing ZmodemProtocol (lrzsz wrapper)
// so callers (fileBrowser, fileBatchDownload, etc.) can use it without changes.
//
// During transfer:
// - Inactivity timeouts are cleared and reset on each data event to prevent
//   stray terminal output from interfering with the protocol stream.
// - Non-protocol terminal output is suppressed via _send guard.

import { ZmodemEngine } from '../transfers/zmodem.js';

class NativeZmodemProtocol {
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

		var adapter = this._createAdapter();
		this._engine = new ZmodemEngine(adapter, {
			subpacketSize: this._opts.subpacketSize || 1024,
			escapeCtl: this._opts.escapeCtl || false,
			timeout: this._opts.timeout || 15000,
			initialCrcMode: this._call.zmodem_crc_mode || 'zbin_crc16',
		});

		this._engine.on('error', function() {});
		this._engine.on('headerRx', function(h) {
			if (h.type === 'ZRINIT_CAPS') {
				var alogger = import('../utils/alogger.js');
				alogger.then(function(m) {
					var raw = h.raw || {};
					m.writeAlog(3, 'ZMODEM ZRINIT raw bytes: p0=0x' + (raw.p0 || 0).toString(16) +
						' p1=0x' + (raw.p1 || 0).toString(16) +
						' p2=0x' + (raw.p2 || 0).toString(16) +
						' p3=0x' + (raw.p3 || 0).toString(16) +
						' | ZF0(p3)=0x' + (h.flags_ZF0 || 0).toString(16) +
						' canFC32=' + h.canFC32 + ' escCtl=' + h.escCtl + ' window=' + h.window, 'cyan');
				});
			}
		});

		var result = await this._engine.send(filePaths);
		this._restore();
		return result;
	}

	async receive(targetDir) {
		var adapter = this._createAdapter();
		this._engine = new ZmodemEngine(adapter, {
			escapeCtl: this._opts.escapeCtl || false,
			timeout: this._opts.timeout || 15000,
		});

		this._engine.on('error', function() {});

		var result = await this._engine.receive(targetDir);
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

		// Suppress non-protocol terminal output during transfer
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

export { NativeZmodemProtocol };
