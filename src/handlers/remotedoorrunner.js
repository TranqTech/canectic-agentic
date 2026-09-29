// remotedoorrunner.js -- run a door on another Canectic door server for a
// caller here (#86, phase D).
//
// The call adopts this as its current handler, exactly as it does a local
// DoorRunner, so the menu's inactivity timer is out of the way and
// CallManager._doorReturn brings the caller back to the menu (or the next
// flow stage) when the remote door ends.
//
// Flow: connect with the caller's name, screen size and encoding; if the menu
// entry named a door, go straight to it, otherwise show the remote's door list
// as a numbered menu; then pass bytes both ways until the remote side closes.
// The door's own inactivity setting applies, without the "are you there"
// warning, which would land in the middle of the remote door's screen.

import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";
import appConfig from "../config/appConfig.js";
import { openSession } from "../utils/doorserverClient.js";
import * as remotes from "../models/doorserverRemotes.js";
import { createDoorMenu } from "../../bin/doorclient.js";

class RemoteDoorRunner extends BaseHandler {
	/**
	 * remote: a doorserver_remotes row; door: slug or ''.
	 * opts.open: session factory (tests); defaults to openSession.
	 */
	constructor(call, remote, door, opts) {
		super(call, "RemoteDoor");
		this.remote = remote;
		this.door = door || "";
		this.open = (opts && opts.open) || openSession;
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

	startStage() {
		var call = this.call;
		var ur = call.user_record || {};
		var enc = String(call.term_encoding || "").toLowerCase();
		this._enableRawMode();
		this.resetInactivityTimeouts();
		this._say("\r\nConnecting to " + (this.remote.title || this.remote.name) + "...\r\n");

		var s = this.session = this.open({
			url: this.remote.url, systemId: this.remote.system_id, secret: this.remote.secret,
			user: { name: ur.username || call.caller_username || "Guest", real_name: ur.fullname || call.caller_fullname || "" },
			term: { width: call.term_width || 80, height: call.term_height || 24, encoding: (enc === "utf-8" || enc === "utf8") ? "utf8" : "cp437", type: "ansi" },
			door: this.door || undefined
		});
		remotes.touch(this.remote.uuid).catch(function () {});

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
		s.on("data", (buf) => { if (this.call) this.call.cmds.senddata(buf); });
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
		this.streaming = false;
		this.choosing = false;
		if (this.session) this.session.close();
		if (this.call) this.call.cmds.resetcolors();
		this._say("\r\n" + (message ? message + "\r\n" : "") + " Press any key to continue...");
		this.waitingForKey = true;
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
		if (this.session) this.session.close();
		this._disableRawMode();
		super.clearHandler();
	}
}

export { RemoteDoorRunner };
