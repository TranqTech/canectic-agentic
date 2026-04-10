// fireEvent.js -- Menu command to fire a template event for the current user.
//
// This is a non-interactive menu command: it fires the configured event
// and immediately returns control to the calling menu. Useful for wiring
// template events into menus -- e.g. a "log off" menu item that fires a
// `user_logoff` custom event, or a door launch that fires `door_played`.
//
// command_arg format:
//   "event_code"
//   "event_code|{\"key\":\"value\"}"     (event code plus JSON extraVars)
//
// The target user is always the current session user. For broader targets
// use the CLI tool (src/tools/fireEvent.js) or the admin UI Fire page.

import { BaseSubModule } from "../basesubmodule.js";
import * as alogger from "../../utils/alogger.js";

class FireEvent extends BaseSubModule {
	constructor(call, options) {
		super(call, "FireEvent");
		this._options = options || {};
	}

	async run() {
		try {
			if (!this.call) { this.signalReturn(); return; }

			var arg = this._options.arg || '';
			if (!arg) {
				alogger.writeAlog(5, 'FireEvent: no command_arg specified', 'yellow');
				this.signalReturn();
				return;
			}

			var userId = this.call.user_record && this.call.user_record.id;
			if (!userId) {
				alogger.writeAlog(5, 'FireEvent: no user session; nothing to fire', 'yellow');
				this.signalReturn();
				return;
			}

			// Parse "event_code" or "event_code|{json}"
			var pipeIdx = arg.indexOf('|');
			var eventCode, extraVars = {};
			if (pipeIdx >= 0) {
				eventCode = arg.substring(0, pipeIdx).trim();
				var jsonPart = arg.substring(pipeIdx + 1).trim();
				try {
					extraVars = JSON.parse(jsonPart);
				} catch (e) {
					alogger.writeAlog(3, 'FireEvent: invalid JSON in arg: ' + e.message, 'yellow');
				}
			} else {
				eventCode = arg.trim();
			}

			var tmplMod = await import('../../models/messageTemplates.js');
			var result = await tmplMod.fireEvent(eventCode, userId, extraVars);
			alogger.writeAlog(5,
				'FireEvent: ' + eventCode + ' for user ' + userId +
				': ' + result.fired + ' delivered, ' + result.skipped + ' skipped',
				'cyan'
			);
		} catch (err) {
			alogger.writeAlog(3, 'FireEvent: exception: ' + (err.message || err), 'yellow');
		}

		this.signalReturn();
	}
}

export { FireEvent };
