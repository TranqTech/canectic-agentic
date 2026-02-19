import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

class SnoopHandler extends BaseHandler {
	constructor(call, targetCall) {
		super(call, "Snoop");
		this.targetCall = targetCall;
		this._onDataBound = null;
		this._onDisconnectBound = null;
		this.inactivityTO = 600000;
		this.loggingId = "Snoop (Node " + this.call.nodenum + " -> Node " + targetCall.nodenum + ")";
	}

	_attach() {
		var targetBuffer = this.targetCall.outputBuffer;
		if (!targetBuffer) {
			this.call.cmds.senddata("\r\nTarget node has no output buffer.\r\n");
			this.finished = true;
			this.signalReturn();
			return;
		}

		// Send catch-up history
		var history = targetBuffer.getHistory();
		if (history.length > 0) {
			this.call.cmds.senddata(history);
		}

		// Attach live listener
		this._onDataBound = (data) => {
			try {
				if (this.call) {
					this.call.cmds.senddata(data);
				}
			} catch (_) {
				this._detach();
			}
		};
		targetBuffer.emitter.on("data", this._onDataBound);

		// Watch for target disconnecting
		this._onDisconnectBound = () => {
			this.call.cmds.senddata("\r\n\r\n--- Target node disconnected ---\r\n");
			this.finished = true;
			this.signalReturn();
		};
		this.targetCall.callEvent.on("disconnected", this._onDisconnectBound);
	}

	_detach() {
		if (this.targetCall && this.targetCall.outputBuffer && this._onDataBound) {
			this.targetCall.outputBuffer.emitter.removeListener("data", this._onDataBound);
			this._onDataBound = null;
		}
		if (this.targetCall && this._onDisconnectBound) {
			this.targetCall.callEvent.removeListener("disconnected", this._onDisconnectBound);
			this._onDisconnectBound = null;
		}
	}

	onKey(key) {
		if (key === "ESC" || key === "^A") {
			this.finished = true;
		}
	}

	onChar(ch) {
		// Snooping is view-only — ignore character input
	}

	signalReturn() {
		this._detach();
		this.emitter.emit("ModuleReturn");
	}

	startStage() {
		try {
			this.call.cmds.clearscreen();
			var msg = "\r\n--- Snooping Node " + this.targetCall.nodenum;
			if (this.targetCall.caller_username) {
				msg += " (" + this.targetCall.caller_username + ")";
			}
			msg += " ---\r\n";
			msg += "--- Press ESC to disconnect ---\r\n\r\n";
			this.call.cmds.senddata(msg);
			this._attach();
			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("startStage error", err);
		}
	}

	clearHandler() {
		if (!this.active) return;
		this._detach();
		this.targetCall = null;
		super.clearHandler();
	}
}

export { SnoopHandler };