// protocols/zmodem.js — ZMODEM file transfer via external sz (lrzsz)
//
// Spawns `sz` through node-pty. The terminal client auto-detects the
// ZMODEM initiation sequence and switches to receive mode automatically.
//
// Requires: apt install lrzsz
//
// sz flags used:
//   -b    — binary transfer (no text conversion)
//   -B 4096 — buffer size
//   -e    — escape all control characters (safer for terminal clients)
//   -q    — quiet (no local progress display on the pty)
//   -O    — use 16-bit CRC-32 (better compatibility)

import { BaseProtocol } from "./base.js";

class ZmodemProtocol extends BaseProtocol {
	constructor(call) {
		super(call, "ZMODEM");
	}

	_buildCommand(filePaths) {
		// sz sends one or more files via ZMODEM
		var args = [
			"-b",       // binary mode
			"-e",       // escape control chars
			"-B", "4096"  // buffer size
		];

		// Add all file paths
		for (var fp of filePaths) {
			args.push(fp);
		}

		return { cmd: "sz", args: args };
	}
}

export { ZmodemProtocol };
