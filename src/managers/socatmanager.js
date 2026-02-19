import { exec } from "child_process";
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from "os";
import { EventEmitter } from 'node:events';
import * as alogger from "../utils/alogger.js";

const vdevdir = homedir() + "/vdev";
const socatpref = vdevdir + "/p";
const defaultTimeout = 10000;
const healthCheckInterval = 30000;

class SocatPortPair {
	constructor(portNum, process, port1Path, port2Path) {
		this.portNum = portNum;
		this.process = process;
		this.port1 = port1Path;
		this.port2 = port2Path;
		this.pid = process.pid;
		this.ready = false;
		this.inUse = false;
		this.createdAt = Date.now();
	}
}

class SocatManager {
	constructor() {
		this.activePairs = new Map(); // portNum -> SocatPortPair
		this.loggingId = "SocatManager";
		this._healthCheckTimer = null;

		// Ensure vdev directory exists
		if (!existsSync(vdevdir)) {
			mkdirSync(vdevdir, { recursive: true });
		}

		// Clean up any orphaned files from previous runs
		this._cleanupOrphans();

		// Start periodic health checks
		this._startHealthCheck();
	}

	// --- Port allocation ---
	async allocate(timeout) {
		timeout = timeout || defaultTimeout;

		var portNum = this._findAvailablePortNum();
		if (portNum === null) {
			throw new Error("No available socat port pairs");
		}

		var port1 = socatpref + portNum;
		var port2 = socatpref + (portNum + 1);

		var pair = await this._startSocat(portNum, port1, port2, timeout);
		this.activePairs.set(portNum, pair);

		var logmsg = this.loggingId + "\n  Allocated port pair " + portNum + "/" + (portNum + 1) + " (PID " + pair.pid + ")";
		alogger.writeAlog(5, logmsg, "greenbright");

		return {
			port1: port1,
			port2: port2,
			portNum: portNum
		};
	}

	release(portNum) {
		var pair = this.activePairs.get(portNum);
		if (!pair) return;

		var logmsg = this.loggingId + "\n  Releasing port pair " + portNum + "/" + (portNum + 1);
		alogger.writeAlog(5, logmsg, "cyan");

		this._killPair(pair);
		this.activePairs.delete(portNum);
	}

	// --- Internal ---
	_findAvailablePortNum() {
		// Use odd numbers so pairs are always (n, n+1)
		for (var i = 1; i < 200; i += 2) {
			// Check not already tracked by us
			if (this.activePairs.has(i)) continue;
			// Check files don't exist (orphans from other processes)
			if (existsSync(socatpref + i)) continue;
			if (existsSync(socatpref + (i + 1))) continue;
			return i;
		}
		return null;
	}

	_startSocat(portNum, port1, port2, timeout) {
		return new Promise((resolve, reject) => {
			var settled = false;
			var socatProcess = null;
			var pollTimer = null;
			var timeoutTimer = null;

			var cleanup = (err) => {
				if (settled) return;
				settled = true;
				clearInterval(pollTimer);
				clearTimeout(timeoutTimer);
				if (err) {
					// Kill the process if it started
					if (socatProcess) {
						try { socatProcess.kill(); } catch (_) {}
					}
					this._cleanupFiles(port1, port2);
					reject(err);
				}
			};

			try {
				var socatcmd = "socat -d pty,raw,echo=0,link=" + port1 + " pty,raw,echo=0,link=" + port2;
				socatProcess = exec(socatcmd);
			} catch (err) {
				cleanup(new Error("Socat exec failed: " + err.message));
				return;
			}

			socatProcess.on('error', (err) => {
				cleanup(new Error("Socat process error: " + err.message));
			});

			socatProcess.on('close', (code) => {
				if (!settled) {
					cleanup(new Error("Socat exited prematurely with code " + code));
				}
			});

			// Poll for file creation rather than using chokidar
			// More reliable and avoids watcher setup/teardown overhead
			pollTimer = setInterval(() => {
				if (existsSync(port1) && existsSync(port2)) {
					if (settled) return;
					settled = true;
					clearInterval(pollTimer);
					clearTimeout(timeoutTimer);

					var pair = new SocatPortPair(portNum, socatProcess, port1, port2);
					pair.ready = true;
					pair.inUse = true;
					resolve(pair);
				}
			}, 100);

			timeoutTimer = setTimeout(() => {
				cleanup(new Error("Socat port creation timed out after " + timeout + "ms"));
			}, timeout);
		});
	}

	_killPair(pair) {
		// Kill the process first
		if (pair.process) {
			try {
				pair.process.kill('SIGTERM');
			} catch (_) {}
			// Force kill after a short delay if it doesn't die
			setTimeout(() => {
				try {
					pair.process.kill('SIGKILL');
				} catch (_) {}
			}, 2000);
		}

		// Clean up the port files
		// Small delay to let socat clean up after itself first
		setTimeout(() => {
			this._cleanupFiles(pair.port1, pair.port2);
		}, 500);
	}

	_cleanupFiles(...paths) {
		for (var p of paths) {
			try {
				if (existsSync(p)) {
					unlinkSync(p);
					alogger.writeAlog(5, this.loggingId + "\n  Cleaned up: " + p, "cyan");
				}
			} catch (err) {
				alogger.writeAlog(3, this.loggingId + "\n  Failed to clean up " + p + ": " + err.message, "yellow");
			}
		}
	}

	// --- Orphan cleanup ---
	_cleanupOrphans() {
		// On startup, remove any leftover port files and kill stale socat processes
		var logmsg = this.loggingId + "\n  Checking for orphaned socat ports...";
		alogger.writeAlog(5, logmsg, "cyan");

		var cleaned = 0;
		for (var i = 1; i < 200; i++) {
			var portPath = socatpref + i;
			if (existsSync(portPath)) {
				try {
					unlinkSync(portPath);
					cleaned++;
				} catch (_) {}
			}
		}

		if (cleaned > 0) {
			alogger.writeAlog(4, this.loggingId + "\n  Cleaned " + cleaned + " orphaned port files", "yellowbright");
		}

		// Kill any lingering socat processes that reference our vdev dir
		try {
			exec("pkill -f 'socat.*" + vdevdir + "'", (err) => {
				// Ignore errors — just means nothing to kill
			});
		} catch (_) {}
	}

	// --- Health checks ---
	_startHealthCheck() {
		this._healthCheckTimer = setInterval(() => {
			this._runHealthCheck();
		}, healthCheckInterval);
	}

	_runHealthCheck() {
		for (var [portNum, pair] of this.activePairs) {
			var healthy = true;

			// Check if the process is still alive
			if (pair.process) {
				try {
					// Sending signal 0 checks if process exists without killing it
					process.kill(pair.pid, 0);
				} catch (_) {
					healthy = false;
				}
			} else {
				healthy = false;
			}

			// Check if the port files still exist
			if (!existsSync(pair.port1) || !existsSync(pair.port2)) {
				healthy = false;
			}

			if (!healthy) {
				var logmsg = this.loggingId + "\n  Unhealthy port pair detected: " + portNum + "/" + (portNum + 1) + " — cleaning up";
				alogger.writeAlog(3, logmsg, "yellowbright");
				this.release(portNum);
			}
		}
	}

	// --- Shutdown ---
	shutdown() {
		clearInterval(this._healthCheckTimer);

		var logmsg = this.loggingId + "\n  Shutting down. Releasing " + this.activePairs.size + " port pairs.";
		alogger.writeAlog(4, logmsg, "cyan");

		for (var [portNum] of this.activePairs) {
			this.release(portNum);
		}
	}

	// --- Status ---
	getStatus() {
		return {
			activePairs: this.activePairs.size,
			ports: Array.from(this.activePairs.entries()).map(([num, pair]) => ({
				portNum: num,
				pid: pair.pid,
				ready: pair.ready,
				inUse: pair.inUse,
				age: Date.now() - pair.createdAt
			}))
		};
	}
}

export { SocatManager };