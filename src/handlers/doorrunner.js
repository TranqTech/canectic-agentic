import { EventEmitter } from 'node:events';
import { spawn, exec } from "child_process";
import { SerialPort } from 'serialport';
import * as pty from "node-pty";
import { existsSync } from 'node:fs';
import { homedir } from "os";
import * as dotenv from 'dotenv';

import { BaseHandler } from "./basehandler.js";
import { DoorOutputParser } from "../helpers/outputParser.js"
import * as alogger from "../utils/alogger.js";
import * as dropfile_handler from "./dropfile_handler.js";
import { substitute, substituteArray } from '../utils/configvars.js';
import appConfig from "../config/appConfig.js";

dotenv.config();

// Launch strategies
const LAUNCH_TYPES = {
	NATIVE_SHELL: "NativeShell",
	EXEC_NATIVE:  "ExecNative",
	SPAWN_NATIVE: "SpawnNative",
	DOSEMU:       "Dosemu",
	DOSEMU_PTY:   "DosemuPty",
};

class DoorRunner extends BaseHandler {
	constructor(call, doorConfig, socatManager) {
		super(call, "DoorRunner");
		this._socatManager = socatManager;
		this._allocatedPortNum = null;
		this._previousRawmode = false;
		this._previousRawtarget = null;
		this._outputParser = null;

		// Door configuration
		this.doorConfig = doorConfig || {};
		this.launchType = doorConfig.launchType || LAUNCH_TYPES.NATIVE_SHELL;
		this.doorCmd = substitute(doorConfig.cmd || "", call, doorConfig);
		this.dropfileType = doorConfig.dropfileType || null;
		this.dropfileDir = doorConfig.dropfileDir
			? substitute(doorConfig.dropfileDir, call, doorConfig)
			: null;
		this.doorArgs = substituteArray(doorConfig.doorArgs, call, doorConfig);
		this.pauseOnExit = doorConfig.pauseOnExit !== undefined ? doorConfig.pauseOnExit : true;
		this.returnStage = doorConfig.returnStage || null;

		// Timeouts
		this.launchTO = appConfig.getNumber('xtrnTO', 30000);
		this.inactivityTO = appConfig.getNumber('doorInactivityTO', 5) * 60 * 1000; // minutes → ms

		// Process handles
		this._child = null;
		this._ptySocket = null;
		this._serialport = null;
		this._outputSocket = null;

		// State
		this._doorExited = false;
		this._waitingForKeypress = false;

		// Runner settings for dropfile
		this.runnerSettings = {
			comport: 5,
			baudrate: call.baudRate || 38400,
			comtype: 2
		};

		this.loggingId = "DoorRunner (Node " + this.call.nodenum + ") [" + this.doorCmd + "]";
	}
	_enableRawMode() {
		if (!this.call) return;
		this._previousRawmode = this.call.rawmode;
		this._previousRawtarget = this.call.rawtarget;
		this.call.rawmode = true;
		this.call.rawtarget = (data) => {
			this._onRawInput(data);
		};
	}

	_disableRawMode() {
		if (!this.call) return;
		this.call.rawmode = this._previousRawmode;
		this.call.rawtarget = this._previousRawtarget;
	}

	_onRawInput(data) {
		if (!this.active) return;
		if (this._waitingForKeypress) {
			this._waitingForKeypress = false;
			this.finished = true;
			this._disableRawMode();
			this.signalReturn();
			return;
		}
		if (this._doorExited) {
			this._disableRawMode();
			this.finished = true;
			this.signalReturn();
			return;
		}
		try {
			if (this._outputSocket) {
				this._outputSocket.write(data);
			} else if (this._child && this._child.stdin) {
				this._child.stdin.write(data);
			} else if (this._ptySocket) {
				this._ptySocket.write(data);
			}
		} catch (err) {
			var logmsg = this.loggingId + "\n  Raw write to process failed: " + err.message;
			alogger.writeAlog(4, logmsg, "yellow");
		}
	}
	// --- Input handling ---
	onKey(key) {
		if (this._waitingForKeypress || this._doorExited) {
			this._waitingForKeypress = false;
			this.finished = true;
			return;
		}
		const keyMap = {
			"Enter":      "\r",
			"Backspace":  "\b",
			"ESC":        "\x1b",
			"Tab":        "\t",
			"RightArrow": "\x1b[C",
			"LeftArrow":  "\x1b[D",
			"UpArrow":    "\x1b[A",
			"DownArrow":  "\x1b[B",
			"^S":         "\x13",
			"^Z":         "\x1a",
			"^A":         "\x01",
		};
		var sequence = keyMap[key];
		if (sequence) {
			this._writeToProcess(sequence);
		}
	}

	onChar(ch) {
		if (this._waitingForKeypress || this._doorExited) {
			this._waitingForKeypress = false;
			this.finished = true;
			return;
		}
		this._writeToProcess(ch);
	}

	_writeToProcess(data) {
		try {
			if (this._outputSocket) {
				this._outputSocket.write(data);
			} else if (this._child && this._child.stdin) {
				this._child.stdin.write(data);
			} else if (this._ptySocket) {
				this._ptySocket.write(data);
			}
		} catch (err) {
			var logmsg = this.loggingId + "\n  Write to process failed: " + err.message;
			alogger.writeAlog(4, logmsg, "yellow");
		}
	}

	// --- Dropfile ---
	_doDropfile() {
		return new Promise((resolve, reject) => {
			if (!this.dropfileType) {
				resolve();
				return;
			}

			// Determine whether to use real names in the dropfile
			var useRealNames = false;			
			if (this.call.doorsession) {
				useRealNames = !!this.doorConfig.usereal_doorsession;
			} else {
				useRealNames = !!this.doorConfig.usereal_local;
			}

			var writer = new dropfile_handler.dropfileWriter(
				this.call,
				this.dropfileType,
				this.dropfileDir,
				this.runnerSettings,
				useRealNames
			);
			writer.emitter.on('DropfileCompleted', () => {
				resolve();
			});
			writer.emitter.on('NoDropfileNeeded', () => {
				resolve();
			});
			writer.emitter.on('DropfileError', () => {
				reject(new Error("Dropfile creation failed"));
			});
			// Defer to next tick so the promise is fully constructed
			// before the emitter can fire
			process.nextTick(() => {
				writer.doSetup();
			});
		});
	}

	// --- Launch strategies ---
	async _launch() {
		try {
			await this._doDropfile();
		} catch (err) {
			if (!this.active) return;
			this.call.cmds.senddata("\r\nError creating dropfile. Press Enter to return.\r\n");
			this._waitForKeyAndExit();
			return;
		}

		if (!this.active) return;
		console.log("Hitting Switch")
		switch (this.launchType) {
			case LAUNCH_TYPES.NATIVE_SHELL:
				this._launchNativeShell();
				break;
			case LAUNCH_TYPES.EXEC_NATIVE:
				this._launchExecNative();
				break;
			case LAUNCH_TYPES.SPAWN_NATIVE:
				this._launchSpawnNative();
				break;
			case LAUNCH_TYPES.DOSEMU:
				this._launchDosemu();
				break;
			case LAUNCH_TYPES.DOSEMU_PTY:
				console.log("Type Found")
				this._launchDosemuPty();
				break;
			default:
				this.call.cmds.senddata("\r\nUnknown door launch type. Press Enter to return.\r\n");
				this._waitForKeyAndExit();
				return;
		}
	}

	_launchNativeShell() {
		var runCmd = appConfig.get('doordir', '') + "/" + this.doorCmd;
		var logmsg = this.loggingId + "\n  Launching NativeShell: " + runCmd;
		alogger.writeAlog(4, logmsg, "greenbright");

		try {
			this._ptySocket = pty.spawn(runCmd, [], {
				name: 'xterm-color',
				cols: this.call.term_width || 80,
				rows: this.call.term_height || 24,
				cwd: process.env.PWD,
				env: process.env
			});
			this._outputSocket = this._ptySocket;

			this._ptySocket.onData((data) => {
				if (this.call) {
					this.call.cmds.senddata(Buffer.from(data));
				}
			});

			this._ptySocket.on('close', () => {
				this._onDoorExit(0);
			});
			this._enableRawMode();
		} catch (err) {
			this._handleError("NativeShell launch failed", err);
		}
	}

	_launchExecNative() {
		var runCmd = appConfig.get('doordir', '') + "/" + this.doorCmd;
		var logmsg = this.loggingId + "\n  Launching ExecNative: " + runCmd;
		alogger.writeAlog(4, logmsg, "greenbright");

		try {
			this._child = exec(runCmd, {
				shell: true,
				stdio: 'pipe',
				encoding: 'utf-8',
				env: { ...process.env, FORCE_COLOR: '1' }
			});
			this._outputSocket = this._child.stdin;

			this._child.stdout.on('data', (chunk) => {
				if (this.call) {
					this.call.cmds.senddata(Buffer.from(chunk));
				}
			});

			this._child.stderr.on('data', (data) => {
				var logmsg = this.loggingId + "\n  stderr: " + data;
				alogger.writeAlog(4, logmsg, "yellow");
			});

			this._child.on('close', (code) => {
				this._onDoorExit(code);
			});
			this._enableRawMode();
		} catch (err) {
			this._handleError("ExecNative launch failed", err);
		}
	}

	_launchSpawnNative() {
		var runCmd = appConfig.get('doordir', '') + "/" + this.doorCmd;
		var logmsg = this.loggingId + "\n  Launching SpawnNative: " + runCmd;
		alogger.writeAlog(4, logmsg, "greenbright");

		try {
			this.call.cmds.clearscreen();
			this._child = spawn(runCmd, {
				shell: true,
				stdio: 'pipe',
				encoding: 'utf-8',
				env: { ...process.env, FORCE_COLOR: '1' }
			});
			this._outputSocket = this._child.stdin;

			this._child.stdout.on('data', (chunk) => {
				if (this.call) {
					this.call.cmds.senddata(Buffer.from(chunk));
				}
			});

			this._child.stderr.on('data', (data) => {
				var logmsg = this.loggingId + "\n  stderr: " + data;
				alogger.writeAlog(4, logmsg, "yellow");
			});

			this._child.on('close', (code) => {
				this._onDoorExit(code);
			});
			this._enableRawMode();
		} catch (err) {
			this._handleError("SpawnNative launch failed", err);
		}
	}

	_launchDosemu() {
		var doscmd = "dosemu -E " + this.doorCmd + " -t";
		var logmsg = this.loggingId + "\n  Launching Dosemu: " + doscmd;
		alogger.writeAlog(4, logmsg, "greenbright");

		try {
			this._child = exec(doscmd);
			this._outputSocket = this._child.stdin;

			this._child.stdout.on('data', (chunk) => {
				if (this.call) {
					this.call.cmds.senddata(chunk);
				}
			});

			this._child.stderr.on('data', (data) => {
				var logmsg = this.loggingId + "\n  stderr: " + data;
				alogger.writeAlog(4, logmsg, "yellow");
			});

			this._child.on('close', (code) => {
				this._onDoorExit(code);
			});
			this._enableRawMode();
		} catch (err) {
			this._handleError("Dosemu launch failed", err);
		}
	}

	_launchDosemuPty() {
		var logmsg = this.loggingId + "\n  Launching DosemuPty via SocatManager";
		alogger.writeAlog(4, logmsg, "greenbright");

		this._socatManager.allocate(this.launchTO)
			.then(ports => {
				if (!this.active) {
					this._socatManager.release(ports.portNum);
					return;
				}
				this._allocatedPortNum = ports.portNum;
				this._startSerial(ports.port1, ports.port2);
			})
			.catch(err => {
				if (!this.active) return;
				this.call.cmds.senddata("\r\nFailed to allocate serial ports: " + err.message + "\r\n");
				this._waitForKeyAndExit();
			});
	}

	_startSerial(port1, port2) {
		try {
			this._serialport = new SerialPort({
				path: port1,
				baudRate: this.runnerSettings.baudrate
			});
		} catch (err) {
			this._handleError("Serial port open failed", err);
			return;
		}

		this._outputSocket = this._serialport;

		// Set up output parser if needed
		var needsUTF8 = this.call.term_encoding === "utf8" || this.call.term_encoding === "utf-8";
		//setting the centering check to slightly above the standard 80x25 to prevent triggering in case of odd terminals with just an extra line or column
		var needsCenter = (this.call.term_width > 90) || (this.call.term_height > 30);

		if (needsUTF8 || needsCenter) {
			this._outputParser = new DoorOutputParser({
				convertCP437: needsUTF8,
				centerOutput: needsCenter,
				srcCols: 80,
				srcRows: 25,
				destCols: this.call.term_width || 80,
				destRows: this.call.term_height || 25,
			});

			this._outputParser.emitter.on("data", (processed) => {
				if (this.call) {
					this.call.cmds.senddata(processed);
				}
			});
		}

		this._serialport.on('data', (data) => {
			if (this.call) {
				if (this._outputParser) {
					this._outputParser.process(data);
				} else {
					this.call.cmds.senddata(data);
				}
			}
		});

		this._serialport.on('error', (err) => {
			var logmsg = this.loggingId + "\n  Serial error: " + err.message;
			alogger.writeAlog(4, logmsg, "red");
		});

		this._serialport.on('close', () => {
			alogger.writeAlog(5, this.loggingId + "\n  Serial port closed", "cyan");
		});

		this._serialport.on('open', () => {
			this._startPtyDosemu(port2);
		});
	}

	_startPtyDosemu(port2) {
		var doscmd = 'dosemu -I"serial { pseudo com 5 device ' + port2 + '}" -E ' + this.doorCmd + ' -t';
		var logmsg = this.loggingId + "\n  Launching PTY Dosemu: " + doscmd;
		alogger.writeAlog(5, logmsg, "greenbright");

		try {
			this.call.overrideBuffer = true;
			this._child = exec(doscmd);

			this._child.stdout.on('data', (chunk) => {
				if (this.call) {
					this.call.writeOverrideBuffer(chunk);
				}
			});

			this._child.stderr.on('data', (data) => {
				var logmsg = this.loggingId + "\n  Dosemu stderr: " + data;
				alogger.writeAlog(4, logmsg, "yellow");
			});

			this._child.on('close', (code) => {
				this._onDoorExit(code);
			});
			this._enableRawMode();
		} catch (err) {
			this._handleError("PTY Dosemu launch failed", err);
		}
	}

	// --- Door exit ---
	_onDoorExit(code) {
		if (this._doorExited) return;
		this._doorExited = true;

		var logmsg = this.loggingId + "\n  Door exited with code: " + code;
		alogger.writeAlog(5, logmsg, "cyan");

		if (!this.call) return;

		this._disableRawMode();
		this.call.overrideBuffer = false;
		this.call.cmds.resetcolors();

		if (this.pauseOnExit) {
			this.call.cmds.senddata("\r\n Press any key to continue...");
			this._waitingForKeypress = true;
			// Stay in raw mode for the keypress so we don't
			// need the parser just for one key
			this._enableRawMode();
			this.resetInactivityTimeouts();
		} else {
			this.finished = true;
			this.signalReturn();
		}
	}

	_waitForKeyAndExit() {
		this._doorExited = true;
		this._waitingForKeypress = true;
		this.resetInactivityTimeouts();
	}

	// --- Process cleanup ---
	_killProcesses() {
		this._disableRawMode();
		if (this._outputParser) {
			this._outputParser.destroy();
			this._outputParser = null;
		}
		if (this.call) {
			this.call.overrideBuffer = false;
		}

		if (this._serialport) {
			try { this._serialport.close(); } catch (_) {}
			this._serialport = null;
		}

		if (this._ptySocket) {
			try { this._ptySocket.destroy(); } catch (_) {}
			this._ptySocket = null;
		}

		if (this._child) {
			try { this._child.kill(); } catch (_) {}
			this._child = null;
		}

		if (this._allocatedPortNum !== null && this._socatManager) {
			this._socatManager.release(this._allocatedPortNum);
			this._allocatedPortNum = null;
		}

		this._outputSocket = null;
	}

	// --- Lifecycle ---
	signalReturn() {
		if (this.returnStage) {
			this.emitter.emit("NextStage", this.returnStage);
		} else {
			this.emitter.emit("ModuleReturn");
		}
	}

	startStage() {
		this._launch().catch(err => {
			this._handleError("startStage error", err);
		});
	}

	clearHandler() {
		if (!this.active) return;
		this._killProcesses();
		super.clearHandler();
	}
}

export { DoorRunner, LAUNCH_TYPES };