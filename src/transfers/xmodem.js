// transfers/xmodem.js — Native XMODEM-CRC / XMODEM-1K engine.
//
// Pure byte-stream state machine. Works over any bidirectional channel
// via the StreamAdapter duck-type: { write(buf), onData(cb), offData() }.
//
// Supports:
//   - XMODEM-CRC (128-byte blocks, CRC-16)
//   - XMODEM-1K  (1024-byte blocks, CRC-16)
//
// Does NOT support plain checksum XMODEM. If a receiver sends NAK
// instead of 'C', the transfer is aborted.

import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as path from 'path';
import { crc16 } from './crc.js';
import { SOH, STX, EOT, ACK, NAK, CAN, SUB } from './constants.js';

var C_BYTE = 0x43; // 'C' — receiver requests CRC mode

// Retry and timeout defaults
var DEFAULT_TIMEOUT    = 10000;  // 10s per-block timeout
var DEFAULT_MAX_ERRORS = 10;     // max consecutive errors before abort
var INIT_TIMEOUT       = 60000;  // 60s waiting for initial 'C' or NAK
var CAN_COUNT          = 3;      // consecutive CANs to abort

class XmodemEngine extends EventEmitter {
	constructor(adapter, options) {
		super();
		this._adapter = adapter;
		this._opts = options || {};
		this._blockSize = this._opts.blockSize || 128;
		this._timeout = this._opts.timeout || DEFAULT_TIMEOUT;
		this._maxErrors = this._opts.maxErrors || DEFAULT_MAX_ERRORS;

		this._state = 'idle';
		this._timer = null;
		this._errors = 0;
		this._canCount = 0;
		this._aborted = false;

		// Send state
		this._fileHandle = null;
		this._fileSize = 0;
		this._blockNum = 1;
		this._bytesSent = 0;
		this._currentBlock = null;
		this._sendResolve = null;
		this._sendReject = null;
		this._fileName = '';

		// Receive state
		this._writeStream = null;
		this._expectedBlock = 1;
		this._bytesReceived = 0;
		this._recvBuf = Buffer.alloc(0);
		this._recvResolve = null;
		this._recvReject = null;
		this._targetDir = '';
		this._recvFileName = '';
	}

	// ======================================================================
	// SEND
	// ======================================================================

	/**
	 * Send a single file via XMODEM.
	 * @param {string} filePath — absolute path to file
	 * @param {string} [fileName] — display name (defaults to basename)
	 * @returns {Promise<{success: boolean, error?: string}>}
	 */
	send(filePath, fileName) {
		var self = this;
		this._fileName = fileName || path.basename(filePath);

		return new Promise(function(resolve, reject) {
			self._sendResolve = resolve;
			self._sendReject = reject;

			// Wire adapter FIRST — the receiver may send 'C' before
			// our async file open completes.
			self._blockNum = 1;
			self._bytesSent = 0;
			self._errors = 0;
			self._state = 'await_c';
			self._sendFilePath = filePath;

			self._adapter.onData(function(data) { self._onSendData(data); });
			self._startTimer(INIT_TIMEOUT, 'Timeout waiting for receiver');
		});
	}

	_openFileAndSend() {
		var self = this;
		var filePath = this._sendFilePath;

		fs.stat(filePath, function(err, stats) {
			if (err) {
				self._finish(false, 'File not found: ' + filePath);
				return;
			}

			self._fileSize = stats.size;
			self.emit('fileStart', { name: self._fileName, size: self._fileSize });

			fs.open(filePath, 'r', function(err2, fd) {
				if (err2) {
					self._finish(false, 'Cannot open file: ' + err2.message);
					return;
				}

				self._fileHandle = fd;
				self._sendNextBlock();
			});
		});
	}

	_onSendData(data) {
		if (this._aborted) return;

		for (var i = 0; i < data.length; i++) {
			var b = data[i];

			// Check for CAN sequence
			if (b === CAN) {
				this._canCount++;
				if (this._canCount >= CAN_COUNT) {
					this._finish(false, 'Transfer cancelled by receiver');
					return;
				}
				continue;
			}
			this._canCount = 0;

			if (this._state === 'await_c') {
				if (b === C_BYTE) {
					// Receiver wants CRC mode — open file and start sending
					this._clearTimer();
					this._state = 'sending';
					this._openFileAndSend();
				} else if (b === NAK) {
					// Receiver wants checksum mode — we don't support it
					this._sendCancel();
					this._finish(false, 'Receiver requested checksum mode (unsupported)');
					return;
				}
				// Ignore other bytes during init
			} else if (this._state === 'await_ack') {
				if (b === ACK) {
					this._clearTimer();
					this._errors = 0;
					this._blockNum = (this._blockNum + 1) & 0xFF;
					this._sendNextBlock();
				} else if (b === NAK) {
					this._clearTimer();
					this._errors++;
					if (this._errors >= this._maxErrors) {
						this._sendCancel();
						this._finish(false, 'Too many errors');
						return;
					}
					// Resend current block
					this._resendBlock();
				}
			} else if (this._state === 'await_eot_ack') {
				if (b === ACK) {
					this._clearTimer();
					this.emit('fileComplete', {
						name: this._fileName,
						size: this._fileSize
					});
					this._finish(true);
				} else if (b === NAK) {
					// Resend EOT
					this._clearTimer();
					this._adapter.write(Buffer.from([EOT]));
					this._startTimer(this._timeout, 'Timeout waiting for EOT ACK');
				}
			}
		}
	}

	_sendNextBlock() {
		var self = this;
		var buf = Buffer.alloc(this._blockSize);
		var bytesRead = 0;

		fs.read(this._fileHandle, buf, 0, this._blockSize, this._bytesSent, function(err, nread) {
			if (err) {
				self._sendCancel();
				self._finish(false, 'Read error: ' + err.message);
				return;
			}

			if (nread === 0) {
				// All data sent — send EOT
				self._state = 'await_eot_ack';
				self._adapter.write(Buffer.from([EOT]));
				self._startTimer(self._timeout, 'Timeout waiting for EOT ACK');
				return;
			}

			bytesRead = nread;

			// Pad incomplete block with SUB (0x1A)
			if (nread < self._blockSize) {
				buf.fill(SUB, nread);
			}

			self._bytesSent += nread;
			self._currentBlock = self._buildBlock(buf);
			self._state = 'await_ack';
			self._adapter.write(self._currentBlock);
			self._startTimer(self._timeout, 'Timeout waiting for ACK');

			self.emit('progress', {
				file: self._fileName,
				bytesSent: self._bytesSent,
				totalSize: self._fileSize,
				blockNumber: self._blockNum
			});
		});
	}

	_resendBlock() {
		if (this._currentBlock) {
			this._adapter.write(this._currentBlock);
			this._startTimer(this._timeout, 'Timeout waiting for ACK');
		}
	}

	_buildBlock(data) {
		var header = this._blockSize === 1024 ? STX : SOH;
		var blockNum = this._blockNum & 0xFF;
		var complement = (~blockNum) & 0xFF;

		var crc = crc16(data);
		var crcHi = (crc >>> 8) & 0xFF;
		var crcLo = crc & 0xFF;

		// header + blocknum + complement + data + crc16
		var frame = Buffer.alloc(3 + data.length + 2);
		frame[0] = header;
		frame[1] = blockNum;
		frame[2] = complement;
		data.copy(frame, 3);
		frame[3 + data.length] = crcHi;
		frame[3 + data.length + 1] = crcLo;

		return frame;
	}

	// ======================================================================
	// RECEIVE
	// ======================================================================

	/**
	 * Receive a file via XMODEM.
	 * @param {string} targetDir — directory to write received file into
	 * @param {string} [fileName] — filename to use (defaults to 'xmodem_recv_<timestamp>')
	 * @returns {Promise<{success: boolean, files?: Array, error?: string}>}
	 */
	receive(targetDir, fileName) {
		var self = this;
		this._targetDir = targetDir;
		this._recvFileName = fileName || ('xmodem_recv_' + Date.now());

		return new Promise(function(resolve, reject) {
			self._recvResolve = resolve;
			self._recvReject = reject;

			var fullPath = path.join(targetDir, self._recvFileName);
			self._recvFullPath = fullPath;
			self._writeStream = fs.createWriteStream(fullPath);
			self._expectedBlock = 1;
			self._bytesReceived = 0;
			self._errors = 0;
			self._recvBuf = Buffer.alloc(0);

			self.emit('fileStart', { name: self._recvFileName, size: 0 });

			// Wire adapter
			self._adapter.onData(function(data) { self._onRecvData(data); });

			// Send 'C' to request CRC mode
			self._state = 'recv_init';
			self._sendC();
		});
	}

	_sendC() {
		this._adapter.write(Buffer.from([C_BYTE]));
		this._startTimer(INIT_TIMEOUT, 'Timeout waiting for first block');
	}

	_onRecvData(data) {
		if (this._aborted) return;

		// Accumulate incoming data
		this._recvBuf = Buffer.concat([this._recvBuf, data]);

		this._processRecvBuffer();
	}

	_processRecvBuffer() {
		while (this._recvBuf.length > 0 && !this._aborted) {
			var first = this._recvBuf[0];

			// Check for CAN
			if (first === CAN) {
				this._canCount++;
				this._recvBuf = this._recvBuf.subarray(1);
				if (this._canCount >= CAN_COUNT) {
					this._finishRecv(false, 'Transfer cancelled by sender');
					return;
				}
				continue;
			}
			this._canCount = 0;

			// Check for EOT
			if (first === EOT) {
				this._recvBuf = this._recvBuf.subarray(1);
				this._clearTimer();
				this._adapter.write(Buffer.from([ACK]));
				this._finalizeRecv();
				return;
			}

			// Must be SOH or STX — skip known noise bytes (NUL, XON, XOFF,
			// parity-masked versions) but break on anything else to avoid
			// misaligning block boundaries
			if (first !== SOH && first !== STX) {
				if (first === 0x00 || first === 0x11 || first === 0x13 ||
					first === 0x91 || first === 0x93) {
					// Skip flow control / padding noise
					this._recvBuf = this._recvBuf.subarray(1);
					continue;
				}
				// Unknown byte — don't discard blindly, wait for more data
				// in case this is a partial block that hasn't fully arrived
				break;
			}

			var blockDataSize = first === STX ? 1024 : 128;
			var frameSize = 3 + blockDataSize + 2; // header + blocknum + complement + data + crc16

			if (this._recvBuf.length < frameSize) {
				// Need more data
				break;
			}

			// Extract frame
			var frame = this._recvBuf.subarray(0, frameSize);
			this._recvBuf = this._recvBuf.subarray(frameSize);

			this._clearTimer();
			this._processRecvBlock(frame, blockDataSize);
		}
	}

	_processRecvBlock(frame, blockDataSize) {
		var blockNum = frame[1];
		var complement = frame[2];
		var data = frame.subarray(3, 3 + blockDataSize);
		var rxCrcHi = frame[3 + blockDataSize];
		var rxCrcLo = frame[3 + blockDataSize + 1];
		var rxCrc = (rxCrcHi << 8) | rxCrcLo;

		// Validate complement
		if (((blockNum + complement) & 0xFF) !== 0xFF) {
			this._errors++;
			if (this._errors >= this._maxErrors) {
				this._sendCancel();
				this._finishRecv(false, 'Too many errors');
				return;
			}
			this._adapter.write(Buffer.from([NAK]));
			this._startTimer(this._timeout, 'Timeout waiting for block');
			return;
		}

		// Validate CRC
		var calcCrc = crc16(data);
		if (calcCrc !== rxCrc) {
			this._errors++;
			if (this._errors >= this._maxErrors) {
				this._sendCancel();
				this._finishRecv(false, 'Too many CRC errors');
				return;
			}
			this._adapter.write(Buffer.from([NAK]));
			this._startTimer(this._timeout, 'Timeout waiting for block');
			return;
		}

		// Check block number
		var expected = this._expectedBlock & 0xFF;
		if (blockNum === expected) {
			// Good block — transition state so timeouts send NAK, not 'C'
			this._state = 'receiving';
			this._writeStream.write(data);
			this._bytesReceived += blockDataSize;
			this._expectedBlock = (this._expectedBlock + 1) & 0xFF;
			this._errors = 0;
			this._adapter.write(Buffer.from([ACK]));
			this._startTimer(this._timeout, 'Timeout waiting for next block');

			this.emit('progress', {
				file: this._recvFileName,
				bytesReceived: this._bytesReceived,
				totalSize: 0,
				blockNumber: blockNum
			});
		} else if (blockNum === ((this._expectedBlock - 1) & 0xFF)) {
			// Duplicate — ACK it but don't write again
			this._adapter.write(Buffer.from([ACK]));
			this._startTimer(this._timeout, 'Timeout waiting for next block');
		} else {
			// Out of sequence
			this._sendCancel();
			this._finishRecv(false, 'Block sequence error: expected ' + expected + ' got ' + blockNum);
		}
	}

	_finalizeRecv() {
		var self = this;
		if (this._writeStream) {
			this._writeStream.end(function() {
				// Trim trailing SUB padding from last block
				self._trimPadding(self._recvFullPath);

				self.emit('fileComplete', {
					name: self._recvFileName,
					size: self._bytesReceived,
					path: self._recvFullPath
				});
				self._finishRecv(true);
			});
			this._writeStream = null;
		} else {
			this._finishRecv(true);
		}
	}

	_trimPadding(filePath) {
		// XMODEM pads the last block with SUB (0x1A). For binary files
		// this is wrong — but we cannot know the true file size in basic
		// XMODEM. We trim trailing SUBs as a best-effort heuristic.
		// This matches how most BBS software handles it.
		try {
			var data = fs.readFileSync(filePath);
			var end = data.length;
			while (end > 0 && data[end - 1] === SUB) {
				end--;
			}
			if (end < data.length) {
				fs.writeFileSync(filePath, data.subarray(0, end));
			}
		} catch (_) {
			// Non-fatal — file will have padding
		}
	}

	// ======================================================================
	// ABORT
	// ======================================================================

	abort() {
		if (this._aborted) return;
		this._sendCancel();
		if (this._state.startsWith('recv') || this._state === 'recv_init') {
			this._finishRecv(false, 'Aborted');
		} else {
			this._finish(false, 'Aborted');
		}
	}

	// ======================================================================
	// INTERNAL
	// ======================================================================

	_sendCancel() {
		// Send 5 CANs followed by 5 BSes (standard abort sequence)
		var cancelBuf = Buffer.alloc(10);
		for (var i = 0; i < 5; i++) cancelBuf[i] = CAN;
		for (var j = 5; j < 10; j++) cancelBuf[j] = 0x08; // BS
		this._adapter.write(cancelBuf);
	}

	_startTimer(ms, msg) {
		this._clearTimer();
		var self = this;
		this._timer = setTimeout(function() {
			self._timer = null;
			if (self._state.startsWith('recv') || self._state === 'recv_init') {
				self._errors++;
				if (self._errors >= self._maxErrors) {
					self._sendCancel();
					self._finishRecv(false, msg || 'Timeout');
				} else if (self._state === 'recv_init') {
					// Retry sending 'C'
					self._sendC();
				} else {
					self._adapter.write(Buffer.from([NAK]));
					self._startTimer(ms, msg);
				}
			} else {
				self._finish(false, msg || 'Timeout');
			}
		}, ms);
	}

	_clearTimer() {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
	}

	_finish(success, error) {
		if (this._aborted) return;
		this._aborted = true;
		this._clearTimer();
		this._state = 'done';

		if (this._fileHandle) {
			fs.close(this._fileHandle, function() {});
			this._fileHandle = null;
		}

		this._adapter.offData();

		if (this._sendResolve) {
			this._sendResolve({ success: success, error: error || null });
			this._sendResolve = null;
			this._sendReject = null;
		}
	}

	_finishRecv(success, error) {
		if (this._aborted) return;
		this._aborted = true;
		this._clearTimer();
		this._state = 'done';

		if (this._writeStream) {
			this._writeStream.end();
			this._writeStream = null;
		}

		this._adapter.offData();

		var result = {
			success: success,
			error: error || null,
			files: success ? [{
				name: this._recvFileName,
				size: this._bytesReceived,
				path: this._recvFullPath
			}] : []
		};

		if (this._recvResolve) {
			this._recvResolve(result);
			this._recvResolve = null;
			this._recvReject = null;
		}
	}
}

export { XmodemEngine };
