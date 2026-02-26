/**
 * syncjsdoor_comm.js — SharedArrayBuffer IPC for Synchronet JS Door Shim
 *
 * Provides a synchronous communication bridge between the main thread (BBS)
 * and a worker thread (running the door game).
 *
 * The door expects blocking I/O (waitkey, getkey, getstr) — we achieve this
 * with Atomics.wait() in the worker, and Atomics.notify() from the main thread.
 *
 * SharedArrayBuffer Layout (COMM_BUFFER_SIZE bytes):
 * ┌─────────────────────────────────────────────────────────┐
 * │ Int32 [0]  signal    — 0=idle, 1=data, 2=disconnect,   │
 * │                        3=resize                         │
 * │ Int32 [1]  dataLen   — number of key bytes available    │
 * │ Int32 [2]  ackSignal — worker ack (for flow control)    │
 * │ Int32 [3]  reserved                                     │
 * │ Uint8 [16..16+KEY_BUFFER_SIZE] — key/input data ring    │
 * │ Uint8 [16+KEY_BUFFER_SIZE..end] — metadata (cols, rows) │
 * └─────────────────────────────────────────────────────────┘
 *
 * Output (worker→main) uses parentPort.postMessage() — non-blocking.
 */

// --- Constants shared between main and worker ---

const HEADER_INTS = 4;                  // 4 x Int32 = 16 bytes header
const HEADER_BYTES = HEADER_INTS * 4;
const KEY_BUFFER_SIZE = 4096;           // Ring buffer for input keys
const META_SIZE = 64;                   // Terminal metadata (cols, rows, etc.)
const COMM_BUFFER_SIZE = HEADER_BYTES + KEY_BUFFER_SIZE + META_SIZE;

// Signal values (Int32[0])
const SIG_IDLE       = 0;
const SIG_DATA       = 1;
const SIG_DISCONNECT = 2;
const SIG_RESIZE     = 3;

// Meta offsets (byte offsets from start of meta region)
const META_OFFSET = HEADER_BYTES + KEY_BUFFER_SIZE;
const META_COLS   = 0;   // Uint16
const META_ROWS   = 2;   // Uint16
const META_ANSI   = 4;   // Uint8 (boolean)
const META_NODE   = 5;   // Uint8

// Output message types (worker → main via postMessage)
const MSG_OUTPUT       = 'output';        // Raw terminal output data
const MSG_READY        = 'ready';         // Worker initialized and ready
const MSG_EXIT         = 'exit';          // Door exited (code in payload)
const MSG_ERROR        = 'error';         // Door threw an error
const MSG_DB_REQUEST   = 'db_request';    // SQLite operation request
const MSG_DB_RESPONSE  = 'db_response';   // SQLite operation response
const MSG_FILE_REQUEST = 'file_request';  // File I/O request
const MSG_FILE_RESPONSE= 'file_response';// File I/O response


// ============================================================
//  MainSide — used by SyncJSDoorRunner on the main thread
// ============================================================
class MainSide {
	constructor() {
		this._sab = new SharedArrayBuffer(COMM_BUFFER_SIZE);
		this._int32 = new Int32Array(this._sab);
		this._uint8 = new Uint8Array(this._sab);
		this._meta = new DataView(this._sab, META_OFFSET, META_SIZE);

		// Ring buffer write position (main-side tracking)
		this._writePos = 0;
	}

	/** Returns the SharedArrayBuffer to pass to the worker */
	get sharedBuffer() {
		return this._sab;
	}

	/**
	 * Set terminal metadata before the worker starts.
	 */
	setTermInfo(cols, rows, ansiEnabled, nodeNum) {
		this._meta.setUint16(META_COLS, cols || 80, true);
		this._meta.setUint16(META_ROWS, rows || 24, true);
		this._meta.setUint8(META_ANSI, ansiEnabled ? 1 : 0);
		this._meta.setUint8(META_NODE, nodeNum || 0);
	}

	/**
	 * Push a single key string into the shared buffer.
	 * Keys are null-terminated in the ring buffer so the worker
	 * can read variable-length key names (e.g. "KEY_UP\0", "a\0").
	 */
	pushKey(keyString) {
		var encoded = Buffer.from(keyString + '\0', 'utf-8');

		// Write into the ring buffer region
		for (var i = 0; i < encoded.length; i++) {
			this._uint8[HEADER_BYTES + (this._writePos % KEY_BUFFER_SIZE)] = encoded[i];
			this._writePos++;
		}

		// Update data length and signal
		Atomics.store(this._int32, 1, this._writePos);
		Atomics.store(this._int32, 0, SIG_DATA);
		Atomics.notify(this._int32, 0);
	}

	/**
	 * Push raw bytes (for raw mode passthrough).
	 * Each byte is stored as a single char + null terminator.
	 * ANSI escape sequence parsing is done on the worker side
	 * (in the dorkit shim's getkey()) to avoid split-buffer issues.
	 */
	pushRawBytes(buffer) {
		for (var b = 0; b < buffer.length; b++) {
			var ch = String.fromCharCode(buffer[b]);
			this.pushKey(ch);
		}
	}

	/**
	 * Signal the worker that the connection has been lost.
	 */
	signalDisconnect() {
		Atomics.store(this._int32, 0, SIG_DISCONNECT);
		Atomics.notify(this._int32, 0);
	}

	/**
	 * Signal terminal resize.
	 */
	signalResize(cols, rows) {
		this._meta.setUint16(META_COLS, cols, true);
		this._meta.setUint16(META_ROWS, rows, true);
		Atomics.store(this._int32, 0, SIG_RESIZE);
		Atomics.notify(this._int32, 0);
	}

	/**
	 * Reset the buffer state.
	 */
	reset() {
		this._writePos = 0;
		Atomics.store(this._int32, 0, SIG_IDLE);
		Atomics.store(this._int32, 1, 0);
		Atomics.store(this._int32, 2, 0);
	}
}


// ============================================================
//  WorkerSide — used by DorkitShim inside the worker thread
// ============================================================
class WorkerSide {
	constructor(sab) {
		this._sab = sab;
		this._int32 = new Int32Array(sab);
		this._uint8 = new Uint8Array(sab);
		this._meta = new DataView(sab, META_OFFSET, META_SIZE);

		// Ring buffer read position (worker-side tracking)
		this._readPos = 0;

		// Internal key buffer (parsed keys ready to deliver)
		this._keyQueue = [];

		// Connection state
		this.connected = true;
	}

	// --- Terminal metadata ---
	get cols() {
		return this._meta.getUint16(META_COLS, true) || 80;
	}
	get rows() {
		return this._meta.getUint16(META_ROWS, true) || 24;
	}
	get ansiEnabled() {
		return this._meta.getUint8(META_ANSI) === 1;
	}
	get nodeNum() {
		return this._meta.getUint8(META_NODE);
	}

	/**
	 * Check for disconnect signal without blocking.
	 */
	_checkDisconnect() {
		var sig = Atomics.load(this._int32, 0);
		if (sig === SIG_DISCONNECT) {
			this.connected = false;
			return true;
		}
		return false;
	}

	/**
	 * Drain any available key data from the ring buffer into _keyQueue.
	 * Non-blocking — reads whatever is available.
	 */
	_drainBuffer() {
		var writePos = Atomics.load(this._int32, 1);

		while (this._readPos < writePos) {
			// Read a null-terminated key string
			var keyStr = '';
			while (this._readPos < writePos) {
				var byte = this._uint8[HEADER_BYTES + (this._readPos % KEY_BUFFER_SIZE)];
				this._readPos++;
				if (byte === 0) break; // null terminator
				keyStr += String.fromCharCode(byte);
			}
			if (keyStr.length > 0) {
				this._keyQueue.push(keyStr);
			}
		}
	}

	/**
	 * Check if a key is available without blocking.
	 * Returns true if at least one key is queued.
	 */
	hasKey() {
		if (this._keyQueue.length > 0) return true;
		this._drainBuffer();
		return this._keyQueue.length > 0;
	}

	/**
	 * Wait for a key with optional timeout.
	 * BLOCKS the worker thread using Atomics.wait().
	 *
	 * @param {number} timeoutMs — max wait time in ms. -1 = wait forever.
	 * @returns {boolean} true if a key is available, false on timeout
	 */
	waitKey(timeoutMs) {
		// Already have buffered keys?
		if (this.hasKey()) return true;
		if (!this.connected) return true; // return true so getkey returns CONNECTION_CLOSED

		// Snapshot the current signal value
		var currentSig = Atomics.load(this._int32, 0);

		if (currentSig === SIG_DATA) {
			// Data might have arrived between hasKey() and here
			this._drainBuffer();
			if (this._keyQueue.length > 0) return true;
			// Reset signal so we can wait for the next one
			Atomics.store(this._int32, 0, SIG_IDLE);
		}

		if (currentSig === SIG_DISCONNECT) {
			this.connected = false;
			return true;
		}

		// Block until signal changes from IDLE
		var waitTimeout = timeoutMs < 0 ? undefined : timeoutMs;
		var result = Atomics.wait(this._int32, 0, SIG_IDLE, waitTimeout);

		if (result === 'timed-out') {
			return false;
		}

		// Something happened — check what
		var newSig = Atomics.load(this._int32, 0);
		if (newSig === SIG_DISCONNECT) {
			this.connected = false;
			return true;
		}
		if (newSig === SIG_RESIZE) {
			// Terminal resized — reset signal, the cols/rows getters will
			// return the updated values automatically
			Atomics.store(this._int32, 0, SIG_IDLE);
			return false; // Not a key, just a resize
		}

		// SIG_DATA — drain and check
		this._drainBuffer();
		// Reset signal so future waits work correctly
		Atomics.store(this._int32, 0, SIG_IDLE);
		return this._keyQueue.length > 0;
	}

	/**
	 * Get the next key from the queue.
	 * Non-blocking — returns undefined if nothing available.
	 */
	getKey() {
		if (!this.connected) return 'CONNECTION_CLOSED';
		this._drainBuffer();
		if (this._keyQueue.length > 0) {
			return this._keyQueue.shift();
		}
		return undefined;
	}

	/**
	 * Get a single raw byte (no ANSI parsing).
	 * Non-blocking — returns undefined if nothing available.
	 */
	getByte() {
		// Same as getKey for our implementation since input
		// has already been parsed by the main thread's ansiInputParser
		return this.getKey();
	}
}


// ============================================================
//  Exports
// ============================================================
export {
	// Classes
	MainSide,
	WorkerSide,

	// Constants
	COMM_BUFFER_SIZE,
	KEY_BUFFER_SIZE,
	HEADER_BYTES,
	META_OFFSET,
	META_SIZE,

	// Signals
	SIG_IDLE,
	SIG_DATA,
	SIG_DISCONNECT,
	SIG_RESIZE,

	// Message types
	MSG_OUTPUT,
	MSG_READY,
	MSG_EXIT,
	MSG_ERROR,
	MSG_DB_REQUEST,
	MSG_DB_RESPONSE,
	MSG_FILE_REQUEST,
	MSG_FILE_RESPONSE,
};