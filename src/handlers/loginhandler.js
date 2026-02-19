import { BaseHandler } from "./basehandler.js";
import { checkUserPass, updateUserCalls } from "../../db/useraccounts.js";

const validunamechars = new RegExp("[A-Za-z0-9 ]");
const validpwchars = new RegExp("[A-Za-z0-9]");
const login_limit = 3;

class LoginHandler extends BaseHandler {
    constructor(call, system_name) {
        super(call, "Login");
        this.system_name = system_name;
        this.username = "";
        this.password = "";
        this.current_field = "Username";
        this.login_attempts = 0;
        this.validlogin = false;
    }

    // --- Input handling ---
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

    // --- Display (dumb terminal — add ANSI branching as needed) ---
    _sendUnamePrompt() {
        this.call.cmds.senddata("\r\n Username: ");
    }

    _sendPwPrompt() {
        this.call.cmds.senddata("\r\n Password: ");
    }

    _sendInvalidMsg() {
        this.call.cmds.senddata("\r\n   Invalid Login. Try Again.\r\n");
    }

    _sendLoginOK() {
        this.call.cmds.senddata("\r\n Login OK! Welcome, " + this.call.caller_username + "\r\n");
        this.call.cmds.senddata("Press any key to continue...");
    }

    // --- Lifecycle overrides ---
    signalReturn() {
        if (this.validlogin) {
            this.emitter.emit("LoginOK");
        } else {
            this.emitter.emit("ModuleReturn");
        }
    }

    startStage() {
        try {
            this.call.cmds.clearscreen();
            this.call.cmds.senddata("\r\n=== " + this.system_name + " Login ===\r\n");
            this._sendUnamePrompt();
            this.setInactivityTimeouts();
        } catch (err) {
            this._handleError("startStage error", err);
        }
    }
}

export { LoginHandler };