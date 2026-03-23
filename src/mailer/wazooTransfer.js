// mailer/wazooTransfer.js — Wazoo batch file transfer engine.
//
// Orchestrates half-duplex ZMODEM file exchange after EMSI handshake.
// The Wazoo batch sequence is:
//   1. Answerer sends files (ZMODEM session)
//   2. Answerer signals end (ZFIN)
//   3. Caller sends files (ZMODEM session)
//   4. Caller signals end (ZFIN)
//   5. Session complete
//
// Each ZMODEM session is a complete send or receive using the native
// ZmodemEngine via the StreamAdapter pattern (same as terminal transfers).

import { EventEmitter } from 'node:events';
import { ZmodemEngine } from '../transfers/zmodem.js';
import * as alogger from '../utils/alogger.js';

class WazooTransferEngine extends EventEmitter {
	constructor(transport, options) {
		super();
		this._transport = transport;
		this._opts = options || {};

		this._role = this._opts.role || 'caller';
		this._inboundDir = this._opts.inboundDir || 'ftn/in';
		this._tempDir = this._opts.tempDir || 'ftn/tmp';
		this._outboundFiles = this._opts.outboundFiles || []; // [{ path, name?, size? }]
		this._sessionId = this._opts.sessionId || 'wazoo';

		this._filesSent = 0;
		this._filesReceived = 0;
		this._aborted = false;
	}

	/**
	 * Execute the full Wazoo batch sequence.
	 * @returns {Promise<{success: boolean, filesSent: number, filesReceived: number, error?: string}>}
	 */
	async run() {
		try {
			if (this._role === 'answerer') {
				// Answerer sends first, then receives
				await this._sendBatch();
				if (this._aborted) return this._result(false, 'Aborted');
				await this._receiveBatch();
			} else {
				// Caller receives first, then sends
				await this._receiveBatch();
				if (this._aborted) return this._result(false, 'Aborted');
				await this._sendBatch();
			}

			if (this._aborted) return this._result(false, 'Aborted');

			alogger.writeClog(5,
				'Wazoo ' + this._sessionId + ': complete — sent ' + this._filesSent +
				', received ' + this._filesReceived, 'mailer', 'greenbright');

			this.emit('allComplete', {
				filesSent: this._filesSent,
				filesReceived: this._filesReceived
			});

			return this._result(true);
		} catch (err) {
			alogger.writeClog(3,
				'Wazoo ' + this._sessionId + ': error — ' + err.message,
				'mailer', 'redbright');
			return this._result(false, err.message);
		}
	}

	abort() {
		this._aborted = true;
	}

	// ======================================================================
	// SEND BATCH
	// ======================================================================

	async _sendBatch() {
		var adapter = this._createAdapter();

		var engine = new ZmodemEngine(adapter, {
			subpacketSize: 1024,
			escapeCtl: true,
			timeout: 30000,
			initialCrcMode: 'zbin_crc16', // Maximum legacy compatibility
		});

		engine.on('error', function() {}); // Prevent unhandled
		engine.on('fileComplete', (info) => {
			this._filesSent++;
			alogger.writeClog(5,
				'Wazoo ' + this._sessionId + ': sent ' + info.name,
				'mailer', 'green');
			this.emit('sendComplete', info);
		});
		engine.on('progress', (info) => {
			this.emit('sendProgress', info);
		});

		var result;
		if (this._outboundFiles.length === 0) {
			// No files — send empty batch
			result = await engine.sendEmpty();
		} else {
			result = await engine.send(this._outboundFiles);
		}

		this.emit('batchComplete', { direction: 'send' });

		if (!result.success && result.error) {
			alogger.writeClog(3,
				'Wazoo ' + this._sessionId + ': send batch error — ' + result.error,
				'mailer', 'yellow');
		}

		return result;
	}

	// ======================================================================
	// RECEIVE BATCH
	// ======================================================================

	async _receiveBatch() {
		var adapter = this._createAdapter();

		var engine = new ZmodemEngine(adapter, {
			escapeCtl: true,
			timeout: 30000,
		});

		engine.on('error', function() {}); // Prevent unhandled
		engine.on('fileComplete', (info) => {
			this._filesReceived++;
			alogger.writeClog(5,
				'Wazoo ' + this._sessionId + ': received ' + info.name +
				' (' + info.size + ' bytes)', 'mailer', 'green');
			this.emit('receiveComplete', info);
		});
		engine.on('progress', (info) => {
			this.emit('receiveProgress', info);
		});

		var result = await engine.receive(this._inboundDir);

		this.emit('batchComplete', { direction: 'receive' });

		if (!result.success && result.error) {
			alogger.writeClog(3,
				'Wazoo ' + this._sessionId + ': receive batch error — ' + result.error,
				'mailer', 'yellow');
		}

		return result;
	}

	// ======================================================================
	// ADAPTER
	// ======================================================================

	_createAdapter() {
		var transport = this._transport;
		var dataHandler = null;

		return {
			write: function(buf) {
				transport.write(buf);
			},
			onData: function(cb) {
				dataHandler = cb;
				transport.on('data', dataHandler);
			},
			offData: function() {
				if (dataHandler) {
					transport.removeListener('data', dataHandler);
					dataHandler = null;
				}
			}
		};
	}

	// ======================================================================
	// HELPERS
	// ======================================================================

	_result(success, error) {
		return {
			success: success,
			filesSent: this._filesSent,
			filesReceived: this._filesReceived,
			error: error || null
		};
	}
}

export { WazooTransferEngine };
