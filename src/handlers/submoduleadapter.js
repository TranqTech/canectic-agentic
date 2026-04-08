import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";

/**
 * SubModuleAdapter wraps a BaseSubModule so it can be used as a standalone
 * call-flow stage (i.e. registered in handlerRegistry and loaded by loadHandler).
 *
 * It provides:
 *   - Inactivity timeouts (from BaseHandler) that own the timeout lifecycle
 *   - Input routing to the wrapped sub-module
 *   - Proper cleanup on return or hangup
 *
 * When the same sub-module class is run from MenuHandler via _runSubModule(),
 * it runs directly as a BaseSubModule — no adapter, no extra timeouts.
 * This eliminates the cascading/orphan timeout problem.
 */
class SubModuleAdapter extends BaseHandler {
	constructor(call, SubModuleClass, handlerType, options) {
		super(call, handlerType || "SubModuleAdapter");
		this.SubModuleClass = SubModuleClass;
		this._options = options || null;
		this.module = null;
	}

	startStage() {
		if (!this.call) return;
		try {
			this.module = this._options
				? new this.SubModuleClass(this.call, this._options)
				: new this.SubModuleClass(this.call);

			this.module.emitter.on("ModuleReturn", () => {
				this._onModuleReturn();
			});

			this.module.emitter.on("HangupSignal", () => {
				this.emitter.emit("HangupSignal");
			});

			this.module.startStage();
			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("startStage error", err);
		}
	}

	handleInput(inputArray) {
		if (!this.active) return;
		this._clearAllTimeouts();

		if (this.module && this.module.active) {
			this.module.handleInput(inputArray);

			// module may have been nulled by _onModuleReturn firing
			// synchronously from inside handleInput (via signalReturn)
			if (!this.module || !this.active) return;

			if (this.module.finished) {
				this._onModuleReturn();
				return;
			}
		}

		if (this.active && !this.finished) {
			this.setInactivityTimeouts();
		}
	}

	_onModuleReturn() {
		if (this.module) {
			try {
				this.module.clearHandler();
			} catch (_) {}
			this.module = null;
		}
		this.finished = true;
		this.emitter.emit("ModuleReturn");
	}

	clearHandler() {
		if (this.module) {
			try {
				this.module.clearHandler();
			} catch (_) {}
			this.module = null;
		}
		super.clearHandler();
	}
}

export { SubModuleAdapter };