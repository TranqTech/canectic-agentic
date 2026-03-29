// mailVerifyCheck.js - Call flow wrapper for mailVerify.
// Checks verification status and skips entirely if already verified.
// For the menu command (on-demand), use mailVerify directly.

import { BaseSubModule } from "../basesubmodule.js";
import { isVerified } from "../../models/mailVerification.js";
import { mailVerify } from "./mailVerify.js";

class mailVerifyCheck extends BaseSubModule {
	constructor(call) {
		super(call, "MailVerifyCheck");

		this._userId = null;
		if (call.user_record) {
			this._userId = call.user_record.id || null;
		}

		this._verifierActive = false;
		this._activeVerifier = null;
		this.loggingId = "MailVerifyCheck (Node " + call.nodenum + ")";
	}

	handleInput(inputArray) {
		if (this._verifierActive && this._activeVerifier) {
			this._activeVerifier.handleInput(inputArray);
			return;
		}
		super.handleInput(inputArray);
	}

	onKey(key) {}
	onChar(ch) {}

	run() {
		if (!this.call || !this._userId) {
			this.signalReturn();
			return;
		}

		isVerified(this._userId)
			.then(verified => {
				if (!this.active) return;
				if (verified) {
					this.signalReturn();
					return;
				}
				// Not verified - launch the full verifier
				this._activeVerifier = new mailVerify(this.call);
				this._verifierActive = true;
				this._activeVerifier.emitter.on("ModuleReturn", () => {
					this._verifierActive = false;
					this._activeVerifier = null;
					this.signalReturn();
				});
				this._activeVerifier.run();
			})
			.catch(err => {
				if (!this.active) return;
				this.signalReturn();
			});
	}
}

export { mailVerifyCheck };
