// protocols/base.js — Base class for file transfer protocols
//
// Uses child_process.spawn with raw stdio pipes (NOT node-pty).
// PTY would do terminal processing (line ending conversion, etc.) that
// corrupts ZMODEM binary frames.  Raw pipes give byte-for-byte passthrough.
//
// Raw mode pattern borrowed from DoorRunner — saves/restores call.rawmode
// so client bytes go directly to the transfer tool's stdin.

import { EventEmitter } from 'node:events';
import { spawn } from "child_process";
import * as pty from "node-pty";
import * as alogger from "../utils/alogger.js";

class BaseProtocol extends EventEmitter {
	constructor(call, protocolName) {
		super();
		this.call = call;
		this.protocolName = protocolName || "Base";
		this.active = false;

		// Raw mode state save
		this._previousRawmode = false;
		this._previousRawtarget = null;

		// Process handle
		this._child = null;

		// Transfer state
		this._transferComplete = false;
		this._exitCode = null;

		this.loggingId = "Protocol:" + this.protocolName + " (Node " + (call ? call.nodenum : '?') + ")";
	}

	// --- Raw mode management (same pattern as DoorRunner) ---

	_enableRawMode() {
		if (!this.call) return;
		this._previousRawmode = this.call.rawmode;
		this._previousRawtarget = this.call.rawtarget;
		this.call.rawmode = true;
		this.call.rawtarget = (data) => {
			this._onClientData(data);
		};
	}

	_disableRawMode() {
		if (!this.call) return;
		this.call.rawmode = this._previousRawmode;
		this.call.rawtarget = this._previousRawtarget;
	}

	// Client data → child stdin
	_onClientData(data) {
		if (!this.active || !this._child || !this._child.stdin || this._child.stdin.destroyed) return;
		try {
			this._child.stdin.write(data);
		} catch (err) {
			alogger.writeAlog(4, this.loggingId + " stdin write error: " + err.message, "yellow");
		}
	}

	// --- Subclass override ---

	/**
	 * Build the command and args for the transfer tool.
	 * @param {string[]} filePaths — absolute paths to files to send
	 * @returns {{ cmd: string, args: string[] }}
	 */
	_buildCommand(filePaths) {
		throw new Error("Subclass must implement _buildCommand()");
	}

	// --- Transfer execution ---

	/**
	 * Send one or more files.
	 * @param {string[]} filePaths — absolute paths to files
	 * @returns {Promise<{ success: boolean, exitCode: number, error: string|null }>}
	 */
	send(filePaths) {
		var self = this;

		return new Promise(function(resolve) {
			if (!self.call) {
				return resolve({ success: false, exitCode: -1, error: "No call object" });
			}

			if (!filePaths || filePaths.length === 0) {
				return resolve({ success: false, exitCode: -1, error: "No files specified" });
			}

			var cmdInfo;
			try {
				cmdInfo = self._buildCommand(filePaths);
			} catch (err) {
				return resolve({ success: false, exitCode: -1, error: err.message });
			}

			alogger.writeAlog(4, self.loggingId + "\n  Sending " + filePaths.length + " file(s): " + cmdInfo.cmd + " " + cmdInfo.args.join(" "), "cyan");

			self.active = true;
			self._transferComplete = false;

			try {
				// Spawn with raw stdio pipes — no terminal processing
				self._child = spawn(cmdInfo.cmd, cmdInfo.args, {
					stdio: ['pipe', 'pipe', 'pipe'],
					cwd: process.cwd(),
					env: process.env
				});

				// Child stdout → client (raw bytes, no conversion)
				self._child.stdout.on('data', function(chunk) {
					if (self.call) {
						self.call.cmds.senddata(chunk);
					}
				});

				// Child stderr → log (for debugging)
				self._child.stderr.on('data', function(chunk) {
					var msg = chunk.toString().trim();
					if (msg) {
						alogger.writeAlog(5, self.loggingId + " stderr: " + msg, "yellow");
					}
				});

				// Process exit
				self._child.on('close', function(code) {
					self._exitCode = code;
					self._onTransferEnd(code);
				});

				self._child.on('error', function(err) {
					alogger.writeAlog(2, self.loggingId + " process error: " + err.message, "redbright");
					self._cleanup();
					if (!self._transferComplete) {
						self._transferComplete = true;
						resolve({ success: false, exitCode: -1, error: err.message });
					}
				});

				// Enable raw mode so client bytes go to child stdin
				self._enableRawMode();

				// Safety timeout (5 minutes per file, minimum 60 seconds)
				var timeoutMs = Math.max(60000, filePaths.length * 300000);
				var timer = setTimeout(function() {
					alogger.writeAlog(3, self.loggingId + " Transfer timeout", "redbright");
					self._cleanup();
					if (!self._transferComplete) {
						self._transferComplete = true;
						resolve({ success: false, exitCode: -1, error: "Transfer timeout" });
					}
				}, timeoutMs);

				// Wait for completion
				self.once('done', function(result) {
					clearTimeout(timer);
					resolve(result);
				});

			} catch (err) {
				alogger.writeAlog(2, self.loggingId + " Spawn failed: " + err.message, "redbright");
				self._cleanup();
				resolve({ success: false, exitCode: -1, error: "Spawn failed: " + err.message });
			}
		});
	}

	/**
	 * Receive files from the client into a target directory.
	 * Uses a PTY (rz requires a tty for proper ZMODEM handshaking).
	 * @param {string} targetDir — directory where received files will land
	 * @param {{ cmd: string, args: string[] }} cmdInfo — command to run
	 * @returns {Promise<{ success: boolean, exitCode: number, error: string|null }>}
	 */
	receiveInto(targetDir, cmdInfo) {
		var self = this;

		return new Promise(function(resolve) {
			if (!self.call) {
				return resolve({ success: false, exitCode: -1, error: "No call object" });
			}

			alogger.writeAlog(4, self.loggingId + "\n  Receiving into: " + targetDir + "  cmd: " + cmdInfo.cmd + " " + cmdInfo.args.join(" "), "cyan");

			self.active = true;
			self._transferComplete = false;

			try {
				// rz needs a tty for ZMODEM handshaking — use PTY
				self._pty = pty.spawn(cmdInfo.cmd, cmdInfo.args, {
					name: 'dumb',
					cols: 80,
					rows: 24,
					cwd: targetDir,
					env: process.env
				});

				// PTY data → client (raw binary)
				self._pty.onData(function(data) {
					if (self.call) {
						self.call.cmds.senddata(Buffer.from(data, 'binary'));
					}
				});

				self._pty.on('exit', function(code) {
					self._exitCode = code;
				});

				self._pty.on('close', function() {
					self._onTransferEnd(self._exitCode || 0);
				});

				// Override raw mode target to write to PTY
				self._previousRawmode = self.call.rawmode;
				self._previousRawtarget = self.call.rawtarget;
				self.call.rawmode = true;
				self.call.rawtarget = function(data) {
					if (!self.active || !self._pty) return;
					try {
						self._pty.write(data);
					} catch (err) {
						alogger.writeAlog(4, self.loggingId + " pty write error: " + err.message, "yellow");
					}
				};

				// 5 minute timeout for receive
				var timer = setTimeout(function() {
					alogger.writeAlog(3, self.loggingId + " Receive timeout", "redbright");
					self._cleanupPty();
					if (!self._transferComplete) {
						self._transferComplete = true;
						resolve({ success: false, exitCode: -1, error: "Receive timeout" });
					}
				}, 300000);

				self.once('done', function(result) {
					clearTimeout(timer);
					resolve(result);
				});

			} catch (err) {
				alogger.writeAlog(2, self.loggingId + " Spawn failed: " + err.message, "redbright");
				self._cleanup();
				resolve({ success: false, exitCode: -1, error: "Spawn failed: " + err.message });
			}
		});
	}

	/**
	 * Receive files using raw pipes (not PTY).
	 * For use with wrappers like 'script' that provide their own PTY.
	 */
	receiveIntoRaw(targetDir, cmdInfo) {
		var self = this;

		return new Promise(function(resolve) {
			if (!self.call) {
				return resolve({ success: false, exitCode: -1, error: "No call object" });
			}

			alogger.writeAlog(4, self.loggingId + "\n  Receiving (raw) into: " + targetDir + "  cmd: " + cmdInfo.cmd + " " + cmdInfo.args.join(" "), "cyan");

			self.active = true;
			self._transferComplete = false;

			try {
				self._child = spawn(cmdInfo.cmd, cmdInfo.args, {
					stdio: ['pipe', 'pipe', 'pipe'],
					cwd: targetDir,
					env: process.env
				});

				self._child.stdout.on('data', function(chunk) {
					if (self.call) {
						self.call.cmds.senddata(chunk);
					}
				});

				self._child.stderr.on('data', function(chunk) {
					var msg = chunk.toString().trim();
					if (msg) {
						alogger.writeAlog(5, self.loggingId + " stderr: " + msg, "yellow");
					}
				});

				self._child.on('close', function(code) {
					self._exitCode = code;
					self._onTransferEnd(code);
				});

				self._child.on('error', function(err) {
					alogger.writeAlog(2, self.loggingId + " process error: " + err.message, "redbright");
					self._cleanup();
					if (!self._transferComplete) {
						self._transferComplete = true;
						resolve({ success: false, exitCode: -1, error: err.message });
					}
				});

				self._enableRawMode();

				var timer = setTimeout(function() {
					alogger.writeAlog(3, self.loggingId + " Receive timeout", "redbright");
					self._cleanup();
					if (!self._transferComplete) {
						self._transferComplete = true;
						resolve({ success: false, exitCode: -1, error: "Receive timeout" });
					}
				}, 300000);

				self.once('done', function(result) {
					clearTimeout(timer);
					resolve(result);
				});

			} catch (err) {
				alogger.writeAlog(2, self.loggingId + " Spawn failed: " + err.message, "redbright");
				self._cleanup();
				resolve({ success: false, exitCode: -1, error: "Spawn failed: " + err.message });
			}
		});
	}

	_cleanupPty() {
		this._disableRawMode();
		if (this._pty) {
			try { this._pty.kill(); } catch (_) {}
			this._pty = null;
		}
		this.active = false;
	}

	_onTransferEnd(code) {
		if (this._transferComplete) return;
		this._transferComplete = true;
		this.active = false;

		var exitCode = this._exitCode !== null ? this._exitCode : code;
		var success = exitCode === 0;

		alogger.writeAlog(4, this.loggingId + " Transfer " + (success ? "complete" : "failed") + " (exit " + exitCode + ")", success ? "greenbright" : "redbright");

		if (this._pty) {
			this._cleanupPty();
		} else {
			this._cleanup();
		}

		this.emit('done', {
			success: success,
			exitCode: exitCode,
			error: success ? null : "Transfer exited with code " + exitCode
		});
	}

	_cleanup() {
		this._disableRawMode();

		if (this._child) {
			try {
				if (this._child.stdin && !this._child.stdin.destroyed) {
					this._child.stdin.end();
				}
				this._child.kill();
			} catch (_) {}
			this._child = null;
		}

		this.active = false;
	}

	/**
	 * Abort a transfer in progress.
	 */
	abort() {
		alogger.writeAlog(3, this.loggingId + " Aborting transfer", "yellow");
		this._cleanup();
		if (!this._transferComplete) {
			this._transferComplete = true;
			this.emit('done', { success: false, exitCode: -1, error: "Aborted" });
		}
	}
}

export { BaseProtocol };
