// terminalserver.js — Unified terminal connection server (TCP + Telnet auto-detect)
//
// Listens on a single port and auto-detects whether each connection is
// raw TCP or telnet by sniffing the first bytes from the client:
//
// - If the first bytes are IAC (0xFF) + telnet command (0xFB-0xFE),
//   the connection is promoted to telnet mode with full IAC filtering.
// - If the first bytes are NOT IAC, or no data arrives within 500ms,
//   the connection is treated as raw TCP.
//
// This eliminates client/server mode mismatch issues — SyncTERM in
// telnet mode auto-detects to telnet, DosBox/vmodem auto-detects to TCP.

import { v4 as uuidv4 } from 'uuid';
import * as net from 'net';
import * as alogger from "../utils/alogger.js";
import { TelnetConnection } from './telnetserver.js';

var IAC = 0xFF;
var DETECT_TIMEOUT = 500; // ms to wait for first data

// Telnet command bytes that follow IAC
var TELNET_COMMANDS = new Set([0xFB, 0xFC, 0xFD, 0xFE, 0xFA]); // WILL, WONT, DO, DONT, SB

// ---------------------------------------------------------------------------
// TerminalPool — manages both TCP and Telnet connections
// ---------------------------------------------------------------------------

class TerminalPool {
	constructor(name) {
		this.name = name;
		this.uuid = uuidv4();
		this.connections = [];
		this.callPool = null;
		this.forwardtoPool = false;
		this.loggingId = "TerminalPool " + name;
	}

	setCallPool(callpool) {
		this.callPool = callpool;
		this.forwardtoPool = true;
	}

	handleConnection(socket) {
		socket.setKeepAlive(true, 30000);

		// Always start as telnet — send negotiation and check the response.
		// Telnet clients respond with IAC commands (confirming telnet mode).
		// Raw TCP clients either send nothing or non-IAC data.
		//
		// The TelnetConnection's IAC parser is safe for raw TCP data — it only
		// triggers on 0xFF which never appears in normal terminal input.
		// If we detect raw TCP, we downgrade: disable IAC escaping on outbound
		// and bypass the parser on inbound. This is important for file transfers
		// where 0xFF bytes must pass through unmodified.

		var conn = new TelnetConnection(socket, this);
		this.connections.push(conn);

		// Monitor incoming data to confirm telnet mode. The telnet parser
		// processes all data regardless — if the client IS telnet, IAC
		// commands get handled correctly. If it's raw TCP, no harm done
		// during the detection window since 0xFF almost never appears in
		// terminal input. After the window closes, we either confirm
		// telnet (IAC seen) or downgrade to raw TCP (disable IAC processing).
		var self = this;
		var confirmed = false;

		function checkForIAC(data) {
			if (confirmed) return;
			for (var i = 0; i < data.length - 1; i++) {
				if (data[i] === IAC && TELNET_COMMANDS.has(data[i + 1])) {
					confirmed = true;
					socket.removeListener('data', iacCheck);
					clearTimeout(downgradeTimer);
					alogger.writeAlog(4, self.loggingId + " Confirmed telnet: " +
						socket.remoteAddress, "cyan");
					return;
				}
			}
		}

		function iacCheck(data) { checkForIAC(data); }

		// Watch all data chunks for up to 2 seconds
		socket.prependListener('data', iacCheck);

		var downgradeTimer = setTimeout(function() {
			if (confirmed) return;
			socket.removeListener('data', iacCheck);
			conn.connectionType = "TCP";
			conn.telnetParser._disabled = true;
			alogger.writeAlog(4, self.loggingId + " No telnet detected — downgraded to raw TCP: " +
				socket.remoteAddress, "cyan");
		}, 2000);

		alogger.writeAlog(3, this.loggingId + "\n  " +
			this.connections.length + " active connection(s)", "blue");
	}

	removeConnection(connection) {
		if (!connection) return;
		for (var i = 0; i < this.connections.length; i++) {
			if (this.connections[i] === connection) {
				this.connections.splice(i, 1);
				alogger.writeAlog(3, this.loggingId + "\n  " +
					this.connections.length + " active connection(s)", "blue");
				return;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// TerminalServer — listens on a single port, auto-detects protocol
// ---------------------------------------------------------------------------

class TerminalServer {
	constructor(port, pool) {
		this.port = port;
		this.pool = pool;
		this.server = null;
	}

	start() {
		this.server = net.createServer((socket) => {
			this.pool.handleConnection(socket);
		});

		this.server.on('error', (err) => {
			alogger.writeAlog(0, "Terminal server error: " + err.message, "redbright");
		});

		this.server.listen(this.port, () => {
			alogger.writeAlog(1, "Terminal server listening on port " + this.port +
				" (auto-detect TCP/Telnet)", "magentabright", true);
		});
	}

	stop() {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}

export { TerminalPool, TerminalServer };
