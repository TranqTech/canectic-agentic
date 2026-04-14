import { EventEmitter } from 'node:events';
import { exec } from "child_process";
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
	NATIVE_SHELL:   "NativeShell",
	NATIVE_COMMAND: "NativeCommand",
	DOSEMU:         "Dosemu",
	DOSEMU_PTY:     "DosemuPty",
};

// Quote a string for safe inclusion in a /bin/sh command line.
// Used when appending doorArgs to NativeShell's runCmd so args with
// spaces or shell metacharacters are preserved. Single-quotes are the
// safe default in POSIX sh; the only thing that can't appear inside
// single quotes is a single quote itself, so we close-reopen around any.
function _shQuote(s) {
	if (s === null || s === undefined) return "''";
	var str = String(s);
	if (str === '') return "''";
	// Safe identifier characters pass through unquoted for readability in logs
	if (/^[A-Za-z0-9_./=:+,@%-]+$/.test(str)) return str;
	return "'" + str.replace(/'/g, "'\\''") + "'";
}

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
		this.doorDir = doorConfig.doorDir
			? substitute(doorConfig.doorDir, call, doorConfig)
			: appConfig.get('doordir', '') || process.cwd();
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

		// Clear screen before door launch to reset terminal viewport.
		// This ensures absolute cursor positioning (ESC[row;colH) from the door
		// maps to the visible screen, not a scrolled-up buffer position.
		this.call.cmds.clearscreen();
		this.call.cmds.senddata("\x1b[H"); // Home cursor

		switch (this.launchType) {
			case LAUNCH_TYPES.NATIVE_SHELL:
				this._launchNativeShell();
				break;
			case LAUNCH_TYPES.NATIVE_COMMAND:
			case "ExecNative":    // legacy DB values
			case "SpawnNative":
				this._launchNativeCommand();
				break;
			case LAUNCH_TYPES.DOSEMU:
				this._launchDosemu();
				break;
			case LAUNCH_TYPES.DOSEMU_PTY:
				this._launchDosemuPty();
				break;
			default:
				this.call.cmds.senddata("\r\nUnknown door launch type. Press Enter to return.\r\n");
				this._waitForKeyAndExit();
				return;
		}
	}

	// Set up the output parser for CP437 conversion and/or centering.
	// Called by each launch method before piping output.
	_setupOutputParser() {
		var enc = (this.call.term_encoding || '').toLowerCase();
		var needsUTF8 = (enc === 'utf8' || enc === 'utf-8');
		// DOS doors (Dosemu/DosemuPty) are always 80x25 - center on oversized terminals.
		// NativeShell/Exec/Spawn handle their own sizing unless fixedSize is set.
		var isDos = (this.launchType === 'Dosemu' || this.launchType === 'DosemuPty');
		var forceFixed = this.doorConfig.fixedSize || false;
		var needsCenter = (isDos || forceFixed) && ((this.call.term_width > 90) || (this.call.term_height > 30));

		if (needsUTF8 || needsCenter) {
			this._outputParser = new DoorOutputParser({
				convertCP437: needsUTF8,
				centerOutput: needsCenter,
				debugLog: true,
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
	}

	// Pipe data through the output parser if active, otherwise send directly.
	_sendDoorOutput(data) {
		if (!this.call) return;
		if (this._outputParser) {
			this._outputParser.process(data);
		} else {
			this.call.cmds.senddata(Buffer.from(data));
		}
	}

	_launchNativeShell() {
		// Route through /bin/sh -c so the sysop's command line is parsed
		// naturally (args, quoted strings, env var refs all work). node-pty
		// would otherwise treat the whole `runCmd` as a literal executable
		// filename -- "./USURPER /N1" fails execvp because that's not a
		// real path. Matches NativeCommand's exec() behaviour but PTY-wrapped.
		var runCmd = this.doorCmd;
		// Append any doorArgs (admin-configured arg list) so /bin/sh parses them
		if (Array.isArray(this.doorArgs) && this.doorArgs.length > 0) {
			runCmd = runCmd + ' ' + this.doorArgs.map(_shQuote).join(' ');
		}
		var logmsg = this.loggingId + "\n  Launching NativeShell: " + runCmd + "\n  cwd: " + this.doorDir;
		alogger.writeAlog(4, logmsg, "greenbright");

		this._setupOutputParser();

		try {
			this._ptySocket = pty.spawn('/bin/sh', ['-c', runCmd], {
				name: 'xterm-color',
				cols: this.call.term_width || 80,
				rows: this.call.term_height || 25,
				cwd: this.doorDir,
				env: process.env
			});
			this._outputSocket = this._ptySocket;

			this._ptySocket.onData((data) => {
				this._sendDoorOutput(data);
			});

			this._ptySocket.on('close', () => {
				this._onDoorExit(0);
			});
			this._enableRawMode();
		} catch (err) {
			this._handleError("NativeShell launch failed", err);
		}
	}

	_launchNativeCommand() {
		var runCmd = this.doorCmd;
		var logmsg = this.loggingId + "\n  Launching NativeCommand: " + runCmd + "\n  cwd: " + this.doorDir;
		alogger.writeAlog(4, logmsg, "greenbright");

		this._setupOutputParser();

		try {
			this._child = exec(runCmd, {
				shell: true,
				stdio: 'pipe',
				cwd: this.doorDir,
				env: { ...process.env, FORCE_COLOR: '1' }
			});
			this._outputSocket = this._child.stdin;

			this._child.stdout.on('data', (chunk) => {
				this._sendDoorOutput(chunk);
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
			this._handleError("NativeCommand launch failed", err);
		}
	}

	_launchDosemu() {
		var doscmd = "dosemu -E " + this.doorCmd.replace(/\\/g, '\\\\') + " -t";
		var logmsg = this.loggingId + "\n  Launching Dosemu: " + doscmd;
		alogger.writeAlog(4, logmsg, "greenbright");

		this._setupOutputParser();

		try {
			this._child = exec(doscmd);
			this._outputSocket = this._child.stdin;

			this._child.stdout.on('data', (chunk) => {
				this._sendDoorOutput(chunk);
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

		this._setupOutputParser();

		this._serialport.on('data', (data) => {
			this._sendDoorOutput(data);
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
		var doscmd = 'dosemu -I"serial { pseudo com 5 device ' + port2 + '}" -E ' + this.doorCmd.replace(/\\/g, '\\\\') + ' -t';
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