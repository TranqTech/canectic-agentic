import { BaseSubModule } from "../basesubmodule.js";
import { DateTime } from "luxon";
import { getUserList } from "../../models/useraccounts.js";

const unameclr = 13;
const fcallclr = 6;
const lcallclr = 12;
const ccntclr = 14;
const headclr = 11;
const msgclr = 10;

class userList extends BaseSubModule {
	constructor(call) {
		super(call, "UserList");
		this.userlist = [];
		this.currntidx = 0;
		this.pausedlist = false;
		this.listfinished = false;

		// Geometry
		this.liststartx = 3;
		this.col2x = 27;
		this.col3x = 47;
		this.col4x = 73;
		this.liststarty = 2;
	}

	_showList() {
		if (this.dumb) {
			this._showListDumb();
			return;
		}

		this.pausedlist = false;
		this.call.cmds.clearscreen();
		var currY = this.liststarty;

		this.call.cmds.movecursor(this.liststartx, currY);
		this.call.cmds.setfgcolor(headclr);
		this.call.cmds.senddata("Username");
		this.call.cmds.movecursor(this.col2x, currY);
		this.call.cmds.senddata("First On");
		this.call.cmds.movecursor(this.col3x, currY);
		this.call.cmds.senddata("Last On");
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

		for (var ul = this.currntidx; ul < this.userlist.length; ul++) {
			var entry = this.userlist[ul];

			this.call.cmds.movecursor(this.liststartx, currY);
			this.call.cmds.setfgcolor(unameclr);
			this.call.cmds.senddata(entry.username);

			this.call.cmds.movecursor(this.col2x, currY);
			this.call.cmds.setfgcolor(fcallclr);
			if (entry.firstlogon) {
				this.call.cmds.senddata(DateTime.fromJSDate(entry.firstlogon).toFormat("MMMM dd, yyyy"));
			}

			this.call.cmds.movecursor(this.col3x, currY);
			this.call.cmds.setfgcolor(lcallclr);
			if (entry.lastlogon) {
				this.call.cmds.senddata(DateTime.fromJSDate(entry.lastlogon).toFormat("MMMM dd, yyyy"));
			}

			this.call.cmds.movecursor(this.col4x, currY);
			this.call.cmds.setfgcolor(ccntclr);
			if (entry.logoncount) {
				this.call.cmds.senddata(entry.logoncount.toString());
			}

			this.currntidx = ul;
			currY++;

			if (currY >= this.call.term_height - 1) {
				this.call.cmds.movecursor(this.liststartx, currY);
				this.call.cmds.setfgcolor(msgclr);
				var pct = Math.round(this.currntidx / this.userlist.length * 100) + "%";
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
		this.call.cmds.senddata("List Complete, Press enter to exit");
		this.listfinished = true;
	}

	_showListDumb() {
		this.pausedlist = false;
		this.call.cmds.senddata("\r\n User List\r\n");
		var lineCount = 0;

		for (var ul = this.currntidx; ul < this.userlist.length; ul++) {
			var entry = this.userlist[ul];
			var line = " " + entry.username;
			this.call.cmds.senddata("\r\n" + line);
			this.currntidx = ul;
			lineCount++;

			if (lineCount >= 23) {
				this.call.cmds.senddata("\r\n [Pause] Enter for more.");
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
		getUserList()
			.then(res => {
				if (!this.active) return;
				this.userlist = res;
				this._showList();
			})
			.catch(err => {
				if (!this.active) return;
				console.log(err);
				this.signalReturn();
			});
	}
}

export { userList };
