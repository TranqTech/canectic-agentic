// protocols/zmodem_native.js — Terminal ZMODEM wrapper (native engine).
//
// Bridges the native ZmodemEngine to a terminal call object.
// Provides the same send() API as the existing ZmodemProtocol (lrzsz wrapper)
// so callers (fileBrowser, fileBatchDownload, etc.) can use it without changes.

import { ZmodemEngine } from '../transfers/zmodem.js';

class NativeZmodemProtocol {
	constructor(call, options) {
		this._call = call;
		this._opts = options || {};
		this._engine = null;
		this._previousRawmode = false;
		this._previousRawtarget = null;
	}

	/**
	 * Send files via ZMODEM.
	 * @param {string[]} filePaths — array of file paths
	 * @returns {Promise<{success: boolean, error?: string}>}
	 */
	async send(filePaths) {
		if (!filePaths || filePaths.length === 0) {
			return { success: false, error: 'No files to send' };
		}

		var adapter = this._createAdapter();
		this._engine = new ZmodemEngine(adapter, {
			subpacketSize: this._opts.subpacketSize || 1024,
			escapeCtl: this._opts.escapeCtl || false,
			timeout: this._opts.timeout || 15000,
		});

		var result = await this._engine.send(filePaths);
		this._restoreRawMode();
		return result;
	}

	abort() {
		if (this._engine) {
			this._engine.abort();
		}
		this._restoreRawMode();
	}

	_createAdapter() {
		var call = this._call;
		var self = this;

		return {
			write: function(buf) {
				if (call && call.connection) {
					call.connection.sendRawBinary(buf);
				}
			},
			onData: function(cb) {
				if (!call) return;
				self._previousRawmode = call.rawmode;
				self._previousRawtarget = call.rawtarget;
				call.rawmode = true;
				call.rawtarget = function(data) {
					cb(Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary'));
				};
			},
			offData: function() {
				self._restoreRawMode();
			}
		};
	}

	_restoreRawMode() {
		if (this._call) {
			this._call.rawmode = this._previousRawmode;
			this._call.rawtarget = this._previousRawtarget;
		}
	}
}

export { NativeZmodemProtocol };
