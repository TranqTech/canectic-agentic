import { BaseSubModule } from "../basesubmodule.js";

class listMessages extends BaseSubModule {
	constructor(call) {
		super(call, "ListMessages");
		// TODO: implement message listing
	}

	onKey(key) {
		// Any key exits for now
		this.finished = true;
	}

	onChar(ch) {
		this.finished = true;
	}

	run() {
		this.call.cmds.senddata("\r\n  Message listing not yet implemented.\r\n  Press any key to return.");
	}
}

export { listMessages };
