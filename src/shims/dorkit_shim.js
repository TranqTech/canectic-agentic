/**
 * dorkit_shim.js — Drop-in replacement for the Synchronet dorkit dk object
 *
 * Maps dorkit's synchronous console API onto our SharedArrayBuffer comm layer.
 * This runs inside the worker thread.
 *
 * Key behaviors emulated:
 *   dk.console.print(str)     → sendOutput (ANSI passthrough)
 *   dk.console.waitkey(ms)    → WorkerSide.waitKey (Atomics.wait)
 *   dk.console.getkey()       → WorkerSide.getKey
 *   dk.console.getstr(opts)   → blocking line editor
 *   dk.console.attr           → Attribute with ANSI code generation
 *   dk.console.clear()        → ESC[2J
 *   dk.console.gotoxy(x,y)    → ESC[y;xH
 *
 * Color model:
 *   Synchronet uses an 8-bit attribute byte: BbbbFfff
 *   B=blink, bbb=background(0-7), F=bright, fff=foreground(0-7)
 *   The Attribute class manages this and generates ANSI escape sequences.
 */

// ============================================================
//  CP437 → Unicode mapping for bytes 0x00-0x1F and 0x80-0xFF
// ============================================================
// Terminals expect UTF-8 but ANSI art uses CP437 byte values.
// Bytes 0x20-0x7E are identical in both encodings (ASCII printable).
// Bytes 0x7F and above need mapping. Bytes 0x00-0x1F in CP437 are
// graphical characters (smileys, card suits, etc.) but in ANSI data
// streams they're control characters, so we only map 0x80-0xFF.
var _cp437High = [
	'\u00C7','\u00FC','\u00E9','\u00E2','\u00E4','\u00E0','\u00E5','\u00E7', // 80-87
	'\u00EA','\u00EB','\u00E8','\u00EF','\u00EE','\u00EC','\u00C4','\u00C5', // 88-8F
	'\u00C9','\u00E6','\u00C6','\u00F4','\u00F6','\u00F2','\u00FB','\u00F9', // 90-97
	'\u00FF','\u00D6','\u00DC','\u00A2','\u00A3','\u00A5','\u20A7','\u0192', // 98-9F
	'\u00E1','\u00ED','\u00F3','\u00FA','\u00F1','\u00D1','\u00AA','\u00BA', // A0-A7
	'\u00BF','\u2310','\u00AC','\u00BD','\u00BC','\u00A1','\u00AB','\u00BB', // A8-AF
	'\u2591','\u2592','\u2593','\u2502','\u2524','\u2561','\u2562','\u2556', // B0-B7
	'\u2555','\u2563','\u2551','\u2557','\u255D','\u255C','\u255B','\u2510', // B8-BF
	'\u2514','\u2534','\u252C','\u251C','\u2500','\u253C','\u255E','\u255F', // C0-C7
	'\u255A','\u2554','\u2569','\u2566','\u2560','\u2550','\u256C','\u2567', // C8-CF
	'\u2568','\u2564','\u2565','\u2559','\u2558','\u2552','\u2553','\u256B', // D0-D7
	'\u256A','\u2518','\u250C','\u2588','\u2584','\u258C','\u2590','\u2580', // D8-DF
	'\u03B1','\u00DF','\u0393','\u03C0','\u03A3','\u03C3','\u00B5','\u03C4', // E0-E7
	'\u03A6','\u0398','\u03A9','\u03B4','\u221E','\u03C6','\u03B5','\u2229', // E8-EF
	'\u2261','\u00B1','\u2265','\u2264','\u2320','\u2321','\u00F7','\u2248', // F0-F7
	'\u00B0','\u2219','\u00B7','\u221A','\u207F','\u00B2','\u25A0','\u00A0'  // F8-FF
];

/**
 * Convert a latin1/binary string containing CP437 art to UTF-8.
 * Preserves ANSI escape sequences (ESC + 0x20-0x7E bytes) and
 * control characters 0x00-0x1F (including ESC, CR, LF, BEL).
 * Only remaps bytes 0x80-0xFF using the CP437 table.
 */
function cp437toUnicode(str) {
	var out = '';
	for (var i = 0; i < str.length; i++) {
		var code = str.charCodeAt(i);
		if (code >= 0x80 && code <= 0xFF) {
			out += _cp437High[code - 0x80];
		} else {
			out += str[i];
		}
	}
	return out;
}


// ============================================================
//  Attribute class — matches Synchronet's Attribute
// ============================================================
class Attribute {
	constructor(val) {
		if (val instanceof Attribute) {
			this._value = val._value;
		} else {
			this._value = (typeof val === 'number') ? val : 7;
		}
	}

	get value() { return this._value; }
	set value(v) {
		if (v instanceof Attribute) {
			this._value = v._value;
		} else {
			this._value = v & 0xFF;
		}
	}

	// Foreground color (0-7, low 3 bits) — CGA ordering
	get fg() { return this._value & 0x07; }
	set fg(v) { this._value = (this._value & 0xF8) | (v & 0x07); }

	// Background color (0-7, bits 4-6) — CGA ordering
	get bg() { return (this._value >> 4) & 0x07; }
	set bg(v) { this._value = (this._value & 0x8F) | ((v & 0x07) << 4); }

	// Bright/bold (bit 3)
	get bright() { return !!(this._value & 0x08); }
	set bright(v) {
		if (v) this._value |= 0x08;
		else this._value &= ~0x08;
	}

	// Blink (bit 7)
	get blink() { return !!(this._value & 0x80); }
	set blink(v) {
		if (v) this._value |= 0x80;
		else this._value &= ~0x80;
	}

	// CGA color constants — CGA order: 0=Black 1=Blue 2=Green 3=Cyan 4=Red 5=Magenta 6=Brown 7=White
	static BLACK   = 0;
	static BLUE    = 1;
	static GREEN   = 2;
	static CYAN    = 3;
	static RED     = 4;
	static MAGENTA = 5;
	static BROWN   = 6;
	static YELLOW  = 6;
	static WHITE   = 7;

	// CGA index → ANSI SGR offset lookup table
	// CGA: 0=Black 1=Blue  2=Green 3=Cyan 4=Red   5=Magenta 6=Brown 7=White
	// ANSI: 0=Black 1=Red  2=Green 3=Yellow 4=Blue 5=Magenta 6=Cyan 7=White
	static CGA2ANSI = [0, 4, 2, 6, 1, 5, 3, 7];

	/**
	 * Generate ANSI escape sequence to transition from prev attr to this attr.
	 * If prev is undefined, generates a full reset + set sequence.
	 */
	ansi(prev) {
		var codes = [];
		var needReset = false;

		if (prev === undefined || prev === null) {
			needReset = true;
		} else {
			var prevVal = (prev instanceof Attribute) ? prev._value : prev;
			if (prevVal === this._value) return '';
			// Check if we need a reset (e.g. removing bright/blink requires it)
			var prevBright = !!(prevVal & 0x08);
			var prevBlink  = !!(prevVal & 0x80);
			if ((prevBright && !this.bright) || (prevBlink && !this.blink)) {
				needReset = true;
			}
		}

		if (needReset) {
			codes.push(0);
		}

		// Bright/bold
		if (this.bright) {
			codes.push(1);
		}

		// Blink
		if (this.blink) {
			codes.push(5);
		}

		// Foreground (30-37) — convert CGA index to ANSI SGR code
		var fgCode = 30 + Attribute.CGA2ANSI[this.fg];
		codes.push(fgCode);

		// Background (40-47) — convert CGA index to ANSI SGR code
		// Must emit when: reset, bg is non-black, OR prev bg differs
		var prevBg = (!needReset && prev) ? ((((prev instanceof Attribute) ? prev._value : prev) >> 4) & 0x07) : -1;
		if (this.bg > 0 || needReset || prevBg !== this.bg) {
			codes.push(40 + Attribute.CGA2ANSI[this.bg]);
		}

		if (codes.length === 0) return '';
		return '\x1b[' + codes.join(';') + 'm';
	}
}


// ============================================================
//  DorkitShim — the main dk object replacement
// ============================================================
class DorkitShim {
	constructor(comm, sendOutput, userInfo) {
		this._comm = comm;
		this._sendOutput = sendOutput;
		this._userInfo = userInfo || {};

		// Build the dk-compatible structure
		this.console = new DorkitConsole(comm, sendOutput);
		// Build connect time for date/time fields
		var _connectTime = userInfo.connectTime
			? new Date(userInfo.connectTime)
			: new Date();
		var _connectDateStr = (_connectTime.getMonth() + 1) + '/' +
			_connectTime.getDate() + '/' + _connectTime.getFullYear();
		var _connectTimeStr = _connectTime.getHours() + ':' +
			String(_connectTime.getMinutes()).padStart(2, '0');
		var _connectEpoch = Math.floor(_connectTime.getTime() / 1000);

		// Format a date value (ISO string, Date, timestamp, or null) to M/D/YYYY
		function _fmtDate(val, fallback) {
			if (!val) return fallback || '';
			try {
				var d = (val instanceof Date) ? val : new Date(val);
				if (isNaN(d.getTime())) return fallback || '';
				return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
			} catch (_) { return fallback || ''; }
		}

		// Format a date value to HH:MM
		function _fmtTime(val, fallback) {
			if (!val) return fallback || '';
			try {
				var d = (val instanceof Date) ? val : new Date(val);
				if (isNaN(d.getTime())) return fallback || '';
				return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
			} catch (_) { return fallback || ''; }
		}

		this.connection = {
			type: 'socket',
			baud: 38400,
			parity: 0,
			node: comm.nodeNum,
			dte: 38400,
			error_correcting: true,
			time: _connectEpoch,
			socket: null,
			telnet: false,
			active: true,
			inactive_time: null,
			disconnect_timeout: 30
		};

		this.user = {
			full_name: userInfo.fullName || 'Unknown',
			location: userInfo.location || 'Unknown',
			home_phone: '',
			work_phone: '',
			data_phone: '',
			pass: '',
			level: userInfo.security || 0,
			times_on: userInfo.logonCount || 1,
			last_called: _fmtDate(userInfo.lastLogon, _connectDateStr),
			seconds_remaining: (userInfo.timeLeft || 9999) * 60,
			seconds_remaining_from: _connectEpoch,
			minutes_remaining: userInfo.timeLeft || 9999,
			conference: [],
			curr_conference: 0,
			expires: '',
			number: userInfo.userNumber || 1,
			default_protocol: 'Z',
			uploads: userInfo.uploadCount || 0,
			upload_kb: userInfo.uploadKb || 0,
			downloads: userInfo.downloadCount || 0,
			download_kb: userInfo.downloadKb || 0,
			kb_downloaded_today: 0,
			max_download_kb_per_day: 0,
			birthdate: _fmtDate(userInfo.birthdate, ''),
			alias: userInfo.alias || userInfo.fullName || 'Unknown',
			ansi_supported: comm.ansiEnabled,
			time_credits: 0,
			last_new_file_scan_date: _connectDateStr,
			last_call_time: _fmtTime(userInfo.lastLogon, _connectTimeStr),
			max_daily_files: 0,
			downloaded_today: 0,
			comment: userInfo.userComment || '',
			doors_opened: userInfo.doorsOpened || 0,
			messages_left: userInfo.messagesLeft || 0,
			expert_mode: true
		};
		this.system = {
			main_dir: '',
			gen_dir: '',
			sysop_name: 'Sysop',
			default_attr: new Attribute(7),
			mode: 'socket'
		};
		this.misc = {
			event_time: '',
			record_locking: true
		};

		// Not used in shim mode but present for API compat
		this.detect_ansi = function() { return comm.ansiEnabled; };
		this.parse_dropfile = function() {};
		this.parse_cmdline = function() {};
	}
}


// ============================================================
//  DorkitConsole — dk.console replacement
// ============================================================
class DorkitConsole {
	constructor(comm, sendOutput) {
		this._comm = comm;
		this._sendOutput = sendOutput;

		// Terminal state
		this.auto_pause = true;  // Doors that don't want it disable it on startup
		this.ansi = comm.ansiEnabled;
		this.charset = 'cp437';
		this.local = false;
		this.remote = true;
		this.active = true;  // LORD2 sets false to suppress output during background ops
		this.rows = comm.rows;
		this.cols = comm.cols;
		this.x = 1;
		this.y = 1;

		// Screen tracking objects — dorkit exposes these for cursor/attr state.
		// LORD2's l2lib.js requires one of these to exist and uses scr.pos.x,
		// scr.pos.y, scr.attr.value throughout for UI positioning.
		var self = this;
		this.remote_screen = {
			get pos() { return { x: self.x, y: self.y }; },
			set pos(v) { if (v) { self.x = v.x || self.x; self.y = v.y || self.y; } },
			get attr() { return self._currentAttr; },
			cols: comm.cols,
			rows: comm.rows,
			new_lines: 0,
			printed: false,
			touched: [],
			graphic: { get: function() { return undefined; } }
		};
		this.local_screen = undefined;
		this.local_io = undefined;

		// dk.console.pos — proxy object matching original dorkit's
		// defineProperty pattern. Reads this.x / this.y.
		this.pos = {};
		Object.defineProperty(this.pos, 'x', {
			enumerable: true,
			get: function() { return self.x; }
		});
		Object.defineProperty(this.pos, 'y', {
			enumerable: true,
			get: function() { return self.y; }
		});

		// Attribute management — the attr object needs a "live" .value setter
		// that emits ANSI escape codes when changed, exactly like dorkit does.
		// LORD's foreground() calls dk.console.attr.value = X directly.
		this._currentAttr = new Attribute(7);
		this._prevAttr = new Attribute(7);
		this._attrDirty = false;  // Set true when raw ANSI passes through print()
		Object.defineProperty(this._currentAttr, 'value', {
			enumerable: true,
			get: function() {
				return this._value;
			},
			set: function(val) {
				if (val instanceof Attribute) val = val._value;
				val = val & 0xFF;
				if (val !== this._value || self._attrDirty) {
					this._value = val;
					// When dirty (raw ANSI went through print), we don't
					// know the terminal's actual state. Pass undefined as
					// prev to force a full reset + set sequence.
					var ansiStr = self._attrDirty
						? this.ansi(undefined)
						: this.ansi(self._prevAttr);
					self._prevAttr._value = val;
					self._attrDirty = false;
					if (ansiStr) {
						self._sendOutput(ansiStr);
					}
				}
			}
		});

		// Expose attr as a direct property of the console (dk.console.attr).
		// Original dorkit has this as the live Attribute object. Many doors
		// access dk.console.attr.value, dk.console.attr.fg, etc.
		// Setting to a string like 'HR' parses each char as a Ctrl-A code.
		// Setting to a number sets the attribute value directly.
		Object.defineProperty(this, 'attr', {
			get: function() { return self._currentAttr; },
			set: function(val) {
				if (typeof val === 'string') {
					// Parse as Ctrl-A code string: 'HR' = High + Red
					// Build target attribute in a temp object, then assign
					var tmp = new Attribute(self._currentAttr._value);
					for (var i = 0; i < val.length; i++) {
						self._ctrla_attr(val[i], tmp);
					}
					self._currentAttr.value = tmp._value;
				} else if (typeof val === 'number') {
					self._currentAttr.value = val;
				} else if (val instanceof Attribute) {
					self._currentAttr.value = val._value;
				}
			},
			enumerable: true, configurable: true
		});

		// Key constants (must match dorkit)
		this.key = {
			CTRL_A: '\x01', CTRL_B: '\x02', CTRL_C: '\x03',
			CTRL_D: '\x04', CTRL_E: '\x05', CTRL_F: '\x06',
			CTRL_G: '\x07', BEEP: '\x07',
			CTRL_H: '\x08', BACKSPACE: '\x08',
			CTRL_I: '\x09', TAB: '\x09',
			CTRL_J: '\x0a', LF: '\x0a',
			CTRL_K: '\x0b', CTRL_L: '\x0c', CLEAR: '\x0c',
			CTRL_M: '\x0d', RETURN: '\x0d',
			CTRL_N: '\x0e', CTRL_O: '\x0f', CTRL_P: '\x10',
			CTRL_Q: '\x11', CTRL_R: '\x12',
			CTRL_S: '\x13', PAUSE: '\x13',
			CTRL_T: '\x14', CTRL_U: '\x15', CTRL_V: '\x16',
			CTRL_W: '\x17', CTRL_X: '\x18', CTRL_Y: '\x19',
			CTRL_Z: '\x1a',
			ESCAPE: '\x1b',
			DELETE: '\x7f',
			KEY_UP: 'KEY_UP',
			KEY_DOWN: 'KEY_DOWN',
			KEY_RIGHT: 'KEY_RIGHT',
			KEY_LEFT: 'KEY_LEFT',
			KEY_HOME: 'KEY_HOME',
			KEY_END: 'KEY_END',
			KEY_F1: 'KEY_F1', KEY_F2: 'KEY_F2', KEY_F3: 'KEY_F3',
			KEY_F4: 'KEY_F4', KEY_F5: 'KEY_F5', KEY_F6: 'KEY_F6',
			KEY_F7: 'KEY_F7', KEY_F8: 'KEY_F8', KEY_F9: 'KEY_F9',
			KEY_F10: 'KEY_F10', KEY_F11: 'KEY_F11', KEY_F12: 'KEY_F12',
			KEY_PGUP: 'KEY_PGUP', KEY_PGDOWN: 'KEY_PGDOWN',
			KEY_INS: 'KEY_INS', KEY_DEL: 'KEY_DEL',
			KEY_ALT_0: 'KEY_ALT_0', KEY_ALT_1: 'KEY_ALT_1',
			KEY_ALT_2: 'KEY_ALT_2', KEY_ALT_3: 'KEY_ALT_3',
			KEY_ALT_4: 'KEY_ALT_4', KEY_ALT_5: 'KEY_ALT_5',
			KEY_ALT_6: 'KEY_ALT_6', KEY_ALT_7: 'KEY_ALT_7',
			KEY_ALT_8: 'KEY_ALT_8', KEY_ALT_9: 'KEY_ALT_9',
			POSITION_REPORT: 'POSITION_REPORT',
			UNKNOWN_ANSI: 'UNKNOWN_ANSI',
			CONNECTION_CLOSED: 'CONNECTION_CLOSED'
		};

		this.last_pos = { x: 1, y: 1 };
		this.keybuf = [];
		this.input_queue_callback = [];

		// Dorkit getstr defaults
		this.getstr_defaults = {
			timeout: undefined,
			password: false,
			password_char: '*',
			upper_case: false,
			integer: false,
			decimal: false,
			edit: '',
			crlf: true,
			exascii: false,
			input_box: false,
			select: true,
			attr: undefined,
			sel_attr: undefined,
			len: 80,
			max: undefined,
			min: undefined,
			hotkeys: undefined
		};
	}

	// --- Attribute property ---
	get attr() {
		return this._currentAttr;
	}

	set attr(val) {
		if (typeof val === 'number') {
			// Direct numeric attr — the .value setter emits ANSI
			this._currentAttr.value = val;
		} else if (val instanceof Attribute) {
			this._currentAttr.value = val._value;
		} else if (typeof val === 'string') {
			// Handle ^A code strings (e.g. dk.console.attr = 'HR')
			var next = new Attribute(this._currentAttr);
			for (var i = 0; i < val.length; i++) {
				this._ctrla_attr(val[i], next);
			}
			// Single assignment triggers one ANSI emit
			this._currentAttr.value = next._value;
		}
	}

	/**
	 * Apply a ^A attribute code character to an Attribute object.
	 * Matches dorkit's ctrla_attr exactly.
	 */
	_ctrla_attr(code, attr) {
		switch (code.toUpperCase()) {
			case 'K': attr.fg = Attribute.BLACK; break;    // 0
			case 'B': attr.fg = Attribute.BLUE; break;     // 1
			case 'G': attr.fg = Attribute.GREEN; break;    // 2
			case 'C': attr.fg = Attribute.CYAN; break;     // 3
			case 'R': attr.fg = Attribute.RED; break;      // 4
			case 'M': attr.fg = Attribute.MAGENTA; break;  // 5
			case 'Y': attr.fg = Attribute.YELLOW; break;   // 6
			case 'W': attr.fg = Attribute.WHITE; break;    // 7
			case '0': attr.bg = Attribute.BLACK; break;    // 0
			case '1': attr.bg = Attribute.RED; break;      // 4
			case '2': attr.bg = Attribute.GREEN; break;    // 2
			case '3': attr.bg = Attribute.YELLOW; break;   // 6
			case '4': attr.bg = Attribute.BLUE; break;     // 1
			case '5': attr.bg = Attribute.MAGENTA; break;  // 5
			case '6': attr.bg = Attribute.CYAN; break;     // 3
			case '7': attr.bg = Attribute.WHITE; break;    // 7
			case 'H': attr.bright = true; break;
			case 'I': attr.blink = true; break;
			case 'N': attr.value = 7; break;
			case '-':
				if (attr.blink || attr.bright || attr.bg !== Attribute.BLACK) {
					attr.value = 7;
				}
				break;
			case '_':
				if (attr.blink || attr.bg !== Attribute.BLACK) {
					attr.value = 7;
				}
				break;
		}
	}

	/**
	 * Parse ^A codes in a string, returning the ANSI-escaped result.
	 */
	parse_ctrla(txt, origAttr) {
		var ret = '';
		var currAttr = origAttr ? new Attribute(origAttr) : undefined;
		var nextAttr = new Attribute(currAttr || 7);

		function attrStr() {
			if (currAttr === undefined || currAttr._value !== nextAttr._value) {
				var ansiStr = nextAttr.ansi(currAttr);
				if (currAttr === undefined) {
					currAttr = new Attribute(nextAttr);
				} else {
					currAttr.value = nextAttr.value;
				}
				return ansiStr;
			}
			return '';
		}

		for (var i = 0; i < txt.length; i++) {
			if (txt.charCodeAt(i) === 1) {
				i++;
				if (i >= txt.length) break;
				if (txt[i] === '\x01') {
					ret += attrStr() + '\x01';
				} else {
					this._ctrla_attr(txt[i], nextAttr);
				}
			} else {
				ret += attrStr() + txt[i];
			}
		}
		return ret + attrStr();
	}

	// --- Output methods ---

	/** Raw print — no parsing */
	print(str) {
		if (typeof str !== 'string') str = String(str);

		// Strip ANSI music sequences. Synchronet ANSI music: ESC[M followed
		// by MML note data (letters A-G, O, T, L, P, N, digits, #, +, -, ., ;).
		// Only strip when followed by MML chars — bare ESC[M (ANSI "Delete Line")
		// followed by ESC is left alone to not corrupt real ANSI sequences.
		str = str.replace(/\x1b\[M([A-GOTLPNRSV0-9#\+\-\.\;<> ]+)/gi, '');

		// Strip BEL (0x07) characters embedded in output strings.
		str = str.replace(/\x07/g, '');

		if (str.length === 0) return;

		// Auto-pause: check before printing, pause if a screenful has scrolled
		if (this.auto_pause && this.remote_screen && this.remote_screen.new_lines >= this.rows) {
			this.pause();
		}

		// If raw ANSI escapes pass through (e.g. from .ans art files),
		// the terminal color state diverges from our _currentAttr tracker.
		// Mark dirty so the next attr.value= does a full reset.
		if (str.indexOf('\x1b[') !== -1) {
			this._attrDirty = true;
		}
		this._sendOutput(str);

		// Count newlines for auto_pause tracking, but only for
		// sequential text output. If the string contains cursor
		// positioning (ESC[...H or ESC[...f), it's screen drawing
		// and should reset the counter instead.
		if (this.auto_pause) {
			if (/\x1b\[\d*;?\d*[HfABd]/.test(str)) {
				// Cursor positioning detected — screen drawing mode
				if (this.remote_screen) this.remote_screen.new_lines = 0;
			} else if (this.remote_screen) {
				for (var i = 0; i < str.length; i++) {
					if (str[i] === '\n') this.remote_screen.new_lines++;
				}
			}
		}

		// Track cursor position roughly
		this._trackCursor(str);
	}

	/** Print with CRLF */
	println(line) {
		this.print(line + '\r\n');
	}

	/** Print with ^A code parsing */
	aprint(str) {
		this.print(this.parse_ctrla(str, this._currentAttr));
	}

	/**
	 * Parse Synchronet pipe codes (|XX) in a string.
	 * |00-|07: normal foreground, |08-|15: bright foreground, |16-|23: background.
	 */
	parse_pipe(str) {
		var _cgaToAnsi = [30, 34, 32, 36, 31, 35, 33, 37]; // CGA→ANSI fg
		return str.replace(/\|(\d{2})/g, function(match, digits) {
			var n = parseInt(digits, 10);
			if (n >= 0 && n <= 7) {
				// Normal foreground
				return '\x1b[0;' + _cgaToAnsi[n] + 'm';
			} else if (n >= 8 && n <= 15) {
				// Bright foreground
				return '\x1b[1;' + _cgaToAnsi[n - 8] + 'm';
			} else if (n >= 16 && n <= 23) {
				// Background
				return '\x1b[' + (_cgaToAnsi[n - 16] + 10) + 'm';
			}
			return match; // Not a valid pipe code, leave as-is
		});
	}

	/**
	 * Expand Synchronet @-codes in a string.
	 * @USER@, @SYSOP@, @BBS@, @ROWS@, @COLS@, etc.
	 */
	expand_atcodes(str) {
		var self = this;
		return str.replace(/@([A-Z_]+)@/g, function(match, code) {
			switch (code) {
				case 'USER':
				case 'ALIAS': return globalThis.user ? (globalThis.user.alias || globalThis.user.name || 'User') : 'User';
				case 'NAME': return globalThis.user ? (globalThis.user.name || '') : '';
				case 'SYSOP': return globalThis.system ? (globalThis.system.operator || 'Sysop') : 'Sysop';
				case 'BBS': return globalThis.system ? (globalThis.system.name || 'BBS') : 'BBS';
				case 'ROWS': return String(self.rows);
				case 'COLS':
				case 'COLUMNS': return String(self.cols);
				case 'NODE': return String(globalThis.bbs ? globalThis.bbs.node_num : 1);
				case 'TIME_LEFT': return '60'; // stub
				case 'DATE': return new Date().toLocaleDateString('en-US');
				case 'TIME': return new Date().toLocaleTimeString('en-US');
				case 'CLS': self.clear(); return '';
				case 'PAUSE': self.pause(); return '';
				default: return match; // Unknown — leave as-is
			}
		});
	}

	/**
	 * putmsg — full Synchronet-style output processing.
	 * Processes @-codes, pipe codes, AND Ctrl-A codes.
	 */
	putmsg(str, mode) {
		if (typeof str !== 'string') str = String(str);
		str = this.expand_atcodes(str);
		str = this.parse_pipe(str);
		this.aprint(str);
	}

	/** Print with ^A parsing + CRLF */
	aprintln(line) {
		this.println(this.parse_ctrla(line, this._currentAttr));
	}

	/** Centre text on current line */
	centre(str) {
		// Strip Ctrl-A codes for visible length calculation
		var visible = str.replace(/\x01./g, '');
		var pos = Math.floor((this.cols - visible.length) / 2);
		if (pos > 0) this.movex(pos - this.x);
		this.aprint(str);
	}
	center(str) { this.centre(str); }

	beep() { this._sendOutput('\x07'); }

	// --- Screen control ---

	clear() {
		// Auto-pause: if there are pending lines, pause before clearing
		if (this.auto_pause && this.remote_screen && this.remote_screen.new_lines > 0) {
			this.pause();
		}
		// Send an explicit reset + clear screen. After this the terminal
		// is at default attr (7), so force-sync our tracker to match.
		this._sendOutput('\x1b[0m\x1b[2J\x1b[H');
		this._currentAttr._value = 7;
		this._prevAttr._value = 7;
		this._attrDirty = false;
		this.x = 1;
		this.y = 1;
		if (this.remote_screen) {
			this.remote_screen.new_lines = 0;
			this.remote_screen.printed = false;
		}
	}

	cleareol() {
		this._sendOutput('\x1b[K');
	}

	/**
	 * Get a Graphic object representing a screen region.
	 * Not available in remote-only mode (no local screen buffer).
	 * Returns undefined, matching dorkit behavior when local_io is absent.
	 */
	getblock(sx, sy, ex, ey) {
		return undefined;
	}

	gotoxy(x, y) {
		this._sendOutput('\x1b[' + y + ';' + x + 'H');
		this.x = x;
		this.y = y;
		// Cursor positioning indicates screen drawing, not sequential
		// scrolling — reset the auto_pause line counter.
		if (this.remote_screen) this.remote_screen.new_lines = 0;
	}

	movex(pos) {
		if (pos === 0) return;
		if (pos > 0) {
			this._sendOutput('\x1b[' + pos + 'C');
		} else {
			this._sendOutput('\x1b[' + (-pos) + 'D');
		}
		this.x += pos;
	}

	movey(pos) {
		if (pos === 0) return;
		if (pos > 0) {
			this._sendOutput('\x1b[' + pos + 'B');
		} else {
			this._sendOutput('\x1b[' + (-pos) + 'A');
		}
		this.y += pos;
	}

	// --- Input methods ---

	/**
	 * Wait for a key press with timeout.
	 * BLOCKS the worker thread.
	 * @param {number} timeout — milliseconds to wait
	 * @returns {boolean} true if key available
	 */
	waitkey(timeout) {
		if (this.keybuf.length > 0) return true;
		if (!this._comm.connected) return true;
		return this._comm.waitKey(timeout);
	}

	/**
	 * Get a single key. ANSI sequences have already been parsed
	 * by the main thread's ansiInputParser.
	 * Returns the key string or undefined.
	 */
	getkey() {
		if (!this._comm.connected) return this.key.CONNECTION_CLOSED;

		// Any user input resets the auto_pause line counter —
		// matches Synchronet and dorkit behavior.
		if (this.remote_screen) this.remote_screen.new_lines = 0;

		// Check internal buffer first (for pushed-back keys)
		if (this.keybuf.length > 0) {
			return this.keybuf.shift();
		}

		if (!this.waitkey(0)) return undefined;

		var key = this._comm.getKey();
		if (key === undefined) return undefined;
		if (key === 'CONNECTION_CLOSED') return this.key.CONNECTION_CLOSED;

		// Assemble ANSI escape sequences into complete strings.
		// Known sequences (arrows etc.) → KEY_UP, KEY_DOWN, etc.
		// Unknown sequences (terminal responses) → returned as complete
		// multi-char string (e.g. "\x1b[1;1R"). Games that check
		// ch.length > 1 or ch == '\x1b' will handle them naturally.
		if (key === '\x1b') {
			if (!this._comm.waitKey(50)) return '\x1b'; // lone ESC

			var next = this._comm.getKey();
			if (next === undefined) return '\x1b';

			if (next === '[') {
				// CSI sequence — collect params then final byte
				var collected = '';
				while (this._comm.waitKey(50)) {
					var ch = this._comm.getKey();
					if (ch === undefined) break;
					var code = ch.charCodeAt(0);
					if (code >= 0x20 && code <= 0x3f) {
						collected += ch; // parameter or intermediate byte
					} else if (code >= 0x40 && code <= 0x7e) {
						// Final byte — complete sequence
						var mapped = this._mapAnsiSequence(collected + ch);
						if (mapped) return mapped;
						// Unknown sequence — return whole thing as one string
						return '\x1b[' + collected + ch;
					} else {
						// Unexpected byte — push it back, abort sequence
						this.keybuf.push(ch);
						break;
					}
				}
				// Incomplete CSI — push everything back, return ESC
				this.keybuf.push('[');
				for (var c = 0; c < collected.length; c++) {
					this.keybuf.push(collected[c]);
				}
				return '\x1b';
			} else if (next === 'O') {
				// SS3 sequences (ESC O A/B/C/D for arrows on some terminals)
				if (this._comm.waitKey(50)) {
					var ss3 = this._comm.getKey();
					if (ss3) {
						var ss3map = { 'A': 'KEY_UP', 'B': 'KEY_DOWN',
						               'C': 'KEY_RIGHT', 'D': 'KEY_LEFT' };
						if (ss3map[ss3]) return ss3map[ss3];
						// Unknown SS3 — return complete
						return '\x1bO' + ss3;
					}
				}
				this.keybuf.push('O');
				return '\x1b';
			} else {
				// ESC + unknown — return as two-char string
				return '\x1b' + next;
			}
		}

		return key;
	}

	/**
	 * Map a CSI sequence body (params + final byte) to a dorkit key name.
	 */
	_mapAnsiSequence(seq) {
		var map = {
			'A': 'KEY_UP',    'B': 'KEY_DOWN',
			'C': 'KEY_RIGHT', 'D': 'KEY_LEFT',
			'H': 'KEY_HOME',  'F': 'KEY_END',
			'1~': 'KEY_HOME', '4~': 'KEY_END',
			'2~': 'KEY_INS',  '3~': 'KEY_DEL',
			'5~': 'KEY_PGUP', '6~': 'KEY_PGDOWN',
			'11~': 'KEY_F1',  '12~': 'KEY_F2',
			'13~': 'KEY_F3',  '14~': 'KEY_F4',
			'15~': 'KEY_F5',  '17~': 'KEY_F6',
			'18~': 'KEY_F7',  '19~': 'KEY_F8',
			'20~': 'KEY_F9',  '21~': 'KEY_F10',
			'23~': 'KEY_F11', '24~': 'KEY_F12',
		};
		return map[seq] || null;
	}

	/**
	 * Get a raw byte (no ANSI parsing).
	 */
	getbyte() {
		if (!this._comm.connected) return undefined;
		if (this.keybuf.length > 0) {
			var k = this.keybuf.shift();
			if (k.length === 1) return k;
			// Extended key — push back and return undefined
			this.keybuf.unshift(k);
			return undefined;
		}
		if (!this.waitkey(0)) return undefined;
		var key = this._comm.getKey();
		if (key && key.length === 1) return key;
		if (key) this.keybuf.push(key); // Push back extended keys
		return undefined;
	}

	/**
	 * Interactive string input (line editor).
	 * Mirrors dorkit's getstr() — blocking.
	 *
	 * Includes:
	 *   - select mode (inverse highlight on edit values, type to erase)
	 *   - decimal mode (regex-validated numeric input with decimal point)
	 *   - min/max validation on Enter for integer and decimal modes
	 */
	getstr(inOpts) {
		var opt = {};
		var k;

		// Merge defaults
		for (k in this.getstr_defaults) {
			opt[k] = (inOpts && inOpts[k] !== undefined) ? inOpts[k] : this.getstr_defaults[k];
		}

		// Decimal regex
		var decimal_re;
		if (opt.decimal) {
			decimal_re = /^([0-9]+(\.[0-9]*)?)?$/;
		}

		// Attribute setup for select mode
		if (opt.attr === undefined) {
			opt.attr = new Attribute(this._currentAttr);
		}
		if (opt.sel_attr === undefined) {
			opt.sel_attr = new Attribute(this._currentAttr);
			// Inverse: swap fg and bg, keep bright and blink
			var tmpFg = opt.sel_attr.fg;
			opt.sel_attr.fg = opt.sel_attr.bg;
			opt.sel_attr.bg = tmpFg;
		}

		var str = opt.edit || '';
		var dispstr = opt.password ? opt.password_char.repeat(str.length) : str;
		var pos = str.length;
		var insmode = true;
		var self = this;

		// Reset auto_pause line counter — user is interacting
		if (this.auto_pause && this.remote_screen) {
			this.remote_screen.new_lines = 0;
		}

		// --- Select mode helpers ---
		// Movement keys: deselect but keep the text
		function do_select_keep() {
			if (opt.select) {
				opt.select = false;
				self._currentAttr.value = opt.attr.value;
				self.movex(-pos);
				self.print(dispstr);
				pos = str.length;
			}
		}
		// Editing keys: deselect and erase the text
		function do_select_erase() {
			if (opt.select) {
				opt.select = false;
				self._currentAttr.value = opt.attr.value;
				self.movex(-pos);
				self.print(' '.repeat(str.length));
				self.movex(-str.length);
				dispstr = '';
				str = '';
				pos = 0;
			}
		}

		// Set foreground attribute
		this._currentAttr.value = opt.attr.value;

		// Draw the input box
		if (opt.input_box) {
			for (var i = 0; i < opt.len; i++) this.print(' ');
			this.movex(-opt.len);
		}

		// Display initial value (in select highlight if select mode)
		if (opt.select && str.length > 0) {
			this._currentAttr.value = opt.sel_attr.value;
		}
		this.print(dispstr);
		if (opt.select && str.length > 0) {
			this._currentAttr.value = opt.attr.value;
		}

		while (true) {
			if (!this.waitkey(opt.timeout === undefined ? 1000 : opt.timeout)) {
				if (opt.timeout !== undefined) return str;
				continue;
			}

			var key = this.getkey();
			if (key === undefined) continue;
			if (key === this.key.CONNECTION_CLOSED) return str;

			if (opt.upper_case && key.length === 1) {
				key = key.toUpperCase();
			}

			// Hotkeys — only when string is empty
			if (opt.hotkeys && str.length === 0 && opt.hotkeys.indexOf(key) !== -1) {
				if (key.charCodeAt(0) >= 32) {
					this.print(opt.password ? opt.password_char : key);
				}
				if (opt.crlf) this.println('');
				return key;
			}

			switch (key) {
				case 'KEY_HOME':
					do_select_keep();
					this.movex(-pos);
					pos = 0;
					break;
				case 'KEY_END':
					do_select_keep();
					this.movex(str.length - pos);
					pos = str.length;
					break;
				case 'KEY_LEFT':
					do_select_keep();
					if (pos > 0) { pos--; this.movex(-1); }
					break;
				case 'KEY_RIGHT':
					do_select_keep();
					if (pos < str.length) { pos++; this.movex(1); }
					break;
				case '\x7f':
				case '\b':
					do_select_erase();
					if (pos > 0) {
						str = str.substring(0, pos - 1) + str.substring(pos);
						dispstr = opt.password ? opt.password_char.repeat(str.length) : str;
						pos--;
						this.movex(-1);
						this.print(dispstr.substring(pos) + ' ');
						this.movex(-1 - (str.length - pos));
					}
					break;
				case 'KEY_DEL':
					do_select_erase();
					if (pos < str.length) {
						str = str.substring(0, pos) + str.substring(pos + 1);
						dispstr = opt.password ? opt.password_char.repeat(str.length) : str;
						this.print(dispstr.substring(pos) + ' ');
						this.movex(-1 - (str.length - pos));
					}
					break;
				case 'KEY_INS':
					do_select_keep();
					insmode = !insmode;
					break;
				case '\r':
					// Min/max validation for integer and decimal modes
					if (opt.integer || opt.decimal) {
						var val = opt.integer ? parseInt(str, 10) : parseFloat(str);
						if (isNaN(val)) val = 0;
						if (opt.min !== undefined && opt.min > val) break;
						if (opt.max !== undefined && opt.max < val) break;
					}
					if (opt.crlf) this.println('');
					return str;
				default:
					if (key.length > 1) break; // Unhandled extended key
					if (opt.integer && (key < '0' || key > '9')) break;
					if (!opt.exascii && key.charCodeAt(0) > 127) break;
					if (key.charCodeAt(0) < 32) break;
					do_select_erase();
					if (str.length >= opt.len) break;

					var newstr = str.substring(0, pos) + key + str.substring(insmode ? pos : pos + 1);
					if (opt.decimal && newstr.search(decimal_re) === -1) break;

					str = newstr;
					dispstr = opt.password ? opt.password_char.repeat(str.length) : str;
					this.print(dispstr.substring(pos));
					pos++;
					this.movex(-(str.length - pos));
					break;
			}
		}
	}

	/**
	 * More/pause prompt.
	 * Temporarily disables auto_pause while printing its own prompt
	 * to avoid recursive triggering, then resets the line counter.
	 */
	pause() {
		var savedAttr = this._currentAttr._value;
		var savedAutoPause = this.auto_pause;

		this.auto_pause = false;
		this.attr = 'HR';
		this.aprint('[Hit a key]');
		this._currentAttr.value = savedAttr;
		while (!this.waitkey(10000)) {}
		this.getkey();
		this.print('\b'.repeat(11) + ' '.repeat(11) + '\b'.repeat(11));
		this.auto_pause = savedAutoPause;
		if (this.remote_screen) {
			this.remote_screen.new_lines = 0;
			this.remote_screen.touched = [];
			this.remote_screen.printed = false;
		}
	}

	// --- Internal helpers ---

	/** Rough cursor position tracking */
	_trackCursor(str) {
		for (var i = 0; i < str.length; i++) {
			var ch = str[i];
			if (ch === '\r') {
				this.x = 1;
			} else if (ch === '\n') {
				this.y++;
			} else if (ch === '\x1b') {
				// Skip ANSI sequences for tracking — imperfect but good enough
				// for the auto-pause line counter
				break;
			} else {
				this.x++;
				if (this.x > this.cols) {
					this.x = 1;
					this.y++;
				}
			}
		}
	}
}


// ============================================================
//  Exports
// ============================================================
export { DorkitShim, DorkitConsole, Attribute };