import { EventEmitter } from 'node:events';

const DEFAULT_MAX_LINES = 2000;

class OutputRingBuffer {
	constructor(maxLines) {
		this.maxLines = maxLines || DEFAULT_MAX_LINES;
		this.lines = [];
		this.currentLine = Buffer.alloc(0);
		this.emitter = new EventEmitter();
		// Cap listeners since multiple snoop sessions might attach
		this.emitter.setMaxListeners(20);
	}

	// Write data into the buffer — call this wherever you send data to the client
	write(data) {
		var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

		// Emit raw data for any live watchers
		this.emitter.emit("data", buf);

		// Split on newlines to maintain line-based ring buffer
		var i = 0;
		while (i < buf.length) {
			var newlineIdx = buf.indexOf(0x0A, i); // \n
			if (newlineIdx === -1) {
				// No more newlines — append remainder to current line
				this.currentLine = Buffer.concat([this.currentLine, buf.subarray(i)]);
				break;
			}

			// Found a newline — complete the current line
			var segment = buf.subarray(i, newlineIdx + 1);
			this.currentLine = Buffer.concat([this.currentLine, segment]);
			this.lines.push(this.currentLine);
			this.currentLine = Buffer.alloc(0);

			// Trim if over max
			if (this.lines.length > this.maxLines) {
				this.lines.shift();
			}

			i = newlineIdx + 1;
		}
	}

	// Get buffered content for catch-up — returns a single Buffer
	getHistory() {
		var parts = this.lines.slice();
		if (this.currentLine.length > 0) {
			parts.push(this.currentLine);
		}
		return Buffer.concat(parts);
	}

	// Get line count
	getLineCount() {
		return this.lines.length + (this.currentLine.length > 0 ? 1 : 0);
	}

	clear() {
		this.lines = [];
		this.currentLine = Buffer.alloc(0);
	}

	destroy() {
		this.emitter.emit("end");
		this.emitter.removeAllListeners();
		this.lines = [];
		this.currentLine = Buffer.alloc(0);
	}
}

export { OutputRingBuffer };