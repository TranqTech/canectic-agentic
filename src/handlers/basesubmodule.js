import { EventEmitter } from 'node:events';
import * as alogger from "../utils/alogger.js";

const df_zombie_timeout = 10000;

class BaseSubModule {
	constructor(call, type) {
		this.call = call;
		this.type = type || "SubModule";
		this.emitter = new EventEmitter();
		this.active = true;
		this.finished = false;
		this.dumb = (call.term_type === "Dumb");

		this.zombieTO = null;
		this.zombieTimeout = df_zombie_timeout;

		this.loggingId = type + " (Node " + call.nodenum + ")";
	}

	// --- Input dispatch ---
	// Parent (MenuHandler) calls this with an array of parsed input tokens.
	// Sub-modules that use the legacy input_array/handleData pattern
	// will have input routed by the menu handler's compatibility layer.
	// New sub-modules should override handleInput directly.
	handleInput(inputArray) {
		if (!this.active) return;
		for (var i = 0; i < inputArray.length; i++) {
			if (!this.active) return;
			var token = inputArray[i];
			if (token.startsWith("KEY_")) {
				this.onKey(token.slice(4));
			} else if (token.startsWith("CHAR_")) {
				this.onChar(token.slice(5));
			} else if (token.startsWith("CMD_")) {
				this.onCmd(token.slice(4));
			}
		}
		if (this.finished) {
			this.signalReturn();
		}
	}

	// Override these in subclasses
	onKey(key) {}
	onChar(ch) {}
	onCmd(cmd) {}

	// --- Lifecycle ---
	signalReturn() {
		if (!this.active) return;
		this._setZombieTO();
		this.finished = true;
		this.emitter.emit("ModuleReturn");
	}

	signalHangup() {
		if (!this.active) return;
		this.finished = true;
		this.emitter.emit("HangupSignal");
	}

	// Called by startStage — subclasses override to do their work
	run() {
		// Override in subclass
	}

	startStage() {
		if (!this.active) return;
		try {
			this.run();
		} catch (err) {
			alogger.writeAlog(3, this.loggingId + "\n  run() error: " + (err?.stack || err), "redbright");
			this.signalReturn();
		}
	}

	// --- Zombie timeout ---
	_setZombieTO() {
		if (this.call) {
			this.zombieTO = setTimeout(() => this._zombieCheck(), this.zombieTimeout);
		}
	}

	_zombieCheck() {
		if (this.active && this.call) {
			alogger.writeAlog(4, this.loggingId + " zombie — re-emitting ModuleReturn", "yellow");
			this.emitter.emit("ModuleReturn");
		}
	}

	// --- Cleanup ---
	clearHandler() {
		if (!this.active) return;
		this.active = false;
		this.finished = true;
		clearTimeout(this.zombieTO);
		this.emitter.removeAllListeners();
		this.call = null;
	}
}

export { BaseSubModule };