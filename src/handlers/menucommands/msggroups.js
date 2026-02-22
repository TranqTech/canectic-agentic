import { BaseSubModule } from "../basesubmodule.js";
import { updateUserMsgGroup } from "../../models/useraccounts.js";
import { listMsgGroups } from "../../models/messages.js";

const number_regex = new RegExp("[0-9]");
const df_error_clr = 2;
const df_input_clr = 13;
const df_prompt_clr = 11;
const df_title_clr = 14;
const df_list_clr = 15;

class msgGroupChange extends BaseSubModule {
	constructor(call) {
		super(call, "MsgGroupSelect");
		this.title = "Message Groups";
		this.msg_group_arr = [];
		this.inputbuffer = "";
		this.haserror = false;

		// Colors
		this.title_clr = df_title_clr;
		this.prompt_clr = df_prompt_clr;
		this.error_clr = df_error_clr;
		this.input_clr = df_input_clr;
		this.list_clr = df_list_clr;

		// Geometry
		this.title_x = 2;
		this.title_y = 2;
		this.list_start_x = this.title_x + 2;
		this.list_start_y = this.title_y + 2;
		this.prompt_x = 2;
		this.prompt_y = 0;
		this.error_x = 2;
		this.error_y = 0;
		this.input_x = 2;
		this.input_y = 0;

		// Build prompt string
		if (call.msg_group) {
			this.prompt_str = "Message Group Select -> [" + call.msg_group + "] -> " + call.caller_username + ":";
		} else {
			this.prompt_str = "Message Group Select -> " + call.caller_username + ":";
		}
	}

	_calcPos() {
		if (this.dumb) return;
		this.prompt_y = this.call.term_height - 1;
		this.input_x = this.prompt_x + this.prompt_str.length + 1;
		this.input_y = this.prompt_y;
		this.error_x = this.prompt_x;
		this.error_y = this.call.term_height;
	}

	_drawMenu() {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n" + this.title + "\r\n");
			for (var i = 0; i < this.msg_group_arr.length; i++) {
				this.call.cmds.senddata("  " + (i + 1) + ") " + this.msg_group_arr[i].title + "\r\n");
			}
			this.call.cmds.senddata(this.prompt_str);
			return;
		}

		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();
		this.call.cmds.movecursor(this.title_x, this.title_y);
		this.call.cmds.setfgcolor(this.title_clr);
		this.call.cmds.senddata(this.title);

		var currY = this.list_start_y;
		for (var i = 0; i < this.msg_group_arr.length; i++) {
			this.call.cmds.movecursor(this.list_start_x, currY);
			this.call.cmds.setfgcolor(this.list_clr);
			this.call.cmds.senddata((i + 1) + ") " + this.msg_group_arr[i].title);
			currY++;
		}

		this.call.cmds.setfgcolor(this.prompt_clr);
		this.call.cmds.movecursor(this.prompt_x, this.prompt_y);
		this.call.cmds.senddata(this.prompt_str);
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	_drawError(msg) {
		this.haserror = true;
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + msg + "\r\n" + this.prompt_str);
			return;
		}
		this._clearInput();
		this.call.cmds.movecursor(this.error_x, this.error_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.error_clr);
		this.call.cmds.senddata(msg);
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	_clearInput() {
		if (this.dumb) return;
		this.call.cmds.movecursor(this.input_x, this.input_y);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(this.input_clr);
		this.call.cmds.movecursor(this.input_x, this.input_y);
	}

	_trySelect() {
		var inputint = Number(this.inputbuffer);
		if (isNaN(inputint) || inputint < 1 || !this.msg_group_arr[inputint - 1]) {
			this._drawError("Invalid Selection");
			this.inputbuffer = "";
			return;
		}

		var selected = this.msg_group_arr[inputint - 1];
		this._clearInput();
		this.call.cmds.senddata(selected.title);
		this.inputbuffer = "";
		this.call.msg_group = selected.name;
		this.call.msg_group_title = selected.title;
		updateUserMsgGroup(this.call.caller_username, selected.name);
		this.signalReturn();
	}

	// --- Input ---
	onKey(key) {
		switch (key) {
			case "Enter":
				if (this.inputbuffer.length > 0) this._trySelect();
				return;
			case "ESC":
				this.signalReturn();
				return;
			case "Backspace":
				if (this.inputbuffer.length > 0) {
					this.call.cmds.senddata("\b \b");
					this.inputbuffer = this.inputbuffer.slice(0, -1);
				}
				return;
		}
	}

	onChar(ch) {
		if (ch.toLowerCase() === "q") {
			this.signalReturn();
			return;
		}
		if (number_regex.test(ch)) {
			this.inputbuffer += ch;
			this.call.cmds.senddata(ch);
			// Auto-select if list is small enough
			if (this.msg_group_arr.length < 10) {
				this._trySelect();
			} else if (this.inputbuffer.length > 1 && this.msg_group_arr.length < 100) {
				this._trySelect();
			}
		}
	}

	// --- Lifecycle ---
	run() {
		listMsgGroups()
			.then(res => {
				if (!this.active) return;
				this.msg_group_arr = res || [];
				this._calcPos();
				this._drawMenu();
			})
			.catch(err => {
				if (!this.active) return;
				console.log(err);
				this.signalReturn();
			});
	}
}

export { msgGroupChange };
