import { EventEmitter } from 'node:events';
import * as alogger from "../utils/alogger.js";
import { BaseHandler } from "./basehandler.js";
import { charSet } from "../commandsets/charsets.js";

// Known terminal identification strings (ASCII-decoded)
const KNOWN_TERMINALS = {
	"CTerm":   { type: "CTerm",   defaultEncoding: "CP437" },
	"IcyTerm": { type: "IcyTerm", defaultEncoding: "CP437" },
	// Add more as discovered
};

// CTerm-based terminals distinguished by version
const CTERM_VARIANTS = [
	{ maxMinor: 314, name: "MagiTerm" },
	// SyncTERM is the default/fallback for CTerm
];

// Sixel support detection via DA1 response flags
// In the standard VT DA1 format: ESC [ ? Ps1 ; Ps2 ; ... c
// A '4' in the parameter list indicates sixel support
const DA1_SIXEL_FLAG = 4;

// Known terminal sixel support lookup
// Used for terminals that don't report via standard DA1 flags
const SIXEL_SUPPORT = {
	"SyncTerm":  { supported: true,  minVersion: "1.300" },
	"MagiTerm":  { supported: true,  minVersion: "1.300" },
	"IcyTerm":   { supported: true,  minVersion: "0.1"   },
	"CTerm":     { supported: true,  minVersion: "1.300" },
	"RIPTel":    { supported: false },
	"RIPTerm":   { supported: false },
	"VT100":     { supported: false },
};

// Each request defines what to send, how long to wait,
// and whether we expect a response or just a delay
const REQUEST_SEQUENCE = [
	{ name: "DeviceAttribs", expectsResponse: true,  timeout: 3000 },
	{ name: "MoveCursor",    expectsResponse: false, timeout: 200  },
	{ name: "CursorPos",     expectsResponse: true,  timeout: 3000 },
	{ name: "ResetCursor",   expectsResponse: false, timeout: 200  },
	{ name: "CursorPos",     expectsResponse: true,  timeout: 3000 },
	{ name: "SendUTFChar",   expectsResponse: false, timeout: 200  },
	{ name: "CursorPos",     expectsResponse: true,  timeout: 3000 },
];

const escape_intermed = new RegExp("[!\"#$%&'()*+,-./]");
const escape_terminator1 = new RegExp("[A-Za-z]");
const escape_terminator2 = new RegExp("[@\\[\\]^_`\\{\\}\\|~]");
const valid_escape_chars = new RegExp("[0-9:;?= ]");

class TerminalNegotiator extends BaseHandler {
	constructor(call) {
		super(call, "TermNegotiate");
		this.inactivityTO = 0;
		this.negotiationTO = 15000;
		this._utf8TestChar = Buffer.from("\xc3\xa9");
		this.startupDelay = Number(process.env.termNegotiateDelay) || 500;
		this.startupMessage = process.env.termNegotiateMsg || "Detecting Terminal...\r\n";

		// Request state
		this._currentRequest = 0;
		this._requestTimer = null;
		this._awaitingResponse = false;

		// Cursor position test tracking
		this._cursorTest = 0;
		this._preUtfCol = 0;
		this._postUtfCol = 0;

		// Parse state
		this._capturingEscape = false;
		this._escapebuffer = "";
		this._escapeterm = "";
		this._charbuffer = "";
		this._hexscapebuff = "";
		this._capturingHexscape = false;
		this._responseBuffer = "";

		// Raw mode state
		this._previousRawmode = false;
		this._previousRawtarget = null;

		this.loggingId = "TermNegotiate (Node " + this.call.nodenum + ")";
	}

	// --- Raw mode ---
	_enableRawMode() {
		if (!this.call) return;
		this._previousRawmode = this.call.rawmode;
		this._previousRawtarget = this.call.rawtarget;
		this.call.rawmode = true;
		this.call.rawtarget = (data) => {
			this._onRawData(data);
		};
	}

	_disableRawMode() {
		if (!this.call) return;
		this.call.rawmode = this._previousRawmode;
		this.call.rawtarget = this._previousRawtarget;
	}

	_onRawData(data) {
		if (!this.active) return;
		try {
			this._responseBuffer += data.toString('hex');
			this._processResponseBuffer();
		} catch (err) {
			this._handleError("Raw data handling error", err);
		}
	}

	// --- Request state machine ---
	_sendCurrentRequest() {
		if (this._currentRequest >= REQUEST_SEQUENCE.length) {
			this._finishNegotiation();
			return;
		}
		if (!this.active || !this.call) return;

		var req = REQUEST_SEQUENCE[this._currentRequest];

		this._clearRequestTimer();

		alogger.writeAlog(5, this.loggingId + "\n  Sending: " + req.name + " (#" + this._currentRequest + ")", "cyan");

		this._awaitingResponse = req.expectsResponse;

		switch (req.name) {
			case "Clearscreen":
				this.call.cmds.clearscreen();
				break;
			case "ResetCursor":
				this.call.cmds.homecursor();
				break;
			case "SendUTFChar":
				this.call.cmds.senddata(this._utf8TestChar);
				break;
			case "DeviceAttribs":
				this.call.sendString("\x1b[0c");
				break;
			case "MoveCursor":
				this.call.sendString("\x1b[200;200H");
				break;
			case "CursorPos":
				this.call.sendString("\x1b[6n");
				break;
			case "RIPVer":
				this.call.sendString("\x1b[0!");
				break;
			case "SetScreen":
				if (this.call.term_width <= 80) {
					this.call.sendString("\x1b[=3;7h");
				}
				break;
			default:
				this._advanceToNext();
				return;
		}

		this._requestTimer = setTimeout(() => {
			this._onRequestTimeout();
		}, req.timeout);
	}

	_clearRequestTimer() {
		if (this._requestTimer) {
			clearTimeout(this._requestTimer);
			this._requestTimer = null;
		}
	}

	_advanceToNext() {
		this._currentRequest++;
		this._awaitingResponse = false;
		this._requestTimer = setTimeout(() => {
			this._sendCurrentRequest();
		}, 50);
	}

	_onRequestTimeout() {
		if (!this.active) return;
		var req = REQUEST_SEQUENCE[this._currentRequest];
		if (!req) {
			this._finishNegotiation();
			return;
		}

		if (req.expectsResponse) {
			alogger.writeAlog(5, this.loggingId + "\n  Timeout (no response): " + req.name, "yellow");

			if (this._charbuffer.length > 0) {
				this._checkCharBuffer();
				return;
			}

			if (req.name === "CursorPos" && this._cursorTest === 0) {
				this._setTermDefaults();
			}
		} else {
			alogger.writeAlog(5, this.loggingId + "\n  Delay complete: " + req.name, "cyan");
		}

		this._advanceToNext();
	}

	// --- Response parsing ---
	_processResponseBuffer() {
		while (this._responseBuffer.length >= 2) {
			var hexbyte = this._responseBuffer.substr(0, 2);
			this._responseBuffer = this._responseBuffer.slice(2);
			var byte = parseInt(hexbyte, 16);
			var ch = String.fromCharCode(byte);

			if (this._capturingHexscape) {
				this._collectHexscape(hexbyte);
				continue;
			}
			if (hexbyte === "ff") {
				this._capturingHexscape = true;
				continue;
			}

			if (ch === "\x1b") {
				this._clearRequestTimer();
				if (this._charbuffer.length > 0) {
					this._checkCharBuffer();
				}
				this._capturingEscape = true;
				this._escapebuffer = "";
				this._escapeterm = "";
				continue;
			}

			if (this._capturingEscape) {
				this._collectEscape(ch);
			} else {
				this._charbuffer += ch;
			}
		}
	}

	_collectEscape(ch) {
		if (ch === "\x1b") {
			this._escapebuffer = "";
			return;
		}
		if (this._escapebuffer.length < 1 && ch === "[") {
			return;
		}
		if (escape_intermed.test(ch)) {
			this._escapebuffer += ch;
			return;
		}
		if (valid_escape_chars.test(ch)) {
			this._escapebuffer += ch;
			return;
		}
		if (escape_terminator1.test(ch) || escape_terminator2.test(ch)) {
			this._escapeterm = ch;
			this._evalEscape();
			return;
		}
	}

	_collectHexscape(hexbyte) {
		this._hexscapebuff += hexbyte;
		if (hexbyte === "03" || hexbyte === "18") {
			switch (this._hexscapebuff) {
				case "fd03":
					alogger.writeAlog(5, this.loggingId + "\n  Detected MagiTerm (older)", "cyan");
					this.call.term_type = "MagiTerm-Older";
					break;
				case "fb18":
					alogger.writeAlog(5, this.loggingId + "\n  Detected MagiTerm variant", "cyan");
					break;
			}
			this._hexscapebuff = "";
			this._capturingHexscape = false;
		}
	}

	_checkCharBuffer() {
		if (this._charbuffer.includes("RIPSCRIP")) {
			var ripMajor = Number(this._charbuffer.substr(8, 2));
			var ripMinor = Number(this._charbuffer.substr(10, 2));
			var ripVer = ripMajor + "." + ripMinor;
			this.call.term_rip_major = ripMajor;
			this.call.term_rip_minor = ripMinor;
			this.call.term_rip_string = ripVer;
			this.call.use_rip = true;
			alogger.writeAlog(4, this.loggingId + "\n  RIP capable: v" + ripVer, "cyan");
		}
		this._charbuffer = "";
	}

	// --- Escape evaluation ---
	_evalEscape() {
		alogger.writeAlog(5, this.loggingId + "\n  Response: ESC[" + this._escapebuffer + this._escapeterm, "cyan");

		switch (this._escapeterm) {
			case "R":
				this._handleCursorResponse();
				break;
			case "c":
				this._handleDeviceAttribs();
				break;
			default:
				break;
		}

		this._clearEscape();

		if (this._awaitingResponse) {
			this._advanceToNext();
		}
	}

	_handleCursorResponse() {
		var parts = this._escapebuffer.split(";");
		if (parts.length < 2) return;

		var val1 = Number(parts[0]);
		var val2 = Number(parts[1]);

		switch (this._cursorTest) {
			case 0:
				this._setCursorPosTermSize(val1, val2);
				this._cursorTest++;
				break;
			case 1:
				this._preUtfCol = val2;
				this._cursorTest++;
				break;
			case 2:
				this._postUtfCol = val2;
				if ((this._postUtfCol - this._preUtfCol) > 1) {
					this.call.term_encoding = "CP437";
				} else {
					this.call.term_encoding = "UTF8";
				}
				alogger.writeAlog(4, this.loggingId + "\n  Encoding detected: " + this.call.term_encoding, "cyan");
				this._cursorTest++;
				break;
		}
	}

	_setCursorPosTermSize(pos1, pos2) {
		if (pos1 < pos2) {
			this.call.term_height = pos1;
			this.call.term_width = pos2;
		} else if (pos1 === 1 && pos2 === 1) {
			this.call.term_width = 80;
			this.call.term_height = 24;
		} else {
			alogger.writeAlog(4, this.loggingId + "\n  Unusual cursor pos: " + pos1 + "," + pos2, "yellow");
			this.call.term_width = 80;
			this.call.term_height = 24;
		}
		alogger.writeAlog(4, this.loggingId + "\n  Terminal size: " + this.call.term_width + "x" + this.call.term_height, "cyan");
	}

	_decodeAsciiIdent(paramString) {
		var parts = paramString.split(";");
		var nameChars = [];
		var i = 0;

		while (i < parts.length) {
			var val = Number(parts[i]);
			if (isNaN(val) || val < 32 || val > 126) break;
			var ch = String.fromCharCode(val);
			if (/[A-Za-z]/.test(ch)) {
				nameChars.push(ch);
				i++;
			} else {
				if (nameChars.length > 0) break;
				nameChars.push(ch);
				i++;
			}
		}

		if (nameChars.length === 0) return null;

		var name = nameChars.join("");
		var versionParams = parts.slice(i).map(p => Number(p)).filter(n => !isNaN(n));

		return {
			name: name,
			versionParams: versionParams,
			versionString: versionParams.join(".")
		};
	}

	_handleDeviceAttribs() {
		var attribs = this._escapebuffer;

		if (attribs.startsWith("=")) {
			// Private/extended DA response — try ASCII ident decode
			var paramString = attribs.slice(1);
			var ident = this._decodeAsciiIdent(paramString);

			if (ident && ident.name.length > 1) {
				this.call.term_id = ident.name;
				this.call.term_version = ident.versionString;

				alogger.writeAlog(4, this.loggingId
					+ "\n  Terminal ident: " + ident.name
					+ " v" + ident.versionString, "cyan");

				var known = KNOWN_TERMINALS[ident.name];
				if (known) {
					if (this.call.term_encoding === "Unknown" && known.defaultEncoding) {
						this.call.term_encoding = known.defaultEncoding;
					}

					if (ident.name === "CTerm") {
						var minor = ident.versionParams[1] || 0;
						var matched = false;
						for (var variant of CTERM_VARIANTS) {
							if (minor <= variant.maxMinor) {
								this.call.term_type = variant.name;
								matched = true;
								break;
							}
						}
						if (!matched) {
							this.call.term_type = "SyncTerm";
						}
					} else {
						this.call.term_type = known.type;
					}
				} else {
					alogger.writeAlog(4, this.loggingId
						+ "\n  Unknown terminal ident: " + ident.name
						+ " v" + ident.versionString, "yellow");
					this.call.term_type = ident.name;
				}
			} else {
				alogger.writeAlog(4, this.loggingId
					+ "\n  Unknown private DA response: " + attribs, "yellow");
				if (this.call.term_type === "Unknown") {
					this.call.term_type = "VT100";
				}
			}
			return;
		}

		// Standard VT DA1 responses (? prefix)
		if (attribs.startsWith("?")) {
			var params = attribs.slice(1).split(";").map(p => Number(p));

			// Check for sixel flag (4) in parameter list
			if (params.includes(DA1_SIXEL_FLAG)) {
				this.call.use_sixel = true;
				alogger.writeAlog(4, this.loggingId
					+ "\n  Sixel support detected via DA1 flag", "cyan");
			}

			// Determine terminal type from params
			if (params[0] === 1 && params.length === 2 && params[1] === 0) {
				this.call.term_type = "VT100";
			} else if (params[0] === 6 && params.includes(128)) {
				// TeleGraphix product
				if (this.call.term_rip_major === 3) {
					this.call.term_type = "RIPTel";
				} else if (this.call.term_rip_major > 0) {
					this.call.term_type = "RIPTerm";
				}
				if (this.call.term_encoding === "Unknown") {
					this.call.term_encoding = "CP437";
				}
			} else {
				if (this.call.term_type === "Unknown") {
					this.call.term_type = "VT100";
				}
			}

			alogger.writeAlog(4, this.loggingId + "\n  Terminal type: " + this.call.term_type, "cyan");
			return;
		}

		// Unrecognized format
		alogger.writeAlog(4, this.loggingId + "\n  Unrecognized DA response: " + attribs, "yellow");
	}

	// --- Sixel support check ---
	_checkSixelSupport() {
		// Already detected via DA1 flag
		if (this.call.use_sixel) return;

		var lookup = SIXEL_SUPPORT[this.call.term_type];
		if (!lookup) return;

		if (lookup.supported) {
			if (lookup.minVersion && this.call.term_version) {
				if (this._compareVersions(this.call.term_version, lookup.minVersion) >= 0) {
					this.call.use_sixel = true;
				}
			} else if (lookup.supported && !lookup.minVersion) {
				// No version requirement — just check the flag
				this.call.use_sixel = true;
			}
		}

		if (this.call.use_sixel) {
			alogger.writeAlog(4, this.loggingId
				+ "\n  Sixel support detected via lookup: "
				+ this.call.term_type + " v" + this.call.term_version, "cyan");
		}
	}

	_compareVersions(a, b) {
		var partsA = String(a).split(".").map(Number);
		var partsB = String(b).split(".").map(Number);
		var len = Math.max(partsA.length, partsB.length);
		for (var i = 0; i < len; i++) {
			var va = partsA[i] || 0;
			var vb = partsB[i] || 0;
			if (va > vb) return 1;
			if (va < vb) return -1;
		}
		return 0;
	}

	// --- Defaults ---
	_setTermDefaults() {
		alogger.writeAlog(4, this.loggingId + "\n  Using terminal defaults", "yellow");
		if (!this.call.term_height) this.call.term_height = 24;
		if (!this.call.term_width) this.call.term_width = 80;
		if (this.call.term_type === "Unknown") {
			this.call.term_type = "Dumb";
			this.call.term_encoding = "ASCII";
		}
	}

	// --- Completion ---
	_finishNegotiation() {
		if (this.finished) return;

		this._clearRequestTimer();

		if (!this.call.term_height) this.call.term_height = 24;
		if (!this.call.term_width) this.call.term_width = 80;
		if (this.call.term_encoding === "Unknown") this.call.term_encoding = "CP437";

		// Check sixel support after all detection is done
		this._checkSixelSupport();

		this.call.charset = new charSet(this.call.term_encoding);

		alogger.writeAlog(4, this.loggingId + "\n  Negotiation complete:"
			+ "\n  Type: " + this.call.term_type
			+ (this.call.term_id ? "\n  Ident: " + this.call.term_id : "")
			+ (this.call.term_version ? "\n  Version: " + this.call.term_version : "")
			+ "\n  Encoding: " + this.call.term_encoding
			+ "\n  Size: " + this.call.term_width + "x" + this.call.term_height
			+ (this.call.use_rip ? "\n  RIP: v" + this.call.term_rip_string : "")
			+ "\n  Sixel: " + (this.call.use_sixel ? "Yes" : "No"),
			"greenbright");

		this.finished = true;
		this._disableRawMode();
		this.signalReturn();
	}

	_clearEscape() {
		this._capturingEscape = false;
		this._escapebuffer = "";
		this._escapeterm = "";
	}

	// --- Lifecycle ---
	signalReturn() {
		this.emitter.emit("NegotiateComplete");
	}

	startStage() {
		try {
			this._enableRawMode();

			this._setTimeout(() => {
				alogger.writeAlog(4, this.loggingId + "\n  Overall negotiation timeout", "yellow");
				this._finishNegotiation();
			}, this.negotiationTO + this.startupDelay);

			// Delay before starting requests — some terminals need
			// a moment after connection before they're ready to
			// respond to escape sequences
			this._requestTimer = setTimeout(() => {
				if (!this.active || !this.call) return;
				if (this.startupMessage) {
					this.call.cmds.senddata(this.startupMessage);
				}
				this.call.sendString("\x1b[!_");
				this._sendCurrentRequest();
			}, this.startupDelay);

		} catch (err) {
			this._handleError("startStage error", err);
		}
	}

	clearHandler() {
		if (!this.active) return;
		this._clearRequestTimer();
		this._disableRawMode();
		super.clearHandler();
	}
}

export { TerminalNegotiator };