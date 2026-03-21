// protocols/zmodem_receive.js — ZMODEM file receive via external rz (lrzsz)
//
// rz requires a tty, but node-pty corrupts binary data (UTF-8 string
// conversion in onData). Solution: use child_process.spawn with raw pipes
// and the 'script' command as a PTY wrapper — rz sees a tty, but we get
// clean binary I/O on stdin/stdout.
//
// Requires: apt install lrzsz

import { BaseProtocol } from "./base.js";

class ZmodemReceiveProtocol extends BaseProtocol {
	constructor(call) {
		super(call, "ZMODEM-RX");
	}

	/**
	 * Receive files into the specified directory.
	 * Uses 'script' as a tty wrapper so rz gets a tty but we get raw pipes.
	 * @param {string} targetDir — directory where files will be saved
	 * @returns {Promise<{ success: boolean, exitCode: number, error: string|null }>}
	 */
	receive(targetDir) {
		// Wrap rz in script(1) which provides a PTY for the child process
		// but exposes raw stdin/stdout to us via pipes.
		// -q: quiet (no "Script started" banner)
		// -f: flush after each write
		// -c: command to run
		// /dev/null: typescript file (we don't need the log)
		var cmdInfo = {
			cmd: "script",
			args: [
				"-qfc",
				"stty raw -echo; exec rz -b -e",
				"/dev/null"
			]
		};
		return this.receiveIntoRaw(targetDir, cmdInfo);
	}
}

export { ZmodemReceiveProtocol };
