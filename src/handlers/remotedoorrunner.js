// remotedoorrunner.js -- run a door on another system for a caller here
// (#86 phase D; every kind of door provider since #89).
//
// The call adopts this as its current handler, exactly as it does a local
// DoorRunner, so the menu's inactivity timer is out of the way and
// CallManager._doorReturn brings the caller back to the menu (or the next
// flow stage) when the remote door ends.
//
// Flow: connect with the caller's name, screen size and encoding; if a door
// was named, go straight to it, otherwise a Canectic door server's list is
// shown as a numbered menu (an RLogin server or BBSLink shows its own menu);
// then pass bytes both ways until the remote side closes. Output from an
// RLogin server or BBSLink is CP437 and is converted for a UTF-8 caller.
// The door's own inactivity setting applies, without the "are you there"
// warning, which would land in the middle of the remote door's screen.

import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";
import { openProviderSession } from "../utils/doorProviders.js";
import { DoorOutputParser } from "../helpers/outputParser.js";
import * as remotes from "../models/doorserverRemotes.js";
import { createDoorMenu } from "../../bin/doorclient.js";

class RemoteDoorRunner extends BaseHandler {
	/**
	 * remote: a doorserver_remotes row; door: slug or ''.
	 * opts.open(remote, sessionOpts): session factory (tests); defaults to
	 * openProviderSession. May return the session or a promise of it.
	 */
	constructor(call, remote, door, opts) {
		super(call, "RemoteDoor");
		this.remote = remote;
		this.door = door || "";
		this.open = (opts && opts.open) || openProviderSession;
		this.inactivityTO = appConfig.getNumber('doorInactivityTO', 5) * 60 * 1000;
		this.session = null;
		this.streaming = false;
		this.choosing = false;
		this.menu = null;
		this.waitingForKey = false;
		this.loggingId = "RemoteDoor (Node " + call.nodenum + ") [" + remote.name + (door ? ":" + door : "") + "]";
	}

	_say(text) { if (this.call) this.call.cmds.senddata(text); }

	_enableRawMode() {
		this._prevRawmode = this.call.rawmode;
		this._prevRawtarget = this.call.rawtarget;
		this.call.rawmode = true;
		this.call.rawtarget = (data) => this._onInput(data);
	}

	_disableRawMode() {
		if (!this.call) return;
		this.call.rawmode = this._prevRawmode;
		this.call.rawtarget = this._prevRawtarget;
	}

	async startStage() {
		var call = this.call;
		var ur = call.user_record || {};
		var enc = String(call.term_encoding || "").toLowerCase();
		var utf8 = enc === "utf-8" || enc === "utf8";
		this._enableRawMode();
		this.resetInactivityTimeouts();
		this._say("\r\nConnecting to " + (this.remote.title || this.remote.name) + "...\r\n");

		var s;
		try {
			s = await this.open(this.remote, {
				user: { name: ur.username || call.caller_username || "Guest", real_name: ur.fullname || call.caller_fullname || "", id: ur.id || null },
				term: { width: call.term_width || 80, height: call.term_height || 24, encoding: utf8 ? "utf8" : "cp437", type: "ansi" },
				door: this.door || ""
			});
		} catch (err) {
			alogger.writeAlog(2, this.loggingId + "\n  Could not open the session: " + (err.stack || err), "redbright");
			this._end("Could not connect: " + (err.message || err));
			return;
		}
		if (!this.active) { try { s.close(); } catch (_) {} return; }
		this.session = s;
		remotes.touch(this.remote.uuid).catch(function () {});

		// An RLogin server or BBSLink sends CP437 whatever the caller's terminal
		if (s.cp437 && utf8) {
			this._outputParser = new DoorOutputParser({ convertCP437: true, centerOutput: false, srcCols: 80, srcRows: 25, destCols: call.term_width || 80, destRows: call.term_height || 25 });
			this._outputParser.emitter.on("data", (processed) => { if (this.call) this.call.cmds.senddata(processed); });
		}

		s.on("auth_ok", (doors, collections) => {
			if (this.door) return;
			if (!doors || !doors.length) { this._end("That door server has no doors on offer."); return; }
			this.choosing = true;
			this.menu = createDoorMenu({
				doors: doors, collections: collections, title: this.remote.title || this.remote.name, quitWord: "go back",
				write: (t) => this._say(t),
				onPick: (slug) => { this.choosing = false; this.session.launch(slug); },
				onQuit: () => { this.choosing = false; this.session.close(); this._finish(); }
			});
			this.menu.start();
		});
		s.on("launch_ok", () => {
			this.streaming = true;
			this.choosing = false;
			alogger.writeAlog(3, this.loggingId + "\n  " + ((call.user_record && call.user_record.username) || call.caller_username || "?") + " entered a remote door", "greenbright");
		});
		s.on("data", (buf) => {
			if (!this.call) return;
			if (this._outputParser) this._outputParser.process(buf);
			else this.call.cmds.senddata(buf);
		});
		s.on("auth_fail", (reason) => this._end("The door server refused the connection: " + reason));
		s.on("error_frame", (reason) => { if (!this.streaming) this._end(reason); });
		s.on("error", (reason) => { if (!this.streaming) this._end("Could not connect: " + reason); });
		s.on("close", () => {
			if (this.waitingForKey || !this.active) return;
			this._end(this.streaming ? "" : "The door server closed the connection.");
		});
	}

	_onInput(data) {
		if (!this.active) return;
		this.resetInactivityTimeouts();
		if (this.waitingForKey) { this._finish(); return; }
		if (this.streaming) { this.session.send(Buffer.from(data)); return; }
		if (!this.choosing) return;
		for (var ch of Buffer.from(data).toString("latin1")) {
			this.menu.key(ch);
			if (!this.choosing) return;
		}
	}

	// The remote door or the connection ended: say why if there is a reason,
	// and wait for a key so the caller can read it.
	_end(message) {
		if (!this.active || this.waitingForKey) return;
		// Set first: closing the session emits 'close', which comes back here
		this.waitingForKey = true;
		this.streaming = false;
		this.choosing = false;
		if (this.session) this.session.close();
		if (this.call) this.call.cmds.resetcolors();
		this._say("\r\n" + (message ? message + "\r\n" : "") + " Press any key to continue...");
	}

	_finish() {
		// Nothing may time the caller out once the remote door is over
		this._clearAllTimeouts();
		this._disableRawMode();
		this.finished = true;
		this.signalReturn();
	}

	onInactivityWarn() { }

	clearHandler() {
		if (!this.active) return;
		var session = this.session;
		this._disableRawMode();
		super.clearHandler();
		// After the handler has stopped, so the session's 'close' is not taken
		// for the remote door ending
		if (session) session.close();
	}
}

export { RemoteDoorRunner };
