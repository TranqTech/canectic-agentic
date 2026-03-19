import { BaseSubModule } from "../basesubmodule.js";
import * as privateMessages from "../../models/privateMessages.js";
import * as alogger from "../../utils/alogger.js";

// Lazy-import PM reader
var _readerMod = null;
async function getReaderMod() {
	if (!_readerMod) {
		try {
			_readerMod = await import("./pmReader.js");
		} catch (_) {
			_readerMod = null;
		}
	}
	return _readerMod;
}

// Colors
const CLR_PROMPT = 14;
const CLR_COUNT = 11;
const CLR_DIM = 8;

// =========================================================================

class pmCheck extends BaseSubModule {
	constructor(call) {
		super(call, "PmCheck");

		this._userId = null;
		if (call.user_record) {
			this._userId = call.user_record.id || call.user_record.user_id || null;
		}

		this._unreadCount = 0;
		this._waiting = false;    // waiting for any key (no messages)
		this._prompting = false;  // waiting for Y/N (has messages)
		this._readerActive = false;
		this._activeReader = null;

		this.loggingId = "PmCheck (Node " + call.nodenum + ")";
	}

	onKey(key) {
		if (this._waiting) {
			this.signalReturn();
			return;
		}
		if (this._prompting) {
			// Any key besides Y exits
			if (key === "Enter") return; // ignore bare enter, wait for char
			this.signalReturn();
		}
	}

	onChar(ch) {
		if (this._waiting) {
			this.signalReturn();
			return;
		}
		if (this._prompting) {
			if (ch.toLowerCase() === "y") {
				this._prompting = false;
				this._launchReader();
			} else {
				this.signalReturn();
			}
		}
	}

	handleInput(inputArray) {
		if (this._readerActive && this._activeReader) {
			this._activeReader.handleInput(inputArray);
			return;
		}
		super.handleInput(inputArray);
	}

	async _launchReader() {
		var readerMod = await getReaderMod();
		if (!readerMod || !readerMod.pmReader) {
			this.call.cmds.senddata("\r\n");
			this.signalReturn();
			return;
		}

		var reader = new readerMod.pmReader(this.call);

		this._readerActive = true;
		this._activeReader = reader;

		reader.emitter.on("ModuleReturn", () => {
			this._readerActive = false;
			this._activeReader = null;
			try { reader.clearHandler(); } catch (_) {}
			if (this.active) this.signalReturn();
		});

		reader.emitter.on("HangupSignal", () => {
			this._readerActive = false;
			this._activeReader = null;
			try { reader.clearHandler(); } catch (_) {}
			this.signalHangup();
		});

		reader.startStage();
	}

	run() {
		if (!this._userId) {
			setTimeout(() => { if (this.active) this.signalReturn(); }, 100);
			return;
		}

		privateMessages.getUnreadCount(this._userId)
			.then(count => {
				if (!this.active || !this.call) return;
				this._unreadCount = count || 0;

				if (this._unreadCount === 0) {
					// No new messages
					this.call.cmds.senddata("\r\n");
					if (this.dumb) {
						this.call.cmds.senddata("  No new private messages.\r\n\r\n");
					} else {
						this.call.cmds.setfgcolor(CLR_DIM);
						this.call.cmds.senddata("  No new private messages. ");
						this.call.cmds.setfgcolor(CLR_DIM);
						this.call.cmds.senddata("[Press any key]");
						this.call.cmds.resetcolors();
					}
					this._waiting = true;
				} else {
					// Has unread messages
					this.call.cmds.senddata("\r\n");
					if (this.dumb) {
						this.call.cmds.senddata("  You have " + this._unreadCount +
							" new private message" + (this._unreadCount > 1 ? "s" : "") +
							".\r\n  Read now? (Y/N) ");
					} else {
						this.call.cmds.setfgcolor(CLR_PROMPT);
						this.call.cmds.senddata("  You have ");
						this.call.cmds.setfgcolor(CLR_COUNT);
						this.call.cmds.senddata(String(this._unreadCount));
						this.call.cmds.setfgcolor(CLR_PROMPT);
						this.call.cmds.senddata(" new private message" +
							(this._unreadCount > 1 ? "s" : "") + ". ");
						this.call.cmds.setfgcolor(CLR_COUNT);
						this.call.cmds.senddata("Read now? (Y/N) ");
						this.call.cmds.resetcolors();
					}
					this._prompting = true;
				}
			})
			.catch(err => {
				alogger.writeAlog(3, this.loggingId + " run error: " + (err?.message || err), "redbright");
				if (this.active) this.signalReturn();
			});
	}

	clearHandler() {
		if (!this.active) return;
		if (this._activeReader) {
			try { this._activeReader.clearHandler(); } catch (_) {}
			this._activeReader = null;
			this._readerActive = false;
		}
		super.clearHandler();
	}
}

export { pmCheck };
