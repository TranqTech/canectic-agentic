import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

// DoorLaunchHandler — a flow-composable stage for launching doors.
//
// When used as a call flow stage (e.g. in the Doorserver flow):
//   - If call.doorTarget is set, launches that door directly
//   - If no doorTarget, sets currentMenu to "doorsession" and emits NextStage "menu"
//
// The fromMenu flag controls exit behavior after the door completes:
//   - fromMenu = true  → return to the calling menu
//   - fromMenu = false → advance the call flow (ModuleReturn)

class DoorLaunchHandler extends BaseHandler {
	constructor(call, fromMenu) {
		super(call, "DoorLaunch");
		this.fromMenu = fromMenu || false;
		this.loggingId = "DoorLaunch (Node " + (call.nodenum || "?") + ")";
	}

	startStage() {
		if (!this.call) return;

		if (this.call.doorTarget) {
			// A specific door was requested — launch it
			alogger.writeAlog(4, this.loggingId + " Launching door target: " + this.call.doorTarget, "greenbright");
			this.call.launchDoor(this.call.doorTarget, this.fromMenu);
		} else {
			// No specific door — load the doorsession menu for the user to pick
			alogger.writeAlog(4, this.loggingId + " No door target, loading doorsession menu", "cyanbright");
			this.call.currentMenu = "doorsession";
			this.call.menuHistory = [];
			this.emitter.emit("NextStage", "menu");
		}
	}

	handleInput(inputArray) {
		// This handler doesn't process input — the door or menu does
	}

	clearHandler() {
		if (!this.active) return;
		super.clearHandler();
	}
}

export { DoorLaunchHandler };