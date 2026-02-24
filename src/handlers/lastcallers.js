import { BaseSubModule } from "./basesubmodule.js";
import { DateTime } from "luxon";
import { getLastCallers } from "../models/callers.js";

const unameclr = 13;
const fcallclr = 6;
const lcallclr = 12;
const ccntclr = 14;
const headclr = 11;
const msgclr = 10;

class LastCallers extends BaseSubModule {
	constructor(call) {
		super(call, "LastCallers");
		this.callerlist = [];
		this.currntidx = 0;
		this.pausedlist = false;
		this.listfinished = false;
		this.title = "Last Callers";
		this.titleclr = 10;

		// Geometry
		this.titlex = 2;
		this.titley = 2;
		this.liststartx = 3;
		this.col2x = 27;
		this.col3x = 53;
		this.col4x = 73;
		this.liststarty = this.titley + 2;

		// Dumb terminal header (built in _calcPos)
		this.dumbline = "";
		this.dumbhead = "";

		this.loggingId = "LastCallers (Node " + call.nodenum + ")";
	}

	_calcPos() {
		if (!this.dumb) {
			this.titlex = Math.round(this.call.term_width / 2) - Math.round(this.title.length / 2);
		} else {
			this.dumbline = " Username";
			for (var i = this.dumbline.length; i < this.col2x; i++) this.dumbline += " ";
			this.dumbline += "Time";
			for (var i = this.dumbline.length; i < this.col3x; i++) this.dumbline += " ";
			this.dumbline += "Location";
			for (var i = this.dumbline.length; i < this.col4x; i++) this.dumbline += " ";
			this.dumbline += "Calls";
			this.dumbhead = "-".repeat(79);
		}
	}

	_formatTime(starttime) {
		if (!starttime) return "";
		var ltob = DateTime.fromJSDate(starttime);
		if (ltob.hasSame(DateTime.local(), "day")) {
			return ltob.toFormat("HH:mm");
		}
		return ltob.toFormat("MMMM dd");
	}

	// --- Display ---
	_showList() {
		if (this.dumb) {
			this._showListDumb();
			return;
		}

		this.pausedlist = false;
		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();
		this.call.cmds.movecursor(this.titlex, this.titley);
		this.call.cmds.setfgcolor(this.titleclr);
		this.call.cmds.senddata(this.title);

		var currY = this.liststarty;

		// Header
		this.call.cmds.movecursor(this.liststartx, currY);
		this.call.cmds.setfgcolor(headclr);
		this.call.cmds.senddata("Username");
		this.call.cmds.movecursor(this.col2x, currY);
		this.call.cmds.senddata("Time");
		this.call.cmds.movecursor(this.col3x, currY);
		this.call.cmds.senddata("Location");
		this.call.cmds.movecursor(this.col4x - 2, currY);
		this.call.cmds.senddata("Calls");
		currY++;

		this.call.cmds.movecursor(this.liststartx, currY);
		this.call.cmds.senddata("--------");
		this.call.cmds.movecursor(this.col2x, currY);
		this.call.cmds.senddata("--------");
		this.call.cmds.movecursor(this.col3x, currY);
		this.call.cmds.senddata("-------");
		this.call.cmds.movecursor(this.col4x - 2, currY);
		this.call.cmds.senddata("-----");
		currY++;

		// Entries
		for (var ul = this.currntidx; ul < this.callerlist.length; ul++) {
			var entry = this.callerlist[ul];

			this.call.cmds.movecursor(this.liststartx, currY);
			this.call.cmds.setfgcolor(unameclr);
			this.call.cmds.senddata(entry.username);

			this.call.cmds.movecursor(this.col2x, currY);
			this.call.cmds.setfgcolor(fcallclr);
			this.call.cmds.senddata(this._formatTime(entry.starttime));

			this.call.cmds.movecursor(this.col3x + 2, currY);
			this.call.cmds.setfgcolor(lcallclr);
			this.call.cmds.senddata(entry.location || entry.source || "");

			this.call.cmds.movecursor(this.col4x, currY);
			this.call.cmds.setfgcolor(ccntclr);
			if (entry.logoncount) this.call.cmds.senddata(entry.logoncount.toString());

			this.currntidx = ul;
			currY++;

			if (currY >= this.call.term_height - 1) {
				this.call.cmds.movecursor(this.liststartx, currY);
				this.call.cmds.setfgcolor(msgclr);
				var pct = Math.round(this.currntidx / this.callerlist.length * 100) + "%";
				this.call.cmds.senddata("[Pause] Enter for more.");
				this.call.cmds.movecursor(this.col4x, currY);
				this.call.cmds.senddata(pct);
				this.pausedlist = true;
				return;
			}
		}

		currY++;
		this.call.cmds.setfgcolor(msgclr);
		this.call.cmds.movecursor(this.liststartx, currY);
		this.call.cmds.senddata("Press Enter to continue");
		this.listfinished = true;
	}

	_showListDumb() {
		if (!this.pausedlist) {
			this.call.cmds.senddata("\r\n  " + this.title + "\r\n");
			this.call.cmds.senddata(this.dumbline + "\r\n");
			this.call.cmds.senddata(this.dumbhead);
		}
		this.pausedlist = false;
		var lineCount = 0;

		for (var ul = this.currntidx; ul < this.callerlist.length; ul++) {
			var entry = this.callerlist[ul];
			var line = " " + entry.username;
			for (var i = line.length; i < this.col2x; i++) line += " ";
			line += this._formatTime(entry.starttime);
			for (var i = line.length; i < this.col3x; i++) line += " ";
			line += entry.location || "Unknown";
			for (var i = line.length; i < this.col4x; i++) line += " ";
			if (entry.logoncount) line += entry.logoncount.toString();

			this.call.cmds.senddata("\r\n" + line);
			this.currntidx = ul;
			lineCount++;

			if (lineCount >= 23) {
				var pct = Math.round(this.currntidx / this.callerlist.length * 100) + "%";
				this.call.cmds.senddata("\r\n [Pause] Enter for more.  - " + pct);
				this.pausedlist = true;
				return;
			}
		}

		this.call.cmds.senddata("\r\n Press Enter to continue");
		this.listfinished = true;
	}

	// --- Input ---
	onKey(key) {
		this._handleAnyInput();
	}

	onChar(ch) {
		this._handleAnyInput();
	}

	_handleAnyInput() {
		if (this.pausedlist) {
			this.currntidx++;
			this._showList();
			return;
		}
		if (this.listfinished) {
			this.finished = true;
		}
	}

	// --- Lifecycle ---
	run() {
		if (!this.call) return;
		this._calcPos();
		getLastCallers()
			.then(res => {
				if (!this.active) return;
				this.callerlist = res.reverse();
				this._showList();
			})
			.catch(err => {
				if (!this.active) return;
				console.log(err);
				this.signalReturn();
			});
	}
}

export { LastCallers };