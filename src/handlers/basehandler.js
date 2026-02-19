import { EventEmitter } from 'node:events';
import * as alogger from "../utils/alogger.js";

const defaultInactivityTO = Number(process.env.connectTO) || 60000;
const defaultWarnBuff = Number(process.env.warnbuff) || 10000;
const defaultWarnMsg = process.env.warnmsg || "Are you there?";
const defaultInactiveMsg = process.env.inactivemsg || "You have been inactive too long";

class BaseHandler {
    constructor(call, handlerType) {
        this.call = call;
        this.type = handlerType || "Base";
        this.active = true;
        this.finished = false;
        this.emitter = new EventEmitter();
        this.loggingId = this.type + " Handler (Node " + this.call.nodenum + ")";

        // Timeout config — subclasses can override in constructor
        this.inactivityTO = defaultInactivityTO;
        this.warnBuff = defaultWarnBuff;
        this.warnMsg = defaultWarnMsg;
        this.inactiveMsg = defaultInactiveMsg;

        // Tracked timeouts
        this._timeouts = new Set();
    }

    // --- Timeout management ---
    _setTimeout(fn, delay) {
        const id = setTimeout(() => {
            this._timeouts.delete(id);
            if (!this.active) return;
            try {
                fn();
            } catch (err) {
                this._handleError("Timeout callback error", err);
            }
        }, delay);
        this._timeouts.add(id);
        return id;
    }

    _clearAllTimeouts() {
        for (const id of this._timeouts) {
            clearTimeout(id);
        }
        this._timeouts.clear();
    }

    // --- Inactivity ---
    setInactivityTimeouts() {
        if (this.finished || !this.active) return;
        const warnDelay = (this.inactivityTO - this.warnBuff > 0)
            ? this.inactivityTO - this.warnBuff
            : Math.round(this.inactivityTO / 2);
        this._setTimeout(() => this.onInactivityWarn(), warnDelay);
        this._setTimeout(() => this.onInactivityKick(), this.inactivityTO);
    }

    resetInactivityTimeouts() {
        this._clearAllTimeouts();
        this.setInactivityTimeouts();
    }

    onInactivityWarn() {
        if (this.call) {
            this.call.cmds.senddata("\r\n" + this.warnMsg);
        }
    }

    onInactivityKick() {
        if (this.call) {
            this.call.cmds.senddata("\r\n" + this.inactiveMsg);
            this.call.hangUpCall();
        }
    }

    // --- Error isolation ---
    _handleError(context, err) {
        var logmsg = this.loggingId + "\n  " + context + "\n  " + (err?.stack || err);
        alogger.writeAlog(3, logmsg, "red");
        try {
            if (this.call) {
                this.call.hangUpCall();
            }
        } catch (_) { }
        this.clearHandler();
    }

    // --- Input dispatch ---
    // Subclasses implement onKey(), onChar(), onCmd()
    handleInput(inputArray) {
        if (!this.active) return;
        try {
            this._clearAllTimeouts();
            for (const inputkey of inputArray) {
                if (!this.active) break;
                this._dispatchInput(inputkey);
            }
            if (!this.active) return;
            if (this.finished) {
                this.signalReturn();
            } else {
                this.setInactivityTimeouts();
            }
        } catch (err) {
            this._handleError("Input handling error", err);
        }
    }

    _dispatchInput(inputkey) {
        if (inputkey.startsWith("KEY_")) {
            this.onKey(inputkey.slice(4));
        } else if (inputkey.startsWith("CHAR_")) {
            this.onChar(inputkey.slice(5));
        } else if (inputkey.startsWith("CMD_")) {
            this.onCmd(inputkey.slice(4));
        }
    }

    // Subclasses override these
    onKey(key) { }
    onChar(ch) { }
    onCmd(cmd) { }

    // --- Lifecycle ---
    signalReturn() {
        // Subclasses override to emit appropriate events
        this.emitter.emit("ModuleReturn");
    }

    startStage() {
        // Subclasses override
    }

    clearHandler() {
        if (!this.active) return;
        this.active = false;
        this._clearAllTimeouts();
        this.emitter.removeAllListeners();
        this.call = null;
    }
}

export { BaseHandler };