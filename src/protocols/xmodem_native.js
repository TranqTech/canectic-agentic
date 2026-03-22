// protocols/xmodem_native.js — Terminal XMODEM wrapper.
//
// Bridges the native XmodemEngine to a terminal call object.
// Provides the same send()/receive() API as the ZMODEM protocol wrappers
// so callers (fileBrowser, fileBatchDownload, etc.) can use it without changes.

import { XmodemEngine } from '../transfers/xmodem.js';

class NativeXmodemProtocol {
	constructor(call, options) {
		this._call = call;
		this._opts = options || {};
		this._engine = null;
		this._previousRawmode = false;
		this._previousRawtarget = null;
	}

	/**
	 * Send files via XMODEM. Only supports one file at a time (XMODEM limitation).
	 * @param {string[]} filePaths — array of file paths (only first is used)
	 * @returns {Promise<{success: boolean, error?: string}>}
	 */
	async send(filePaths) {
		if (!filePaths || filePaths.length === 0) {
			return { success: false, error: 'No files to send' };
		}

		// XMODEM sends one file at a time — send them sequentially
		for (var i = 0; i < filePaths.length; i++) {
			var adapter = this._createAdapter();
			this._engine = new XmodemEngine(adapter, {
				blockSize: this._opts.blockSize || 1024, // Default to 1K
				timeout: this._opts.timeout || 10000,
			});

			var result = await this._engine.send(filePaths[i]);
			this._restoreRawMode();

			if (!result.success) {
				return result;
			}
		}

		return { success: true };
	}

	/**
	 * Receive a file via XMODEM.
	 * @param {string} targetDir — directory to write into
	 * @param {string} [fileName] — filename to use
	 * @returns {Promise<{success: boolean, files?: Array, error?: string}>}
	 */
	async receive(targetDir, fileName) {
		var adapter = this._createAdapter();
		this._engine = new XmodemEngine(adapter, {
			blockSize: this._opts.blockSize || 1024,
			timeout: this._opts.timeout || 10000,
		});

		var result = await this._engine.receive(targetDir, fileName);
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
				// Save current raw mode state
				self._previousRawmode = call.rawmode;
				self._previousRawtarget = call.rawtarget;
				// Enable raw mode — bytes from client go directly to cb
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

export { NativeXmodemProtocol };
