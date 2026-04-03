// newsViewer.js -- News file viewer for terminal.
//
// Displays active news files (ANSI/ASCII art) in sequence.
// Each file is shown full-screen with optional centering for
// oversized terminals. Press any key to advance, ESC to skip all.
// Used as both a call flow stage and a menu command.

import { BaseSubModule } from "../basesubmodule.js";
import { getActiveNewsFiles } from "../../models/newsFiles.js";
import * as alogger from "../../utils/alogger.js";
import { readFileSync } from 'fs';

class NewsViewer extends BaseSubModule {
	constructor(call) {
		super(call, "NewsViewer");
		this._newsFiles = [];
		this._currentIdx = -1;
		this._waitingForKey = false;
		this.loggingId = "NewsViewer (Node " + call.nodenum + ")";
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		this._newsFiles = await getActiveNewsFiles();
		if (this._newsFiles.length === 0) {
			this.signalReturn();
			return;
		}

		this._showNext();
	}

	_showNext() {
		this._currentIdx++;
		if (this._currentIdx >= this._newsFiles.length) {
			this.signalReturn();
			return;
		}

		var nf = this._newsFiles[this._currentIdx];
		var cmds = this.call.cmds;
		var termWidth = this.call.term_width || 80;
		var termHeight = this.call.term_height || 25;

		try {
			var rawBuf = readFileSync(nf.file_path);

			// Strip EOF marker
			var eofIdx = rawBuf.indexOf(0x1A);
			if (eofIdx !== -1) rawBuf = rawBuf.subarray(0, eofIdx);
			if (rawBuf.length === 0) {
				this._showNext();
				return;
			}

			cmds.clearscreen();
			cmds.resetcolors();

			// Centering: if enabled and terminal is wider than source, pad each line
			if (nf.center && termWidth > (nf.source_width || 80)) {
				var srcWidth = nf.source_width || 80;
				var leftPad = Math.floor((termWidth - srcWidth) / 2);
				var padStr = ' '.repeat(leftPad);

				// Split on newlines, prepend padding to each line
				var text = rawBuf.toString('binary');
				var lines = text.split(/\r?\n/);
				var centered = [];
				for (var i = 0; i < lines.length; i++) {
					centered.push(padStr + lines[i]);
				}
				var centeredStr = centered.join('\r\n');
				cmds.senddata(Buffer.from(centeredStr, 'binary'));
			} else {
				cmds.senddata(rawBuf);
			}

			cmds.resetcolors();

			// Position prompt at bottom
			var promptRow = termHeight;
			if (!this.dumb) {
				cmds.movecursor(1, promptRow);
			}
			cmds.senddata("\r\n");

			this._waitingForKey = true;
		} catch (err) {
			// File not found -- skip to next
			alogger.writeAlog(3, 'NewsViewer: could not read ' + nf.file_path + ': ' + err.message, 'yellow');
			this._showNext();
		}
	}

	onKey(key) {
		if (!this.active || !this.call) return;
		if (!this._waitingForKey) return;

		this._waitingForKey = false;

		if (key === 'ESC') {
			// Skip all remaining news files
			this.signalReturn();
			return;
		}

		this._showNext();
	}

	onChar(ch) {
		if (!this.active || !this.call) return;
		if (!this._waitingForKey) return;

		this._waitingForKey = false;
		this._showNext();
	}
}

export { NewsViewer };
