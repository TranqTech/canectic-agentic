import { BaseHandler } from "./basehandler.js";
import { checkUserPass, updateUserCalls } from "../models/useraccounts.js";
import * as alogger from "../utils/alogger.js";

const validunamechars = new RegExp("[A-Za-z0-9 ]");
const validpwchars = new RegExp("[A-Za-z0-9]");
const login_limit = 3;

// Colors
const warn_clr = 2;
const border_clr = 4;
const unameclr = 11;
const pwclr = 11;
const unamelabel = 10;
const pwlabel = 13;
const logonmsgclr = 15;
const logonmsgbg = 2;

class LoginHandler extends BaseHandler {
    constructor(call, system_name) {
        super(call, "Login");
        this.system_name = system_name;
        this.dumb = (call.term_type === "Dumb");

        // Field state
        this.username = "";
        this.password = "";
        this.current_field = "Username";
        this.login_attempts = 0;
        this.validlogin = false;

        // Box geometry
        this.logon_message = " Logging into " + system_name + " ";
        this.logon_message_x = 0;
        this.logon_message_y = 0;
        this.warn_x = 0;
        this.warn_y = 25;
        this.haswarning = false;
        this.box_start_x = 0;
        this.box_start_y = 0;
        this.box_width = 42;
        this.box_height = 6;
        this.box_end_x = 0;
        this.password_x = 0;
        this.password_y = 0;
        this.username_x = 0;
        this.username_y = 0;
        this.cont_message_x = 0;
        this.cont_message_y = 0;
        this.fieldspaces = "";

        // Box drawing characters from charset
        if (!this.dumb && call.charset) {
            this.menu_tl_corner = call.charset.getBoxBuff(22);
            this.menu_tr_corner = call.charset.getBoxBuff(8);
            this.menu_bl_corner = call.charset.getBoxBuff(21);
            this.menu_br_corner = call.charset.getBoxBuff(9);
            this.menu_lt_corner = call.charset.getBoxBuff(25);
            this.menu_rt_corner = call.charset.getBoxBuff(6);
            this.menu_hz_block = call.charset.getBoxBuff(26);
            this.menu_vert_block = call.charset.getBoxBuff(7);
        }

        // Pre-built line buffers (populated in _calcMenuPos)
        this.menu_top_line = null;
        this.menu_mid_line = null;
        this.menu_bottom_line = null;

        this.loggingId = "Login (Node " + this.call.nodenum + ")";
    }

    // --- Box geometry ---
    _calcMenuPos() {
        if (this.dumb) return;

        this.box_start_x = Math.round(this.call.term_width / 2) - Math.round(this.box_width / 2);
        this.box_start_y = Math.round(this.call.term_height / 2) - Math.round(this.box_height / 2);
        this.password_x = this.box_start_x + 12;
        this.username_x = this.password_x;
        this.username_y = this.box_start_y + 2;
        this.password_y = this.username_y + 2;
        this.box_end_x = this.box_start_x + this.box_width;
        this.cont_message_x = this.box_end_x - 28;
        this.cont_message_y = this.box_start_y + this.box_height;

        this.logon_message_x = Math.round(this.call.term_width / 2) - Math.round(this.logon_message.length / 2);
        if ((this.box_start_y - 2) > 0) {
            this.logon_message_y = this.box_start_y - 2;
        } else {
            this.logon_message_y = 1;
        }

        this.warn_x = this.logon_message_x;
        this.warn_y = this.box_start_y + this.box_height + 1;

        // Build field spaces
        var spacecount = this.box_end_x - (this.box_start_x + 11);
        this.fieldspaces = " ".repeat(spacecount);

        // Build box line buffers
        this.menu_top_line = this.menu_tl_corner;
        this.menu_mid_line = this.menu_lt_corner;
        this.menu_bottom_line = this.menu_bl_corner;

        for (var i = 0; i < (this.box_width - 1); i++) {
            this.menu_top_line = Buffer.concat([this.menu_top_line, this.menu_hz_block]);
            this.menu_mid_line = Buffer.concat([this.menu_mid_line, this.menu_hz_block]);
            this.menu_bottom_line = Buffer.concat([this.menu_bottom_line, this.menu_hz_block]);
        }
        this.menu_top_line = Buffer.concat([this.menu_top_line, this.menu_tr_corner]);
        this.menu_mid_line = Buffer.concat([this.menu_mid_line, this.menu_rt_corner]);
        this.menu_bottom_line = Buffer.concat([this.menu_bottom_line, this.menu_br_corner]);
    }

    // --- Drawing ---
    _drawBox() {
        if (this.dumb) return;

        // Logon message banner
        this.call.cmds.movecursor(this.logon_message_x, this.logon_message_y);
        this.call.cmds.setbgcolor(logonmsgbg);
        this.call.cmds.setfgcolor(logonmsgclr);
        this.call.cmds.senddata(this.logon_message);
        this.call.cmds.resetcolors();

        var currY = this.box_start_y + 1;

        // Top line
        this.call.cmds.movecursor(this.box_start_x, currY);
        this.call.cmds.setfgcolor(border_clr);
        this.call.cmds.senddata(this.menu_top_line);
        currY++;

        // Username row
        this.call.cmds.movecursor(this.box_start_x, currY);
        this.call.cmds.senddata(this.menu_vert_block);
        this.call.cmds.setfgcolor(unamelabel);
        this.call.cmds.senddata(" Username: ");
        this.call.cmds.senddata(this.fieldspaces);
        this.call.cmds.movecursor(this.box_end_x, currY);
        this.call.cmds.setfgcolor(border_clr);
        this.call.cmds.senddata(this.menu_vert_block);
        currY++;

        // Mid line
        this.call.cmds.movecursor(this.box_start_x, currY);
        this.call.cmds.setfgcolor(border_clr);
        this.call.cmds.senddata(this.menu_mid_line);
        currY++;

        // Password row
        this.call.cmds.movecursor(this.box_start_x, currY);
        this.call.cmds.senddata(this.menu_vert_block);
        this.call.cmds.setfgcolor(pwlabel);
        this.call.cmds.senddata(" Password: ");
        this.call.cmds.senddata(this.fieldspaces);
        this.call.cmds.movecursor(this.box_end_x, currY);
        this.call.cmds.setfgcolor(border_clr);
        this.call.cmds.senddata(this.menu_vert_block);
        currY++;

        // Bottom line
        this.call.cmds.movecursor(this.box_start_x, currY);
        this.call.cmds.setfgcolor(border_clr);
        this.call.cmds.senddata(this.menu_bottom_line);

        // Position cursor in username field
        this.call.cmds.movecursor(this.username_x, this.username_y);
        this.call.cmds.setfgcolor(unameclr);
    }

    // --- Input handling ---
    // Override handleInput to clear warning display before dispatching
    handleInput(inputArray) {
        if (this.haswarning) {
            this._clearWarning();
        }
        super.handleInput(inputArray);
    }

    onKey(key) {
        switch (key) {
            case "ESC":
            case "UpArrow":
            case "LeftArrow":
                this._prevField();
                return;
            case "^A":
                this.finished = true;
                return;
            case "Enter":
            case "Tab":
            case "DownArrow":
            case "RightArrow":
                this._nextField();
                return;
            case "Backspace":
                this._handleBackspace();
                return;
        }
    }

    onChar(ch) {
        if (this.current_field === "Username" && validunamechars.test(ch)) {
            this.username += ch;
            this.call.cmds.senddata(ch);
        } else if (this.current_field === "Password" && validpwchars.test(ch)) {
            this.password += ch;
            this.call.cmds.senddata("*");
        }
    }

    _handleBackspace() {
        if (this.current_field === "Username" && this.username.length > 0) {
            this.username = this.username.slice(0, -1);
            this.call.cmds.senddata("\b \b");
        } else if (this.current_field === "Password" && this.password.length > 0) {
            this.password = this.password.slice(0, -1);
            this.call.cmds.senddata("\b \b");
        }
    }

    // --- Field navigation ---
    _prevField() {
        if (this.current_field === "Password") {
            this._restartEntry();
        } else {
            this.finished = true;
        }
    }

    _nextField() {
        if (this.current_field === "Username") {
            if (this.username.length > 0) {
                this.current_field = "Password";
                this._sendPwPrompt();
            } else {
                this.call.cmds.sendbeep();
            }
        } else if (this.current_field === "Password") {
            this._checkLogin();
        }
    }

    _restartEntry() {
        this.username = "";
        this.password = "";
        this.current_field = "Username";
        this._sendUnamePrompt();
    }

    // --- Display ---
    _sendUnamePrompt() {
        if (!this.dumb) {
            this.call.cmds.movecursor(this.username_x, this.username_y);
            this.call.cmds.cleartoeol();
            this.call.cmds.movecursor(this.password_x, this.password_y);
            this.call.cmds.cleartoeol();
            // Redraw right border after clearing
            this.call.cmds.setfgcolor(border_clr);
            this.call.cmds.movecursor(this.box_end_x, this.username_y);
            this.call.cmds.senddata(this.menu_vert_block);
            this.call.cmds.movecursor(this.box_end_x, this.password_y);
            this.call.cmds.senddata(this.menu_vert_block);
            // Position cursor in username field
            this.call.cmds.movecursor(this.username_x, this.username_y);
            this.call.cmds.setfgcolor(unameclr);
        } else {
            this.call.cmds.senddata("\r\n Username: ");
        }
    }

    _sendPwPrompt() {
        if (!this.dumb) {
            this.call.cmds.movecursor(this.password_x, this.password_y);
            this.call.cmds.setfgcolor(pwclr);
        } else {
            this.call.cmds.senddata("\r\n Password: ");
        }
    }

    _sendInvalidMsg() {
        if (!this.dumb) {
            this.call.cmds.movecursor(this.box_start_x, this.box_start_y);
            this.call.cmds.setfgcolor(1);
            this.call.cmds.senddata(" Invalid Login. Try Again.");
        } else {
            this.call.cmds.senddata("\r\n   Invalid Login. Try Again.\r\n");
        }
    }

    _sendLoginOK() {
        if (!this.dumb) {
            this.call.cmds.movecursor(this.box_start_x, this.box_start_y);
            this.call.cmds.cleartoeol();
            this.call.cmds.setfgcolor(10);
            this.call.cmds.senddata(" Login OK! Welcome, ");
            this.call.cmds.senddata(this.call.caller_username);
            this.call.cmds.movecursor(this.cont_message_x, this.cont_message_y);
            this.call.cmds.senddata("Press any key to continue...");
            this.call.cmds.resetcolors();
        } else {
            this.call.cmds.senddata("\r\n Login OK! Welcome, " + this.call.caller_username + "\r\n");
            this.call.cmds.senddata("Press any key to continue...");
        }
    }

    // --- Warning display ---
    _clearWarning() {
        if (!this.haswarning) return;
        this.haswarning = false;
        if (this.dumb) return;

        this.call.cmds.movecursor(this.warn_x, this.warn_y);
        this.call.cmds.cleartoeol();

        // Restore cursor to current field position
        if (this.current_field === "Username") {
            this.call.cmds.setfgcolor(unameclr);
            this.call.cmds.movecursor(this.username_x + this.username.length, this.username_y);
        } else if (this.current_field === "Password") {
            this.call.cmds.setfgcolor(pwclr);
            this.call.cmds.movecursor(this.password_x + this.password.length, this.password_y);
        }
    }

    // Override BaseHandler to position warning in the box
    onInactivityWarn() {
        if (!this.call) return;
        this.haswarning = true;
        if (!this.dumb) {
            this.call.cmds.movecursor(this.warn_x, this.warn_y);
            this.call.cmds.cleartoeol();
            this.call.cmds.setfgcolor(warn_clr);
        }
        this.call.cmds.senddata(this.warnMsg);
    }

    // Override BaseHandler to position kick message
    onInactivityKick() {
        if (!this.call) return;
        if (!this.dumb) {
            this.call.cmds.movecursor(this.warn_x, this.warn_y);
            this.call.cmds.setfgcolor(warn_clr);
            this.call.cmds.cleartoeol();
        }
        this.call.cmds.senddata(this.inactiveMsg);
        this.call.hangUpCall();
    }

    // --- Auth ---
    _checkLogin() {
        checkUserPass(this.username, this.password)
            .then(result => {
                if (!this.active) return;
                if (result.isvalid) {
                    this._loginSuccess(result.useraccount);
                } else {
                    this._loginFailed();
                }
            })
            .catch(err => {
                if (!this.active) return;
                this._handleError("Credential check error", err);
            });
    }

    _loginSuccess(useraccount) {
        this.validlogin = true;
        this.finished = true;
        this.call.caller_username = useraccount.username;
        this.call.caller_fullname = useraccount.fullname;
        this.call.caller_location = useraccount.location;
        this.call.user_record = useraccount;
        if (useraccount.msg_group) this.call.msg_group = useraccount.msg_group;
        if (useraccount.msg_area) this.call.msg_area = useraccount.msg_area;
        if (useraccount.file_group) this.call.file_group = useraccount.file_group;
        if (useraccount.file_area) this.call.file_area = useraccount.file_area;
        this.username = useraccount.username;
        updateUserCalls(useraccount);
        this._sendLoginOK();
    }

    _loginFailed() {
        this.login_attempts += 1;
        this.username = "";
        this.password = "";
        this.current_field = "Username";

        if (this.login_attempts >= login_limit) {
            this.call.cmds.senddata("\r\nToo Many Incorrect Attempts. Goodbye\r\n");
            this._clearAllTimeouts();
            this.emitter.emit("LoginLimit");
            return;
        }
        this._sendInvalidMsg();
        this._sendUnamePrompt();
    }

    // --- Lifecycle ---
    signalReturn() {
        if (this.validlogin) {
            this.emitter.emit("LoginOK");
        } else {
            this.emitter.emit("ModuleReturn");
        }
    }

    startStage() {
        try {
            this._calcMenuPos();
            this.call.cmds.clearscreen();
            this.call.cmds.drawrandomscreen("Login");

            if (!this.dumb) {
                this.emitter.emit("DrawSysInfo");
                this._drawBox();
            } else {
                this.call.cmds.senddata("\r\n");
                this._sendUnamePrompt();
            }

            this.setInactivityTimeouts();
        } catch (err) {
            this._handleError("startStage error", err);
        }
    }
}

export { LoginHandler };