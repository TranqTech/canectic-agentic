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

dotenv.config();
alogger.setProcessName('mail');

var systemvermsg = systeminfo.versionMsg();
var imapServer;
var smtpServer;

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
	await appConfig.load();
	alogger.writeAlog(1, systemvermsg + "\n  Mail Process Startup", "yellowbright", true);

	var domain = appConfig.get('mail_domain', '');
	if (!domain) {
		alogger.writeAlog(1, "[Mail] Disabled — mail_domain not configured", "yellow");
		process.exit(0);
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

	if (started === 0) {
		alogger.writeAlog(1, "[Mail] No servers enabled — exiting", "yellow");
		process.exit(0);
	}

	alogger.writeAlog(1, "[Mail] Ready — " + started + " server(s) running", "greenbright", true);
}

await main();
