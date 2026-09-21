// maintenanceWatch.js -- how a running process follows the maintenance flag.
//
// One watcher per process. It checks the flag file every couple of seconds,
// tells the subsystems in the process when maintenance starts, changes, ends
// or reaches its grace deadline, and writes the process's drain status while
// the flag is set.
//
// Subsystems do not know about each other. Each registers a drain source, a
// function returning what it still has in flight as {label: count}, and
// subscribes to the events it cares about. That matters in embedded mode,
// where the gateway process also runs the toss and mailer workers: the one
// status file for the process then reports all of them, without the watcher
// having a hardcoded idea of what lives where.
//
// Polling rather than fs.watch because nothing else in the codebase watches
// files, inotify semantics around an atomic rename are exactly the kind of
// detail that differs by platform and filesystem, and a stat every two seconds
// costs nothing. Polling rather than a Redis event because the flag must work
// when Redis or the database is the thing being worked on.
//
// Builtins only, so it is testable without a database and usable from any
// process. Logging is passed in.

import { EventEmitter } from 'events';
import * as flags from './maintenanceFlag.js';

var DEFAULT_INTERVAL_MS = 2000;

class MaintenanceWatch extends EventEmitter {
	/**
	 * @param {object} opts
	 * @param {string} opts.process        name for the status file: gateway, mail, mailer, worker
	 * @param {string} [opts.root]         install root, default process.cwd()
	 * @param {function} [opts.graceDefault]  returns maintenance_grace_seconds
	 * @param {function} [opts.log]        (level, message) for failures; silent by default
	 * @param {number} [opts.intervalMs]
	 */
	constructor(opts) {
		super();
		var o = opts || {};
		this.processName  = o.process || 'process';
		this.root         = o.root || process.cwd();
		this.graceDefault = typeof o.graceDefault === 'function' ? o.graceDefault : function () { return null; };
		this.log          = typeof o.log === 'function' ? o.log : function () {};
		this.intervalMs   = o.intervalMs || DEFAULT_INTERVAL_MS;

		this._sources   = new Map();
		this._timer     = null;
		this._ticking   = false;
		this._flag      = null;
		this._key       = null;
		this._deadlineFiredFor = null;
	}

	start() {
		if (this._timer) return this;
		this.tick();
		this._timer = setInterval(() => { this.tick(); }, this.intervalMs);
		// A watcher must never be what keeps a process alive.
		if (this._timer.unref) this._timer.unref();
		return this;
	}

	stop() {
		if (this._timer) clearInterval(this._timer);
		this._timer = null;
		flags.clearDrainStatus(this.root, this.processName);
	}

	/**
	 * Report what a subsystem still has in flight.
	 * @param {string} name
	 * @param {function} fn  returns {label: count}, may be async
	 */
	registerDrainSource(name, fn) {
		this._sources.set(name, fn);
	}

	/** The current state, synchronously, as of the last check. */
	current() {
		var flag = this._flag;
		return {
			active:       !!flag,
			flag:         flag,
			deadline:     flag ? flags.deadlineOf(flag, this.graceDefault()) : null,
			expectedBack: flag ? flags.expectedBackOf(flag) : null
		};
	}

	/** Has the grace run out? False when the board is open. */
	pastDeadline(now) {
		var c = this.current();
		if (!c.active) return false;
		return (now ? new Date(now).getTime() : Date.now()) >= c.deadline.getTime();
	}

	/**
	 * Re-read the flag now instead of waiting for the next tick, for a caller
	 * that has just changed it and is about to act on the result.
	 */
	refreshNow() {
		this._apply(flags.readFlag(this.root));
		return this.current();
	}

	async tick() {
		if (this._ticking) return;
		this._ticking = true;
		try {
			this._apply(flags.readFlag(this.root));
			if (this._flag) {
				this._checkDeadline();
				await this._writeStatus();
			}
		} catch (err) {
			this.log(1, 'Maintenance watch (' + this.processName + '): ' + (err && err.message || err));
		} finally {
			this._ticking = false;
		}
	}

	_apply(flag) {
		var prev = this._flag;
		var key = flag ? JSON.stringify(flag) : null;
		if (key === this._key) return;

		this._flag = flag;
		this._key = key;

		// A different `since` is a different closure even if nothing in between
		// saw the board open, so subscribers see a leave and then an enter.
		if (prev && flag && prev.since !== flag.since) {
			this._emitSafe('leave', prev);
			prev = null;
		}

		if (!prev && flag) {
			this._emitSafe('enter', flag);
		} else if (prev && !flag) {
			this._deadlineFiredFor = null;
			flags.clearDrainStatus(this.root, this.processName);
			this._emitSafe('leave', prev);
		} else if (prev && flag) {
			this._emitSafe('change', flag);
		}
	}

	_checkDeadline() {
		var flag = this._flag;
		if (this._deadlineFiredFor === flag.since) return;
		if (!this.pastDeadline()) return;
		this._deadlineFiredFor = flag.since;
		this._emitSafe('deadline', flag);
	}

	async _writeStatus() {
		var pending = {};
		for (var [name, fn] of this._sources) {
			try {
				var counts = await fn();
				for (var label in counts || {}) {
					if (!Object.prototype.hasOwnProperty.call(counts, label)) continue;
					pending[label] = (pending[label] || 0) + (parseInt(counts[label], 10) || 0);
				}
			} catch (err) {
				// A source that cannot answer is not drained: saying otherwise
				// would let the updater stop a process that is mid-job.
				pending[name + ' (unknown)'] = 1;
				this.log(2, 'Maintenance drain source ' + name + ' failed: ' + (err && err.message || err));
			}
		}
		var drained = Object.keys(pending).every(function (k) { return !pending[k]; });
		// The flag may have been cleared while the sources were answering.
		if (!this._flag) return;
		flags.writeDrainStatus(this.root, this.processName, {
			since:    this._flag.since,
			drained:  drained,
			pending:  pending,
			deadline: this.current().deadline
		});
	}

	_emitSafe(event, flag) {
		// A subscriber that throws must not stop the others hearing about it,
		// or one broken subsystem would leave the rest of the process open.
		for (var listener of this.listeners(event)) {
			try {
				var r = listener(flag);
				if (r && typeof r.catch === 'function') {
					r.catch((err) => {
						this.log(1, 'Maintenance ' + event + ' handler failed: ' + (err && err.message || err));
					});
				}
			} catch (err) {
				this.log(1, 'Maintenance ' + event + ' handler failed: ' + (err && err.message || err));
			}
		}
	}
}

// One per process. Modules that need it import the accessor rather than
// having the instance threaded through every constructor.
var instance = null;

function initMaintenanceWatch(opts) {
	if (instance) return instance;
	instance = new MaintenanceWatch(opts);
	return instance;
}

/** The process's watcher, or null before init (tests, CLI tools). */
function maintenanceWatch() {
	return instance;
}

/** Safe from anywhere: the board's state, or open when nothing is watching. */
function currentMaintenance() {
	return instance ? instance.current() : { active: false, flag: null, deadline: null, expectedBack: null };
}

// Tests only.
function _resetForTests() {
	if (instance) instance.stop();
	instance = null;
}

export {
	MaintenanceWatch,
	initMaintenanceWatch,
	maintenanceWatch,
	currentMaintenance,
	_resetForTests
};
