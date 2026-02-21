import { EventEmitter } from 'node:events';

// CP437 to Unicode mapping table
// Characters 0x00-0x1F are control codes in ASCII but displayable glyphs in CP437
// Characters 0x80-0xFF are the extended CP437 set
const CP437_TABLE = [
	// 0x00-0x0F
	'\u0000', '\u263A', '\u263B', '\u2665', '\u2666', '\u2663', '\u2660', '\u2022',
	'\u25D8', '\u25CB', '\u25D9', '\u2642', '\u2640', '\u266A', '\u266B', '\u263C',
	// 0x10-0x1F
	'\u25BA', '\u25C4', '\u2195', '\u203C', '\u00B6', '\u00A7', '\u25AC', '\u21A8',
	'\u2191', '\u2193', '\u2192', '\u2190', '\u221F', '\u2194', '\u25B2', '\u25BC',
	// 0x20-0x7E map to standard ASCII (handled in code)
	// 0x7F
	// 0x80-0x8F
	'\u00C7', '\u00FC', '\u00E9', '\u00E2', '\u00E4', '\u00E0', '\u00E5', '\u00E7',
	'\u00EA', '\u00EB', '\u00E8', '\u00EF', '\u00EE', '\u00EC', '\u00C4', '\u00C5',
	// 0x90-0x9F
	'\u00C9', '\u00E6', '\u00C6', '\u00F4', '\u00F6', '\u00F2', '\u00FB', '\u00F9',
	'\u00FF', '\u00D6', '\u00DC', '\u00A2', '\u00A3', '\u00A5', '\u20A7', '\u0192',
	// 0xA0-0xAF
	'\u00E1', '\u00ED', '\u00F3', '\u00FA', '\u00F1', '\u00D1', '\u00AA', '\u00BA',
	'\u00BF', '\u2310', '\u00AC', '\u00BD', '\u00BC', '\u00A1', '\u00AB', '\u00BB',
	// 0xB0-0xBF
	'\u2591', '\u2592', '\u2593', '\u2502', '\u2524', '\u2561', '\u2562', '\u2556',
	'\u2555', '\u2563', '\u2551', '\u2557', '\u255D', '\u255C', '\u255B', '\u2510',
	// 0xC0-0xCF
	'\u2514', '\u2534', '\u252C', '\u251C', '\u2500', '\u253C', '\u255E', '\u255F',
	'\u255A', '\u2554', '\u2569', '\u2566', '\u2560', '\u2550', '\u256C', '\u2567',
	// 0xD0-0xDF
	'\u2568', '\u2564', '\u2565', '\u2559', '\u2558', '\u2552', '\u2553', '\u256B',
	'\u256A', '\u2518', '\u250C', '\u2588', '\u2584', '\u258C', '\u2590', '\u2580',
	// 0xE0-0xEF
	'\u03B1', '\u00DF', '\u0393', '\u03C0', '\u03A3', '\u03C3', '\u00B5', '\u03C4',
	'\u03A6', '\u0398', '\u03A9', '\u03B4', '\u221E', '\u03C6', '\u03B5', '\u2229',
	// 0xF0-0xFF
	'\u2261', '\u00B1', '\u2265', '\u2264', '\u2320', '\u2321', '\u00F7', '\u2248',
	'\u00B0', '\u2219', '\u00B7', '\u221A', '\u207F', '\u00B2', '\u25A0', '\u00A0',
];

// ANSI escape sequence states
const PARSE_STATE = {
	NORMAL:    0,
	ESC:       1,
	CSI:       2,
	CSI_PARAM: 3,
	OSC:       4,
};

class DoorOutputParser {
	constructor(options) {
		options = options || {};
		this.emitter = new EventEmitter();

		// Feature flags
		this.convertCP437 = options.convertCP437 !== undefined ? options.convertCP437 : false;
		this.centerOutput = options.centerOutput !== undefined ? options.centerOutput : false;

		// Source dimensions (what the door thinks the screen is)
		this.srcCols = options.srcCols || 80;
		this.srcRows = options.srcRows || 25;

		// Target dimensions (what the user's terminal actually is)
		this.destCols = options.destCols || 80;
		this.destRows = options.destRows || 25;

		// Calculated offsets for centering
		this.offsetCol = 0;
		this.offsetRow = 0;
		this._calcOffsets();

		// Cursor tracking — we need to know where the door thinks
		// the cursor is so we can translate positions
		this.cursorCol = 1;
		this.cursorRow = 1;

		// ANSI parse state
		this._state = PARSE_STATE.NORMAL;
		this._escBuffer = "";
		this._paramBuffer = "";
		this._intermediates = "";

		// Output accumulator — we batch output for efficiency
		this._outBuffer = "";

		this.loggingId = "DoorOutputParser";
	}

	_calcOffsets() {
		if (this.centerOutput) {
			this.offsetCol = Math.max(0, Math.floor((this.destCols - this.srcCols) / 2));
			this.offsetRow = Math.max(0, Math.floor((this.destRows - this.srcRows) / 2));
		} else {
			this.offsetCol = 0;
			this.offsetRow = 0;
		}
	}

	// Update terminal dimensions (e.g. on NAWS update)
	setDestSize(cols, rows) {
		this.destCols = cols;
		this.destRows = rows;
		this._calcOffsets();
	}

	// --- CP437 conversion ---
	_convertByte(byte) {
		// Standard printable ASCII range — no conversion needed
		if (byte >= 0x20 && byte <= 0x7E) {
			return String.fromCharCode(byte);
		}
		// DEL
		if (byte === 0x7F) {
			return '\u2302'; // House character in CP437
		}
		// Control codes 0x00-0x1F — some are actual control codes we
		// need to pass through, others are CP437 glyphs
		if (byte < 0x20) {
			switch (byte) {
				case 0x07: return '\x07'; // BEL — pass through
				case 0x08: return '\x08'; // BS — pass through
				case 0x09: return '\x09'; // TAB — pass through
				case 0x0A: return '\x0A'; // LF — pass through
				case 0x0D: return '\x0D'; // CR — pass through
				case 0x1B: return '\x1B'; // ESC — pass through (ANSI sequences)
				default:   return CP437_TABLE[byte]; // CP437 glyph
			}
		}
		// Extended characters 0x80-0xFF
		if (byte >= 0x80 && byte <= 0xFF) {
			return CP437_TABLE[byte - 0x80 + 0x20];
		}
		return String.fromCharCode(byte);
	}

	// --- Centering: translate cursor position ---
	_translatePos(col, row) {
		return {
			col: col + this.offsetCol,
			row: row + this.offsetRow
		};
	}

	_emitMoveCursor(col, row) {
		var pos = this._translatePos(col, row);
		this._outBuffer += "\x1b[" + pos.row + ";" + pos.col + "H";
	}

	// --- ANSI sequence processing ---
	_processCSI(params, intermediates, finalByte) {
		var paramStr = params;
		var parts = paramStr.split(';').map(p => p === '' ? 0 : parseInt(p, 10));

		switch (finalByte) {
			case 'H': // CUP — Cursor Position
			case 'f': // HVP — Horizontal Vertical Position
				var row = parts[0] || 1;
				var col = parts[1] || 1;
				this.cursorRow = row;
				this.cursorCol = col;
				if (this.centerOutput) {
					this._emitMoveCursor(col, row);
				} else {
					this._outBuffer += "\x1b[" + paramStr + finalByte;
				}
				return;

			case 'A': // CUU — Cursor Up
				var n = parts[0] || 1;
				this.cursorRow = Math.max(1, this.cursorRow - n);
				if (this.centerOutput) {
					this._emitMoveCursor(this.cursorCol, this.cursorRow);
				} else {
					this._outBuffer += "\x1b[" + paramStr + finalByte;
				}
				return;

			case 'B': // CUD — Cursor Down
				var n = parts[0] || 1;
				this.cursorRow = Math.min(this.srcRows, this.cursorRow + n);
				if (this.centerOutput) {
					this._emitMoveCursor(this.cursorCol, this.cursorRow);
				} else {
					this._outBuffer += "\x1b[" + paramStr + finalByte;
				}
				return;

			case 'C': // CUF — Cursor Forward
				var n = parts[0] || 1;
				this.cursorCol = Math.min(this.srcCols, this.cursorCol + n);
				if (this.centerOutput) {
					this._emitMoveCursor(this.cursorCol, this.cursorRow);
				} else {
					this._outBuffer += "\x1b[" + paramStr + finalByte;
				}
				return;

			case 'D': // CUB — Cursor Back
				var n = parts[0] || 1;
				this.cursorCol = Math.max(1, this.cursorCol - n);
				if (this.centerOutput) {
					this._emitMoveCursor(this.cursorCol, this.cursorRow);
				} else {
					this._outBuffer += "\x1b[" + paramStr + finalByte;
				}
				return;

			case 'J': // ED — Erase Display
				if (this.centerOutput) {
					var mode = parts[0] || 0;
					if (mode === 2) {
						// Clear entire screen — clear the real screen,
						// then redraw border/frame if needed
						this._outBuffer += "\x1b[2J";
						// Reposition cursor
						this._emitMoveCursor(this.cursorCol, this.cursorRow);
					} else {
						// Partial clears are trickier with centering.
						// For now, pass through with offset position
						this._outBuffer += "\x1b[" + paramStr + finalByte;
					}
				} else {
					this._outBuffer += "\x1b[" + paramStr + finalByte;
				}
				return;

			case 'K': // EL — Erase in Line
				if (this.centerOutput) {
					var mode = parts[0] || 0;
					if (mode === 0) {
						// Clear from cursor to end of door's line
						// Write spaces to fill the door's line width
						var remaining = this.srcCols - this.cursorCol + 1;
						this._outBuffer += ' '.repeat(remaining);
						// Move cursor back
						this._emitMoveCursor(this.cursorCol, this.cursorRow);
					} else if (mode === 1) {
						// Clear from start of line to cursor
						this._emitMoveCursor(1, this.cursorRow);
						this._outBuffer += ' '.repeat(this.cursorCol);
						this._emitMoveCursor(this.cursorCol, this.cursorRow);
					} else if (mode === 2) {
						// Clear entire line
						this._emitMoveCursor(1, this.cursorRow);
						this._outBuffer += ' '.repeat(this.srcCols);
						this._emitMoveCursor(this.cursorCol, this.cursorRow);
					}
				} else {
					this._outBuffer += "\x1b[" + paramStr + finalByte;
				}
				return;

			case 's': // SCP — Save Cursor Position
				this._savedCol = this.cursorCol;
				this._savedRow = this.cursorRow;
				if (this.centerOutput) {
					// Emit translated save
					this._emitMoveCursor(this.cursorCol, this.cursorRow);
					this._outBuffer += "\x1b[s";
				} else {
					this._outBuffer += "\x1b[s";
				}
				return;

			case 'u': // RCP — Restore Cursor Position
				this.cursorCol = this._savedCol || 1;
				this.cursorRow = this._savedRow || 1;
				if (this.centerOutput) {
					this._emitMoveCursor(this.cursorCol, this.cursorRow);
				} else {
					this._outBuffer += "\x1b[u";
				}
				return;

			default:
				// SGR (m), scrolling, and everything else — pass through as-is
				this._outBuffer += "\x1b[" + intermediates + paramStr + finalByte;
				return;
		}
	}

	// --- Main parse loop ---
	process(data) {
		var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		this._outBuffer = "";

		for (var i = 0; i < buf.length; i++) {
			var byte = buf[i];

			switch (this._state) {
				case PARSE_STATE.NORMAL:
					if (byte === 0x1B) {
						this._state = PARSE_STATE.ESC;
						this._paramBuffer = "";
						this._intermediates = "";
					} else if (byte === 0x0D) {
						// CR — reset column
						this.cursorCol = 1;
						if (this.centerOutput) {
							this._emitMoveCursor(this.cursorCol, this.cursorRow);
						} else {
							this._outBuffer += "\r";
						}
					} else if (byte === 0x0A) {
						// LF — advance row
						this.cursorRow = Math.min(this.srcRows, this.cursorRow + 1);
						if (this.centerOutput) {
							this._emitMoveCursor(this.cursorCol, this.cursorRow);
						} else {
							this._outBuffer += "\n";
						}
					} else if (byte === 0x08) {
						// BS — move back
						this.cursorCol = Math.max(1, this.cursorCol - 1);
						if (this.centerOutput) {
							this._emitMoveCursor(this.cursorCol, this.cursorRow);
						} else {
							this._outBuffer += "\b";
						}
					} else if (byte === 0x09) {
						// TAB — advance to next tab stop
						this.cursorCol = Math.min(this.srcCols, ((Math.floor((this.cursorCol - 1) / 8) + 1) * 8) + 1);
						if (this.centerOutput) {
							this._emitMoveCursor(this.cursorCol, this.cursorRow);
						} else {
							this._outBuffer += "\t";
						}
					} else if (byte === 0x07) {
						// BEL — pass through
						this._outBuffer += "\x07";
					} else {
						// Printable character
						var ch;
						if (this.convertCP437) {
							ch = this._convertByte(byte);
						} else {
							ch = String.fromCharCode(byte);
						}
						this._outBuffer += ch;
						this.cursorCol++;
						// Line wrap
						if (this.cursorCol > this.srcCols) {
							this.cursorCol = 1;
							this.cursorRow = Math.min(this.srcRows, this.cursorRow + 1);
							if (this.centerOutput) {
								this._emitMoveCursor(this.cursorCol, this.cursorRow);
							}
						}
					}
					break;

				case PARSE_STATE.ESC:
					if (byte === 0x5B) {
						// [ — CSI
						this._state = PARSE_STATE.CSI_PARAM;
					} else if (byte === 0x5D) {
						// ] — OSC
						this._state = PARSE_STATE.OSC;
					} else if (byte >= 0x40 && byte <= 0x5F) {
						// Other ESC Fe sequences — pass through
						this._outBuffer += "\x1b" + String.fromCharCode(byte);
						this._state = PARSE_STATE.NORMAL;
					} else {
						// Unknown — dump and reset
						this._outBuffer += "\x1b" + String.fromCharCode(byte);
						this._state = PARSE_STATE.NORMAL;
					}
					break;

				case PARSE_STATE.CSI_PARAM:
					if (byte >= 0x30 && byte <= 0x3F) {
						// Parameter bytes: 0-9, ;, <, =, >, ?
						this._paramBuffer += String.fromCharCode(byte);
					} else if (byte >= 0x20 && byte <= 0x2F) {
						// Intermediate bytes
						this._intermediates += String.fromCharCode(byte);
					} else if (byte >= 0x40 && byte <= 0x7E) {
						// Final byte — process the sequence
						this._processCSI(this._paramBuffer, this._intermediates, String.fromCharCode(byte));
						this._state = PARSE_STATE.NORMAL;
					} else {
						// Invalid — dump what we have and reset
						this._outBuffer += "\x1b[" + this._paramBuffer + String.fromCharCode(byte);
						this._state = PARSE_STATE.NORMAL;
					}
					break;

				case PARSE_STATE.OSC:
					// Consume until ST (ESC \ or BEL)
					if (byte === 0x07) {
						this._state = PARSE_STATE.NORMAL;
					} else if (byte === 0x1B) {
						// Could be ESC \ (ST)
						// Peek ahead handled by going back to ESC state
						this._state = PARSE_STATE.ESC;
					}
					// Discard OSC content — doors don't typically use it
					break;
			}
		}

		// Flush accumulated output
		if (this._outBuffer.length > 0) {
			this.emitter.emit("data", this._outBuffer);
		}
	}

	// Prepare the screen for centered output
	// Call this before the door starts to draw a border or clear the viewport
	prepareScreen(cmds) {
		if (!this.centerOutput) return;

		// Clear the entire real screen
		cmds.clearscreen();

		// Optionally draw a border around the door viewport
		if (this.offsetCol > 0 || this.offsetRow > 0) {
			this._drawBorder(cmds);
		}

		// Position cursor at door's 1,1
		var pos = this._translatePos(1, 1);
		cmds.movecursor(pos.col, pos.row);
	}

	_drawBorder(cmds) {
		var left = this.offsetCol;
		var top = this.offsetRow;
		var right = left + this.srcCols + 1;
		var bottom = top + this.srcRows + 1;

		// Top border
		cmds.movecursor(left, top);
		cmds.senddata('\u250C' + '\u2500'.repeat(this.srcCols) + '\u2510');

		// Side borders
		for (var row = top + 1; row <= bottom - 1; row++) {
			cmds.movecursor(left, row);
			cmds.senddata('\u2502');
			cmds.movecursor(right, row);
			cmds.senddata('\u2502');
		}

		// Bottom border
		cmds.movecursor(left, bottom);
		cmds.senddata('\u2514' + '\u2500'.repeat(this.srcCols) + '\u2518');
	}

	// Reset parser state
	reset() {
		this._state = PARSE_STATE.NORMAL;
		this._paramBuffer = "";
		this._intermediates = "";
		this._outBuffer = "";
		this.cursorCol = 1;
		this.cursorRow = 1;
	}

	destroy() {
		this.emitter.removeAllListeners();
		this._outBuffer = "";
	}
}

export { DoorOutputParser };