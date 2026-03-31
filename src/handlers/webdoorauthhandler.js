// webdoorauthhandler.js - Pre-authenticates a web door session from a Redis token.
//
// Used in the WebDoor call flow. Reads the one-time launch token from the
// WebSocket URL query string, validates it against Redis, and sets up the
// call object with the user record and door target. No client-side auth
// needed since the token was generated server-side from a validated session.

import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";
import * as redis from "../middleware/db/redis.js";
import { getUserByUUID } from "../models/useraccounts.js";
class WebDoorAuthHandler extends BaseHandler {
	constructor(call) {
		super(call, "WebDoorAuth");
		this.inactivityTO = 15000; // 15 seconds to validate
		this.warnMsg = "";
		this.loggingId = "WebDoorAuth (Node " + (call.nodenum || "?") + ")";
	}

	async startStage() {
		if (!this.call) return;

		try {
			// Extract token from the connection request URL query string
			var token = null;
			var reqUrl = '';
			if (this.call.connection) {
				reqUrl = this.call.connection.requestUrl || this.call.connection.path || '';
				alogger.writeAlog(4, this.loggingId + " Request URL: " + reqUrl, "cyan");
			}
			if (reqUrl) {
				var qIdx = reqUrl.indexOf('?');
				if (qIdx >= 0) {
					var params = new URLSearchParams(reqUrl.substring(qIdx));
					token = params.get('token');
				}
			}

			if (!token) {
				alogger.writeAlog(3, this.loggingId + " No launch token in URL", "yellow");
				this._sendError("No launch token provided");
				return;
			}

			// Read and delete token from Redis (one-time use)
			var rc = await redis.getClient();
			var tokenData = await rc.get('webdoor:' + token);
			if (!tokenData) {
				alogger.writeAlog(3, this.loggingId + " Invalid or expired launch token", "yellow");
				this._sendError("Invalid or expired launch token");
				return;
			}
			await rc.del('webdoor:' + token);

			var launch;
			try {
				launch = JSON.parse(tokenData);
			} catch (e) {
				this._sendError("Corrupt launch token");
				return;
			}

			// Fetch user record
			var user = await getUserByUUID(launch.userUuid);
			if (!user) {
				this._sendError("User not found");
				return;
			}

			// Set up the call object
			this.call.user_record = user;
			this.call.caller_username = user.username;
			this.call.caller_fullname = user.fullname || user.username;
			this.call.caller_location = user.location || '';
			this.call.security = user.security || 0;
			this.call.permissionflags = user.permissionflags || [];
			this.call.restrictionflags = user.restrictionflags || [];
			this.call.doorTarget = launch.doorSlug;
			this.call.doorsession = true;
			this.call.web_originated = true;

			// Terminal settings for web client
			this.call.term_type = "xterm";
			this.call.term_encoding = "UTF8";
			if (launch.termWidth) this.call.term_width = launch.termWidth;
			if (launch.termHeight) this.call.term_height = launch.termHeight;
			// No charset init needed - xterm.js handles UTF-8 natively

			alogger.writeAlog(3, this.loggingId + " Web door auth: " + user.username +
				" launching " + launch.doorSlug, "greenbright");

			this.finished = true;
			this.emitter.emit("DoorAuthOK");

		} catch (err) {
			alogger.writeAlog(2, this.loggingId + " Auth error: " + err.message, "redbright");
			this._sendError("Authentication error");
		}
	}

	_sendError(msg) {
		try {
			if (this.call && this.call.connection && this.call.connection.socket) {
				this.call.connection.socket.send("\r\n" + msg + "\r\n");
			}
		} catch (_) {}
		this.finished = true;
		this.emitter.emit("AuthFailed");
	}

	handleInput(inputArray) {}

	signalReturn() {
		this.emitter.emit("ModuleReturn");
	}

	clearHandler() {
		if (!this.active) return;
		super.clearHandler();
	}
}

export { WebDoorAuthHandler };
