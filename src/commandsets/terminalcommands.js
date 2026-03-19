//node imports
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'fs';
import * as dotenv from 'dotenv';

//setup
dotenv.config();
const textdir = process.env.textdir
const escape_intermed = new RegExp("[!\"#$%&'()*+,-./]")
const escape_terminator1 = new RegExp("[A-Za-z]")
const escape_terminator2 = new RegExp("[@\\[\\]^_`\\{\\}\\|~]")
const valid_escape_chars = new RegExp("[0-9:;?= ]")
const df_esc_timeout = 50


// --- Base command set ---
class BaseCommands {
	constructor(socket, call) {
		this.socket = socket;
		this.call = call;
	}

	// Subclasses override this — the only difference between TCP and Websocket
	_send(data) {
		throw new Error("Subclass must implement _send");
	}

	// --- Core output ---
	senddata(data) {
		this._send(Buffer.from(data));
	}

	sendstring(data) {
		this._send(Buffer.from(data));
	}

	sendbeep() {
		this._send(Buffer.from("\x07"));
	}

	// --- Terminal property accessors ---
	_getTermType() {
		return this.call?.term_type || "Dumb";
	}

	_getEncoding() {
		return this.call?.term_encoding || "CP437";
	}

	_useRip() {
		return this.call?.use_rip || false;
	}

	_useSixel() {
		return this.call?.use_sixel || false;
	}

	_isUTF8() {
		var enc = this._getEncoding();
		return enc === "UTF8" || enc === "utf-8" || enc === "utf8";
	}

	_isDumb() {
		return this._getTermType() === "Dumb";
	}

	// --- Art / Screen drawing ---
	drawfile(artfile, doscreenclear) {
		try {
			var rawbuffer = readFileSync(artfile);
			var isSixel = false;
			var sendbuffer;

			// Check if this is a sixel file (starts with DCS = ESC P or 0x90)
			if (rawbuffer[0] === 0x1b && rawbuffer[1] === 0x50) {
				isSixel = true;
			} else if (rawbuffer[0] === 0x90) {
				isSixel = true;
			}

			if (isSixel) {
				// Sixel files don't have SAUCE — send as-is
				sendbuffer = rawbuffer;
			} else {
				// Strip SAUCE record — remove everything after EOF byte (0x1A)
				var eofIndex = rawbuffer.indexOf(0x1a);
				if (eofIndex !== -1) {
					sendbuffer = rawbuffer.subarray(0, eofIndex);
				} else {
					sendbuffer = rawbuffer;
				}
			}

			if (sendbuffer.length > 0) {
				if (doscreenclear) {
					this.clearscreen();
				}
				this.senddata(sendbuffer);

				if (isSixel) {
					// Ensure we're out of DCS mode
					this._send(Buffer.from("\x1b\\"));
					// Push cursor below the image
					this._send(Buffer.from("\r\n"));
				}

				this.resetcolors();
				return true;
			}
			return false;
		} catch (err) {
			console.log(err);
			return false;
		}
	}

	// Build priority-ordered list of art formats to try
	// RIP > Sixel > UTF8 > ANSI > ASCII
	_getArtFormats() {
		var formats = [];

		if (this._useRip()) {
			formats.push({ dir: "rip", ext: ".rip" });
		}
		if (this._useSixel()) {
			formats.push({ dir: "sixel", ext: ".six" });
		}
		if (this._isUTF8()) {
			formats.push({ dir: "utf8", ext: ".ut8" });
		}
		if (!this._isDumb()) {
			formats.push({ dir: "ans", ext: ".ans" });
		}
		// ASCII is always the final fallback
		formats.push({ dir: "asc", ext: ".asc" });

		return formats;
	}

	// Find the first existing art file across the format fallback chain
	_findArtFile(subdir, filename) {
		var formats = this._getArtFormats();

		for (var fmt of formats) {
			var artdir = textdir + "/" + fmt.dir + "/" + subdir;
			if (!existsSync(artdir)) continue;

			var artfile = artdir + "/" + filename + fmt.ext;
			if (existsSync(artfile)) {
				return artfile;
			}
		}
		return null;
	}

	// Find a random art file from the first format directory that has files
	_findRandomArtFile(subdir) {
		var formats = this._getArtFormats();

		for (var fmt of formats) {
			var artdir = textdir + "/" + fmt.dir + "/" + subdir;
			if (!existsSync(artdir)) continue;

			var filearray = readdirSync(artdir);
			if (filearray.length < 1) continue;

			var artfilename = filearray[Math.floor(Math.random() * filearray.length)];
			if (artfilename) {
				return artdir + "/" + artfilename;
			}
		}
		return null;
	}

	drawscreen(filename, type, doscreenclear) {
		var subdir;
		switch (type) {
			case "Screen":  subdir = "screens"; break;
			case "Header":  subdir = "headers"; break;
			default:        subdir = "misc"; break;
		}

		var artfile = this._findArtFile(subdir, filename);
		if (!artfile) {
			console.log("No art file found for", filename, "in", subdir);
			return;
		}

		this.drawfile(artfile, doscreenclear);
	}

	drawrandomscreen(screentype, doscreenclear) {
		var subdir;
		switch (screentype) {
			case "Logon":        subdir = "logon"; break;
			case "Login":        subdir = "login"; break;
			case "Logoff":       subdir = "logoff"; break;
			case "Goodbye":      subdir = "goodbye"; break;
			case "Registration": subdir = "register"; break;
			default:             subdir = "random"; break;
		}

		var artfile = this._findRandomArtFile(subdir);
		if (!artfile) {
			console.log("No random art files found in", subdir);
			return;
		}

		this.drawfile(artfile, doscreenclear);
	}

	// --- Colors ---
	resetcolors() {
		if (this._isDumb()) return;
		this._send("\x1b[0m");
		this._send("\x1b[39m");
		if (this._getTermType() === "Unknown") {
			this.setbgcolor(0);
		} else {
			this._send("\x1b[49m");
		}
	}

	setfgcolor(fgcolor) {
		if (this._isDumb()) return;
		var setclr = isNaN(fgcolor) ? 7 : fgcolor;
		var fgcolorstring;
		if (setclr > 7) {
			fgcolorstring = "\x1b[1;" + (setclr + 30 - 8) + "m";
		} else {
			fgcolorstring = "\x1b[0;" + (setclr + 30) + "m";
		}
		this._send(Buffer.from(fgcolorstring));
	}

	setbgcolor(bgcolor) {
		if (this._isDumb()) return;
		var setclr = isNaN(bgcolor) ? 0 : bgcolor;
		var bgcolorstring;
		if (setclr > 7) {
			bgcolorstring = "\x1b[1;" + (setclr + 40 - 8) + "m";
		} else {
			bgcolorstring = "\x1b[0;" + (setclr + 40) + "m";
		}
		this._send(Buffer.from(bgcolorstring));
	}

	// Color name to number mapping
	// Standard 8 + bright variants
	static COLOR_NAMES = {
		"black":         0,
		"red":           1,
		"green":         2,
		"yellow":        3,
		"blue":          4,
		"magenta":       5,
		"cyan":          6,
		"white":         7,
		"blackBright":   8,
		"redBright":     9,
		"greenBright":   10,
		"yellowBright":  11,
		"blueBright":    12,
		"magentaBright": 13,
		"cyanBright":    14,
		"whiteBright":   15,
	};

	setfgcolorname(name) {
		var num = BaseCommands.COLOR_NAMES[name];
		if (num !== undefined) {
			this.setfgcolor(num);
		}
	}

	setbgcolorname(name) {
		var num = BaseCommands.COLOR_NAMES[name];
		if (num !== undefined) {
			this.setbgcolor(num);
		}
	}
	// --- Cursor and screen ---
	clearscreen() {
		if (this._isDumb()) {
			this._send("\r\n\r\n\r\n\r\n");
			return;
		}
		this._send("\x1b[2J");
	}

	cleartoeol() {
		this._send("\x1b[0K");
	}

	cleartocursor() {
		this._send("\x1b[1K");
	}

	clearfullline() {
		this._send("\x1b[2K");
	}

	movecursor(xpos, ypos) {
		this._send("\x1b[" + ypos + ";" + xpos + "H");
	}

	movecursorup(num) {
		this._send("\x1b[" + num + "A");
	}

	movecursordown(num) {
		this._send("\x1b[" + num + "B");
	}

	movecursorright(num) {
		this._send("\x1b[" + num + "C");
	}

	movecursorleft(num) {
		this._send("\x1b[" + num + "D");
	}

	moveupone() {
		this._send("\x1b[A");
	}

	movedownone() {
		this._send("\x1b[B");
	}

	moveleftone() {
		this._send("\x1b[D");
	}

	moverightone() {
		this._send("\x1b[C");
	}

	homecursor() {
		this._send("\x1b[H");
	}

	clearline(lineint) {
		if (lineint !== undefined) {
			this._send("\x1b[" + lineint + "K");
		} else {
			this._send("\x1b[K");
		}
	}

	clearhandler() {
		this.socket = null;
		this.call = null;
	}
}


// --- Connection-specific subclasses ---
class tcpCommands extends BaseCommands {
	constructor(socket, call) {
		super(socket, call);
		this.commandType = "TCP";
	}

	_send(data) {
		this.socket.write(Buffer.from(data));
	}
}

class websockCommands extends BaseCommands {
	constructor(socket, call) {
		super(socket, call);
		this.commandType = "Websock";
	}

	_send(data) {
		this.socket.send(Buffer.from(data));
	}
}

class telnetCommands extends BaseCommands {
	constructor(socket, call) {
		super(socket, call);
		this.commandType = "Telnet";
	}

	_send(data) {
		// TODO: implement telnet-specific send with IAC escaping
		this.socket.write(Buffer.from(data));
	}
}


// --- Input parser ---
class ansiInputParser {
	constructor(call) {
		this.call = call;
		this.emitter = new EventEmitter();
		this.hexbuffer = "";
		this.output_array = [];
		this.runningparser = false;
		this.escapemode = false;
		this.esc_timeout = df_esc_timeout;
		this.escapebuffer = "";
		this.zombieTO;
	}

	queueOutput(data) {
		this.output_array.push(data);
	}

	flushOutput() {
		if (this.output_array.length > 0 && this.call) {
			var batch = this.output_array;
			this.output_array = [];
			if (this.call.currentHandler && this.call.currentHandler.active) {
				this.call.currentHandler.handleInput(batch);
			}
		}
	}

	parseHexByte(hexbyte) {
		clearTimeout(this.escTO);
		var stringchar = String.fromCharCode(parseInt(hexbyte, 16));
		if (this.escapemode) {
			if ((this.escapebuffer.length == 0) && (stringchar == "[")) {
				this.escapebuffer += stringchar;
				return;
			}
			if (escape_intermed.test(stringchar)) {
				this.escapebuffer += stringchar;
				return;
			}
			if (valid_escape_chars.test(stringchar)) {
				this.escapebuffer += stringchar;
				return;
			}
			if (escape_terminator1.test(stringchar)) {
				this.escapebuffer += stringchar;
				this.doEscape();
				return;
			}
			if (escape_terminator2.test(stringchar)) {
				this.escapebuffer += stringchar;
				this.doEscape();
				return;
			}
			if (stringchar == "\x1b") {
				if (this.escapebuffer.length < 1) {
					this.queueOutput("KEY_ESC");
				}
				this.escapebuffer = "";
				this.escTO = setTimeout(this.doEscape.bind(this), this.esc_timeout);
				return;
			}
			console.log(stringchar, "Not valid ESC");
			this.escapemode = false;
		}
		if (stringchar == "\x1b") {
			this.escTO = setTimeout(this.doEscape.bind(this), this.esc_timeout);
			this.escapemode = true;
			return;
		}
		var keyname = "";
		switch (stringchar) {
			case "\t":   keyname = "KEY_Tab"; break;
			case "\r":   keyname = "KEY_Enter"; break;
			case "\b":   keyname = "KEY_Backspace"; break;
			case "\x7f": keyname = "KEY_Backspace"; break;
			case "\x01": keyname = "KEY_^A"; break;
			case "\x13": keyname = "KEY_^S"; break;
			case "\x1a": keyname = "KEY_^Z"; break;
			default:     keyname = "CHAR_" + stringchar; break;
		}
		if (keyname) {
			this.queueOutput(keyname);
		} else {
			console.log("No Key Parsed");
		}
	}

	doEscape() {
		if (this.escapemode) {
			this.escapemode = false;
			if (this.escapebuffer.length < 1) {
				this.queueOutput("KEY_ESC");
				this.flushOutput();
				return;
			}
			var keyname = "";
			switch (this.escapebuffer) {
				case "[A":  keyname = "KEY_UpArrow"; break;
				case "[B":  keyname = "KEY_DownArrow"; break;
				case "[C":  keyname = "KEY_RightArrow"; break;
				case "[D":  keyname = "KEY_LeftArrow"; break;
				case "[3~": keyname = "KEY_Delete"; break;
				case "[5~": keyname = "KEY_PgUp"; break;
				case "[6~": keyname = "KEY_PgDn"; break;
				case "[V":  keyname = "KEY_PgUp"; break;   // SCO/VT100 variant
				case "[U":  keyname = "KEY_PgDn"; break;   // SCO/VT100 variant
				case "[2~": keyname = "KEY_Insert"; break;
				case "[H":  keyname = "KEY_Home"; break;
				case "[F":  keyname = "KEY_End"; break;
				case "[K":  keyname = "KEY_End"; break;   // SCO/VT100 variant - This is for cleareol, so syncterm really shouldn't be using it for end.
				case "[1~": keyname = "KEY_Home"; break;   // Alternative Home
				case "[4~": keyname = "KEY_End"; break;    // Alternative End
				default:
					console.log("Unknown Escape Sequence:", this.escapebuffer);
					break;
			}
			this.escapebuffer = "";
			if (keyname) {
				this.queueOutput(keyname);
			}
			this.flushOutput();
		}
	}

	doHexBuffer() {
		while (this.hexbuffer.length > 0) {
			var hexbyte = this.hexbuffer.substr(0, 2);
			this.hexbuffer = this.hexbuffer.slice(2);
			this.parseHexByte(hexbyte);
		}
	}

	handleData() {
		if (!this.runningparser) {
			this.runningparser = true;
			this.doHexBuffer();
			if (!this.escapemode) {
				this.flushOutput();
			}
			this.runningparser = false;
		}
	}

	clearParser() {
		clearTimeout(this.escTO);
		this.call = null;
	}
}


export { tcpCommands, websockCommands, telnetCommands, ansiInputParser, BaseCommands };