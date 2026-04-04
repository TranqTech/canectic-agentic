// notificationReader.js -- Terminal notification reader.
//
// Displays recent notifications in a list. Sysops see sysop broadcasts
// alongside personal notifications. Used as a menu command and call flow stage.

import { BaseSubModule } from "../basesubmodule.js";
import * as alogger from "../../utils/alogger.js";

const TITLE_CLR = 14;
const UNREAD_CLR = 11;
const READ_CLR = 8;
const SEVERITY_DANGER = 12;
const SEVERITY_WARNING = 3;
const SEVERITY_SUCCESS = 10;
const SEVERITY_INFO = 6;
const PROMPT_CLR = 11;

class NotificationReader extends BaseSubModule {
	constructor(call) {
		super(call, "NotificationReader");
		this._notifications = [];
		this._selected = 0;
		this._state = 'loading';
		this.loggingId = "NotificationReader (Node " + call.nodenum + ")";
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		var userId = this.call.caller_user_id;
		if (!userId) { this.signalReturn(); return; }

		try {
			var notifMod = await import('../../models/notifications.js');
			var isSysop = !!(this.call.user_record && this.call.user_record.permissionflags &&
				this.call.user_record.permissionflags.includes && this.call.user_record.permissionflags.includes('Sysop'));
			this._notifications = await notifMod.getUnread(userId, isSysop, 20);
		} catch (err) {
			alogger.writeAlog(3, 'NotificationReader: load error: ' + err.message, 'yellow');
		}

		if (this._notifications.length === 0) {
			if (this.dumb) {
				this.call.cmds.senddata("\r\n  No unread notifications.\r\n  Press any key...\r\n");
			} else {
				this.call.cmds.clearscreen();
				this.call.cmds.movecursor(3, 3);
				this.call.cmds.setfgcolor(TITLE_CLR);
				this.call.cmds.senddata("No unread notifications.");
				this.call.cmds.resetcolors();
				this.call.cmds.movecursor(3, 5);
				this.call.cmds.senddata("Press any key...");
			}
			this._state = 'done';
			return;
		}

		this._state = 'list';
		this._drawList();
	}

	_drawList() {
		var cmds = this.call.cmds;
		var cols = this.call.term_width || 80;
		var rows = this.call.term_height || 25;

		if (this.dumb) {
			cmds.senddata("\r\n  Notifications (" + this._notifications.length + " unread)\r\n\r\n");
			for (var i = 0; i < this._notifications.length; i++) {
				var n = this._notifications[i];
				var sev = n.severity === 'danger' ? '!!' : n.severity === 'warning' ? '! ' : '  ';
				cmds.senddata("  " + sev + " " + (n.title || '') + "\r\n");
			}
			cmds.senddata("\r\n  [R] Mark all read  [Q] Quit\r\n  > ");
			return;
		}

		cmds.clearscreen();
		cmds.resetcolors();

		// Title
		var title = "Notifications (" + this._notifications.length + " unread)";
		var titleX = Math.round(cols / 2) - Math.round(title.length / 2);
		cmds.movecursor(titleX, 2);
		cmds.setfgcolor(TITLE_CLR);
		cmds.senddata(title);
		cmds.resetcolors();

		// List
		var startRow = 4;
		var maxDisplay = Math.min(this._notifications.length, rows - 6);

		for (var i = 0; i < maxDisplay; i++) {
			var n = this._notifications[i];
			var row = startRow + i;
			var isSelected = (i === this._selected);

			cmds.movecursor(2, row);

			// Severity indicator
			var sevClr = n.severity === 'danger' ? SEVERITY_DANGER :
				n.severity === 'warning' ? SEVERITY_WARNING :
				n.severity === 'success' ? SEVERITY_SUCCESS : SEVERITY_INFO;
			cmds.setfgcolor(sevClr);
			cmds.senddata(n.severity === 'danger' ? '!! ' : n.severity === 'warning' ? '!  ' : '   ');

			// Title
			if (isSelected) {
				cmds.setfgcolor(0);
				cmds.setbgcolor(UNREAD_CLR);
			} else {
				cmds.setfgcolor(n.read ? READ_CLR : UNREAD_CLR);
			}

			var titleText = (n.title || '').substring(0, cols - 10);
			cmds.senddata(titleText);

			cmds.resetcolors();
		}

		// Prompt
		cmds.movecursor(2, rows - 1);
		cmds.setfgcolor(PROMPT_CLR);
		cmds.senddata("[R] Mark All Read  [Enter] View  [Q] Quit");
		cmds.resetcolors();
	}

	onKey(key) {
		if (!this.active || !this.call) return;

		if (this._state === 'done' || this._state === 'detail') {
			this.signalReturn();
			return;
		}

		if (this._state === 'list') {
			if (key === 'ESC') {
				this.signalReturn();
				return;
			}
			if (key === 'Up' && this._selected > 0) {
				this._selected--;
				this._drawList();
				return;
			}
			if (key === 'Down' && this._selected < this._notifications.length - 1) {
				this._selected++;
				this._drawList();
				return;
			}
			if (key === 'Enter') {
				this._viewDetail();
				return;
			}
		}
	}

	onChar(ch) {
		if (!this.active || !this.call) return;

		if (this._state === 'done' || this._state === 'detail') {
			this.signalReturn();
			return;
		}

		var upper = ch.toUpperCase();

		if (this._state === 'list') {
			if (upper === 'Q') {
				this.signalReturn();
				return;
			}
			if (upper === 'R') {
				this._markAllRead();
				return;
			}
		}
	}

	async _viewDetail() {
		if (this._selected >= this._notifications.length) return;
		var n = this._notifications[this._selected];

		// Mark read
		try {
			var notifMod = await import('../../models/notifications.js');
			await notifMod.markRead(n.id, this.call.caller_user_id);
			n.read = true;
		} catch (_) {}

		var cmds = this.call.cmds;

		if (this.dumb) {
			cmds.senddata("\r\n  " + (n.title || '') + "\r\n");
			if (n.body) cmds.senddata("  " + n.body + "\r\n");
			cmds.senddata("\r\n  Press any key...\r\n");
			this._state = 'detail';
			return;
		}

		cmds.clearscreen();
		cmds.resetcolors();

		var sevClr = n.severity === 'danger' ? SEVERITY_DANGER :
			n.severity === 'warning' ? SEVERITY_WARNING :
			n.severity === 'success' ? SEVERITY_SUCCESS : SEVERITY_INFO;

		cmds.movecursor(3, 3);
		cmds.setfgcolor(sevClr);
		cmds.senddata(n.title || '');
		cmds.resetcolors();

		if (n.body) {
			cmds.movecursor(3, 5);
			cmds.setfgcolor(7);
			cmds.senddata(n.body);
		}

		if (n.created_at) {
			cmds.movecursor(3, 7);
			cmds.setfgcolor(8);
			cmds.senddata(new Date(n.created_at).toLocaleString());
		}

		cmds.movecursor(3, 9);
		cmds.setfgcolor(PROMPT_CLR);
		cmds.senddata("Press any key...");
		cmds.resetcolors();

		this._state = 'detail';
	}

	async _markAllRead() {
		try {
			var notifMod = await import('../../models/notifications.js');
			var isSysop = !!(this.call.user_record && this.call.user_record.permissionflags &&
				this.call.user_record.permissionflags.includes && this.call.user_record.permissionflags.includes('Sysop'));
			await notifMod.markAllRead(this.call.caller_user_id, isSysop);
		} catch (_) {}
		this.signalReturn();
	}
}

export { NotificationReader };
