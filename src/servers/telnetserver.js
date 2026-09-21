// telnetserver.js — Telnet terminal connection server
//
// Mirrors the TCP server pattern but adds telnet IAC (Interpret As Command)
// negotiation on both inbound and outbound data. The IAC layer is transparent
// to the call handler — it sees clean data bytes with all telnet commands
// stripped. Outgoing data has 0xFF bytes escaped as 0xFF 0xFF.
//
// This works correctly in raw mode (file transfers) because:
// - Inbound: IAC sequences are stripped before data reaches rawtarget
// - Outbound: _send escapes 0xFF bytes so transfer protocols can send
//   any byte value without triggering IAC interpretation on the client

import { v4 as uuidv4 } from 'uuid';
import * as net from 'net';
import * as alogger from "../utils/alogger.js";
import { currentMaintenance } from "../maintenance/maintenanceWatch.js";
import { refuseNewCaller } from "../maintenance/terminalDrain.js";

// --- Telnet constants ---
var IAC  = 0xFF;  // Interpret As Command
var DONT = 0xFE;
var DO   = 0xFD;
var WONT = 0xFC;
var WILL = 0xFB;
var SB   = 0xFA;  // Subnegotiation Begin
var SE   = 0xF0;  // Subnegotiation End
var GA   = 0xF9;  // Go Ahead
var NOP  = 0xF1;

// Telnet options we care about
var OPT_BINARY     = 0;   // Binary Transmission (disable IAC in data)
var OPT_ECHO       = 1;
var OPT_SGA        = 3;   // Suppress Go Ahead
var OPT_TTYPE      = 24;  // Terminal Type
var OPT_NAWS       = 31;  // Negotiate About Window Size
var OPT_LINEMODE   = 34;

// ---------------------------------------------------------------------------
// TelnetParser — strips IAC from inbound, escapes IAC on outbound
// ---------------------------------------------------------------------------

class TelnetParser {
	constructor(connection) {
		this._conn = connection;
		this._state = 'data';  // 'data', 'iac', 'will', 'wont', 'do', 'dont', 'sb', 'sb_data'
		this._sbOption = 0;
		this._sbBuffer = [];
		this._acceptedOptions = new Set(); // Track options we've already accepted
	}

	// Parse incoming data — returns clean data bytes with IAC stripped
	filterInbound(buf) {
		// Disabled = raw TCP mode, pass through unchanged
		if (this._disabled) return buf;

		var clean = [];
		for (var i = 0; i < buf.length; i++) {
			var b = buf[i];

			switch (this._state) {
				case 'data':
					if (b === IAC) {
						this._state = 'iac';
					} else {
						clean.push(b);
					}
					break;

				case 'iac':
					switch (b) {
						case IAC:
							// Escaped 0xFF — literal data byte
							clean.push(0xFF);
							this._state = 'data';
							break;
						case WILL:
							this._state = 'will';
							break;
						case WONT:
							this._state = 'wont';
							break;
						case DO:
							this._state = 'do';
							break;
						case DONT:
							this._state = 'dont';
							break;
						case SB:
							this._state = 'sb';
							break;
						case GA:
						case NOP:
							// Ignore
							this._state = 'data';
							break;
						default:
							// Unknown command — ignore
							this._state = 'data';
							break;
					}
					break;

				case 'will':
					this._handleWill(b);
					this._state = 'data';
					break;

				case 'wont':
					this._state = 'data';
					break;

				case 'do':
					this._handleDo(b);
					this._state = 'data';
					break;

				case 'dont':
					this._state = 'data';
					break;

				case 'sb':
					this._sbOption = b;
					this._sbBuffer = [];
					this._state = 'sb_data';
					break;

				case 'sb_data':
					if (b === IAC) {
						// Could be IAC SE (end) or IAC IAC (escaped 0xFF in SB)
						if (i + 1 < buf.length && buf[i + 1] === SE) {
							this._handleSubnegotiation(this._sbOption, this._sbBuffer);
							i++; // Skip SE
							this._state = 'data';
						} else if (i + 1 < buf.length && buf[i + 1] === IAC) {
							this._sbBuffer.push(0xFF);
							i++; // Skip escaped IAC
						} else {
							// Malformed — end subnegotiation
							this._state = 'data';
						}
					} else {
						this._sbBuffer.push(b);
					}
					break;
			}
		}

		return Buffer.from(clean);
	}

	// Escape outbound data — double any 0xFF bytes
	static escapeOutbound(buf, disabled) {
		if (disabled) return buf;
		// Fast path: if no 0xFF in buffer, return as-is
		var hasFF = false;
		for (var i = 0; i < buf.length; i++) {
			if (buf[i] === 0xFF) { hasFF = true; break; }
		}
		if (!hasFF) return buf;

		// Slow path: escape 0xFF → 0xFF 0xFF
		var out = [];
		for (var j = 0; j < buf.length; j++) {
			out.push(buf[j]);
			if (buf[j] === 0xFF) out.push(0xFF);
		}
		return Buffer.from(out);
	}

	// --- Telnet negotiation handlers ---

	_handleWill(option) {
		// Only respond once per option to prevent negotiation loops
		if (this._acceptedOptions.has(option)) return;

		switch (option) {
			case OPT_NAWS:
				this._acceptedOptions.add(option);
				this._sendCommand(DO, option);
				break;
			case OPT_BINARY:
				// Client will send binary — accept
				this._acceptedOptions.add(option);
				this._sendCommand(DO, option);
				break;
			case OPT_TTYPE:
				this._acceptedOptions.add(option);
				this._sendCommand(DO, option);
				this._sendSB(OPT_TTYPE, [1]); // SEND = 1
				break;
			default:
				this._sendCommand(DONT, option);
				break;
		}
	}

	_handleDo(option) {
		switch (option) {
			case OPT_ECHO:
			case OPT_SGA:
				// We will echo and suppress go-ahead (character mode)
				this._sendCommand(WILL, option);
				break;
			case OPT_BINARY:
				// Client agrees to binary mode (or requests it)
				this._sendCommand(WILL, option);
				break;
			default:
				this._sendCommand(WONT, option);
				break;
		}
	}

	_handleSubnegotiation(option, data) {
		switch (option) {
			case OPT_NAWS:
				// Window size: 4 bytes — width(2) height(2) big-endian
				if (data.length >= 4) {
					var width = (data[0] << 8) | data[1];
					var height = (data[2] << 8) | data[3];
					if (this._conn.callhandler) {
						this._conn.callhandler.term_width = width;
						this._conn.callhandler.term_height = height;
						alogger.writeAlog(4, this._conn.loggingId +
							" NAWS: " + width + "x" + height, "cyan");
					}
				}
				break;
			case OPT_TTYPE:
				// Terminal type: IS(0) + string
				if (data.length > 1 && data[0] === 0) {
					var ttype = Buffer.from(data.slice(1)).toString('ascii').trim();
					this._conn.ttype = ttype;
					if (this._conn.callhandler) {
						this._conn.callhandler.ttype = ttype;
						alogger.writeAlog(4, this._conn.loggingId +
							" TTYPE: " + ttype, "cyan");
					}
				}
				break;
		}
	}

	_sendCommand(cmd, option) {
		var buf = Buffer.from([IAC, cmd, option]);
		if (this._conn.socket && !this._conn.socket.destroyed) {
			this._conn.socket.write(buf);
		}
	}

	_sendSB(option, data) {
		var buf = Buffer.alloc(3 + data.length + 2);
		buf[0] = IAC;
		buf[1] = SB;
		buf[2] = option;
		for (var i = 0; i < data.length; i++) buf[3 + i] = data[i];
		buf[3 + data.length] = IAC;
		buf[4 + data.length] = SE;
		if (this._conn.socket && !this._conn.socket.destroyed) {
			this._conn.socket.write(buf);
		}
	}

	// Send initial negotiation to put client in character mode
	sendInitialNegotiation() {
		this._sendCommand(WILL, OPT_ECHO);
		this._sendCommand(WILL, OPT_SGA);
		this._sendCommand(DO, OPT_NAWS);
		this._sendCommand(DO, OPT_TTYPE);
		this._sendCommand(DO, OPT_SGA);
	}

	// Enable binary mode — disables IAC processing for file transfers.
	// Both sides must agree: we WILL send binary, client should DO binary.
	enableBinaryMode() {
		this._binaryMode = true;
		this._sendCommand(WILL, OPT_BINARY);
		this._sendCommand(DO, OPT_BINARY);
	}

	// Disable binary mode — re-enables IAC processing after transfer.
	disableBinaryMode() {
		this._binaryMode = false;
		this._sendCommand(WONT, OPT_BINARY);
		this._sendCommand(DONT, OPT_BINARY);
	}

	get binaryMode() {
		return this._binaryMode || false;
	}
}

// ---------------------------------------------------------------------------
// TelnetConnection — wraps a TCP socket with IAC filtering
// ---------------------------------------------------------------------------

class TelnetConnection {
	constructor(socket, pool) {
		this.uuid = uuidv4();
		this.connectionType = "Telnet";
		this.socket = socket;
		this.parentPool = pool;
		this.loggingId = "Telnet: " + socket.remoteAddress + ":" + socket.remotePort;
		this.callerId = socket.remoteAddress;
		this.callStatus = "Dialing";
		this.callhandler = null;
		this.telnetParser = new TelnetParser(this);

		socket.on('data', (data) => {
			this.handleData(data);
		});

		socket.once('close', () => {
			this.announceClose();
		});

		socket.on('error', (error) => {
			this.connectionError(error);
		});

		socket.setKeepAlive(true, 30000);

		// Send telnet negotiation before announcing connection
		this.telnetParser.sendInitialNegotiation();

		this.announceConnection();
	}

	announceConnection() {
		var msg = "Telnet connection from " + this.socket.remoteAddress;
		alogger.writeAlog(3, msg, "magenta", true);

		// Maintenance mode: refuse before a node is allocated or anything is
		// negotiated, with the reason and when the board expects to be back.
		var closedText = refuseNewCaller(currentMaintenance());
		if (closedText) {
			alogger.writeAlog(3, "Refused Telnet caller from " + this.socket.remoteAddress + ": maintenance mode", "yellow");
			this.socket.write(closedText);
			this.socket.end();
			return;
		}

		if (this.parentPool.forwardtoPool) {
			alogger.writeAlog(4, "Forwarding Telnet call to pool " + this.parentPool.callPool.name, "cyan");
			this.callhandler = this.parentPool.callPool.createCall(this);
			this.callhandler.setupCall();
		} else {
			this.socket.write("Sorry, no call handlers available. Goodbye.\r\n");
			this.socket.destroy();
		}
	}

	announceClose() {
		var msg = this.loggingId + "\n  Telnet connection closed";
		alogger.writeAlog(3, msg, "magenta");
		this.callStatus = "Disconnected";

		if (this.callhandler) {
			this.callhandler.connectionClosed(this);
		}
		this.callhandler = null;
		this.parentPool.removeConnection(this);
	}

	connectionError(error) {
		if (error.code === 'ECONNRESET' || error.code === 'EPIPE') return;
		var msg = this.loggingId + "\n  Telnet error: " + error.message;
		alogger.writeAlog(3, msg, "red");
	}

	handleData(data) {
		if (this.callhandler) {
			// Filter IAC commands from inbound data
			var clean = this.telnetParser.filterInbound(data);
			if (clean.length > 0) {
				this.callhandler.handleData(clean);
			}
		}
	}

	// --- Output methods (same interface as TcpConnection/WsConnection) ---

	sendtext(text) {
		if (!this.socket.destroyed) {
			this.socket.write(TelnetParser.escapeOutbound(Buffer.from(text), this.telnetParser._disabled));
		}
	}

	sendString(stringdata) {
		if (!this.socket.destroyed) {
			this.socket.write(TelnetParser.escapeOutbound(Buffer.from(stringdata), this.telnetParser._disabled));
		}
	}

	sendData(data) {
		if (!this.socket.destroyed) {
			this.socket.write(TelnetParser.escapeOutbound(Buffer.from(data), this.telnetParser._disabled));
		}
	}

	hangUpCall() {
		alogger.writeAlog(4, "Telnet hangup: " + this.loggingId, "magenta");
		if (!this.socket.destroyed) {
			this.socket.write("\r\nGoodbye!\r\n");
			this.socket.end();
		}
	}
}

// ---------------------------------------------------------------------------
// TelnetPool — manages telnet connections (mirrors TcpPool)
// ---------------------------------------------------------------------------

class TelnetPool {
	constructor(name) {
		this.name = name;
		this.uuid = uuidv4();
		this.connections = [];
		this.callPool = null;
		this.forwardtoPool = false;
		this.loggingId = "TelnetPool " + name;
	}

	setCallPool(callpool) {
		this.callPool = callpool;
		this.forwardtoPool = true;
	}

	handleConnection(socket) {
		var conn = new TelnetConnection(socket, this);
		this.connections.push(conn);
		alogger.writeAlog(3, this.loggingId + "\n  " +
			this.connections.length + " active Telnet connection(s)", "blue");
	}

	removeConnection(connection) {
		if (!connection) return;
		for (var i = 0; i < this.connections.length; i++) {
			if (this.connections[i] === connection) {
				this.connections.splice(i, 1);
				alogger.writeAlog(3, this.loggingId + "\n  " +
					this.connections.length + " active Telnet connection(s)", "blue");
				return;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// TelnetServer — listens on a port, creates TelnetConnections
// ---------------------------------------------------------------------------

class TelnetServer {
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
			alogger.writeAlog(0, "Telnet server error: " + err.message, "redbright");
		});

		this.server.listen(this.port, () => {
			alogger.writeAlog(1, "Telnet terminal server listening on port " + this.port, "magentabright", true);
		});
	}

	stop() {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}

export { TelnetConnection, TelnetPool, TelnetServer, TelnetParser };
