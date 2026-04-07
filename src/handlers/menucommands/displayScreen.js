// displayScreen.js -- Display an art screen and wait for keypress.
//
// Generic screen display command for menus and call flow stages.
// Shows an art file full-screen (with @ code processing), then
// waits for any key to return.
//
// command_arg format:
//   "type:Welcome"         -- random art from welcome/ (with seasonal override)
//   "type:Goodbye"         -- random art from goodbye/
//   "type:Logoff"          -- random art from logoff/
//   "type:Login"           -- random art from login/
//   "type:Logon"           -- random art from logon/
//   "type:Registration"    -- random art from register/
//   "screens/rules"        -- specific file from screens/ subdir
//   "welcome/splash"       -- specific file from welcome/ subdir
//
// The "type:" prefix triggers random selection from the matching
// directory. Without the prefix, it's treated as subdir/filename
// for a specific art file lookup.

import { BaseSubModule } from "../basesubmodule.js";
import * as alogger from "../../utils/alogger.js";

var RANDOM_TYPES = ['Welcome', 'Goodbye', 'Logoff', 'Login', 'Logon', 'Registration'];

class DisplayScreen extends BaseSubModule {
	constructor(call, options) {
		super(call, "DisplayScreen");
		this._options = options || {};
		this._waitingForKey = false;
	}

	async run() {
		if (!this.call) { this.signalReturn(); return; }

		var arg = this._options.arg || '';
		if (!arg) {
			alogger.writeAlog(5, 'DisplayScreen: no command_arg specified', 'yellow');
			this.signalReturn();
			return;
		}

		var cmds = this.call.cmds;
		var rendered = false;

		// Check for "type:XXX" random screen selection
		if (arg.startsWith('type:')) {
			var screenType = arg.substring(5).trim();
			if (RANDOM_TYPES.includes(screenType)) {
				cmds.drawrandomscreen(screenType, true);
				rendered = true;
			} else {
				alogger.writeAlog(5, 'DisplayScreen: unknown screen type: ' + screenType, 'yellow');
			}
		} else {
			// Specific file: "subdir/filename" or just "filename" (defaults to screens/)
			var slashIdx = arg.indexOf('/');
			var subdir, filename;
			if (slashIdx > 0) {
				subdir = arg.substring(0, slashIdx);
				filename = arg.substring(slashIdx + 1);
			} else {
				subdir = 'screens';
				filename = arg;
			}

			// Use drawscreenWithCodes for @ code support
			var result = await cmds.drawscreenWithCodes(filename, subdir === 'screens' ? 'Screen' :
				subdir === 'headers' ? 'Header' :
				subdir === 'welcome' ? 'Welcome' : 'Screen',
				{ doscreenclear: true });

			rendered = result && result.rendered;

			// If drawscreenWithCodes didn't find it (subdir isn't a standard type),
			// try direct art file lookup
			if (!rendered) {
				var artfile = cmds._findArtFile(subdir, filename);
				if (artfile) {
					cmds.drawfile(artfile, true);
					rendered = true;
				}
			}
		}

		if (!rendered) {
			alogger.writeAlog(5, 'DisplayScreen: no art file found for: ' + arg, 'yellow');
			this.signalReturn();
			return;
		}

		this._waitingForKey = true;
	}

	onChar(ch) {
		if (!this.active || !this._waitingForKey) return;
		this._waitingForKey = false;
		this.signalReturn();
	}

	onKey(key) {
		if (!this.active || !this._waitingForKey) return;
		this._waitingForKey = false;
		this.signalReturn();
	}
}

export { DisplayScreen };
