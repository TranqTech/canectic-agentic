// tcpserver.js — TCP terminal connection server
//
// Mirrors the WebSocket server pattern (WsConnection → WsPool → WsManager)
// but uses raw TCP sockets instead of WebSocket frames.
// Each TCP connection is wrapped in a TcpConnection, managed by a TcpPool,
// and the pool forwards to a CallPool for the call lifecycle.

import { v4 as uuidv4 } from 'uuid';
import * as net from 'net';
import * as alogger from "../utils/alogger.js";
import { currentMaintenance } from "../maintenance/maintenanceWatch.js";
import { refuseNewCaller } from "../maintenance/terminalDrain.js";

// ---------------------------------------------------------------------------
// TcpConnection — wraps a single TCP socket (mirrors WsConnection)
// ---------------------------------------------------------------------------

class TcpConnection {
	constructor(socket, pool) {
		this.uuid = uuidv4();
		this.connectionType = "TCP";
		this.socket = socket;
		this.parentPool = pool;
		this.loggingId = "TCP: " + socket.remoteAddress + ":" + socket.remotePort;
		this.callerId = socket.remoteAddress;
		this.callStatus = "Dialing";
		this.callhandler = null;

		socket.on('data', (data) => {
			this.handleData(data);
		});

		socket.once('close', () => {
			this.announceClose();
		});

		socket.on('error', (error) => {
			this.connectionError(error);
		});

		// Set keep-alive to detect dead connections
		socket.setKeepAlive(true, 30000);

		this.announceConnection();
	}

	announceConnection() {
		var msg = "TCP connection from " + this.socket.remoteAddress;
		alogger.writeAlog(3, msg, "magenta", true);

		// Maintenance mode: refuse before a node is allocated or anything is
		// negotiated, with the reason and when the board expects to be back.
		var closedText = refuseNewCaller(currentMaintenance());
		if (closedText) {
			alogger.writeAlog(3, "Refused TCP caller from " + this.socket.remoteAddress + ": maintenance mode", "yellow");
			this.socket.write(closedText);
			this.socket.end();
			return;
		}

		if (this.parentPool.forwardtoPool) {
			alogger.writeAlog(4, "Forwarding TCP call to pool " + this.parentPool.callPool.name, "cyan");
			this.callhandler = this.parentPool.callPool.createCall(this);
			this.callhandler.setupCall();
		} else {
			this.socket.write("Sorry, no call handlers available. Goodbye.\r\n");
			this.socket.destroy();
		}
	}

	announceClose() {
		var msg = this.loggingId + "\n  TCP connection closed";
		alogger.writeAlog(3, msg, "magenta");
		this.callStatus = "Disconnected";

		if (this.callhandler) {
			this.callhandler.connectionClosed(this);
		}
		this.callhandler = null;
		this.parentPool.removeConnection(this);
	}

	connectionError(error) {
		if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
			// Normal disconnect — don't log as error
			return;
		}
		var msg = this.loggingId + "\n  TCP error: " + error.message;
		alogger.writeAlog(3, msg, "red");
	}

	handleData(data) {
		if (this.callhandler) {
			this.callhandler.handleData(data);
		}
	}

	// --- Output methods (same interface as WsConnection) ---

	sendtext(text) {
		if (!this.socket.destroyed) this.socket.write(text);
	}

	sendString(stringdata) {
		if (!this.socket.destroyed) this.socket.write(stringdata);
	}

	sendData(data) {
		if (!this.socket.destroyed) this.socket.write(Buffer.from(data));
	}

	hangUpCall() {
		alogger.writeAlog(4, "TCP hangup: " + this.loggingId, "magenta");
		if (!this.socket.destroyed) {
			this.socket.write("\r\nGoodbye!\r\n");
			this.socket.end();
		}
	}
}

// ---------------------------------------------------------------------------
// TcpPool — manages TCP connections to a call pool (mirrors WsPool)
// ---------------------------------------------------------------------------

class TcpPool {
	constructor(name) {
		this.name = name;
		this.uuid = uuidv4();
		this.connections = [];
		this.callPool = null;
		this.forwardtoPool = false;
		this.loggingId = "TcpPool " + name;
	}

	setCallPool(callpool) {
		this.callPool = callpool;
		this.forwardtoPool = true;
	}

	handleConnection(socket) {
		var conn = new TcpConnection(socket, this);
		this.connections.push(conn);
		var msg = this.loggingId + "\n  There are now " + this.connections.length + " active TCP connections";
		alogger.writeAlog(3, msg, "blue");
	}

	removeConnection(connection) {
		if (!connection) return;
		for (var i = 0; i < this.connections.length; i++) {
			if (this.connections[i] === connection) {
				this.connections.splice(i, 1);
				var msg = this.loggingId + "\n  There are now " + this.connections.length + " active TCP connections";
				alogger.writeAlog(3, msg, "blue");
				return;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// TcpServer — manages the TCP listener and routes to a pool
// ---------------------------------------------------------------------------

class TcpServer {
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
			alogger.writeAlog(0, "TCP server error: " + err.message, "redbright");
		});

		this.server.listen(this.port, () => {
			alogger.writeAlog(1, "TCP terminal server listening on port " + this.port, "magentabright", true);
		});
	}

	stop() {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}

export { TcpConnection, TcpPool, TcpServer };
