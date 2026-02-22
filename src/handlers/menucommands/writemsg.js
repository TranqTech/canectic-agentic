import { BaseSubModule } from "../basesubmodule.js";
import { tEditor } from "../../editors/teditor.js";
import { simpleEditor } from "../../editors/simple.js";

class writeMessage extends BaseSubModule {
	constructor(call, pauseonexit, returntype, message_type, message_target, use_realname) {
		super(call, "WriteMessage");
		this.editor = null;
		this.message_type = message_type;
		this.message_target = message_target;
		this.use_realname = use_realname;
		this.pauseonexit = pauseonexit;
		this.returntype = returntype;

		// Create the appropriate editor
		if (call.use_fse) {
			this.editor = new tEditor(call, pauseonexit, "Command", message_type, message_target, use_realname);
		} else {
			this.editor = new simpleEditor(call, pauseonexit, returntype, message_type, message_target, use_realname);
		}
	}

	_editorReturn() {
		if (this.editor) {
			try { this.editor.clearHandler(); } catch (_) {}
			this.editor = null;
		}
		this.signalReturn();
	}

	// Route input to the editor
	handleInput(inputArray) {
		if (!this.active) return;
		if (this.editor) {
			if (this.editor.input_array) {
				for (var i = 0; i < inputArray.length; i++) {
					this.editor.input_array.push(inputArray[i]);
				}
				this.editor.handleData();
			}
			return;
		}
		// No editor active — any input exits
		super.handleInput(inputArray);
	}

	onKey(key) {
		this.finished = true;
	}

	onChar(ch) {
		this.finished = true;
	}

	run() {
		this.editor.emitter.on("ModuleReturn", () => {
			this._editorReturn();
		});
		this.editor.startStage();
	}

	clearHandler() {
		if (this.editor) {
			try { this.editor.clearHandler(); } catch (_) {}
			this.editor = null;
		}
		super.clearHandler();
	}
}

export { writeMessage };
