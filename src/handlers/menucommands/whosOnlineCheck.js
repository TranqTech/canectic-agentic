import { BaseSubModule } from "../basesubmodule.js";
import { WhosOnline } from "../whosonline.js";
import { getOnlineUsers } from "../../middleware/webActivity.js";

// Call flow wrapper for WhosOnline.
// Checks if anyone else is online (other terminal nodes or web users)
// and skips silently if the current user is the only one around.

class whosOnlineCheck extends BaseSubModule {
	constructor(call) {
		super(call, "WhosOnlineCheck");
		this._delegate = null;
		this.loggingId = "WhosOnlineCheck (Node " + call.nodenum + ")";
	}

	onKey(key) {
		if (this._delegate) {
			this._delegate.onKey(key);
		}
	}

	onChar(ch) {
		if (this._delegate) {
			this._delegate.onChar(ch);
		}
	}

	handleInput(inputArray) {
		if (this._delegate) {
			this._delegate.handleInput(inputArray);
			return;
		}
		super.handleInput(inputArray);
	}

	run() {
		if (!this.call) return;

		// Count other terminal nodes with a username (exclude ourselves)
		var otherNodes = 0;
		if (this.call.nodeManager) {
			var nodes = this.call.nodeManager.getActiveNodes();
			for (var i = 0; i < nodes.length; i++) {
				if (nodes[i].username && nodes[i].nodenum !== this.call.nodenum) {
					otherNodes++;
				}
			}
		}

		// Check web presence (async)
		getOnlineUsers()
			.then(webUsers => {
				if (!this.active) return;

				// Filter out current user from web count
				var currentUsername = (this.call.caller_username || '').toLowerCase();
				var otherWeb = 0;
				for (var w = 0; w < webUsers.length; w++) {
					if (webUsers[w].username && webUsers[w].username.toLowerCase() !== currentUsername) {
						otherWeb++;
					}
				}

				if (otherNodes + otherWeb === 0) {
					// Nobody else online, skip silently
					this.signalReturn();
					return;
				}

				// Others are online, delegate to the real handler
				this._delegate = new WhosOnline(this.call);

				this._delegate.emitter.on("ModuleReturn", () => {
					this._delegate = null;
					if (this.active) this.signalReturn();
				});

				this._delegate.emitter.on("HangupSignal", () => {
					this._delegate = null;
					this.signalHangup();
				});

				this._delegate.startStage();
			})
			.catch(() => {
				// On error, skip rather than block the login flow
				if (this.active) this.signalReturn();
			});
	}

	clearHandler() {
		if (!this.active) return;
		if (this._delegate) {
			try { this._delegate.clearHandler(); } catch (_) {}
			this._delegate = null;
		}
		super.clearHandler();
	}
}

export { whosOnlineCheck };
