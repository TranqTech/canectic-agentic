/**
 * The mailer queue's work, in one place.
 *
 * Two processes consume the `mailer` queue: the standalone mailer
 * (`bin/mailer.js`) and the embedded consumer the gateway starts under
 * PROCESS_MODE=embedded when it runs the mailer in-process
 * (`src/queues/embedded.js`). They were two switch statements over the same
 * job names, and the embedded one had fallen behind: it had no case for
 * `bso-scan` or `nodelist-connect`, so on an embedded board the scan the
 * tossers ask for after writing outbound packets, and the admin's connect to a
 * nodelist address, were logged as unknown and did nothing. The same drift the
 * maintenance queue had before maintenanceJobs.js; the same cure.
 */

/** Every job name the mailer queue carries. tests/mailerJobs.test.js holds the producers to it. */
var MAILER_JOBS = ['signal-outbound', 'trigger-poll', 'poll-scheduled', 'nodelist-connect', 'bso-scan'];

/**
 * Run one mailer job against a MailerManager.
 * @returns {Promise<boolean>} false for a name this does not handle, so the
 *   caller can log it as unknown rather than report success
 */
async function runMailerJob(manager, name, data) {
	var d = data || {};
	switch (name) {
		case 'signal-outbound':
			// A tosser wrote outbound packets: CRASH connections poll at once,
			// NORMAL ones wait for their schedule.
			await manager.signalOutbound(d.connectionUUID);
			return true;
		case 'trigger-poll':
			// The admin's poll button: bypasses the guards, always connects.
			await manager.triggerPoll(d.connectionUUID);
			return true;
		case 'poll-scheduled':
			// A repeatable schedule: a normal poll with every guard.
			await manager.pollConnection(d.connectionUUID);
			return true;
		case 'nodelist-connect':
			// Connect to a nodelist-resolved address with no peer record.
			// Not awaited, as before: the session outlives the job.
			manager.connectToNodelistAddress(d.nodelistData, d.destinationAddress);
			return true;
		case 'bso-scan':
			// On-demand BSO scan, asked for by the tossers after writing packets.
			await manager.scanOutboundNow();
			return true;
		default:
			return false;
	}
}

export { MAILER_JOBS, runMailerJob };
