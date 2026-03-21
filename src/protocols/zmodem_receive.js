// protocols/zmodem_receive.js — ZMODEM file receive via external rz (lrzsz)
//
// Uses raw pipes. If rz complains about not having a tty, we fall back
// to the script(1) wrapper approach.
//
// Requires: apt install lrzsz

import { BaseProtocol } from "./base.js";
import * as alogger from "../utils/alogger.js";

class ZmodemReceiveProtocol extends BaseProtocol {
	constructor(call) {
		super(call, "ZMODEM-RX");
	}

	/**
	 * Receive files into the specified directory.
	 * @param {string} targetDir — directory where files will be saved
	 * @returns {Promise<{ success: boolean, exitCode: number, error: string|null }>}
	 */
	receive(targetDir) {
		// Try raw pipes first — same approach that works for sz
		var cmdInfo = {
			cmd: "rz",
			args: ["-b", "-e"]
		};
		return this.receiveIntoRaw(targetDir, cmdInfo);
	}
}

export { ZmodemReceiveProtocol };
