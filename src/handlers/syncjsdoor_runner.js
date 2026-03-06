/**
 * syncjsdoor_runner.js — Handler for running Synchronet JS doors (e.g. LORD)
 *
 * This is a new launch type that runs a Synchronet-compatible JS door game
 * in a worker thread, bridging the door's synchronous I/O model to the BBS's
 * event-driven architecture.
 *
 * Architecture:
 *
 *   Main Thread (BBS event loop)          Worker Thread (door game)
 *   ┌──────────────────────────┐          ┌──────────────────────────┐
 *   │  SyncJSDoorRunner        │          │  dorkit_shim.js (dk)     │
 *   │    ↕ raw I/O to terminal │ SAB+IPC  │  recordfile_sqlite.js    │
 *   │    ↕ MainSide comm       │◄────────►│  WorkerSide comm         │
 *   │    ↕ SQLite proxy        │          │  lord.js (the door)      │
 *   └──────────────────────────┘          └──────────────────────────┘
 *
 * Input flow:  terminal → ansiInputParser → handleInput → MainSide.pushKey → SAB → WorkerSide.waitKey
 * Output flow: WorkerSide postMessage → SyncJSDoorRunner._onWorkerMessage → cmds.senddata → terminal
 *
 * The worker gets its own copy of dorkit_shim.js which replaces the `dk` global,
 * and recordfile_sqlite.js which replaces RecordFile.  The door script is loaded
 * inside the worker and runs to completion.
 */

import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import * as path from 'path';

import { BaseHandler } from "./basehandler.js";
import { MainSide, MSG_OUTPUT, MSG_READY, MSG_EXIT, MSG_ERROR, MSG_DB_REQUEST } from "../comm/syncjsdoor_comm.js";
import * as alogger from "../utils/alogger.js";

class SyncJSDoorRunner extends BaseHandler {
	constructor(call, doorConfig) {
		super(call, "SyncJSDoor");

		this.doorConfig = doorConfig || {};
		this.doorScript = doorConfig.doorScript || "";   // Path to the main door .js file (e.g. lord.js)
		this.doorDir = doorConfig.doorDir || "";          // Working directory for the door
		this.dbSubdir = doorConfig.dbSubdir || "";           // Subdirectory for SQLite game database
		this.returnStage = doorConfig.returnStage || null;
		this.pauseOnExit = doorConfig.pauseOnExit !== undefined ? doorConfig.pauseOnExit : true;

		// Communication
		this._comm = new MainSide();
		this._worker = null;

		// State
		this._doorExited = false;
		this._waitingForKeypress = false;
		this._previousRawmode = false;
		this._previousRawtarget = null;

		// Timeouts
		this.launchTO = Number(process.env.syncjsdoorTO) || 30000;
		this.inactivityTO = Number(process.env.doorInactivityTO) || 300000;

		this.loggingId = "SyncJSDoor (Node " + this.call.nodenum + ") [" + this.doorScript + "]";
	}

	// --- Raw mode management ---
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

	// --- Input handling ---

	/**
	 * Called when raw bytes arrive from the terminal (raw mode).
	 * Pushes them into the shared buffer for the worker.
	 */
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
			this._comm.pushRawBytes(data);
		} catch (err) {
			alogger.writeAlog(4, this.loggingId + "\n  Raw input push failed: " + err.message, "yellow");
		}
	}

	/**
	 * Called by the input parser with an array of parsed key names.
	 * This is the non-raw-mode path for when another handler might
	 * need to intercept sysop commands, etc.
	 */
	handleInput(inputArray) {
		if (!this.active || this._doorExited) return;

		for (var item of inputArray) {
			if (this._waitingForKeypress) {
				this._waitingForKeypress = false;
				this.finished = true;
				this._disableRawMode();
				this.signalReturn();
				return;
			}

			// Map our BBS key names to dorkit key names
			var mapped = this._mapKeyToDorkit(item);
			if (mapped !== null) {
				this._comm.pushKey(mapped);
			}
		}
	}

	/**
	 * Map BBS input parser key names to dorkit key constants.
	 * Our parser emits "KEY_UpArrow", dorkit expects "KEY_UP", etc.
	 */
	_mapKeyToDorkit(keyName) {
		// Character keys come as "CHAR_x"
		if (keyName.startsWith("CHAR_")) {
			return keyName.substring(5);
		}

		// Map named keys
		var keyMap = {
			"KEY_Enter":      "\r",
			"KEY_Backspace":  "\b",
			"KEY_ESC":        "\x1b",
			"KEY_Tab":        "\t",
			"KEY_UpArrow":    "KEY_UP",
			"KEY_DownArrow":  "KEY_DOWN",
			"KEY_LeftArrow":  "KEY_LEFT",
			"KEY_RightArrow": "KEY_RIGHT",
			"KEY_Home":       "KEY_HOME",
			"KEY_End":        "KEY_END",
			"KEY_Delete":     "KEY_DEL",
			"KEY_^A":         "\x01",
			"KEY_^S":         "\x13",
			"KEY_^Z":         "\x1a",
		};

		return keyMap[keyName] !== undefined ? keyMap[keyName] : null;
	}

	// --- Resolve door arguments ---

	/**
	 * Normalize doorArgs from the door config into a string array.
	 * Accepts:
	 *   - An array of strings: ["arg1", "arg2"]
	 *   - A single space-delimited string: "arg1 arg2"
	 *   - undefined/null (returns empty array)
	 */
	_resolveDoorArgs() {
		var rawArgs = this.doorConfig.doorArgs || [];
		if (typeof rawArgs === 'string') {
			return rawArgs.trim().length > 0 ? rawArgs.trim().split(/\s+/) : [];
		}
		if (Array.isArray(rawArgs)) {
			return rawArgs.map(String);
		}
		return [];
	}

	// --- Worker management ---

	/**
	 * Start the door — create the worker thread and launch the game.
	 */
	startStage() {
		if (!this.call) return;

		alogger.writeAlog(4, this.loggingId + "\n  Starting SyncJS door", "greenbright");

		// Set up terminal info in the shared buffer
		this._comm.setTermInfo(
			this.call.term_width || 80,
			this.call.term_height || 24,
			this.call.term_type !== "Dumb",
			this.call.nodenum || 0
		);
		this._comm.reset();

		// Build worker data

		// Determine whether to expose real full name or use alias/username
		// as the identity. Using full name for door identification is insecure
		// when hosting door clients from other BBS systems — anyone with the
		// same full name could hijack player accounts. Match DoorRunner behavior.
		var useRealName = false;
		if (this.call.doorsession) {
			useRealName = !!this.doorConfig.usereal_doorsession;
		} else {
			useRealName = !!this.doorConfig.usereal_local;
		}

		// Build user_record fields if available.
		// Field names match the users.conf DB schema and the
		// dropfile_handler.js safeUser() accessor pattern.
		var ur = this.call.user_record || {};

		// Resolve command-line arguments for the door script.
		// These become globalThis.argv / globalThis.argc in the worker,
		// matching Synchronet's behavior for door command-line args.
		var doorArgs = this._resolveDoorArgs();
		if (doorArgs.length > 0) {
			alogger.writeAlog(5, this.loggingId + "\n  Door args: " + JSON.stringify(doorArgs), "greenbright");
		}

		var workerData = {
			sharedBuffer: this._comm.sharedBuffer,
			doorScript: this.doorScript,
			doorDir: this.doorDir,
			dbSubdir: this.dbSubdir,
			doorArgs: doorArgs,
			doorConfig: {
				name: this.doorConfig.name || "",
				cmd: this.doorConfig.cmd || "",
			},
			userInfo: {
				alias: this.call.caller_username || "Unknown",
				fullName: useRealName
					? (this.call.caller_fullname || this.call.caller_username || "Unknown")
					: (this.call.caller_username || "Unknown"),
				location: ur.location || this.call.caller_location || "Unknown",
				nodeNum: this.call.nodenum || 0,
				timeLeft: this.call.timeleft || 9999,
				security: ur.security || this.call.security || 0,
				// Fields from user_record (users.conf schema)
				connectTime: this.call.connect_time ? this.call.connect_time.toISO() : new Date().toISOString(),
				userNumber: ur.usernumber || 1,
				logonCount: ur.logoncount || 0,
				lastLogon: ur.lastlogon || null,
				birthdate: ur.birthdate || null,
				// Fields that may exist on expanded user records but
				// aren't in the base users.conf schema — safe defaults
				uploadCount: ur.uploadcount || 0,
				uploadKb: ur.totaluploadk || 0,
				downloadCount: ur.downloadcount || 0,
				downloadKb: ur.totaldownloadk || 0,
				userComment: ur.user_comment || "",
				doorsOpened: ur.lifetimedoortotal || 0,
				messagesLeft: 0,
			}
		};

		try {
			// The worker entry point loads the shim + door script
			var workerPath = path.resolve(
				path.dirname(new URL(import.meta.url).pathname),
				'../workers/syncjsdoor_worker.js'
			);

			this._worker = new Worker(workerPath, {
				workerData: workerData,
				// Enable SharedArrayBuffer support
				execArgv: []
			});

			this._worker.on('message', (msg) => {
				this._onWorkerMessage(msg);
			});

			this._worker.on('error', (err) => {
				this._handleWorkerError(err);
			});

			this._worker.on('exit', (code) => {
				this._onWorkerExit(code);
			});

			// Switch to raw mode for direct input passthrough
			this._enableRawMode();

		} catch (err) {
			alogger.writeAlog(3, this.loggingId + "\n  Failed to create worker: " + err.message, "redbright");
			this._onDoorExit(1);
		}
	}

	/**
	 * Handle messages from the worker thread.
	 */
	_onWorkerMessage(msg) {
		if (!this.call || !this.active) return;

		switch (msg.type) {
			case MSG_OUTPUT:
				// Raw terminal output — send directly to the user's terminal
				try {
					this.call.cmds.senddata(Buffer.from(msg.data));
				} catch (err) {
					alogger.writeAlog(4, this.loggingId + "\n  Output send failed: " + err.message, "yellow");
				}
				break;

			case MSG_READY:
				alogger.writeAlog(5, this.loggingId + "\n  Worker ready", "greenbright");
				break;

			case MSG_EXIT:
				alogger.writeAlog(5, this.loggingId + "\n  Door signaled exit, code: " + (msg.code || 0), "cyan");
				this._onDoorExit(msg.code || 0);
				// Worker blocks after sending exit — terminate it
				if (this._worker) {
					this._worker.terminate().catch(function() {});
				}
				break;

			case MSG_ERROR:
				alogger.writeAlog(3, this.loggingId + "\n  Door error: " + (msg.error || "unknown"), "redbright");
				this._onDoorExit(1);
				if (this._worker) {
					this._worker.terminate().catch(function() {});
				}
				break;

			case MSG_DB_REQUEST:
				// SQLite operations proxied through the main thread
				this._handleDBRequest(msg);
				break;

			default:
				alogger.writeAlog(5, this.loggingId + "\n  Unknown worker message type: " + msg.type, "yellow");
				break;
		}
	}

	/**
	 * Handle SQLite DB requests from the worker.
	 * The worker can't do file I/O directly (or we don't want it to),
	 * so it sends requests here and we execute them and respond.
	 *
	 * For now this is a placeholder — the actual implementation will
	 * depend on how we structure the SQLite access.
	 */
	_handleDBRequest(msg) {
		// TODO: Implement SQLite proxy
		// For now, respond with an error so the worker doesn't hang
		if (this._worker) {
			this._worker.postMessage({
				type: 'db_response',
				requestId: msg.requestId,
				error: 'DB proxy not yet implemented'
			});
		}
	}

	/**
	 * Handle worker thread errors.
	 */
	_handleWorkerError(err) {
		alogger.writeAlog(3, this.loggingId + "\n  Worker error: " + (err?.stack || err.message), "redbright");
		if (!this._doorExited) {
			this._onDoorExit(1);
		}
	}

	/**
	 * Handle worker thread exit.
	 */
	_onWorkerExit(code) {
		if (!this._doorExited) {
			alogger.writeAlog(5, this.loggingId + "\n  Worker thread exited with code: " + code, "cyan");
			this._onDoorExit(code);
		}
	}

	// --- Door exit ---

	_onDoorExit(code) {
		if (this._doorExited) return;
		this._doorExited = true;

		alogger.writeAlog(5, this.loggingId + "\n  Door exited with code: " + code, "cyan");

		if (!this.call) return;

		this._disableRawMode();
		this.call.cmds.resetcolors();

		if (this.pauseOnExit) {
			this.call.cmds.senddata("\r\n Press any key to continue...");
			this._waitingForKeypress = true;
			this._enableRawMode();
			this.resetInactivityTimeouts();
		} else {
			this.finished = true;
			this.signalReturn();
		}
	}

	// --- Lifecycle ---

	signalReturn() {
		if (this.returnStage) {
			this.emitter.emit("NextStage", this.returnStage);
		} else {
			this.emitter.emit("ModuleReturn");
		}
	}

	clearHandler() {
		if (!this.active) return;

		this._disableRawMode();

		// Signal disconnect to the worker so it unblocks
		if (this._comm) {
			this._comm.signalDisconnect();
		}

		// Terminate the worker
		if (this._worker) {
			try {
				this._worker.terminate();
			} catch (_) {}
			this._worker = null;
		}

		super.clearHandler();
	}
}


export { SyncJSDoorRunner };