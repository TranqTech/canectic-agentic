import { BaseSubModule } from "../basesubmodule.js";
import { simpleMessageReader } from "../../readers/simplereader.js";
import { tranqMessageReader } from "../../readers/treader.js";

class readMessages extends BaseSubModule {
	constructor(call) {
		super(call, "ReadMessages");
		this.msg_area = call.msg_area || "";
		this.current_message_idx = call.current_message_idx || 0;
		this.msgReader = null;
	}

	_startReader() {
		if (this.call.use_reader === "tranqMessageReader") {
			this.msgReader = new tranqMessageReader(this.call, this.msg_area, this.current_message_idx);
		} else {
			this.msgReader = new simpleMessageReader(this.call, this.msg_area, this.current_message_idx);
		}

		this.msgReader.emitter.on("ModuleReturn", () => {
			this._readerReturn();
		});

		this.msgReader.startStage();
	}

	_readerReturn() {
		if (this.msgReader) {
			try { this.msgReader.clearHandler(); } catch (_) {}
			this.msgReader = null;
		}
		this.signalReturn();
	}

	// Route input to the reader
	handleInput(inputArray) {
		if (!this.active) return;
		if (this.msgReader) {
			// Reader uses legacy input_array/handleData
			if (this.msgReader.input_array) {
				for (var i = 0; i < inputArray.length; i++) {
					this.msgReader.input_array.push(inputArray[i]);
				}
				this.msgReader.handleData();
			}
			return;
		}
		// No reader active — any input exits
		super.handleInput(inputArray);
	}

	onKey(key) {
		this.finished = true;
	}

	onChar(ch) {
		this.finished = true;
	}

	run() {
		this._startReader();
	}

	clearHandler() {
		if (this.msgReader) {
			try { this.msgReader.clearHandler(); } catch (_) {}
			this.msgReader = null;
		}
		super.clearHandler();
	}
}

export { readMessages };
