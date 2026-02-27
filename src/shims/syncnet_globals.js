/**
 * syncnet_globals.js — Synchronet runtime global polyfills
 *
 * Door scripts written for Synchronet expect a rich set of global functions
 * and objects.  This module installs them into the worker's globalThis so
 * that door scripts (lord.js, etc.) can run unmodified (or near-unmodified).
 *
 * Notable shims:
 *   - File           — Synchronet File object (wraps Node fs)
 *   - random(n)      — random integer 0..n
 *   - time()         — Unix epoch seconds
 *   - ascii(ch)      — char code
 *   - mswait(ms)     — blocking sleep (Atomics.wait)
 *   - file_exists()  — fs.existsSync wrapper
 *   - require()      — Synchronet-style require/load
 *   - exit()         — throws to unwind
 *   - log            — console.log wrapper with level constants
 *   - directory()    — glob-style directory listing
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync,
         statSync, unlinkSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import * as nodePath from 'node:path';
import { Script } from 'node:vm';
import { Attribute } from './dorkit_shim.js';
import { RecordFile, RecordFileRecord, GetRecordLength, getRecordLength, setDatabaseDir, importBinaryRecordFile } from './recordfile_sqlite.js';


/**
 * Transpile SpiderMonkey-specific syntax to V8-compatible JS.
 *
 * Synchronet runs on SpiderMonkey which has non-standard extensions:
 *   - "for each(var x in obj)" — iterates over values (not keys)
 *     Becomes "for(var x of Object.values(obj))"
 */
function _transpileSpiderMonkey(src) {
	// Fast path: no SpiderMonkey extensions present
	if (src.indexOf('for each') === -1) return src;

	// Replace "for each(..." with balanced-paren-aware transform.
	// Pattern: for each ( [var/let/const] IDENT in EXPR )
	// Result:  for ( [var/let/const] IDENT of Object.values( EXPR ) )
	var result = '';
	var feRe = /\bfor\s+each\s*\(/g;
	var lastIdx = 0;
	var match;

	while ((match = feRe.exec(src)) !== null) {
		result += src.substring(lastIdx, match.index);

		// Position is right after the opening (
		var pos = match.index + match[0].length;

		// Skip whitespace
		while (pos < src.length && /\s/.test(src[pos])) pos++;

		// Capture optional var/let/const
		var declMatch = src.substring(pos).match(/^(var|let|const)\s+/);
		var decl = '';
		if (declMatch) {
			decl = declMatch[1] + ' ';
			pos += declMatch[0].length;
		}

		// Capture the variable name — typically just an identifier
		var identMatch = src.substring(pos).match(/^(\w+)\s+in\s+/);
		if (!identMatch) {
			// Not a valid for-each pattern, emit original
			result += match[0];
			lastIdx = match.index + match[0].length;
			continue;
		}
		var ident = identMatch[1];
		pos += identMatch[0].length;

		// Now pos is at the start of EXPR. Find the closing ) that
		// balances the for('s opening (, accounting for nested parens.
		var depth = 1;
		var exprStart = pos;
		while (pos < src.length && depth > 0) {
			if (src[pos] === '(') depth++;
			else if (src[pos] === ')') depth--;
			if (depth > 0) pos++;
		}
		// pos is at the closing )
		var expr = src.substring(exprStart, pos);

		result += 'for(' + decl + ident + ' of Object.values(' + expr + '))';
		lastIdx = pos + 1; // skip past the closing )
		feRe.lastIndex = lastIdx;
	}

	result += src.substring(lastIdx);
	return result;
}

/**
 * Install all Synchronet-compatible globals onto globalThis.
 *
 * @param {DorkitShim} dk — the dorkit shim instance
 * @param {string} doorDir — base directory for the door scripts
 * @param {string} dbSubdir — subdirectory (relative to doorDir) for the SQLite game database, or absolute path
 * @param {MessagePort} parentPort — for async messages to main thread
 */
function installSyncnetGlobals(dk, doorDir, dbSubdir, parentPort) {

	// ---- Configure database directory ----
	// If dbSubdir is set, resolve it relative to doorDir (unless absolute)
	if (dbSubdir) {
		var dbDir;
		if (dbSubdir.startsWith('/') || (dbSubdir.length > 1 && dbSubdir[1] === ':')) {
			dbDir = dbSubdir;
		} else {
			dbDir = nodePath.join(doorDir, dbSubdir);
		}
		setDatabaseDir(dbDir);
	}

	// ---- Make dk available globally ----
	globalThis.dk = dk;
	globalThis.Attribute = Attribute;

	// ---- js object (Synchronet script info) ----
	globalThis.js = {
		exec_dir: doorDir.endsWith('/') ? doorDir : doorDir + '/',
		startup_dir: doorDir.endsWith('/') ? doorDir : doorDir + '/',
		load_path_list: [doorDir + '/'],
		auto_terminate: false,
		terminated: false,
		global: globalThis,
		gc: function() {},
		on_exit: function(code) {
			// Store exit handlers — we'll run them on exit
			if (typeof code === 'string') {
				if (!globalThis._exitHandlers) globalThis._exitHandlers = [];
				globalThis._exitHandlers.push(code);
			}
		},
		exec: function(script, startupDir_or_scope) {
			// Synchronet js.exec(filename, startup_dir, scope, ...argv)
			// or js.exec(filename, scope, ...argv)
			// IGMs rely on running in global scope with access to LORD globals.
			var startupDir, extraArgs;

			if (typeof startupDir_or_scope === 'string') {
				// Second arg is a directory path
				startupDir = startupDir_or_scope;
				// remaining args after scope (arg index 2) are argv
				extraArgs = Array.prototype.slice.call(arguments, 3);
			} else {
				startupDir = null;
				extraArgs = Array.prototype.slice.call(arguments, 2);
			}

			// Save and set exec_dir
			var savedExecDir = globalThis.js.exec_dir;
			var savedArgv = globalThis.argv;
			var savedArgc = globalThis.argc;

			if (startupDir) {
				if (!startupDir.endsWith('/') && !startupDir.endsWith('\\')) {
					startupDir += '/';
				}
				globalThis.js.exec_dir = startupDir;
			}

			// Set argv for the child script
			globalThis.argv = extraArgs;
			globalThis.argc = extraArgs.length;

			try {
				var scriptPath;
				if (startupDir) {
					// Try startupDir first
					var candidate = nodePath.join(startupDir, script);
					if (existsSync(candidate)) {
						scriptPath = candidate;
					}
				}
				if (!scriptPath) {
					scriptPath = _resolveScript(script);
				}
				if (!scriptPath) {
					console.log('[Shim] IGM script not found: ' + script);
					return -1;
				}

				var src = _transpileSpiderMonkey(readFileSync(scriptPath, 'utf-8'));
				// vm.runInThisContext ensures function/var declarations in
				// the IGM become true globalThis properties, and can see
				// LORD globals (player, dk, foreground, lw, etc.)
				new Script(src, { filename: scriptPath }).runInThisContext();
				return 0;
			} catch (e) {
				if (e.message === 'DOOR_EXIT') {
					// Normal exit from IGM — return to caller (LORD)
					return e.exitCode || 0;
				}
				console.log('[Shim] IGM error in ' + script + ': ' + (e.stack || e.message));
				return e;
			} finally {
				// Restore exec_dir and argv
				globalThis.js.exec_dir = savedExecDir;
				globalThis.argv = savedArgv;
				globalThis.argc = savedArgc;
			}
		}
	};

	// ---- Synchronet system object ----
	globalThis.system = {
		os_version: 'Node.js ' + process.version,
		platform: process.platform,
		qwk_id: (process.env.bbsname || 'BBS').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8) || 'BBS',
		ctrl_dir: doorDir + '/',
		text_dir: doorDir + '/',
		node_dir: doorDir + '/',
		nodes: 1,
		node_num: 1,
		name: process.env.bbsname || 'BBS Door Server',
		operator: process.env.sysopname || 'Sysop',
		inetaddr: 'localhost',
		datestr: function(time) {
			var d = time ? new Date(time * 1000) : new Date();
			return (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear();
		},
		username: function(num) { return dk.user.alias; },
		put_telegram: function(num, msg) { /* no-op */ },
		node_list: []
	};

	// Synchronet global user object — IGMs reference this directly
	// (separate from dk.user which dorkit provides)
	globalThis.user = {
		alias: dk.user.alias,
		name: dk.user.full_name,
		number: dk.user.number || 1,
		security: {
			level: dk.user.level || 0,
			flags1: 0, flags2: 0, flags3: 0, flags4: 0
		},
		is_sysop: (dk.user.level || 0) >= 90,
		settings: 0
	};

	// ---- Synchronet bbs object ----
	var _sysStatus = 0;
	globalThis.bbs = {
		node_num: dk.connection ? dk.connection.node : 1,
		online: true
	};
	// sys_status as getter/setter — monitors SS_PAUSEOFF/SS_PAUSEON
	Object.defineProperty(globalThis.bbs, 'sys_status', {
		get: function() { return _sysStatus; },
		set: function(v) {
			_sysStatus = v;
			// SS_PAUSEOFF (1<<2) = 4: door wants to suppress auto-pause
			if (dk.console && (v & 4)) {
				dk.console.auto_pause = false;
			}
		},
		enumerable: true, configurable: true
	});

	// ---- Argv / Argc ----
	globalThis.argv = [];
	globalThis.argc = 0;

	// ---- Synchronet sbbsdefs constants (pre-defined) ----
	// Many doors expect these without explicitly load('sbbsdefs.js').
	// In real Synchronet, sbbsdefs is almost universally loaded.
	// Define the most commonly used ones here; load('sbbsdefs.js')
	// will re-define them (harmlessly) if called.

	// System status flags
	globalThis.SS_MOFF      = (1<<1);
	globalThis.SS_PAUSEOFF  = (1<<2);
	globalThis.SS_PAUSEON   = (1<<3);
	globalThis.SS_USERON    = (1<<13);
	globalThis.SS_TMOUT     = (1<<14);
	globalThis.SS_ABORT     = (1<<15);
	globalThis.SS_SYSPAGE   = (1<<16);
	globalThis.SS_EVENT     = (1<<17);
	globalThis.SS_SPLITP    = (1<<18);
	globalThis.SS_NEWDAY    = (1<<19);

	// Print mode flags
	globalThis.P_NONE       = 0;
	globalThis.P_NOPAUSE    = (1<<0);
	globalThis.P_SAVEATR    = (1<<1);
	globalThis.P_NOATCODES  = (1<<2);
	globalThis.P_NOCRLF     = (1<<3);
	globalThis.P_WORDWRAP   = (1<<4);
	globalThis.P_TRUNCATE   = (1<<5);
	globalThis.P_NOERROR    = (1<<6);
	globalThis.P_PETSCII    = (1<<7);
	globalThis.P_CPM_EOF    = (1<<8);

	// Getkey mode flags
	globalThis.K_NONE       = 0;
	globalThis.K_UPPER      = (1<<0);
	globalThis.K_UPRLWR     = (1<<1);
	globalThis.K_NUMBER     = (1<<2);
	globalThis.K_WRAP       = (1<<3);
	globalThis.K_MSG        = (1<<4);
	globalThis.K_SPIN       = (1<<5);
	globalThis.K_LINE       = (1<<6);
	globalThis.K_EDIT       = (1<<7);
	globalThis.K_NOCRLF     = (1<<8);
	globalThis.K_ALPHA      = (1<<9);
	globalThis.K_NOECHO     = (1<<10);
	globalThis.K_NOSPIN     = 0;

	// Log levels
	globalThis.LOG_EMERG    = 0;
	globalThis.LOG_ALERT    = 1;
	globalThis.LOG_CRIT     = 2;
	globalThis.LOG_ERR      = 3;
	globalThis.LOG_ERROR    = 3;
	globalThis.LOG_WARNING  = 4;
	globalThis.LOG_NOTICE   = 5;
	globalThis.LOG_INFO     = 6;
	globalThis.LOG_DEBUG    = 7;

	// Connection/node types
	globalThis.NODE_WFC     = 0;
	globalThis.NODE_LOGON   = 1;
	globalThis.NODE_NEWUSER = 2;
	globalThis.NODE_INUSE   = 3;
	globalThis.NODE_QUIET   = 4;

	// User settings bits
	globalThis.ANSI         = (1<<0);
	globalThis.COLOR        = (1<<10);
	globalThis.USER_PAUSE   = (1<<3);

	// CGA color attributes
	globalThis.BLACK        = 0;
	globalThis.BLUE         = 1;
	globalThis.GREEN        = 2;
	globalThis.CYAN         = 3;
	globalThis.RED          = 4;
	globalThis.MAGENTA      = 5;
	globalThis.BROWN        = 6;
	globalThis.LIGHTGRAY    = 7;
	globalThis.DARKGRAY     = 8;
	globalThis.LIGHTBLUE    = 9;
	globalThis.LIGHTGREEN   = 10;
	globalThis.LIGHTCYAN    = 11;
	globalThis.LIGHTRED     = 12;
	globalThis.LIGHTMAGENTA = 13;
	globalThis.YELLOW       = 14;
	globalThis.WHITE        = 15;
	globalThis.BG_BLACK     = 0;
	globalThis.BG_BLUE      = (1<<4);
	globalThis.BG_GREEN     = (2<<4);
	globalThis.BG_CYAN      = (3<<4);
	globalThis.BG_RED       = (4<<4);
	globalThis.BG_MAGENTA   = (5<<4);
	globalThis.BG_BROWN     = (6<<4);
	globalThis.BG_LIGHTGRAY = (7<<4);
	globalThis.HIGH         = (1<<3);
	globalThis.BLINK        = (1<<7);
	globalThis.ANSI_NORMAL  = 7;

	// Keyboard constants
	globalThis.KEY_UP       = 'KEY_UP';
	globalThis.KEY_DOWN     = 'KEY_DOWN';
	globalThis.KEY_LEFT     = 'KEY_LEFT';
	globalThis.KEY_RIGHT    = 'KEY_RIGHT';
	globalThis.KEY_HOME     = 'KEY_HOME';
	globalThis.KEY_END      = 'KEY_END';
	globalThis.KEY_DEL      = 'KEY_DEL';
	globalThis.KEY_INS      = 'KEY_INS';
	globalThis.KEY_PAGEUP   = 'KEY_PGUP';
	globalThis.KEY_PAGEDN   = 'KEY_PGDOWN';

	// Misc
	globalThis.LEN_ALIAS    = 25;
	globalThis.SYS_CLOSED   = (1<<0);

	// ---- Synchronet native console methods ----
	// Some doors (e.g. hamtest) use Synchronet's console object directly
	// rather than going through dorkit. Augment Node's console with BBS
	// I/O methods, delegating to dk.console. Preserves console.log etc.
	var _con = dk.console;

	// Synchronet's default console attribute is 2 (green on black).
	// Dorkit games (LORD etc.) set their own colors immediately, so
	// this only visibly affects native Synchronet console games (hamtest, druglord).
	_con._currentAttr._value = 2;
	_con._prevAttr._value = 2;

	globalThis.console.print = function(str) { _con.aprint(String(str)); };
	globalThis.console.write = function(str) {
		var s = String(str);
		_con.aprint(s);
		// Auto-increment line_counter for each newline (used by doors for pagination)
		for (var i = 0; i < s.length; i++) {
			if (s[i] === '\n') globalThis.console.line_counter++;
		}
	};
	globalThis.console.writeln = function(str) {
		var s = String(str);
		_con.aprint(s);
		_con.print('\r\n');
		globalThis.console.line_counter++;
	};
	globalThis.console.putmsg = function(str, mode) { _con.putmsg(String(str), mode); };

	/**
	 * console.mnemonics(str) — prints with ~X hotkey highlighting.
	 * The character after ~ is shown in high-intensity white, then
	 * the attribute reverts to the current console attribute.
	 */
	globalThis.console.mnemonics = function(str) {
		// Synchronet mnemonics uses a configurable color for non-highlighted
		// text (typically green=2) and bright white for ~X highlighted chars.
		// After output, it restores the normal text attribute (LIGHTGRAY=7).
		var normalColor = _con._currentAttr.ansi(undefined); // green (attr 2)
		var hiAttr = '\x1b[1;37m';  // bright white for hotkeys
		var out = normalColor;
		for (var i = 0; i < str.length; i++) {
			if (str[i] === '~' && i + 1 < str.length) {
				out += hiAttr + str[i + 1] + normalColor;
				i++;
			} else {
				out += str[i];
			}
		}
		// Synchronet's mnemonics() ends by applying `input_color`
		// (default: bright white, attr 15) — the standard input prompt
		// color. This is the same color as the ~X hotkey letters.
		out += '\x1b[1;37m';
		_con.print(out);
	};

	globalThis.console.getkey = function(mode) {
		// Synchronet's console.getkey() blocks by default (unlike dorkit's)
		_con.waitkey();
		var key = _con.getkey();
		// Restore normal attribute after input
		_con._sendOutput('\x1b[0;37m');
		// Reset line counter — user input resets pause tracking
		globalThis.console.line_counter = 0;
		// Always return a string — doors chain .toLowerCase() etc. directly
		var result = (key === undefined || key === null) ? '' : key;
		// K_UPPER (bit 0) — convert to uppercase
		if (mode && (mode & 1) && result.length === 1) {
			result = result.toUpperCase();
		}
		return result;
	};
	/**
	 * console.getkeys(validKeys, maxnum) — Synchronet multi-mode input.
	 *
	 * Accepts single-character hotkeys from validKeys string (case-insensitive,
	 * returned uppercase). If maxnum is provided, also accepts digit input to
	 * build a number (1..maxnum). Auto-submits when max digits are reached.
	 * Returns hotkey as a string, or the number as an integer.
	 */
	globalThis.console.getkeys = function(keys, maxnum) {
		var valid = String(keys).toUpperCase();
		var numStr = '';
		var maxDigits = (maxnum !== undefined && maxnum > 0)
			? String(maxnum).length
			: 0;

		while (true) {
			_con.waitkey();
			var ch = _con.getkey();
			if (ch === undefined || ch === 'CONNECTION_CLOSED') return '';
			globalThis.console.line_counter = 0;

			// Enter submits accumulated number
			if (ch === '\r' || ch === '\n') {
				if (numStr.length > 0) {
					var n = parseInt(numStr, 10);
					_con._sendOutput('\x1b[0;37m');
					return n;
				}
				continue;
			}

			// Backspace
			if (ch === '\b' || ch === '\x7f') {
				if (numStr.length > 0) {
					numStr = numStr.substring(0, numStr.length - 1);
					_con.print('\b \b');
				}
				continue;
			}

			var upper = ch.toUpperCase();

			// Hotkey match (only when no digits have been entered)
			if (numStr.length === 0 && valid.indexOf(upper) !== -1) {
				_con.print(upper);
				_con._sendOutput('\x1b[0;37m');
				return upper;
			}

			// Digit input (when maxnum is set)
			if (maxDigits > 0 && ch >= '0' && ch <= '9') {
				var candidate = numStr + ch;
				var n = parseInt(candidate, 10);
				// Don't allow leading zeros except as the whole value "0"
				// Don't allow values exceeding maxnum
				if (n > maxnum) continue;
				numStr = candidate;
				_con.print(ch);
				// Auto-submit when max digits reached
				if (numStr.length >= maxDigits) {
					_con._sendOutput('\x1b[0;37m');
					return parseInt(numStr, 10);
				}
			}
		}
	};
	globalThis.console.getstr = function(str, maxlen, mode) {
		var opts = {};
		if (typeof str === 'string') opts.edit = str;
		if (typeof maxlen === 'number') opts.len = maxlen;
		var result = _con.getstr(opts);
		// Restore normal attribute after input
		_con._sendOutput('\x1b[0;37m');
		return result;
	};
	globalThis.console.clear = function(attr) {
		// Synchronet's clear resets the terminal to default (gray).
		// console.attributes remains set (e.g. 2=green) for use by
		// mnemonics and other attr-aware methods, but raw writes
		// after clear appear in the terminal's default (gray).
		var savedAttr = (attr !== undefined) ? (attr & 0xFF) : _con._currentAttr._value;
		_con.clear(); // sends ESC[0m ESC[2J ESC[H, terminal is now gray
		_con._currentAttr._value = savedAttr;
		_con._prevAttr._value = savedAttr;
		globalThis.console.line_counter = 0;
	};
	globalThis.console.cleartoeol = function() { _con.cleareol(); };
	globalThis.console.clearline = function() {
		_con.print('\r');
		_con.cleareol();
	};
	globalThis.console.gotoxy = function(x, y) {
		if (typeof x === 'object') { _con.gotoxy(x.x, x.y); }
		else { _con.gotoxy(x, y); }
	};
	globalThis.console.home = function() { _con.gotoxy(1, 1); };
	globalThis.console.pushxy = function() { _con._sendOutput('\x1b[s'); };
	globalThis.console.popxy = function() { _con._sendOutput('\x1b[u'); };
	globalThis.console.crlf = function() { _con.println(''); globalThis.console.line_counter++; };
	globalThis.console.pause = function() {
		// Standard Synchronet pause prompt with Ctrl-A color codes
		_con.aprint('\r\n\x01n\x01c[\x01hPress any key to continue\x01n\x01c]');
		_con.waitkey();
		_con.getkey();
		// Erase the prompt
		_con.print('\r');
		_con.cleareol();
		globalThis.console.line_counter = 0;
	};
	globalThis.console.beep = function() { _con.beep(); };
	globalThis.console.center = function(str) { _con.centre(str); };
	globalThis.console.up = function(n) { _con.print('\x1b[' + (n || 1) + 'A'); };
	globalThis.console.down = function(n) { _con.print('\x1b[' + (n || 1) + 'B'); };
	globalThis.console.right = function(n) { _con.print('\x1b[' + (n || 1) + 'C'); };
	globalThis.console.left = function(n) { _con.print('\x1b[' + (n || 1) + 'D'); };

	/**
	 * console.inkey(mode, timeout) — non-blocking key read.
	 * Returns empty string if no key available within timeout.
	 */
	globalThis.console.inkey = function(mode, timeout) {
		if (timeout === undefined) timeout = 0;
		if (!_con.waitkey(timeout)) return '';
		var key = _con.getkey();
		return key === undefined ? '' : key;
	};

	// console.aborted — flag set when user aborts output (Ctrl-C etc.)
	globalThis.console.aborted = false;

	// console.ctrlkey_passthru — bitmask of ctrl keys to pass through
	globalThis.console.ctrlkey_passthru = 0;

	/**
	 * console.printtail(path, lines, mode) — print last N lines of a file.
	 */
	globalThis.console.printtail = function(path, lines, mode) {
		try {
			var content = readFileSync(path, 'binary');
			var allLines = content.split('\n');
			var tail = allLines.slice(-lines);
			_con.print(tail.join('\r\n') + '\r\n');
		} catch (e) {
			// File not found — silently ignore
		}
	};

	globalThis.console.line_counter = 0;
	globalThis.console.screen_rows = _con.rows;
	globalThis.console.screen_columns = _con.cols;

	// console.attributes — get/set current CGA text attribute.
	// Reading returns the current attribute value, setting sends ANSI escape.
	Object.defineProperty(globalThis.console, 'attributes', {
		get: function() {
			return _con._currentAttr ? _con._currentAttr._value : 7;
		},
		set: function(val) {
			if (_con._currentAttr) {
				_con._currentAttr.value = val;
			}
		},
		enumerable: true, configurable: true
	});

	// console.current_column / console.current_row — cursor position
	Object.defineProperty(globalThis.console, 'current_column', {
		get: function() { return _con.x || 1; },
		enumerable: true, configurable: true
	});
	Object.defineProperty(globalThis.console, 'current_row', {
		get: function() { return _con.y || 1; },
		enumerable: true, configurable: true
	});

	/**
	 * console.ansi(attr) — convert a CGA attribute value to an ANSI escape
	 * sequence string. Used by games like dicewarz to generate color codes.
	 */
	globalThis.console.ansi = function(attr) {
		if (attr === undefined || attr === null) return '';
		var a = new Attribute(attr & 0xFF);
		return a.ansi(undefined);
	};

	/**
	 * console.printfile(path, mode) — display an ANSI/text file to the user.
	 * Strips SAUCE metadata records, converts bare LF to CRLF.
	 */
	globalThis.console.printfile = function(path, mode) {
		try {
			var buf = readFileSync(path);
			// Strip SAUCE record — starts with EOF (0x1A) followed by "SAUCE00"
			for (var i = buf.length - 1; i >= 0; i--) {
				if (buf[i] === 0x1A) {
					// Check for SAUCE signature
					if (i + 7 <= buf.length && buf.subarray(i + 1, i + 6).toString() === 'SAUCE') {
						buf = buf.subarray(0, i);
					}
					break;
				}
			}
			// Convert to string (latin1 preserves CP437 high bytes)
			var content = buf.toString('binary');
			// Convert bare \n to \r\n (don't double existing \r\n)
			content = content.replace(/\r?\n/g, '\r\n');
			// P_NOPAUSE (bit 0) — suppress auto_pause during file display
			var savedAP;
			if (mode && (mode & 1)) {
				savedAP = _con.auto_pause;
				_con.auto_pause = false;
			}
			_con.print(content);
			if (savedAP !== undefined) {
				_con.auto_pause = savedAP;
			}
		} catch (e) {
			// File not found — silently ignore
		}
	};

	/**
	 * _lightbarSelect — inline horizontal lightbar selector.
	 *
	 * Renders a row of options with the selected one highlighted.
	 * Arrow keys (left/right) cycle between options, Enter confirms,
	 * and each option can have a direct hotkey for instant selection.
	 *
	 * Falls back to simple hotkey input on non-ANSI terminals.
	 *
	 * @param {Array} options  — [{label:'Yes', hotkey:'Y'}, ...]
	 * @param {number} defaultIdx — index of the initially selected option
	 * @returns {number} selected index, or -1 on disconnect
	 */
	function _lightbarSelect(options, defaultIdx) {
		var selected = (defaultIdx >= 0 && defaultIdx < options.length)
			? defaultIdx : 0;

		// --- Non-ANSI fallback: simple hotkey prompt ---
		if (!_con.ansi) {
			var prompt = '(';
			for (var fi = 0; fi < options.length; fi++) {
				if (fi > 0) prompt += '/';
				if (fi === selected) {
					prompt += options[fi].hotkey.toUpperCase();
				} else {
					prompt += options[fi].hotkey.toLowerCase();
				}
			}
			prompt += ') ? ';
			_con.print(prompt);
			while (true) {
				_con.waitkey();
				var fch = _con.getkey();
				if (fch === undefined) continue;
				if (fch === 'CONNECTION_CLOSED') return -1;
				if (fch === '\r') {
					_con.println(options[selected].label);
					return selected;
				}
				var fupper = fch.toUpperCase();
				for (var fk = 0; fk < options.length; fk++) {
					if (options[fk].hotkey && fupper === options[fk].hotkey.toUpperCase()) {
						_con.println(options[fk].label);
						return fk;
					}
				}
			}
		}

		// --- ANSI lightbar ---

		// Calculate total rendered width.
		// Each option renders as " Label " (padded), with one space gap between.
		var totalWidth = 0;
		for (var wi = 0; wi < options.length; wi++) {
			totalWidth += options[wi].label.length + 2;
			if (wi < options.length - 1) totalWidth += 1;
		}

		function render(redraw) {
			if (redraw) {
				_con._sendOutput('\x1b[' + totalWidth + 'D');
			}
			for (var ri = 0; ri < options.length; ri++) {
				if (ri === selected) {
					// Selected: bright white on blue
					_con._sendOutput('\x1b[1;37;44m ' + options[ri].label + ' \x1b[0m');
				} else {
					// Unselected: cyan on black
					_con._sendOutput('\x1b[0;36m ' + options[ri].label + ' \x1b[0m');
				}
				if (ri < options.length - 1) {
					_con._sendOutput(' ');
				}
			}
		}

		render(false);

		while (true) {
			if (!_con.waitkey(10000)) continue;
			var ch = _con.getkey();
			if (ch === undefined) continue;
			if (ch === 'CONNECTION_CLOSED') {
				_con._sendOutput('\x1b[0;37m');
				_con.println('');
				return -1;
			}

			// Direct hotkey selection
			var upper = (ch.length === 1) ? ch.toUpperCase() : '';
			for (var hi = 0; hi < options.length; hi++) {
				if (options[hi].hotkey && upper === options[hi].hotkey.toUpperCase()) {
					if (selected !== hi) {
						selected = hi;
						render(true);
					}
					_con._sendOutput('\x1b[0;37m');
					_con.println('');
					return selected;
				}
			}

			// Arrow / tab navigation
			if (ch === 'KEY_LEFT' || ch === 'KEY_UP') {
				selected = (selected + options.length - 1) % options.length;
				render(true);
			} else if (ch === 'KEY_RIGHT' || ch === 'KEY_DOWN' || ch === '\t') {
				selected = (selected + 1) % options.length;
				render(true);
			} else if (ch === '\r') {
				_con._sendOutput('\x1b[0;37m');
				_con.println('');
				return selected;
			}
		}
	}

	/**
	 * console.yesno(prompt) — ask a yes/no question (default yes).
	 * Lightbar selector: arrow keys toggle, Y/N direct-select, Enter confirms.
	 * Synchronet convention: returns true for Yes, false for No.
	 */
	globalThis.console.yesno = function(prompt) {
		if (prompt) {
			_con._sendOutput('\x1b[1;34m[\x1b[1;36m\xfb\x1b[1;34m] \x1b[1;33m' + prompt + '\x1b[0m  ');
		}
		var result = _lightbarSelect([
			{ label: 'Yes', hotkey: 'Y' },
			{ label: 'No',  hotkey: 'N' }
		], 0);
		if (result === -1) return false;
		return result === 0;
	};

	/**
	 * console.noyes(prompt) — ask a yes/no question (default no).
	 * Lightbar selector: arrow keys toggle, Y/N direct-select, Enter confirms.
	 * Synchronet convention: returns true for No, false for Yes.
	 * (Inverted from what you'd expect — matches Synchronet API.)
	 */
	globalThis.console.noyes = function(prompt) {
		if (prompt) {
			_con._sendOutput('\x1b[1;34m[\x1b[1;36m\xfb\x1b[1;34m] \x1b[1;33m' + prompt + '\x1b[0m  ');
		}
		var result = _lightbarSelect([
			{ label: 'Yes', hotkey: 'Y' },
			{ label: 'No',  hotkey: 'N' }
		], 1);
		if (result === -1) return true;
		return result === 1;
	};

	/**
	 * console.getnum(maxnum, defaultnum) — read a number from the user.
	 * Synchronet behavior: accepts only digits, auto-submits when max
	 * digits are reached, Enter submits early. Returns number or 0.
	 */
	globalThis.console.getnum = function(maxnum, defaultnum) {
		var maxDigits = String(maxnum).length;
		var str = '';
		while (true) {
			_con.waitkey();
			var ch = _con.getkey();
			if (ch === undefined || ch === 'CONNECTION_CLOSED') return defaultnum || 0;
			if (ch === '\r' || ch === '\n') break;
			if (ch === '\x1b' || ch === 'Q' || ch === 'q') {
				// Abort
				_con.println('');
				return 0;
			}
			if (ch === '\b' || ch === '\x7f') {
				if (str.length > 0) {
					str = str.substring(0, str.length - 1);
					_con.print('\b \b');
				}
				continue;
			}
			if (ch >= '0' && ch <= '9' && str.length < maxDigits) {
				str += ch;
				_con.print(ch);
				// Auto-submit when max digits reached
				if (str.length >= maxDigits) break;
			}
		}
		_con.println('');
		// Restore normal attribute after input
		_con._sendOutput('\x1b[0;37m');
		var num = parseInt(str, 10);
		if (isNaN(num) || num < 0) return defaultnum || 0;
		if (num > maxnum) return maxnum;
		return num;
	};

	// console.strlen — visible length excluding control codes
	globalThis.console.strlen = function(str) {
		return str.replace(/\x1b\[[0-9;]*[A-Za-z]|\x01./g, '').length;
	};

	// ---- Core functions ----

	// Patch eval for SpiderMonkey compat. SpiderMonkey allows
	// eval('function() { ... }') as an expression returning the function.
	// V8 requires parentheses: eval('(function() { ... })').
	// LORD2's l2lib.js uses this pattern extensively to build closures.
	var _origEval = globalThis.eval;
	globalThis.eval = function(code) {
		if (typeof code === 'string') {
			var trimmed = code.trimStart();
			// Anonymous function expression as statement — wrap in parens
			if (trimmed.startsWith('function(') || trimmed.startsWith('function (')) {
				code = '(' + code + ')';
			}
		}
		return _origEval(code);
	};

	globalThis.random = function(n) {
		return Math.floor(Math.random() * n);
	};

	globalThis.time = function() {
		return Math.floor(Date.now() / 1000);
	};

	globalThis.system_clock = globalThis.time;

	/**
	 * strftime — C-style date formatting (Synchronet built-in).
	 * @param {string} fmt — format string with % specifiers
	 * @param {number} epoch — Unix timestamp (seconds), defaults to now
	 */
	globalThis.strftime = function(fmt, epoch) {
		var d = (epoch !== undefined) ? new Date(epoch * 1000) : new Date();
		var pad = function(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; };
		return fmt.replace(/%([%YymdHIMSpjAaBbZ])/g, function(_, c) {
			switch (c) {
				case '%': return '%';
				case 'Y': return d.getFullYear();
				case 'y': return pad(d.getFullYear() % 100);
				case 'm': return pad(d.getMonth() + 1);
				case 'd': return pad(d.getDate());
				case 'H': return pad(d.getHours());
				case 'I': var h = d.getHours() % 12; return pad(h === 0 ? 12 : h);
				case 'M': return pad(d.getMinutes());
				case 'S': return pad(d.getSeconds());
				case 'p': return d.getHours() >= 12 ? 'PM' : 'AM';
				case 'j': var start = new Date(d.getFullYear(),0,0); var diff = d - start; return pad(Math.floor(diff / 86400000), 3);
				case 'A': return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
				case 'a': return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
				case 'B': return ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getMonth()];
				case 'b': return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
				case 'Z': return Intl.DateTimeFormat('en', {timeZoneName:'short'}).formatToParts(d).find(function(p){return p.type==='timeZoneName';})?.value || '';
				default:  return '%' + c;
			}
		});
	};

	/**
	 * format() — Synchronet's sprintf equivalent.
	 * Supports %d, %s, %f with width, precision, zero-padding, and left-align.
	 */
	globalThis.format = function(fmt) {
		var args = Array.prototype.slice.call(arguments, 1);
		var ai = 0;
		return fmt.replace(/%([-]?)(\d+)?(?:\.(\d+))?([diouxXeEfgGsc%])/g, function(match, flags, width, prec, type) {
			if (type === '%') return '%';
			var val = args[ai++];
			var str;
			switch (type) {
				case 'd': case 'i': str = String(parseInt(val, 10) || 0); break;
				case 'o': str = (parseInt(val, 10) || 0).toString(8); break;
				case 'u': str = String((parseInt(val, 10) || 0) >>> 0); break;
				case 'x': str = (parseInt(val, 10) || 0).toString(16); break;
				case 'X': str = (parseInt(val, 10) || 0).toString(16).toUpperCase(); break;
				case 'f': case 'e': case 'E': case 'g': case 'G':
					str = prec !== undefined ? Number(val).toFixed(parseInt(prec, 10)) : String(Number(val));
					break;
				case 's': str = String(val != null ? val : ''); break;
				case 'c': str = String.fromCharCode(parseInt(val, 10) || 0); break;
				default: str = String(val);
			}
			if (prec !== undefined && type === 's') {
				str = str.substring(0, parseInt(prec, 10));
			}
			var w = parseInt(width, 10) || 0;
			if (str.length < w) {
				var padChar = (flags !== '-' && width && width[0] === '0') ? '0' : ' ';
				if (flags === '-') {
					while (str.length < w) str = str + ' ';
				} else {
					while (str.length < w) str = padChar + str;
				}
			}
			return str;
		});
	};

	/**
	 * printf() — Synchronet's formatted print.
	 * Processes Ctrl-A color codes in the result (like console.putmsg).
	 */
	globalThis.printf = function(fmt) {
		var result = globalThis.format.apply(null, arguments);
		_con.aprint(result);
	};

	globalThis.ascii = function(ch) {
		if (typeof ch === 'string') return ch.charCodeAt(0);
		if (typeof ch === 'number') return String.fromCharCode(ch);
		return 0;
	};

	/**
	 * Blocking sleep using a SharedArrayBuffer + Atomics.wait.
	 * This is safe inside a worker thread.
	 */
	var _sleepSAB = new SharedArrayBuffer(4);
	var _sleepView = new Int32Array(_sleepSAB);
	globalThis.mswait = function(ms) {
		if (ms <= 0) return;
		Atomics.wait(_sleepView, 0, 0, ms);
	};

	globalThis.sleep = function(secs) {
		globalThis.mswait(secs * 1000);
	};

	/**
	 * wait() — Synchronet's wait-for-keypress function.
	 * Used by IGMs and other scripts for "press any key" prompts.
	 */
	globalThis.wait = function() {
		dk.console.getkey();
	};

	/**
	 * say_slow() — Synchronet's character-at-a-time output with delay.
	 */
	globalThis.say_slow = function(str) {
		for (var i = 0; i < str.length; i++) {
			dk.console.print(str[i]);
			globalThis.mswait(30);
		}
	};

	/**
	 * word_wrap(str, width, orig_indent) — Synchronet text wrapping utility.
	 * Wraps text at word boundaries to fit within the specified width.
	 * Returns the wrapped string with \n as line separators.
	 */
	globalThis.word_wrap = function(str, width, orig_indent) {
		if (!str) return '';
		if (!width) width = 79;
		var lines = str.split('\n');
		var result = [];
		for (var li = 0; li < lines.length; li++) {
			var line = lines[li];
			if (line.length <= width) {
				result.push(line);
				continue;
			}
			while (line.length > width) {
				var breakAt = line.lastIndexOf(' ', width);
				if (breakAt <= 0) breakAt = width;
				result.push(line.substring(0, breakAt));
				line = line.substring(breakAt + (line[breakAt] === ' ' ? 1 : 0));
			}
			if (line.length > 0) result.push(line);
		}
		// Synchronet's word_wrap appends a trailing newline
		return result.join('\n') + '\n';
	};

	/**
	 * exit() — terminates the door script.
	 *
	 * We can't use throw because game code (e.g. LORD2's REF interpreter)
	 * has catch blocks that swallow all errors and continue. Instead,
	 * we send the exit message to the parent thread and then block this
	 * thread forever using Atomics.wait. The parent will call
	 * worker.terminate() to clean up.
	 */
	globalThis.exit = function(code) {
		// Run on_exit handlers first
		if (globalThis._exitHandlers) {
			for (var h of globalThis._exitHandlers) {
				try { eval(h); } catch (_) {}
			}
		}
		// Signal exit to parent thread
		if (parentPort) {
			parentPort.postMessage({ type: 'exit', code: code || 0 });
		}
		// Block this thread forever — parent will terminate us.
		// Using a dedicated SharedArrayBuffer so we don't interfere
		// with the comm channel's Atomics.
		var blocker = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(blocker, 0, 0);
		// Should never reach here, but just in case:
		throw new Error('DOOR_EXIT');
	};

	// ---- File system helpers ----

	globalThis.file_exists = function(path) {
		try { return existsSync(path); } catch (_) { return false; }
	};

	globalThis.file_isdir = function(path) {
		try {
			var st = statSync(path);
			return st.isDirectory();
		} catch (_) { return false; }
	};

	globalThis.file_date = function(path) {
		try {
			var st = statSync(path);
			return Math.floor(st.mtimeMs / 1000);
		} catch (_) { return 0; }
	};

	globalThis.file_size = function(path) {
		try {
			var st = statSync(path);
			return st.size;
		} catch (_) { return -1; }
	};

	globalThis.file_remove = function(path) {
		try { unlinkSync(path); return true; } catch (_) { return false; }
	};

	globalThis.file_rename = function(oldPath, newPath) {
		try { renameSync(oldPath, newPath); return true; } catch (_) { return false; }
	};

	globalThis.file_copy = function(src, dest) {
		try {
			copyFileSync(src, dest);
			return true;
		} catch (_) { return false; }
	};

	globalThis.mkdir = function(path) {
		try { mkdirSync(path, { recursive: true }); return true; } catch (_) { return false; }
	};

	globalThis.backslash = function(path) {
		if (path.endsWith('/') || path.endsWith('\\')) return path;
		return path + '/';
	};

	globalThis.file_getname = function(path) {
		return nodePath.basename(path);
	};

	/**
	 * file_cfgname(dir, filename) — Synchronet config file path resolver.
	 * Returns dir + filename if it exists, otherwise ctrl_dir + filename.
	 */
	globalThis.file_cfgname = function(dir, filename) {
		var fullPath = nodePath.join(dir, filename);
		if (existsSync(fullPath)) return fullPath;
		return nodePath.join(globalThis.system.ctrl_dir, filename);
	};

	/**
	 * file_getcase(path) — case-insensitive file lookup.
	 * On Linux, filenames are case-sensitive but game files may have
	 * inconsistent casing. Returns the actual path if found, undefined if not.
	 */
	globalThis.file_getcase = function(path) {
		// Fast path — exact match
		if (existsSync(path)) return path;
		// Scan directory for case-insensitive match
		try {
			var dir = nodePath.dirname(path);
			var base = nodePath.basename(path).toLowerCase();
			var entries = readdirSync(dir);
			for (var i = 0; i < entries.length; i++) {
				if (entries[i].toLowerCase() === base) {
					return nodePath.join(dir, entries[i]);
				}
			}
		} catch (_) {}
		return undefined;
	};

	globalThis.directory = function(pattern) {
		// Simple glob implementation for Synchronet compatibility
		// In practice, doors mainly use this for listing files in a directory
		try {
			var dir = nodePath.dirname(pattern);
			var base = nodePath.basename(pattern);
			if (!existsSync(dir)) return [];

			var files = readdirSync(dir);
			if (base === '*' || base === '*.*') {
				return files.map(function(f) { return dir + '/' + f; });
			}

			// Simple wildcard matching
			var re = new RegExp('^' + base.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
			return files.filter(function(f) { return re.test(f); })
			            .map(function(f) { return dir + '/' + f; });
		} catch (_) {
			return [];
		}
	};
	// Synchronet directory flags (used as properties on the function)
	directory.MARK = (1 << 1);
	directory.NOSORT = (1 << 2);
	directory.APPEND = (1 << 5);
	directory.NOESCAPE = (1 << 6);
	directory.PERIOD = (1 << 7);
	directory.ONLYDIR = (1 << 13);

	// ---- Mutex stubs ----
	// Synchronet uses file-based mutexes. For our SQLite-backed approach
	// we handle locking at the DB level, so these are no-ops.
	// Note: lord.js defines its own fmutex/rfmutex wrappers that call
	// file_mutex() internally, so we must provide that too.
	globalThis.file_mutex = function() { return true; };
	globalThis.fmutex = function() { return true; };
	globalThis.rfmutex = function() { return true; };

	// ---- Log object ----
	globalThis.log = function(level, msg) {
		if (msg === undefined) { msg = level; level = 6; }
		console.log('[Door][' + level + '] ' + msg);
	};
	globalThis.log.EMERG = 0;
	globalThis.log.ALERT = 1;
	globalThis.log.CRIT = 2;
	globalThis.log.CRITICAL = 2;
	globalThis.log.ERR = 3;
	globalThis.log.ERROR = 3;
	globalThis.log.WARNING = 4;
	globalThis.log.WARN = 4;
	globalThis.log.NOTICE = 5;
	globalThis.log.INFO = 6;
	globalThis.log.DEBUG = 7;

	// Standalone LOG_* constants (Synchronet also exposes these as globals)
	globalThis.LOG_EMERG    = 0;
	globalThis.LOG_ALERT    = 1;
	globalThis.LOG_CRIT     = 2;
	globalThis.LOG_CRITICAL = 2;
	globalThis.LOG_ERR      = 3;
	globalThis.LOG_ERROR    = 3;
	globalThis.LOG_WARNING  = 4;
	globalThis.LOG_WARN     = 4;
	globalThis.LOG_NOTICE   = 5;
	globalThis.LOG_INFO     = 6;
	globalThis.LOG_DEBUG    = 7;

	// ---- stdout / stdin stubs ----
	globalThis.stdout = {
		writeln: function(str) { console.log(str); },
		write: function(str) { process.stdout.write(str); }
	};

	// ---- Queue (for dorkit input — we bypass this with our comm layer) ----
	globalThis.Queue = function(name) {
		this.name = name;
		this._items = [];
		this.write = function(data) { this._items.push(data); };
		this.read = function() { return this._items.shift(); };
		this.poll = function(timeout) { return this._items.length > 0; };
	};

	// ---- Synchronet TUI Libraries (Frame, Layout, InputLine) ----
	// Define these early so they're available regardless of load chain.
	// Synchronet's frame.js, layout.js, and inputline.js are system libraries
	// that doors expect to be loadable. Some doors load them directly, others
	// rely on layout.js loading frame.js internally. Defining them here
	// ensures they survive any broken load chains.

	globalThis.Frame = function(x, y, width, height, attr, parent) {
		this.x = x || 1;
		this.y = y || 1;
		this.width = width || _con.cols;
		this.height = height || _con.rows;
		this.attr = attr || 7;
		this.parent = parent || null;
		this.is_open = false;
		this.scrolling = false;
		this.word_wrap = false;
		this.transparent = false;
		this.lf_strict = false;
		this.v_scroll = false;
		this.h_scroll = false;
		this.checkbounds = true;
		this.id = 0;
		this.data_width = this.width;
		this.data_height = this.height;
		this._cx = 0;
		this._cy = 0;
		this._children = [];
		if (parent && parent._children) parent._children.push(this);
	};
	globalThis.Frame.prototype.open = function() { this.is_open = true; };
	globalThis.Frame.prototype.close = function() { this.is_open = false; };
	globalThis.Frame.prototype.delete = function() {
		this.is_open = false;
		if (this.parent && this.parent._children) {
			var idx = this.parent._children.indexOf(this);
			if (idx >= 0) this.parent._children.splice(idx, 1);
		}
	};
	globalThis.Frame.prototype.move = function(x, y) { this.x = x; this.y = y; };
	globalThis.Frame.prototype.moveTo = function(x, y) { this.x = x; this.y = y; };
	globalThis.Frame.prototype.gotoxy = function(x, y) { this._cx = x - 1; this._cy = y - 1; };
	globalThis.Frame.prototype.home = function() { this._cx = 0; this._cy = 0; };
	globalThis.Frame.prototype.end = function() { this._cy = this.height - 1; };
	globalThis.Frame.prototype.clear = function(attr) {
		this._cx = 0; this._cy = 0;
		var blank = ' '.repeat(this.width);
		for (var row = 0; row < this.height; row++) {
			_con.gotoxy(this.x, this.y + row);
			_con.print(blank);
		}
	};
	globalThis.Frame.prototype.clearline = function(attr) {
		_con.gotoxy(this.x + this._cx, this.y + this._cy);
		_con.print(' '.repeat(this.width - this._cx));
		_con.gotoxy(this.x + this._cx, this.y + this._cy);
	};
	globalThis.Frame.prototype.putmsg = function(str, attr) {
		if (!str) return;
		var s = String(str);
		// Apply frame's attribute (or explicit attr) as default color.
		var useAttr = (attr !== undefined) ? attr : this.attr;
		if (useAttr !== undefined && _con._currentAttr) {
			_con._currentAttr.value = useAttr;
		}
		_con.gotoxy(this.x + this._cx, this.y + this._cy);
		// Frame.putmsg only processes Ctrl-A codes (not pipe or @-codes)
		_con.aprint(s);
		// Track cursor position through visible output
		var visible = s.replace(/\x01./g, '').replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
		for (var i = 0; i < visible.length; i++) {
			if (visible[i] === '\r') { this._cx = 0; continue; }
			if (visible[i] === '\n') { this._cy++; this._cx = 0; continue; }
			this._cx++;
			if (this._cx >= this.width) { this._cx = 0; this._cy++; }
		}
	};
	globalThis.Frame.prototype.center = function(str) {
		var visible = String(str).replace(/\x01./g, '');
		this._cx = Math.max(0, Math.floor((this.width - visible.length) / 2));
		this.putmsg(str);
	};
	globalThis.Frame.prototype.draw = function() {};
	globalThis.Frame.prototype.cycle = function() { return false; };
	globalThis.Frame.prototype.load = function(filename) {
		try {
			var buf = readFileSync(filename);
			for (var i = buf.length - 1; i >= 0; i--) {
				if (buf[i] === 0x1A && i + 6 <= buf.length &&
					buf.subarray(i + 1, i + 6).toString() === 'SAUCE') {
					buf = buf.subarray(0, i); break;
				}
			}
			_con.gotoxy(this.x, this.y);
			_con.print(buf.toString('binary').replace(/\r?\n/g, '\r\n'));
		} catch (e) {}
	};
	globalThis.Frame.prototype.scroll = function(dir, count) {};
	globalThis.Frame.prototype.screenShot = function(file, append) {};
	globalThis.Frame.prototype.getData = function(x, y) { return { ch: ' ', attr: this.attr }; };
	globalThis.Frame.prototype.setData = function(x, y, ch, attr) {};
	globalThis.Frame.prototype.bottom = function() { this._cy = this.height - 1; };
	globalThis.Frame.prototype.top = function() { this._cy = 0; };
	globalThis.Frame.prototype.invalidate = function() {};
	Object.defineProperties(globalThis.Frame.prototype, {
		columns: { get: function() { return this.width; } },
		rows: { get: function() { return this.height; } },
		cursor_x: {
			get: function() { return this._cx; },
			set: function(v) { this._cx = v; }
		},
		cursor_y: {
			get: function() { return this._cy; },
			set: function(v) { this._cy = v; }
		}
	});

	globalThis.Layout = function(frame) {
		this.frame = frame || null;
		this._tabs = {};
	};
	globalThis.Layout.prototype.addTab = function(name, frame) {
		this._tabs[name] = frame;
	};
	globalThis.Layout.prototype.open = function() {};
	globalThis.Layout.prototype.close = function() {};
	globalThis.Layout.prototype.cycle = function() { return false; };
	globalThis.Layout.prototype.draw = function() {};

	globalThis.InputLine = function(x, y, width, height, attr, frame) {
		this.x = x || (frame ? frame.x : 1);
		this.y = y || (frame ? frame.y : 1);
		this.width = width || 40;
		this.height = height || 1;
		this.attr = attr || 7;
		this.frame = frame || null;
		this.value = '';
		this.max = this.width;
	};
	globalThis.InputLine.prototype.getkey = function(key) {
		if (key === '\r' || key === '\n') return true;
		if (key === '\b' || key === '\x7f') {
			if (this.value.length > 0) {
				this.value = this.value.substring(0, this.value.length - 1);
				_con.print('\b \b');
			}
			return false;
		}
		if (typeof key === 'string' && key.length === 1 && key.charCodeAt(0) >= 32) {
			if (this.value.length < this.max) {
				this.value += key;
				_con.print(key);
			}
		}
		return false;
	};
	globalThis.InputLine.prototype.clear = function() { this.value = ''; };

	// ---- Synchronet require/load ----

	// Track what's been loaded (Synchronet's require checks a global)
	var _loadedModules = {};

	/**
	 * Resolve a script name to an absolute path.
	 * Searches load_path_list just like Synchronet.
	 */
	function _resolveScript(name) {
		// Absolute path
		if (name.startsWith('/')) {
			if (existsSync(name)) return name;
			return null;
		}
		// Check exec_dir first (important for IGMs that load relative scripts)
		if (js.exec_dir) {
			var execCandidate = nodePath.join(js.exec_dir, name);
			if (existsSync(execCandidate)) return execCandidate;
		}
		// Search load path list
		for (var dir of js.load_path_list) {
			var full = dir + (dir.endsWith('/') ? '' : '/') + name;
			if (existsSync(full)) return full;
		}
		return null;
	}

	/**
	 * Synchronet-style require(filename, exportName).
	 * Loads a script and makes its exports available globally.
	 *
	 * For our shim, known scripts like recordfile.js and recorddefs.js
	 * are intercepted and replaced with our SQLite versions.
	 */
	globalThis.require = function(fileOrScope, exportName) {
		// Handle the two-arg form: require("filename.js", "ExportName")
		// and the scope form: require(scope, "filename.js", "ExportName")
		var filename, scope;
		if (typeof fileOrScope === 'object' && typeof exportName === 'string') {
			scope = fileOrScope;
			filename = exportName;
			exportName = arguments[2];
		} else {
			filename = fileOrScope;
		}

		// Already loaded?
		if (exportName && globalThis[exportName] !== undefined) return;
		if (_loadedModules[filename]) return;

		// Intercept known shim targets
		if (filename === 'recordfile.js') {
			// Install our SQLite-backed RecordFile as the global
			_loadedModules[filename] = true;
			globalThis.RecordFile = RecordFile;
			globalThis.RecordFileRecord = RecordFileRecord;
			globalThis.GetRecordLength = GetRecordLength;
			globalThis.getRecordLength = getRecordLength;
			return;
		}
		if (filename === 'recorddefs.js') {
			// recorddefs.js uses top-level var declarations that must
			// land on globalThis — use vm.runInThisContext for global scope
			_loadedModules[filename] = true;
			var scriptPath = _resolveScript(filename);
			if (scriptPath) {
				var src = _transpileSpiderMonkey(readFileSync(scriptPath, 'utf-8'));
				new Script(src, { filename: scriptPath }).runInThisContext();
			}
			return;
		}
		// Synchronet standard library polyfills — already native in modern Node
		if (filename === 'array.js' || filename === 'string.js' || filename === 'math.js') {
			_loadedModules[filename] = true;
			return;
		}
		// dorkit.js — our shim is already installed as globalThis.dk
		if (filename === 'dorkit.js') {
			_loadedModules[filename] = true;
			return;
		}
		// cnflib.js — Synchronet config file reader. Stub with safe defaults.
		if (filename === 'cnflib.js') {
			_loadedModules[filename] = true;
			var target = (typeof fileOrScope === 'object') ? fileOrScope : globalThis;
			target.CNF = {
				read: function() { return {}; }
			};
			return;
		}

		_loadedModules[filename] = true;
		_loadScript(filename, scope);
	};

	/**
	 * Synchronet-style load(filename, ...args).
	 * Loads and executes a script in the current context.
	 */
	globalThis.load = function(filenameOrScope) {
		var filename, scope, args;
		if (typeof filenameOrScope === 'object' && filenameOrScope !== null) {
			// load(scope, filename, ...args) form
			scope = filenameOrScope;
			filename = arguments[1];
			args = Array.prototype.slice.call(arguments, 2);
		} else {
			// load(filename, ...args) form
			filename = filenameOrScope;
			scope = null;
			args = Array.prototype.slice.call(arguments, 1);
		}
		_loadScript(filename, scope, args);
	};

	/**
	 * Internal script loader.
	 * Uses indirect eval so that top-level var declarations in
	 * loaded scripts land on globalThis (matching Synchronet behavior).
	 */
	function _loadScript(filename, scope, args) {
		// Skip known shimmed/polyfilled modules (already handled or native)
		var _shimmedModules = {
			'dorkit.js': true, 'recordfile.js': true,
			'array.js': true, 'string.js': true, 'math.js': true,
			'frame.js': true, 'inputline.js': true, 'layout.js': true
		};
		if (_shimmedModules[filename]) return;

		// graphic.js — Synchronet Graphic class for loading/displaying .bin files.
		// .bin format: raw byte pairs (char, attr) in 80-column rows.
		if (filename === 'graphic.js') {
			globalThis.Graphic = function(width, height) {
				this.width = width || 80;
				this.height = height || 24;
				this.data = [];
				// Initialize grid with spaces + LIGHTGRAY
				for (var y = 0; y < this.height; y++) {
					var row = [];
					for (var x = 0; x < this.width; x++) {
						row.push({ ch: ' ', attr: 7 });
					}
					this.data.push(row);
				}
			};
			globalThis.Graphic.prototype.load = function(filename) {
				try {
					var buf = readFileSync(filename);
					var pos = 0;
					for (var y = 0; y < this.height && pos < buf.length; y++) {
						for (var x = 0; x < this.width && pos + 1 < buf.length; x++) {
							this.data[y][x] = {
								ch: String.fromCharCode(buf[pos]),
								attr: buf[pos + 1]
							};
							pos += 2;
						}
					}
				} catch (e) {
					// File not found
				}
			};
			globalThis.Graphic.prototype.draw = function(xoff, yoff) {
				var x0 = xoff || 0;
				var y0 = yoff || 0;
				var out = '';
				var prevAttr = -1;
				for (var y = 0; y < this.height; y++) {
					out += '\x1b[' + (y + 1 + y0) + ';' + (1 + x0) + 'H';
					for (var x = 0; x < this.width; x++) {
						var cell = this.data[y][x];
						if (cell.attr !== prevAttr) {
							var a = new Attribute(cell.attr);
							out += a.ansi(undefined);
							prevAttr = cell.attr;
						}
						out += cell.ch;
					}
				}
				out += '\x1b[0m';
				_con.print(out);
			};
			return;
		}

		// json-client.js — Synchronet JSON-DB client.
		// Provides a local file-backed JSONClient so doors that use
		// InterBBS JSON scoring (DrugLord, etc.) can store and retrieve
		// scores without a real JSON-DB server connection.
		if (filename === 'json-client.js') {
			var _jsonDbPath = nodePath.join(dbDir || doorDir, 'json-db.json');

			// Read the entire on-disk store (or return empty object)
			function _jsonDbLoad() {
				try {
					return JSON.parse(readFileSync(_jsonDbPath, 'utf-8'));
				} catch (_) { return {}; }
			}

			// Write the entire store to disk
			function _jsonDbSave(store) {
				try {
					var dir = nodePath.dirname(_jsonDbPath);
					if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
					writeFileSync(_jsonDbPath, JSON.stringify(store, null, 2), 'utf-8');
				} catch (e) {
					console.error('[JSONClient] Write error: ' + e.message);
				}
			}

			// Navigate a dot-delimited key path into an object.
			// Returns the value at the path, or undefined if not found.
			function _jsonDbGet(obj, dotKey) {
				if (!dotKey || dotKey === '') return obj;
				var parts = dotKey.split('.');
				var cur = obj;
				for (var i = 0; i < parts.length; i++) {
					if (parts[i] === '') continue; // skip leading/trailing dots
					if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
					cur = cur[parts[i]];
				}
				return cur;
			}

			// Set a value at a dot-delimited key path, creating intermediaries.
			function _jsonDbSet(obj, dotKey, value) {
				var parts = dotKey.split('.').filter(function(p) { return p !== ''; });
				if (parts.length === 0) return;
				var cur = obj;
				for (var i = 0; i < parts.length - 1; i++) {
					if (cur[parts[i]] === undefined || cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') {
						cur[parts[i]] = {};
					}
					cur = cur[parts[i]];
				}
				cur[parts[parts.length - 1]] = value;
			}

			globalThis.JSONClient = function(server, port) {
				// Constructor — in the real client this opens a TCP socket.
				// Our shim just notes the server for logging.
				this._server = server;
				this._port = port;
			};

			globalThis.JSONClient.prototype.read = function(db, key, lock) {
				var store = _jsonDbLoad();
				var dbObj = store[db];
				if (dbObj === undefined) return undefined;
				return _jsonDbGet(dbObj, key);
			};

			globalThis.JSONClient.prototype.write = function(db, key, value, lock) {
				var store = _jsonDbLoad();
				if (store[db] === undefined) store[db] = {};
				_jsonDbSet(store[db], key, value);
				_jsonDbSave(store);
			};

			// Additional methods that some doors may call
			globalThis.JSONClient.prototype.close = function() {};
			globalThis.JSONClient.prototype.push = function(db, key, value, lock) {
				// push appends to an array at the given key
				var store = _jsonDbLoad();
				if (store[db] === undefined) store[db] = {};
				var arr = _jsonDbGet(store[db], key);
				if (!Array.isArray(arr)) arr = [];
				arr.push(value);
				_jsonDbSet(store[db], key, arr);
				_jsonDbSave(store);
			};
			globalThis.JSONClient.prototype.pop = function(db, key, lock) {
				var store = _jsonDbLoad();
				if (store[db] === undefined) return undefined;
				var arr = _jsonDbGet(store[db], key);
				if (!Array.isArray(arr) || arr.length === 0) return undefined;
				var val = arr.pop();
				_jsonDbSet(store[db], key, arr);
				_jsonDbSave(store);
				return val;
			};
			globalThis.JSONClient.prototype.keys = function(db, key, lock) {
				var store = _jsonDbLoad();
				if (store[db] === undefined) return [];
				var obj = _jsonDbGet(store[db], key);
				if (obj === undefined || obj === null || typeof obj !== 'object') return [];
				return Object.keys(obj);
			};
			globalThis.JSONClient.prototype.subscribe = function() {};
			globalThis.JSONClient.prototype.unsubscribe = function() {};
			globalThis.JSONClient.prototype.callback = function() {};
			globalThis.JSONClient.prototype.cycle = function() {};
			return;
		}

		// frame.js, inputline.js, layout.js — Already defined early in
		// installSyncnetGlobals (Frame, InputLine, Layout constructors).
		// Just return to prevent file-not-found errors.
		if (filename === 'frame.js') return;
		if (filename === 'inputline.js') return;
		if (filename === 'layout.js') return;

		// json-chat.js — Synchronet JSON-based chat system.
		// Dicewarz2 loads it but can function without it.
		if (filename === 'json-chat.js') {
			globalThis.JSONChat = function(client) {
				this.client = client;
				this.channels = [];
			};
			globalThis.JSONChat.prototype.submit = function(channel, msg) {};
			globalThis.JSONChat.prototype.receive = function(channel) { return []; };
			globalThis.JSONChat.prototype.join = function(channel) {};
			globalThis.JSONChat.prototype.part = function(channel) {};
			globalThis.JSONChat.prototype.cycle = function() {};
			globalThis.JSONChat.prototype.close = function() {};
			return;
		}

		// funclib.js — Synchronet common function library.
		// Provides utility functions. Define the commonly used ones.
		if (filename === 'funclib.js') {
			globalThis.getColor = function(str) {
				// Parse Synchronet color string like "WHI ON BLU" → ANSI attr
				return 7; // Default to lightgray
			};
			globalThis.printPadded = function(str, len, ch, right) {
				var s = String(str || '');
				ch = ch || ' ';
				while (s.length < len) {
					if (right) s = ch + s;
					else s = s + ch;
				}
				return s.substring(0, len);
			};
			globalThis.centerString = function(str, width) {
				var s = String(str || '');
				width = width || _con.cols;
				var pad = Math.max(0, Math.floor((width - s.length) / 2));
				return ' '.repeat(pad) + s;
			};
			globalThis.stripCtrl = function(str) {
				return String(str || '').replace(/[\x00-\x1f]/g, '');
			};
			globalThis.getKeyStr = function(str) {
				return (str && str.length > 0) ? str.charAt(0).toUpperCase() : '';
			};
			return;
		}

		// sbbsdefs.js — Synchronet system-wide constants.
		// Provide the commonly used ones directly.
		if (filename === 'sbbsdefs.js') {
			// Print mode flags
			globalThis.P_NONE       = 0;
			globalThis.P_NOPAUSE    = (1<<0);   // Don't pause for more prompt
			globalThis.P_SAVEATR    = (1<<1);   // Save/restore attributes
			globalThis.P_NOATCODES  = (1<<2);   // Don't expand @-codes
			globalThis.P_NOCRLF     = (1<<3);   // Don't append CRLF
			globalThis.P_WORDWRAP   = (1<<4);   // Word-wrap
			globalThis.P_TRUNCATE   = (1<<5);   // Truncate to terminal width
			globalThis.P_NOERROR    = (1<<6);   // Silently ignore errors
			globalThis.P_PETSCII    = (1<<7);   // PETSCII translation
			globalThis.P_CPM_EOF    = (1<<8);   // CP/M EOF (^Z) terminates

			// Getkey mode flags
			globalThis.K_NONE       = 0;
			globalThis.K_UPPER      = (1<<0);   // Convert to uppercase
			globalThis.K_UPRLWR     = (1<<1);   // Upper/lowercase
			globalThis.K_NUMBER     = (1<<2);   // Allow numbers only
			globalThis.K_WRAP       = (1<<3);   // Word wrap input
			globalThis.K_MSG        = (1<<4);   // Allow ^A color codes
			globalThis.K_SPIN       = (1<<5);   // Spin cursor
			globalThis.K_LINE       = (1<<6);   // Input line
			globalThis.K_EDIT       = (1<<7);   // Edit existing str
			globalThis.K_NOCRLF     = (1<<8);   // Don't print CRLF after
			globalThis.K_ALPHA      = (1<<9);   // Allow alpha only
			globalThis.K_NOECHO     = (1<<10);  // Don't echo input

			// Log levels
			globalThis.LOG_EMERG    = 0;
			globalThis.LOG_ALERT    = 1;
			globalThis.LOG_CRIT     = 2;
			globalThis.LOG_ERR      = 3;
			globalThis.LOG_ERROR    = 3;
			globalThis.LOG_WARNING  = 4;
			globalThis.LOG_NOTICE   = 5;
			globalThis.LOG_INFO     = 6;
			globalThis.LOG_DEBUG    = 7;

			// Connection types
			globalThis.NODE_WFC     = 0;
			globalThis.NODE_LOGON   = 1;
			globalThis.NODE_NEWUSER = 2;
			globalThis.NODE_INUSE   = 3;
			globalThis.NODE_QUIET   = 4;

			// User settings bits
			globalThis.ANSI         = (1<<0);
			globalThis.COLOR        = (1<<10);
			globalThis.USER_PAUSE   = (1<<3);

			// CGA foreground color attributes (0-15)
			globalThis.BLACK        = 0;
			globalThis.BLUE         = 1;
			globalThis.GREEN        = 2;
			globalThis.CYAN         = 3;
			globalThis.RED          = 4;
			globalThis.MAGENTA      = 5;
			globalThis.BROWN        = 6;
			globalThis.LIGHTGRAY    = 7;
			globalThis.DARKGRAY     = 8;
			globalThis.LIGHTBLUE    = 9;
			globalThis.LIGHTGREEN   = 10;
			globalThis.LIGHTCYAN    = 11;
			globalThis.LIGHTRED     = 12;
			globalThis.LIGHTMAGENTA = 13;
			globalThis.YELLOW       = 14;
			globalThis.WHITE        = 15;

			// CGA background color attributes (bits 4-6)
			globalThis.BG_BLACK     = 0;
			globalThis.BG_BLUE      = (1<<4);   // 16
			globalThis.BG_GREEN     = (2<<4);   // 32
			globalThis.BG_CYAN      = (3<<4);   // 48
			globalThis.BG_RED       = (4<<4);   // 64
			globalThis.BG_MAGENTA   = (5<<4);   // 80
			globalThis.BG_BROWN     = (6<<4);   // 96
			globalThis.BG_LIGHTGRAY = (7<<4);   // 112

			// High intensity / blink
			globalThis.HIGH         = (1<<3);   // 8 — bold/bright
			globalThis.BLINK        = (1<<7);   // 128

			// ANSI reset
			globalThis.ANSI_NORMAL  = 7;        // LIGHTGRAY on BLACK

			// Keyboard constants
			globalThis.KEY_UP       = 'KEY_UP';
			globalThis.KEY_DOWN     = 'KEY_DOWN';
			globalThis.KEY_LEFT     = 'KEY_LEFT';
			globalThis.KEY_RIGHT    = 'KEY_RIGHT';
			globalThis.KEY_HOME     = 'KEY_HOME';
			globalThis.KEY_END      = 'KEY_END';
			globalThis.KEY_DEL      = 'KEY_DEL';
			globalThis.KEY_INS      = 'KEY_INS';
			globalThis.KEY_PAGEUP   = 'KEY_PGUP';
			globalThis.KEY_PAGEDN   = 'KEY_PGDOWN';

			// Additional getkey flags
			globalThis.K_NOSPIN     = 0;        // No-op (spin disabled by default)

			// System settings
			globalThis.SS_MOFF      = (1<<1);   // Disable message offline notification
			globalThis.SS_PAUSEOFF  = (1<<2);   // Pause off (disable pause)
			globalThis.SS_PAUSEON   = (1<<3);   // Pause on (force pause)
			globalThis.SS_USERON    = (1<<13);  // User is online
			globalThis.SS_TMOUT     = (1<<14);  // Time-out warning has been given
			globalThis.SS_ABORT     = (1<<15);  // Ctrl-C abort
			globalThis.SS_SYSPAGE   = (1<<16);  // Sysop page active
			globalThis.SS_EVENT     = (1<<17);  // Timed event active
			globalThis.SS_SPLITP    = (1<<18);  // Split-screen private chat
			globalThis.SS_NEWDAY    = (1<<19);  // New day since logon

			// Misc
			globalThis.LEN_ALIAS    = 25;
			globalThis.SYS_CLOSED   = (1<<0);

			return;
		}

		var scriptPath = _resolveScript(filename);
		if (!scriptPath) {
			console.log('[Shim] Script not found: ' + filename);
			return;
		}

		try {
			var src = _transpileSpiderMonkey(readFileSync(scriptPath, 'utf-8'));
			if (scope) {
				// Synchronet's load(scope, file) makes ALL unqualified
				// assignments land on the scope object — even new properties.
				// We emulate this with a Proxy that claims to own every
				// property (so `with` intercepts all reads/writes), directs
				// writes to the scope, and falls through to globalThis for
				// reads of globals (like random, Array, console, etc.)
				var proxy = new Proxy(scope, {
					has: function() { return true; },
					get: function(target, key) {
						if (key in target) return target[key];
						if (key in globalThis) return globalThis[key];
						return undefined;
					},
					set: function(target, key, value) {
						target[key] = value;
						return true;
					}
				});
				var fn = new Function('with(this) {\n' + src + '\n}');
				fn.call(proxy);
			} else {
				// No scope — run in global scope so var/function declarations
				// become properties of globalThis (matching Synchronet load())
				new Script(src, { filename: scriptPath }).runInThisContext();
			}
		} catch (err) {
			if (err.message === 'DOOR_EXIT') throw err;
			console.error('[Shim] Error loading ' + filename + ': ' + (err.stack || err.message));
		}
	}

	// ---- Synchronet File object ----
	globalThis.File = SyncnetFile;

	// ---- ConnectedSocket stub ----
	// LORD uses this for remote game servers — we can stub it for now
	globalThis.ConnectedSocket = function(host, port) {
		this.ssl_session = false;
		this.nonblocking = false;
		this.writeln = function() {};
		this.readln = function() { return 'OK'; };
		this.close = function() {};
	};

	// ---- conio stub ----
	// LORD2 uses conio.loadfont() for local SyncTERM font loading
	globalThis.conio = {
		loadfont: function() {},
		setfont: function() {},
		gettext: function() { return ''; },
		puttext: function() {}
	};

	// ---- Screen stub ----
	// dorkit uses this for local screen tracking — not needed in our shim
	globalThis.Screen = function(cols, rows, attr, ch) {
		this.cols = cols || 80;
		this.rows = rows || 24;
		this.pos = { x: 1, y: 1 };
		this.new_lines = 0;
		this.printed = false;
		this.touched = [];
		this.attr = new Attribute(attr || 7);
		this.print = function() {};
		this.graphic = { get: function() { return undefined; } };
	};

	// ---- String.prototype.repeat polyfill (if needed) ----
	// Already standard in modern Node, but included for safety
	if (!String.prototype.repeat) {
		String.prototype.repeat = function(count) {
			var str = '' + this;
			var result = '';
			for (var i = 0; i < count; i++) result += str;
			return result;
		};
	}

	// ---- toSource() polyfill ----
	// SpiderMonkey (Synchronet's JS engine) has toSource() on all objects.
	// V8/Node does not. LORD uses it for error logging in handle_igm.
	// MUST be non-enumerable to avoid polluting for...in loops.
	if (!Object.prototype.toSource) {
		Object.defineProperty(Object.prototype, 'toSource', {
			enumerable: false, configurable: true, writable: true,
			value: function() {
				try { return JSON.stringify(this); }
				catch (_) { return String(this); }
			}
		});
	}
	if (!Number.prototype.toSource) {
		Object.defineProperty(Number.prototype, 'toSource', {
			enumerable: false, configurable: true, writable: true,
			value: function() {
				return '(new Number(' + this.valueOf() + '))';
			}
		});
	}
	if (!String.prototype.toSource) {
		Object.defineProperty(String.prototype, 'toSource', {
			enumerable: false, configurable: true, writable: true,
			value: function() {
				return '(new String(' + JSON.stringify(this.valueOf()) + '))';
			}
		});
	}
}


// ============================================================
//  SyncnetFile — Synchronet File object replacement
// ============================================================
/**
 * Emulates Synchronet's File object using Node.js fs.
 * Supports:
 *   - open(mode) with "r", "w", "a", "rb+", "wb+", etc.
 *   - read(len), readln(), readAll(), readBin(bytes)
 *   - write(str,len), writeln(str), writeBin(val,bytes)
 *   - position (get/set), length, eof
 *   - lock/unlock (region locking stubs for single-process)
 *   - flush(), close(), truncate(len)
 */
class SyncnetFile {
	constructor(filename) {
		this.name = filename;
		this._fd = null;
		this._mode = null;
		this._pos = 0;
		this._buffer = null;   // In-memory buffer for the file contents
		this._modified = false;
	}

	get position() { return this._pos; }
	set position(p) { this._pos = Math.max(0, p); }

	get length() {
		if (this._buffer !== null) return this._buffer.length;
		try {
			var st = statSync(this.name);
			return st.size;
		} catch (_) { return 0; }
	}

	get eof() {
		return this._pos >= this.length;
	}

	get is_open() {
		return this._mode !== null;
	}

	/**
	 * Open the file.
	 * @param {string} mode — "r", "w", "a", "r+", "rb+", "wb+", etc.
	 * @param {boolean} shareable — hint for shared access (ignored)
	 * @param {number} bufSize — buffer size hint (ignored)
	 * @returns {boolean} true on success
	 */
	open(mode, shareable, bufSize) {
		try {
			this._mode = mode || 'r';
			var nodeMode;

			// Map Synchronet modes to behavior
			if (mode === 'r' || mode === 'rb') {
				if (!existsSync(this.name)) return false;
				this._buffer = Buffer.from(readFileSync(this.name));
				this._pos = 0;
				return true;
			}
			if (mode === 'r+' || mode === 'rb+') {
				if (!existsSync(this.name)) return false;
				this._buffer = Buffer.from(readFileSync(this.name));
				this._pos = 0;
				return true;
			}
			if (mode === 'w' || mode === 'wb' || mode === 'wb+' || mode === 'w+') {
				this._buffer = Buffer.alloc(0);
				this._pos = 0;
				this._modified = true;
				return true;
			}
			if (mode === 'a') {
				if (existsSync(this.name)) {
					this._buffer = Buffer.from(readFileSync(this.name));
				} else {
					this._buffer = Buffer.alloc(0);
				}
				this._pos = this._buffer.length;
				this._modified = true;
				return true;
			}

			// Default: try to read existing or create new
			if (existsSync(this.name)) {
				this._buffer = Buffer.from(readFileSync(this.name));
			} else {
				this._buffer = Buffer.alloc(0);
				this._modified = true;
			}
			this._pos = 0;
			return true;
		} catch (err) {
			return false;
		}
	}

	read(len) {
		if (this._buffer === null) return '';
		var end = Math.min(this._pos + len, this._buffer.length);
		var chunk = this._buffer.subarray(this._pos, end);
		this._pos = end;
		// Return as a latin1/binary string (CP437 compat)
		return chunk.toString('binary');
	}

	readBin(bytes) {
		if (this._buffer === null) return 0;
		var val = 0;
		for (var i = 0; i < bytes && this._pos < this._buffer.length; i++) {
			val |= this._buffer[this._pos] << (i * 8);
			this._pos++;
		}
		return val;
	}

	readln() {
		if (this._buffer === null || this._pos >= this._buffer.length) return null;
		var start = this._pos;
		while (this._pos < this._buffer.length) {
			var b = this._buffer[this._pos];
			this._pos++;
			if (b === 0x0A) { // LF
				var end = this._pos - 1;
				if (end > start && this._buffer[end - 1] === 0x0D) end--; // Strip CR
				return this._buffer.subarray(start, end).toString('binary');
			}
		}
		// No newline found — return rest of file
		if (this._pos > start) {
			return this._buffer.subarray(start, this._pos).toString('binary');
		}
		return null;
	}

	readAll() {
		var lines = [];
		var line;
		while ((line = this.readln()) !== null) {
			lines.push(line);
		}
		return lines;
	}

	write(str, len) {
		if (this._buffer === null) return false;
		var buf;
		if (len !== undefined) {
			buf = Buffer.from(str.substring(0, len), 'binary');
		} else {
			buf = Buffer.from(str, 'binary');
		}
		this._ensureCapacity(this._pos + buf.length);
		buf.copy(this._buffer, this._pos);
		this._pos += buf.length;
		this._modified = true;
		return true;
	}

	writeBin(val, bytes) {
		if (this._buffer === null) return false;
		this._ensureCapacity(this._pos + bytes);
		for (var i = 0; i < bytes; i++) {
			this._buffer[this._pos] = (val >> (i * 8)) & 0xFF;
			this._pos++;
		}
		this._modified = true;
		return true;
	}

	writeln(str) {
		this.write(str + '\r\n');
	}

	writeAll(lines) {
		if (!Array.isArray(lines)) return;
		for (var i = 0; i < lines.length; i++) {
			this.writeln(lines[i]);
		}
	}

	truncate(len) {
		if (this._buffer === null) return;
		if (len === undefined) len = this._pos;
		this._buffer = Buffer.from(this._buffer.subarray(0, len));
		if (this._pos > len) this._pos = len;
		this._modified = true;
	}

	flush() {
		if (this._modified && this._buffer !== null) {
			try {
				// Ensure directory exists
				var dir = nodePath.dirname(this.name);
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				writeFileSync(this.name, this._buffer);
			} catch (err) {
				console.log('[SyncnetFile] flush error: ' + err.message);
			}
		}
	}

	close() {
		this.flush();
		this._buffer = null;
		this._pos = 0;
		this._mode = null;
	}

	lock(offset, len) {
		// File locking stub — in single-process mode, always succeeds.
		// The SQLite replacement handles real locking at the DB level.
		return true;
	}

	unlock(offset, len) {
		return true;
	}

	/**
	 * Synchronet's iniGetValue — reads INI-style config values.
	 * @param {string|null} section — section name, null for global
	 * @param {string} key — key name
	 * @param {*} defaultVal — default if not found
	 */
	iniGetValue(section, key, defaultVal) {
		if (this._buffer === null) return defaultVal;

		var lines = this._buffer.toString('utf-8').split(/\r?\n/);
		var inSection = (section === null || section === undefined);
		var targetSection = section ? '[' + section + ']' : null;

		for (var line of lines) {
			var trimmed = line.trim();
			if (trimmed.startsWith('[')) {
				if (targetSection === null) {
					// We were in global scope, now entering a section — stop
					break;
				}
				inSection = (trimmed.toLowerCase() === targetSection.toLowerCase());
				continue;
			}
			if (inSection && trimmed.indexOf('=') !== -1) {
				var eqPos = trimmed.indexOf('=');
				var k = trimmed.substring(0, eqPos).trim();
				var v = trimmed.substring(eqPos + 1).trim();
				if (k.toLowerCase() === key.toLowerCase()) {
					// Type-coerce based on defaultVal type
					if (typeof defaultVal === 'boolean') {
						return v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes';
					}
					if (typeof defaultVal === 'number') {
						var num = Number(v);
						return isNaN(num) ? defaultVal : num;
					}
					return v;
				}
			}
		}
		return defaultVal;
	}

	/**
	 * Synchronet's iniGetSections — returns an array of all [section] names.
	 */
	iniGetSections() {
		if (this._buffer === null) return [];

		var lines = this._buffer.toString('utf-8').split(/\r?\n/);
		var sections = [];
		for (var i = 0; i < lines.length; i++) {
			var trimmed = lines[i].trim();
			if (trimmed.startsWith('[') && trimmed.indexOf(']') > 1) {
				sections.push(trimmed.substring(1, trimmed.indexOf(']')));
			}
		}
		return sections;
	}

	/**
	 * Synchronet's iniGetKeys — returns an array of key names in a section.
	 * @param {string|null} section — section name, null for global scope
	 */
	iniGetKeys(section) {
		if (this._buffer === null) return [];

		var lines = this._buffer.toString('utf-8').split(/\r?\n/);
		var inSection = (section === null || section === undefined);
		var targetSection = section ? '[' + section + ']' : null;
		var keys = [];

		for (var i = 0; i < lines.length; i++) {
			var trimmed = lines[i].trim();
			if (trimmed.startsWith('[')) {
				if (targetSection === null) break;
				inSection = (trimmed.toLowerCase() === targetSection.toLowerCase());
				continue;
			}
			if (inSection && trimmed.indexOf('=') !== -1) {
				var k = trimmed.substring(0, trimmed.indexOf('=')).trim();
				if (k) keys.push(k);
			}
		}
		return keys;
	}

	/**
	 * Synchronet's iniSetValue — writes a key=value pair under a section.
	 * Creates the section if it doesn't exist. Updates the in-memory buffer
	 * and auto-flushes to disk when the file is open for writing.
	 * @param {string|null} section — section name, null for global scope
	 * @param {string} key — key name
	 * @param {*} value — value to write
	 */
	iniSetValue(section, key, value) {
		var content = (this._buffer !== null) ? this._buffer.toString('utf-8') : '';
		var lines = content.split(/\r?\n/);

		var targetHeader = section ? '[' + section + ']' : null;
		var inSection = (section === null || section === undefined);
		var sectionStart = -1;
		var sectionEnd = lines.length;
		var keyLine = -1;

		for (var i = 0; i < lines.length; i++) {
			var trimmed = lines[i].trim();
			if (trimmed.startsWith('[')) {
				if (inSection && sectionStart >= 0) {
					// We were in the target section, now leaving it
					sectionEnd = i;
					break;
				}
				if (targetHeader === null) {
					// Global scope ends at first section
					sectionEnd = i;
					break;
				}
				if (trimmed.toLowerCase() === targetHeader.toLowerCase()) {
					inSection = true;
					sectionStart = i;
				}
				continue;
			}
			if (inSection && trimmed.indexOf('=') !== -1) {
				var k = trimmed.substring(0, trimmed.indexOf('=')).trim();
				if (k.toLowerCase() === key.toLowerCase()) {
					keyLine = i;
				}
			}
		}

		var newLine = key + '=' + value;

		if (keyLine >= 0) {
			// Replace existing key
			lines[keyLine] = newLine;
		} else if (inSection && (sectionStart >= 0 || targetHeader === null)) {
			// Section exists but key doesn't — insert before sectionEnd
			lines.splice(sectionEnd, 0, newLine);
		} else {
			// Section doesn't exist — append it
			if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
				lines.push('');
			}
			lines.push('[' + section + ']');
			lines.push(newLine);
		}

		var joined = lines.join('\n');
		this._buffer = Buffer.from(joined, 'utf-8');
		this._modified = true;

		// Synchronet iniSetValue auto-flushes to disk when file is open for write
		if (this._mode && (this._mode.indexOf('w') !== -1 || this._mode.indexOf('+') !== -1 || this._mode.indexOf('a') !== -1)) {
			try { writeFileSync(this.name, joined, 'utf-8'); } catch (_) {}
		}
	}

	/**
	 * Synchronet's iniRemoveKey — removes a key from a section.
	 * @param {string|null} section — section name, null for global scope
	 * @param {string} key — key name to remove
	 */
	iniRemoveKey(section, key) {
		if (this._buffer === null) return false;

		var content = this._buffer.toString('utf-8');
		var lines = content.split(/\r?\n/);
		var targetHeader = section ? '[' + section + ']' : null;
		var inSection = (section === null || section === undefined);
		var removed = false;

		for (var i = 0; i < lines.length; i++) {
			var trimmed = lines[i].trim();
			if (trimmed.startsWith('[')) {
				if (targetHeader === null) break;
				inSection = (trimmed.toLowerCase() === targetHeader.toLowerCase());
				continue;
			}
			if (inSection && trimmed.indexOf('=') !== -1) {
				var k = trimmed.substring(0, trimmed.indexOf('=')).trim();
				if (k.toLowerCase() === key.toLowerCase()) {
					lines.splice(i, 1);
					removed = true;
					break;
				}
			}
		}

		if (removed) {
			var joined = lines.join('\n');
			this._buffer = Buffer.from(joined, 'utf-8');
			this._modified = true;
			if (this._mode && (this._mode.indexOf('w') !== -1 || this._mode.indexOf('+') !== -1 || this._mode.indexOf('a') !== -1)) {
				try { writeFileSync(this.name, joined, 'utf-8'); } catch (_) {}
			}
		}
		return removed;
	}

	/**
	 * Synchronet's iniRemoveSection — removes an entire section and its keys.
	 * @param {string} section — section name to remove
	 */
	iniRemoveSection(section) {
		if (this._buffer === null || !section) return false;

		var content = this._buffer.toString('utf-8');
		var lines = content.split(/\r?\n/);
		var targetHeader = '[' + section + ']';
		var start = -1;
		var end = lines.length;

		for (var i = 0; i < lines.length; i++) {
			var trimmed = lines[i].trim();
			if (trimmed.startsWith('[')) {
				if (start >= 0) { end = i; break; }
				if (trimmed.toLowerCase() === targetHeader.toLowerCase()) { start = i; }
			}
		}

		if (start < 0) return false;

		lines.splice(start, end - start);
		var joined = lines.join('\n');
		this._buffer = Buffer.from(joined, 'utf-8');
		this._modified = true;
		if (this._mode && (this._mode.indexOf('w') !== -1 || this._mode.indexOf('+') !== -1 || this._mode.indexOf('a') !== -1)) {
			try { writeFileSync(this.name, joined, 'utf-8'); } catch (_) {}
		}
		return true;
	}

	// Internal: grow buffer if needed
	_ensureCapacity(needed) {
		if (this._buffer.length >= needed) return;
		var newBuf = Buffer.alloc(needed);
		this._buffer.copy(newBuf);
		this._buffer = newBuf;
	}
}


export { installSyncnetGlobals, SyncnetFile, _transpileSpiderMonkey };