import { BaseSubModule } from "./basesubmodule.js";

const unameclr = 13;
const nodeclr = 14;
const actclr = 6;
const connclr = 12;
const headclr = 11;
const msgclr = 10;

class WhosOnline extends BaseSubModule {
	constructor(call) {
		super(call, "WhosOnline");
		this.nodelist = [];
		this.currntidx = 0;
		this.pausedlist = false;
		this.listfinished = false;
		this.title = "Who's Online";
		this.titleclr = 10;

		// Geometry
		this.titlex = 2;
		this.titley = 2;
		this.liststartx = 3;
		this.col2x = 10;
		this.col3x = 32;
		this.col4x = 62;
		this.liststarty = this.titley + 2;

		// Dumb terminal header
		this.dumbline = "";
		this.dumbhead = "";

		this.loggingId = "WhosOnline (Node " + call.nodenum + ")";
	}

	_calcPos() {
		if (!this.dumb) {
			this.titlex = Math.round(this.call.term_width / 2) - Math.round(this.title.length / 2);
		} else {
			this.dumbline = " Node";
			for (var i = this.dumbline.length; i < this.col2x; i++) this.dumbline += " ";
			this.dumbline += "Username";
			for (var i = this.dumbline.length; i < this.col3x; i++) this.dumbline += " ";
			this.dumbline += "Activity";
			for (var i = this.dumbline.length; i < this.col4x; i++) this.dumbline += " ";
			this.dumbline += "Connection";
			this.dumbhead = "-".repeat(79);
		}
	}

	// Build a human-readable activity string from status + detail
	_formatActivity(entry) {
		var status = entry.status || "";
		var detail = entry.detail || "";

		switch (status) {
			case "connecting":
			case "negotiate":
				return "Connecting";

			case "logon":
			case "login":
				return "Logging In";

			case "door_auth":
				return "Authenticating";

			case "door_launch":
				return "Launching Door";

			case "menu":
				if (detail) {
					return "Browsing the " + detail + " Menu";
				}
				return "Browsing Menus";

			case "door":
				if (detail) {
					// detail_display holds the friendly door name (not the slug)
					var displayName = entry.detail_display || detail;
					return "Playing " + displayName;
				}
				return "Playing a Door";

			case "last_callers":
				return "Viewing Last Callers";

			case "whos_online":
				return "Viewing Who's Online";

			case "disconnecting":
				return "Logging Off";

			default:
				return status || "Unknown";
		}
	}

	_formatConnection(entry) {
		var connType = entry.connection_type || "";
		var labels = {
			"Websock":    "WebSocket",
			"Websocket":  "WebSocket",
			"TCP":        "TCP",
			"Telnet":     "Telnet",
		};
		return labels[connType] || connType || "Unknown";
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
		this.call.cmds.senddata("Node");
		this.call.cmds.movecursor(this.col2x, currY);
		this.call.cmds.senddata("Username");
		this.call.cmds.movecursor(this.col3x, currY);
		this.call.cmds.senddata("Activity");
		this.call.cmds.movecursor(this.col4x, currY);
		this.call.cmds.senddata("Connection");
		currY++;

		this.call.cmds.movecursor(this.liststartx, currY);
		this.call.cmds.senddata("----");
		this.call.cmds.movecursor(this.col2x, currY);
		this.call.cmds.senddata("--------------------");
		this.call.cmds.movecursor(this.col3x, currY);
		this.call.cmds.senddata("----------------------------");
		this.call.cmds.movecursor(this.col4x, currY);
		this.call.cmds.senddata("----------");
		currY++;

		// Entries
		for (var ul = this.currntidx; ul < this.nodelist.length; ul++) {
			var entry = this.nodelist[ul];

			this.call.cmds.movecursor(this.liststartx, currY);
			this.call.cmds.setfgcolor(nodeclr);
			this.call.cmds.senddata(entry.nodenum.toString());

			this.call.cmds.movecursor(this.col2x, currY);
			this.call.cmds.setfgcolor(unameclr);
			this.call.cmds.senddata(entry.username || "\u2014");

			this.call.cmds.movecursor(this.col3x, currY);
			this.call.cmds.setfgcolor(actclr);
			this.call.cmds.senddata(this._formatActivity(entry));

			this.call.cmds.movecursor(this.col4x, currY);
			this.call.cmds.setfgcolor(connclr);
			this.call.cmds.senddata(this._formatConnection(entry));

			this.currntidx = ul;
			currY++;

			if (currY >= this.call.term_height - 1) {
				this.call.cmds.movecursor(this.liststartx, currY);
				this.call.cmds.setfgcolor(msgclr);
				this.call.cmds.senddata("[Pause] Enter for more.");
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

		for (var ul = this.currntidx; ul < this.nodelist.length; ul++) {
			var entry = this.nodelist[ul];
			var line = " " + entry.nodenum.toString();
			for (var i = line.length; i < this.col2x; i++) line += " ";
			line += entry.username || "\u2014";
			for (var i = line.length; i < this.col3x; i++) line += " ";
			line += this._formatActivity(entry);
			for (var i = line.length; i < this.col4x; i++) line += " ";
			line += this._formatConnection(entry);

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
		if (!this.call) return;
		this._calcPos();

		// Get active nodes from the node manager
		if (this.call.nodeManager) {
			this.nodelist = this.call.nodeManager.getActiveNodes();
			// Sort by node number
			this.nodelist.sort((a, b) => a.nodenum - b.nodenum);
		}

		if (this.nodelist.length === 0) {
			this.call.cmds.senddata(this.dumb ? "\r\n  No nodes currently active.\r\n" : "");
			this.listfinished = true;
		}

		this._showList();
	}
}

export { WhosOnline };