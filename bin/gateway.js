#!/usr/bin/env node

//requires

//internal modules
import chalk from 'chalk';
import * as alogger from "../src/utils/alogger.js"
import {WsManager, WsPool} from "../src/servers/websockets.js"
import { TcpPool, TcpServer } from "../src/servers/tcpserver.js"
import { RloginServer } from "../src/servers/rloginserver.js"
import { TelnetPool, TelnetServer } from "../src/servers/telnetserver.js"
import { TerminalPool, TerminalServer } from "../src/servers/terminalserver.js"
import { ImapServer } from "../src/servers/imapServer.js"
import { SmtpServer } from "../src/servers/smtpServer.js"
import { PresenceServer } from "../src/servers/presenceSocket.js"
import * as dotenv from 'dotenv';
import * as systeminfo from "../src/utils/systeminfo.js"
import * as http from "http"
import {CallManager, CallPool, loadFlowsFromDB} from "../src/managers/callmanager.js"
import {nodeManager} from "../src/managers/nodemanager.js"
import { SocatManager } from "../src/managers/socatmanager.js";
import {webserver} from "../src/servers/webserver.js"
import { pgpool } from "../src/middleware/db/postgres.js";
import * as redis from "../src/middleware/db/redis.js";
import * as userMsgPointers from '../src/models/userMsgPointers.js';
import * as userAreaSubs from '../src/models/userAreaSubs.js';
import * as userFilePointers from '../src/models/userFilePointers.js';
import * as userFileSubs from '../src/models/userFileSubs.js';
import { ensureQwkConfNumbers } from '../src/models/msgAreas.js';
import * as callFlowsModel from '../src/models/callFlows.js';
import { seedDefaultTheme } from '../src/models/themes.js';
import { seedDefaults as seedNodelistFlags } from '../src/models/nodelistFlags.js';
import { seedBuiltinEvents as seedTemplateEvents } from '../src/models/messageTemplates.js';

// --- Queue infrastructure ---
import { closeQueues, tossQueue, mailerQueue, maintenanceQueue } from "../src/queues/queues.js";
import * as jobs from "../src/queues/jobs.js";
import { createEventSubscriber, EVENTS } from "../src/queues/events.js";
import { registerSchedules } from "../src/queues/schedules.js";
import { auditQwkIdsAndNotify } from '../src/maintenance/qwkIdAudit.js'
import { startQwkFtpServer } from '../src/servers/qwkFtpServer.js'
import { startWorkerWatchdog } from "../src/queues/workerWatchdog.js";
import { registerLogWebSocket } from "../src/routes/adminLogs.js";
import { registerNodeSpyWebSocket } from "../src/servers/nodespySocket.js";
import appConfig from "../src/config/appConfig.js";
import { initMaintenanceWatch } from "../src/maintenance/maintenanceWatch.js";
import { attachTerminalDrain } from "../src/maintenance/terminalDrain.js";
import { attachWebDrain } from "../src/maintenance/webDrain.js";
import { startClosed, attachQueueDrain } from "../src/maintenance/queueDrain.js";

dotenv.config();
alogger.setProcessName('gateway');

//variable setup
const systemver = systeminfo.softwareVersion()
const vsoftwarename = systeminfo.softwareName()
const systemvermsg = systeminfo.versionMsg()
var systemstartupmsg = systemvermsg + "\n  Gateway Startup"
var systemshutdownmsg = systemvermsg + "\n  Gateway Shutdown"
const webport = process.env.webport || 8080
const processMode = process.env.PROCESS_MODE || 'separate';
var runwssrv = true
var runtcpsrv = true
var servercount = 0
var callservcount = 0
var lastservercount = 0
var wsManager
var presenceServer
var callManager
var primaryNodeManager
var socatManager
var httpServer
var tcpServer         // TCP terminal server (legacy, use terminalServer instead)
var rloginServer      // RLogin door-server access (#86), when enabled
var telnetServer      // Telnet terminal server (legacy, use terminalServer instead)
var terminalServer    // Unified TCP/Telnet auto-detect server
var imapServer        // IMAP server for PM access
var smtpServer        // SMTP submission server for sending PMs
var eventSubscriber
var embeddedWorkers   // only used in embedded mode
var maintWatch        // follows the maintenance mode flag, see startMaintenanceWatch()
var mailerManager     // only used in embedded mode

// --- Configuration ---

// Hardcoded fallbacks (used if DB is empty)
var fallbackWsPaths = [
	{name: "Doorserver", path: "/ws/doorserver", callpool: "Doorserver"},
	{name: "WebDoor",    path: "/ws/webdoor",    callpool: "WebDoor"},
	{name: "Catchall",   path: "/",             callpool: "PrimaryBBS"},
	{name: "BBS",        path: "/ws/bbs",       callpool: "PrimaryBBS"},
]

var fallbackCallPools = [
	{name: "PrimaryBBS",  floworder: "Standard"},
	{name: "Doorserver",  floworder: "Doorserver"},
	{name: "WebDoor",     floworder: "WebDoor"},
]

// Runtime pools/paths (populated from DB or fallbacks)
var callpools = [];
var wspaths = [];

// --- Runtime lookups (populated during startup) ---
var callPoolMap = {}   // name -> CallPool instance
var wsPoolMap = {}     // name -> WsPool instance

//global safety catch
process.on('uncaughtException', (err) => {
	alogger.writeAlog(0, `Uncaught exception: ${err.stack}`, "redbright");
});

process.on('unhandledRejection', (reason) => {
	alogger.writeAlog(0, `Unhandled rejection: ${reason}`, "redbright");
});

process.on('SIGINT', async () => {
	if (embeddedWorkers) await embeddedWorkers.shutdown();
	if (mailerManager) mailerManager.stop();
	if (eventSubscriber) eventSubscriber.shutdown();
	if (tcpServer) tcpServer.stop();
	if (presenceServer) presenceServer.shutdown();
	alogger.shutdownLogBus();
	await closeQueues();
	socatManager.shutdown();
	pgpool.end();
	redis.shutdown();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	if (embeddedWorkers) await embeddedWorkers.shutdown();
	if (mailerManager) mailerManager.stop();
	if (eventSubscriber) eventSubscriber.shutdown();
	if (tcpServer) tcpServer.stop();
	if (presenceServer) presenceServer.shutdown();
	alogger.shutdownLogBus();
	await closeQueues();
	socatManager.shutdown();
	process.exit(0);
});

async function prerunMaint(){
	await userMsgPointers.ensureConstraintsAndIndexes();
	await userAreaSubs.ensureConstraintsAndIndexes();
	await userFilePointers.ensureConstraintsAndIndexes();
	await userFileSubs.ensureConstraintsAndIndexes();
	await ensureQwkConfNumbers();

	// Ensure news files table exists
	var newsFiles = await import("../src/models/newsFiles.js");
	await newsFiles.ensureTable();

	// Ensure the QWK conference start constraint. Column definitions for
	// groups and areas are managed by dbmigrations from db/schema, not here.
	var msgGroupsMod = await import("../src/models/msgGroups.js");
	await msgGroupsMod.ensureQwkConfStartConstraint();

	// Ensure PM attachments table and columns
	var pmAttachments = await import("../src/models/pmAttachments.js");
	await pmAttachments.ensureTable();

	// Ensure notifications table
	var notifMod = await import("../src/models/notifications.js");
	await notifMod.ensureTable();

	// Ensure FREQ magic table
	var freqMod = await import("../src/models/freq.js");
	await freqMod.ensureTable();

	// Ensure seasonal art table, seed defaults, create directories, prime cache
	var seasonalArt = await import("../src/models/seasonalArt.js");
	await seasonalArt.ensureTable();
	seasonalArt.ensureArtDirectories();
	await seasonalArt.refreshSeasonCache();

	// Ensure call flow column exists on users table
	try {
		await pgpool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_callflow_at TIMESTAMP");
	} catch (_) {}

	// Seed and load call flows/pools from DB
	await callFlowsModel.seedDefaults();
	await loadFlowsFromDB();

	// Build runtime pool/path arrays from DB (fallback to hardcoded)
	try {
		var dbPools = await callFlowsModel.getActivePools();
		if (dbPools && dbPools.length > 0) {
			callpools = dbPools.map(function(p) {
				return { name: p.name, floworder: p.flow_name };
			});
			// Build WS paths from pool ws_paths JSONB
			wspaths = [];
			for (var p of dbPools) {
				var paths = p.ws_paths;
				if (typeof paths === 'string') { try { paths = JSON.parse(paths); } catch(_) { paths = []; } }
				if (!Array.isArray(paths)) paths = [];
				for (var wsPath of paths) {
					wspaths.push({ name: p.name, path: wsPath, callpool: p.name });
				}
			}
			alogger.writeAlog(5, '  Loaded ' + dbPools.length + ' call pool(s) from DB', 'cyan');
		}
	} catch (err) {
		alogger.writeAlog(3, '  Failed to load call pools from DB: ' + err.message, 'yellow');
	}

	// Fallback to hardcoded if DB returned nothing
	if (callpools.length === 0) {
		callpools = fallbackCallPools;
		wspaths = fallbackWsPaths;
		alogger.writeAlog(5, '  Using fallback call pools (DB empty)', 'yellow');
	}
}

async function startSocatManager(){
	socatManager = new SocatManager();
}

async function startNodeManager(){
	primaryNodeManager = new nodeManager
	alogger.writeAlog(1, "Starting NodeManager", "yellowbright", true)
	primaryNodeManager.listUsedNodes()
	// Expose to Express routes (for who's online, nodespy, etc.)
	webserver.locals.nodeManager = primaryNodeManager;
}

async function startQwkFtp() {
	if (!appConfig.getBoolean('qwk_ftp_enabled', false)) return
	var port = appConfig.getNumber('qwk_ftp_port', 8021)
	if (!(port > 0)) {
		alogger.writeAlog(2, "  QWK hub FTP server is enabled but qwk_ftp_port is not a port; not started", "yellow")
		return
	}
	try {
		var ftp = await startQwkFtpServer({
			port: port,
			pasvAddress: appConfig.get('qwk_ftp_pasv_address', ''),
			pasvPorts: appConfig.get('qwk_ftp_pasv_ports', '')
		})
		alogger.writeAlog(3, "  QWK hub FTP server listening on port " + ftp.port, "greenbright")
	} catch (err) {
		// A board whose FTP port is taken still has everything else.
		alogger.writeAlog(1, "  QWK hub FTP server could not start on port " + port + ": " + err.message, "redbright")
	}
}

async function startWebServer(){
	httpServer = http.createServer(webserver);
	alogger.writeAlog(1, "Starting Public Webserver", "bluebright")

	httpServer.listen(webport, () => {
		alogger.writeAlog(1, "HTTP running on port " + webport, "bluebright");
		servercount += 1
	})
}

async function startCallPools(){
	alogger.writeAlog(1, "Starting Call Manager", "cyanbright", true)
	callManager = new CallManager(primaryNodeManager)
	callManager.socatManager = socatManager;

	for (var poolcfg of callpools) {
		var pool = callManager.createNewPool(poolcfg.name)
		pool.floworder = poolcfg.floworder
		pool.socatManager = socatManager;
		callPoolMap[poolcfg.name] = pool

		alogger.writeAlog(2, "  Created call pool: " + poolcfg.name + " (flow: " + poolcfg.floworder + ")", "cyan")
	}

	callManager.listPools()
	// Expose to Express routes (for nodespy, etc.)
	webserver.locals.callManager = callManager;
}

async function startWebsockets(){
	wsManager = new WsManager(httpServer);

	for (var wscfg of wspaths) {
		var wsPool = wsManager.createNewPool(wscfg.path, wscfg.name + " Websocket Pool")
		wsPoolMap[wscfg.name] = wsPool

		// Link to the named call pool
		var targetPool = callPoolMap[wscfg.callpool]
		if (targetPool) {
			wsPool.setCallPool(targetPool)
			alogger.writeAlog(2, "  WS path " + wscfg.path + " -> call pool: " + wscfg.callpool, "cyan")
		} else {
			alogger.writeAlog(3, "  WS path " + wscfg.path + " has no matching call pool: " + wscfg.callpool, "yellowbright")
		}
	}

	// Register presence WebSocket (heartbeat/online tracking, chat, notifications)
	presenceServer = new PresenceServer();
	presenceServer.init(httpServer);
	wsManager.registerHandler('/ws/presence', presenceServer);
	alogger.writeAlog(2, "  Presence WebSocket registered on /ws/presence", "cyan");

	// Connect notification system to PresenceServer for real-time push
	var notifConnect = await import("../src/models/notifications.js");
	notifConnect.setPresenceServer(presenceServer);

	servercount += 1
	callservcount += 1
}

// --- TCP terminal server ---

async function startTcpServer(){
	var tcpport = appConfig.getNumber('tcpport', 2023);
	if (!tcpport || tcpport <= 0) {
		alogger.writeAlog(2, "  TCP terminal server disabled (tcpport = 0)", "yellow");
		return;
	}

	var tcpPool = new TcpPool("TCP Terminal Pool");
	var targetPool = callPoolMap["PrimaryBBS"];
	if (targetPool) {
		tcpPool.setCallPool(targetPool);
		alogger.writeAlog(2, "  TCP pool -> call pool: PrimaryBBS", "cyan");
	} else {
		alogger.writeAlog(3, "  TCP pool has no matching call pool", "yellowbright");
	}

	tcpServer = new TcpServer(tcpport, tcpPool);
	tcpServer.start();
	servercount += 1;
	callservcount += 1;
}

// RLogin door-server access (#86), off unless doorserver_rlogin_enabled
async function startRloginServer(){
	if (!appConfig.getBoolean('doorserver_rlogin_enabled', false)) return;
	var port = appConfig.getNumber('doorserver_rlogin_port', 5513);
	var targetPool = callPoolMap["Doorserver"];
	if (!port || !targetPool) {
		alogger.writeAlog(2, "  RLogin door server not started (no port, or no Doorserver pool)", "yellow");
		return;
	}
	rloginServer = new RloginServer(port, targetPool);
	rloginServer.start();
	servercount += 1;
}

async function startTelnetServer(){
	var telnetport = appConfig.getNumber('telnetport', 23);
	if (!telnetport || telnetport <= 0) {
		alogger.writeAlog(2, "  Telnet terminal server disabled (telnetport = 0)", "yellow");
		return;
	}

	var telnetPool = new TelnetPool("Telnet Terminal Pool");
	var targetPool = callPoolMap["PrimaryBBS"];
	if (targetPool) {
		telnetPool.setCallPool(targetPool);
		alogger.writeAlog(2, "  Telnet pool -> call pool: PrimaryBBS", "cyan");
	} else {
		alogger.writeAlog(3, "  Telnet pool has no matching call pool", "yellowbright");
	}

	telnetServer = new TelnetServer(telnetport, telnetPool);
	telnetServer.start();
	servercount += 1;
	callservcount += 1;
}

async function startTerminalServer(){
	var termport = appConfig.getNumber('terminalport', 2023);
	if (!termport || termport <= 0) {
		alogger.writeAlog(2, "  Terminal server disabled (terminalport = 0)", "yellow");
		return;
	}

	var termPool = new TerminalPool("Terminal Pool");
	var targetPool = callPoolMap["PrimaryBBS"];
	if (targetPool) {
		termPool.setCallPool(targetPool);
		alogger.writeAlog(2, "  Terminal pool -> call pool: PrimaryBBS", "cyan");
	} else {
		alogger.writeAlog(3, "  Terminal pool has no matching call pool", "yellowbright");
	}

	terminalServer = new TerminalServer(termport, termPool);
	terminalServer.start();
	servercount += 1;
	callservcount += 1;
}

async function startImapServer(){
	var imapport = appConfig.getNumber('imapport', 10143);
	if (!imapport || imapport <= 0) {
		alogger.writeAlog(2, "  IMAP server disabled (imapport = 0)", "yellow");
		return;
	}
	var domain = appConfig.get('mail_domain', '');
	if (!domain) {
		alogger.writeAlog(2, "  IMAP server disabled (mail_domain not configured)", "yellow");
		return;
	}

	imapServer = new ImapServer(imapport, domain);
	imapServer.setMaintenance(startClosed());
	imapServer.start();
	servercount += 1;
}

async function startSmtpServer(){
	var smtpport = appConfig.getNumber('smtpport', 10587);
	if (!smtpport || smtpport <= 0) {
		alogger.writeAlog(2, "  SMTP server disabled (smtpport = 0)", "yellow");
		return;
	}
	var domain = appConfig.get('mail_domain', '');
	if (!domain) {
		alogger.writeAlog(2, "  SMTP server disabled (mail_domain not configured)", "yellow");
		return;
	}

	smtpServer = new SmtpServer(smtpport, domain);
	smtpServer.setMaintenance(startClosed());
	smtpServer.start();
	servercount += 1;
}

// --- Event subscriber ---
// Listens for cross-process events from the worker and mailer

async function startEventSubscriber(){
	eventSubscriber = createEventSubscriber(async (event) => {
		switch (event.type) {
			case EVENTS.MESSAGES_IMPORTED:
				alogger.writeAlog(3, `[Event] Messages imported: ${JSON.stringify(event.data)}`, "cyan");
				// TODO: push unread count updates to connected WebSocket clients
				break;

			case EVENTS.PM_DELIVERED:
				alogger.writeAlog(3, `[Event] PM delivered: ${JSON.stringify(event.data)}`, "cyan");
				// TODO: push notification to recipient's active sessions
				break;

			case EVENTS.MAILER_SESSION_START:
			case EVENTS.MAILER_SESSION_END:
				alogger.writeAlog(3, `[Event] Mailer: ${event.type}`, "cyan");
				// TODO: update admin dashboard if open
				break;

			case EVENTS.CONFIG_CHANGED:
				alogger.writeAlog(3, "[Event] Config changed, reloading", "cyan");
				appConfig.reload();
				break;

			case EVENTS.WILDCARDS_CHANGED: {
				alogger.writeAlog(4, "[Event] Wildcard rules changed, invalidating cache", "cyan");
				var fwMod = await import("../src/models/fileWildcards.js");
				fwMod.invalidateCache();
				break;
			}

			case EVENTS.NETMAIL_ROUTES_CHANGED: {
				alogger.writeAlog(4, "[Event] Netmail routes changed, invalidating cache", "cyan");
				var nrMod = await import("../src/models/netmailRoutes.js");
				nrMod.invalidateCache();
				break;
			}
		}
	});
	alogger.writeAlog(2, "  Event subscriber started", "cyan");
}

// --- Embedded mode ---
// When PROCESS_MODE=embedded, start mailer and worker processors in-process

async function startEmbeddedMailer(){
	const { MailerManager } = await import("../src/mailer/manager.js");
	if (process.env.MAILER_ENABLED !== 'true') {
		alogger.writeAlog(2, "  Mailer: disabled (set MAILER_ENABLED=true to enable)", "yellow");
		return;
	}
	mailerManager = new MailerManager();
	if (startClosed()) mailerManager.setMaintenance(true);
	mailerManager.start();
	// Wire gateway's WsManager so binkp WS connections route to the mailer
	if (wsManager) {
		var mailerWsPool = wsManager.createNewPool('/ws/mailer/binkp', 'Mailer Binkp Pool');
		mailerManager.setWebSocketPool(mailerWsPool);
	}
	alogger.writeAlog(2, "  Embedded mailer started", "cyan");
}

async function startEmbeddedWorkers(){
	const { startEmbeddedWorkers: startWorkers } = await import("../src/queues/embedded.js");
	embeddedWorkers = await startWorkers({
		mailerManager: mailerManager,
		startPaused: startClosed(),
	});
}

// --- Maintenance mode ---
// Created early in main() so a request or caller arriving during startup sees
// the right answer, and started here, once every subsystem has subscribed, so
// none of them misses the board closing.

async function startMaintenanceWatch(){
	var log = function (level, message) { alogger.writeAlog(level, '[Gateway] ' + message, 'yellowbright'); };

	// Terminal callers: refused at connect (in the connection classes), warned
	// and then disconnected when the grace runs out.
	attachTerminalDrain(maintWatch, callManager, log);

	// Web users: a countdown pushed to open pages and a notification, then the
	// maintenance page once the grace runs out (maintenanceWeb.js). Not waited
	// for, so not a drain source.
	var notifMod = await import("../src/models/notifications.js");
	attachWebDrain(maintWatch, presenceServer, notifMod, log);

	if (processMode === 'embedded') {
		if (mailerManager) {
			maintWatch.on('enter', function () { mailerManager.setMaintenance(true); });
			maintWatch.on('leave', function () { mailerManager.setMaintenance(false); });
			maintWatch.on('deadline', function () { mailerManager.endSessionsForMaintenance(); });
			maintWatch.registerDrainSource('mailer', function () { return mailerManager.drainCounts(); });
		}
		var mailServers = [imapServer, smtpServer].filter(Boolean);
		if (mailServers.length) {
			maintWatch.on('enter', function () { for (var s of mailServers) s.setMaintenance(true); });
			maintWatch.on('leave', function () { for (var s of mailServers) s.setMaintenance(false); });
			maintWatch.on('deadline', function () { for (var s of mailServers) s.closeSessionsForMaintenance(); });
			maintWatch.registerDrainSource('mail', function () {
				return {
					'IMAP sessions': imapServer ? imapServer.sessions.size : 0,
					'SMTP sessions': smtpServer ? smtpServer.sessions.size : 0
				};
			});
		}
		if (embeddedWorkers && embeddedWorkers.consumers) {
			// One consumer per queue in embedded mode, so the queue's own active
			// count is this process's jobs in flight.
			attachQueueDrain(maintWatch, embeddedWorkers.consumers, async function () {
				return {
					'toss jobs': await tossQueue.getActiveCount(),
					'maintenance jobs': await maintenanceQueue.getActiveCount(),
					'mailer jobs': mailerManager ? await mailerQueue.getActiveCount() : 0
				};
			}, log);
		}
	}

	maintWatch.start();
	if (maintWatch.current().active) {
		alogger.writeAlog(1, "Board is in MAINTENANCE MODE: callers are refused until it is cleared", "yellowbright", true);
	}
}

// --- Exit watch ---

async function exitWatch(){
	if (servercount != lastservercount){
		var servercountmsg = systemvermsg + "\n  There are now " + servercount + " server(s) running"
		alogger.writeAlog(1, servercountmsg, "yellowbright", true)
		lastservercount = servercount
	}
	if (servercount < 1){
		if (!alogger.isConsoleLogging()){
			console.log("\n", chalk.yellowBright.bold(systemshutdownmsg))
		}
		alogger.writeAlog(1, systemshutdownmsg, "yellowbright", true)
		return;
	}
	setTimeout(exitWatch, 1000)
}

// --- Main ---

async function main(){
	await alogger.initLogBus()

	// --- Startup validation: fail fast if DB or Redis is unreachable ---
	try {
		await pgpool.query('SELECT 1');
	} catch (err) {
		alogger.writeAlog(0, "PostgreSQL is not reachable: " + err.message, "redbright", true);
		alogger.writeAlog(0, "Check dbhost/dbname/dbuser/dbpass in .env", "redbright");
		process.exit(1);
	}
	try {
		var rc = await redis.getClient();
		await rc.ping();
	} catch (err) {
		alogger.writeAlog(0, "Redis is not reachable: " + err.message, "redbright", true);
		alogger.writeAlog(0, "Check redis_url in .env (default: redis://localhost:6379)", "redbright");
		process.exit(1);
	}

	await appConfig.load()
	maintWatch = initMaintenanceWatch({
		process: 'gateway',
		graceDefault: function () { return appConfig.getNumber('maintenance_grace_seconds', 300); },
		log: function (level, message) { alogger.writeAlog(level, '[Gateway] ' + message, 'yellowbright'); }
	})
	await seedDefaultTheme()
	await seedNodelistFlags()
	await seedTemplateEvents()
	await prerunMaint()

	// Seed the MSGID counter in Redis from DB state for today's day bucket.
	// Idempotent across processes; first one wins, others see the key and
	// return. Must run after appConfig.load() so Redis URL is resolved.
	try {
		var ftnUtilsInit = await import("../src/utils/ftnUtils.js");
		await ftnUtilsInit.initializeMsgidCounter();
	} catch (e) {
		alogger.writeAlog(2, '[Gateway] MSGID counter init failed: ' + e.message, 'yellow');
	}

	await startNodeManager()
	await startSocatManager()
	await startCallPools()
	await startWebServer()

	// QWK hub FTP server (#74): off unless qwk_ftp_enabled is on
	await startQwkFtp()
	if (runwssrv){
		await startWebsockets()
		await registerLogWebSocket(wsManager);
		await registerNodeSpyWebSocket(wsManager, callManager);
	}
	// Unified terminal server (auto-detects TCP vs Telnet)
	await startTerminalServer()
	// Legacy dedicated servers (only if their ports are explicitly set)
	await startTcpServer()
	await startRloginServer()
	await startTelnetServer()

	// Mode-dependent startup
	if (processMode === 'embedded') {
		// In embedded mode, run IMAP/SMTP/mailer/workers in-process
		await startImapServer()
		await startSmtpServer()
		await startEmbeddedMailer()
		await startEmbeddedWorkers()
		alogger.writeAlog(1, "Running in EMBEDDED mode (all-in-one)", "yellowbright", true)
	} else {
		alogger.writeAlog(1, "Running in SEPARATE mode (gateway only)", "yellowbright", true)
	}

	// Event subscriber — runs in both modes
	await startEventSubscriber()

	await startMaintenanceWatch()

	// Register job schedules (polls, toss cycles, maintenance)
	await registerSchedules()

	// QWK IDs that break the rules saves are held to (#67): reported, not refused
	await auditQwkIdsAndNotify()

	// Watch the worker. The gateway does this because a dead gateway is
	// obvious within minutes and a dead worker is silent for days: nothing
	// user-facing depends on the worker, so the only symptom of losing it is
	// mail that quietly stops moving.
	startWorkerWatchdog({ processMode: processMode })
}

await main()
setTimeout(exitWatch, 4000)
