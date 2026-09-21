// queueDrain.js -- pausing BullMQ consumers for maintenance mode.
//
// Used by the worker process, by embedded mode (which runs the same consumers
// inside the gateway) and by the mailer's queue consumer, so the rule lives in
// one place rather than three that drift apart. The maintenance job switch
// drifted exactly that way once, and embedded mode spent months silently
// completing 26 of 33 jobs without doing them.
//
// Pausing is local: Worker.pause() stops this process fetching new jobs and
// resolves when the jobs it already holds have finished. Jobs enqueued in the
// meantime wait in Redis and run when the board reopens, which is the whole
// point: nothing is lost, it is just not started.
//
// A consumer paused before it ever ran must still report paused, not stopped.
// The worker's self-check exits the process when a consumer reports neither
// running nor paused, and a worker that restarts during maintenance would then
// come back unpaused and start work in the middle of it. startClosed() is for
// that case: construct with autorun off, then pause.

import * as flags from './maintenanceFlag.js';

/**
 * Should a consumer created now start paused? Checked synchronously at
 * startup, before the watcher's first tick, so a process that starts on a
 * closed board cannot pick up a job in between.
 */
function startClosed(root) {
	return flags.isActive(root || process.cwd());
}

/**
 * Pause and resume consumers as the board closes and opens, and report their
 * in-flight jobs as a drain source.
 *
 * @param {MaintenanceWatch} watch
 * @param {Array<{name:string, worker:object}>} consumers  BullMQ Workers
 * @param {function} activeCounts  returns {label: count} of jobs in flight, may be async
 * @param {function} [log]         (level, message)
 */
function attachQueueDrain(watch, consumers, activeCounts, log) {
	var say = typeof log === 'function' ? log : function () {};
	var list = (consumers || []).filter(function (c) { return c && c.worker; });

	watch.registerDrainSource('queues', activeCounts);

	watch.on('enter', async function () {
		for (var c of list) {
			if (c.worker.isPaused()) continue;
			say(2, 'Maintenance: pausing ' + c.name + ' queue; jobs in flight will finish, new ones wait');
			// Not awaited in sequence: pausing one consumer must not wait on
			// another's long job before the second stops taking new work.
			(function (consumer) {
				consumer.worker.pause().then(function () {
					say(2, 'Maintenance: ' + consumer.name + ' queue paused and idle');
				}).catch(function (err) {
					say(1, 'Maintenance: could not pause ' + consumer.name + ' queue: ' + (err && err.message || err));
				});
			})(c);
		}
	});

	watch.on('leave', async function () {
		for (var c of list) {
			if (!c.worker.isPaused() && c.worker.isRunning()) continue;
			try {
				await c.worker.resume();
				say(2, 'Maintenance over: ' + c.name + ' queue resumed');
			} catch (err) {
				say(1, 'Maintenance over, but ' + c.name + ' queue did not resume: ' + (err && err.message || err));
			}
		}
	});
}

/** Consumer health for a heartbeat: paused for maintenance is not down. */
function consumerUp(worker) {
	return !!(worker && (worker.isRunning() || worker.isPaused()));
}

export {
	startClosed,
	attachQueueDrain,
	consumerUp
};
