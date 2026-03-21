import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

import { getClientBBS } from "../models/doorserver.js";
import appConfig from "../config/appConfig.js";
const maxAuthBuffer = 4096; // Max bytes we'll accept before giving up

class DoorAuthHandler extends BaseHandler {
	constructor(call) {
		super(call, "DoorAuth");
		this.inactivityTO = appConfig.getNumber('doorAuthTO', 15000);
		this.warnMsg = ""; // No warn for machine clients
		this.authBuffer = "";
		this.authenticated = false;
		this.previousRawmode = false;
		this.previousRawtarget = null;
	}

	// --- Raw mode management ---
	_enableRawMode() {
		// Save previous state in case we're nested
		this.previousRawmode = this.call.rawmode;
		this.previousRawtarget = this.call.rawtarget;
		this.call.rawmode = true;
		this.call.rawtarget = (data) => {
			this._onRawData(data);
		};
	}

	_disableRawMode() {
		if (this.call) {
			this.call.rawmode = this.previousRawmode;
			this.call.rawtarget = this.previousRawtarget;
		}
	}

	// --- Data handling ---
	_onRawData(data) {
		if (!this.active) return;
		try {
			this.resetInactivityTimeouts();

			// Append incoming buffer to our auth string
			this.authBuffer += data.toString("utf8");

			// Guard against oversized payloads
			if (this.authBuffer.length > maxAuthBuffer) {
				this._authFailed("Auth payload too large");
				return;
			}

			// Try to parse — client may send in chunks
			this._tryParseAuth();
		} catch (err) {
			this._handleError("Raw data handling error", err);
		}
	}

	_tryParseAuth() {
		// Look for a complete JSON object
		// Trim any trailing newlines/carriage returns the client might send
		var trimmed = this.authBuffer.trim();

		// Quick check — does it look like we have a complete object?
		if (!trimmed.startsWith("{")) {
			// Not JSON yet, could be partial or garbage
			if (trimmed.length > 0 && !"{".startsWith(trimmed[0])) {
				this._authFailed("Invalid auth format");
			}
			return;
		}

		// Check for balanced braces as a simple completeness test
		var depth = 0;
		for (var i = 0; i < trimmed.length; i++) {
			if (trimmed[i] === "{") depth++;
			if (trimmed[i] === "}") depth--;
			if (depth === 0 && i > 0) {
				// We have a complete object
				var jsonString = trimmed.substring(0, i + 1);
				this._processAuth(jsonString);
				return;
			}
		}
		// Braces not yet balanced — wait for more data
	}

	_processAuth(jsonString) {
		var authData;
		try {
			authData = JSON.parse(jsonString);
		} catch (err) {
			this._authFailed("Malformed JSON");
			return;
		}

		// Validate required fields
		if (!authData.system_id || !authData.auth_token) {
			this._authFailed("Missing required auth fields");
			return;
		}

		// Validate credentials
		this._validateDoorAuth(authData)
			.then(result => {
				if (!this.active) return;
				if (result.valid) {
					this._authSuccess(authData, result);
				} else {
					this._authFailed(result.reason || "Invalid credentials");
				}
			})
			.catch(err => {
				if (!this.active) return;
				this._authFailed("Auth validation error: " + err.message);
			});
	}

	async _validateDoorAuth(authData) {
		// authData contains at minimum:
		//   system_id   - the remote BBS system identifier
		//   auth_token  - shared secret or session token
		//
		// May also contain:
		//   username    - the remote user's name
		//   real_name   - user's real/full name
		//   door_id     - which door game they want to launch (sets doorTarget)
		//   term_type   - remote terminal capabilities
		//   term_width  - remote terminal width
		//   term_height - remote terminal height
		//
		// Returns: { valid: true/false, reason: "...", bbs: {...} }

		if (!authData.system_id || !authData.auth_token) {
			return { valid: false, reason: "Missing System ID or Auth Token" };
		}

		var bbs = await getClientBBS(authData.system_id);
		if (!bbs) {
			return { valid: false, reason: "Unknown System ID" };
		}

		if (authData.auth_token !== bbs.auth_token) {
			return { valid: false, reason: "Auth Token Incorrect" };
		}

		return { valid: true, bbs: bbs };
	}

	// --- Auth results ---
	_authSuccess(authData, result) {
		this.authenticated = true;
		var logmsg = this.loggingId + "\n  Door auth successful from system: " + authData.system_id;
		alogger.writeAlog(4, logmsg, "greenbright");

		var bbs = result.bbs || {};

		// Store connection info on the call object
		this.call.doorsession = true;
		this.call.caller_bbs = authData.system_id;
		this.call.term_type = "Door Client";
		this.call.term_encoding = "CP437";

		// Build caller identity from BBS prefix + remote username
		var prefix = bbs.username_prefix ? bbs.username_prefix + "_" : "";
		this.call.caller_username = prefix + (authData.username || "Guest");
		if (authData.real_name) this.call.caller_fullname = authData.real_name;
		if (bbs.name) this.call.caller_location = bbs.name;

		// Door target — if the client requested a specific door
		if (authData.door_id) this.call.doorTarget = authData.door_id;

		// Terminal dimensions from client
		if (authData.term_width) this.call.term_width = authData.term_width;
		if (authData.term_height) this.call.term_height = authData.term_height;

		// Send success response
		this._sendResponse({
			status: "ok",
			message: "Authenticated",
			node: this.call.nodenum
		});

		this._disableRawMode();
		this.finished = true;
		this.signalReturn();
	}

	_authFailed(reason) {
		var logmsg = this.loggingId + "\n  Door auth failed: " + reason;
		alogger.writeAlog(3, logmsg, "yellowbright");

		this._sendResponse({
			status: "error",
			message: reason
		});

		this._disableRawMode();
		this.finished = true;
		this.emitter.emit("AuthFailed");
	}

	_sendResponse(obj) {
		try {
			if (this.call && this.call.connection) {
				this.call.sendString(JSON.stringify(obj) + "\n");
			}
		} catch (_) {}
	}

	// --- Lifecycle ---
	signalReturn() {
		if (this.authenticated) {
			this.emitter.emit("DoorAuthOK");
		} else {
			this.emitter.emit("ModuleReturn");
		}
	}

	startStage() {
		try {
			this._enableRawMode();
			this._sendResponse({ prompt: "[!SendAuth]" });
			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("startStage error", err);
		}
	}

	// Override inactivity kick to send JSON instead of terminal text
	onInactivityKick() {
		if (this.call) {
			this._sendResponse({
				status: "error",
				message: "Auth timeout"
			});
			this.call.hangUpCall();
		}
	}

	clearHandler() {
		if (!this.active) return;
		this._disableRawMode();
		this.authBuffer = "";
		super.clearHandler();
	}
}

export { DoorAuthHandler };