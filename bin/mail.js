#!/usr/bin/env node

/**
 * Canectic BBS — Mail Process
 *
 * Runs IMAP and SMTP servers as a standalone process, isolated from the
 * terminal gateway.  This prevents mail client activity from blocking
 * terminal sessions and vice versa.
 *
 * IMAP: maps BBS private messages to standard IMAP mailboxes
 * SMTP: submission-only server for sending PMs from mail clients
 *
 * Cross-process communication:
 *   - Subscribes to PM_DELIVERED events (push to IDLE clients)
 *   - Publishes PM_READ_CHANGED events (sync read status to gateway)
 *   - Subscribes to CONFIG_CHANGED events (reload appConfig)
 *
 * With no mail_domain (or every mail port 0) it waits rather than exiting, so
 * pm2 does not restart it in a loop, and starts its servers when a CONFIG_CHANGED
 * reload makes mail possible.
 *
 * Usage:
 *   node bin/mail.js
 *
 * Environment:
 *   imapport       — IMAP listener port (default: 10143, 0 = disabled)
 *   smtpport       — SMTP listener port (default: 10587, 0 = disabled)
 *   mail_domain    — Required domain for addressing (e.g. mybbs.example.com)
 */

import * as dotenv from 'dotenv';
import * as alogger from "../src/utils/alogger.js";
import * as systeminfo from "../src/utils/systeminfo.js";
import { pgpool } from "../src/middleware/db/postgres.js";
import * as redis from "../src/middleware/db/redis.js";
import { ImapServer } from "../src/servers/imapServer.js";
import { SmtpServer } from "../src/servers/smtpServer.js";
import appConfig from "../src/config/appConfig.js";
import { initMaintenanceWatch } from "../src/maintenance/maintenanceWatch.js";
import { isActive as isMaintenanceActive } from "../src/maintenance/maintenanceFlag.js";
import { createEventSubscriber, EVENTS } from "../src/queues/events.js";
import { mailDisabledReason } from "../src/servers/mailStartup.js";

dotenv.config();
alogger.setProcessName('mail');

var systemvermsg = systeminfo.versionMsg();
var imapServer;
var smtpServer;
var inboundSmtpServer;
var configSubscriber;
var serversStarted = false;
var serversStarting = false;

// ---------------------------------------------------------------------------
// Safety catches
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
	alogger.writeAlog(0, `[Mail] Uncaught exception: ${err.stack}`, "redbright");
});

process.on('unhandledRejection', (reason) => {
	alogger.writeAlog(0, `[Mail] Unhandled rejection: ${reason}`, "redbright");
});

async function shutdown() {
	alogger.writeAlog(1, "[Mail] Shutting down", "yellowbright", true);
	if (imapServer) imapServer.stop();
	if (smtpServer) smtpServer.stop();
	if (inboundSmtpServer) inboundSmtpServer.stop();
	if (configSubscriber) configSubscriber.shutdown();
	alogger.shutdownLogBus();
	pgpool.end();
	redis.shutdown();
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
	await alogger.initLogBus();

	// Startup validation: fail fast if DB or Redis is unreachable
	try {
		await pgpool.query('SELECT 1');
	} catch (err) {
		alogger.writeAlog(0, "PostgreSQL is not reachable: " + err.message, "redbright", true);
		process.exit(1);
	}
	try {
		var rc = await redis.getClient();
		await rc.ping();
	} catch (err) {
		alogger.writeAlog(0, "Redis is not reachable: " + err.message, "redbright", true);
		process.exit(1);
	}

	await appConfig.load();
	alogger.writeAlog(1, systemvermsg + "\n  Mail Process Startup", "yellowbright", true);

	// One subscriber for the life of the process. It reloads config in every
	// mode (the IMAP server has its own, so an SMTP-only process used to get
	// none), and it is what wakes a process that is waiting for mail to be
	// configured.
	configSubscriber = createEventSubscriber(function (event) {
		if (event.type !== EVENTS.CONFIG_CHANGED) return;
		appConfig.reload().then(function () {
			if (!serversStarted) return startIfConfigured(false);
		}).catch(function (err) {
			alogger.writeAlog(1, '[Mail] Config reload failed: ' + err.message, 'redbright');
		});
	});

	await startIfConfigured(true);
}

/**
 * Start the servers if mail is configured; otherwise wait, quietly.
 *
 * It used to exit, and pm2 restarts anything that exits, so a board without a
 * mail domain (every fresh install) restarted this process every few seconds
 * until pm2 gave up. Waiting keeps it online and idle, and saving a mail domain
 * in /admin/config starts the servers without a restart.
 */
async function startIfConfigured(atStartup) {
	if (serversStarted || serversStarting) return;
	var reason = mailDisabledReason(appConfig);
	if (reason) {
		if (atStartup) {
			alogger.writeAlog(1, '[Mail] Waiting: ' + reason + '. Set it in /admin/config and the mail servers start ' +
				'without a restart.', 'yellow');
		}
		return;
	}
	serversStarting = true;
	try {
		await startServers();
		serversStarted = true;
	} finally {
		serversStarting = false;
	}
}

async function startServers() {
	var domain = appConfig.get('mail_domain', '');

	// Ensure PM attachments schema
	var pmAttachments = await import("../src/models/pmAttachments.js");
	await pmAttachments.ensureTable();

	// Seed the MSGID counter in Redis from DB state for today's day bucket.
	// Idempotent across processes; mail.js participates because SMTP
	// submission can stamp new outbound messages with @MSGID kludges.
	try {
		var ftnUtilsInit = await import("../src/utils/ftnUtils.js");
		await ftnUtilsInit.initializeMsgidCounter();
	} catch (e) {
		alogger.writeAlog(2, '[Mail] MSGID counter init failed: ' + e.message, 'yellow');
	}

	var started = 0;

	// IMAP server
	var imapport = appConfig.getNumber('imapport', 10143);
	if (imapport && imapport > 0) {
		imapServer = new ImapServer(imapport, domain);
		imapServer.start();
		started++;
	} else {
		alogger.writeAlog(2, "[Mail] IMAP disabled (imapport = 0)", "yellow");
	}

	// SMTP server
	var smtpport = appConfig.getNumber('smtpport', 10587);
	if (smtpport && smtpport > 0) {
		smtpServer = new SmtpServer(smtpport, domain);
		smtpServer.start();
		started++;
	} else {
		alogger.writeAlog(2, "[Mail] SMTP disabled (smtpport = 0)", "yellow");
	}

	// Inbound SMTP (trusted gateway injection from external MTA)
	var inboundPort = appConfig.getNumber('email_inbound_port', 0);
	if (inboundPort && inboundPort > 0) {
		var trustedHosts = appConfig.get('email_trusted_hosts', '127.0.0.1');
		inboundSmtpServer = new SmtpServer(inboundPort, domain, {
			trusted: true,
			trustedHosts: trustedHosts
		});
		inboundSmtpServer.start();
		started++;
	}

	// mailDisabledReason() has already checked that at least one port is set.

	// Maintenance mode: refuse new mail client connections while the board is
	// closed and close the ones still open when the grace runs out. Set before
	// the first watcher tick, so a restart onto a closed board takes nobody in.
	var servers = [imapServer, smtpServer, inboundSmtpServer].filter(Boolean);
	var closedAtStart = isMaintenanceActive(process.cwd());
	for (var srv of servers) srv.setMaintenance(closedAtStart);

	var maintLog = function (level, message) { alogger.writeAlog(level, '[Mail] ' + message, 'yellowbright'); };
	var watch = initMaintenanceWatch({
		process: 'mail',
		graceDefault: function () { return appConfig.getNumber('maintenance_grace_seconds', 300); },
		log: maintLog
	});
	watch.on('enter', function () {
		for (var s of servers) s.setMaintenance(true);
		maintLog(2, 'Maintenance: refusing new mail client connections');
	});
	watch.on('leave', function () {
		for (var s of servers) s.setMaintenance(false);
		maintLog(2, 'Maintenance over: accepting mail client connections');
	});
	watch.on('deadline', function () {
		for (var s of servers) s.closeSessionsForMaintenance();
	});
	watch.registerDrainSource('mail', function () {
		return {
			'IMAP sessions': imapServer ? imapServer.sessions.size : 0,
			'SMTP sessions': (smtpServer ? smtpServer.sessions.size : 0) +
				(inboundSmtpServer ? inboundSmtpServer.sessions.size : 0)
		};
	});
	watch.start();

	alogger.writeAlog(1, "[Mail] Ready — " + started + " server(s) running", "greenbright", true);
}

await main();
