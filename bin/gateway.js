#!/usr/bin/env node

//requires

//internal modules
import chalk from 'chalk';
import * as alogger from "../src/utils/alogger.js"
import {WsManager, WsPool} from "../src/servers/websockets.js"
import * as dotenv from 'dotenv';
import * as systeminfo from "../src/utils/systeminfo.js"
import * as http from "http"
import {CallManager, CallPool} from "../src/managers/callmanager.js"
import {nodeManager} from "../src/managers/nodemanager.js"
import { SocatManager } from "../src/managers/socatmanager.js";
import {webserver} from "../src/servers/webserver.js"
import { pgpool } from "../src/middleware/db/postgres.js";
import * as redis from "../src/middleware/db/redis.js";
import * as userMsgPointers from '../src/models/userMsgPointers.js';
import * as userAreaSubs from '../src/models/userAreaSubs.js';

// --- Queue infrastructure ---
import { closeQueues } from "../src/queues/queues.js";
import * as jobs from "../src/queues/jobs.js";
import { createEventSubscriber, EVENTS } from "../src/queues/events.js";
import { registerSchedules } from "../src/queues/schedules.js";

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
var servercount = 0
var callservcount = 0
var lastservercount = 0
var wsManager
var callManager
var primaryNodeManager
var socatManager
var httpServer
var eventSubscriber
var embeddedWorkers   // only used in embedded mode
var mailerManager     // only used in embedded mode

// --- Configuration ---

var wspaths = [
	{name: "Doorserver", path: "/ws/doorserver", callpool: "Doorserver"},
	{name: "Catchall",   path: "/",             callpool: "PrimaryBBS"},
	{name: "BBS",        path: "/ws/bbs",       callpool: "PrimaryBBS"},
]

var callpools = [
	{name: "PrimaryBBS",  floworder: "Standard"},
	{name: "Doorserver",  floworder: "Doorserver"},
]

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
	alogger.shutdownLogBus();
	await closeQueues();
	socatManager.shutdown();
	process.exit(0);
});

async function prerunMaint(){
	await userMsgPointers.ensureConstraintsAndIndexes();
	await userAreaSubs.ensureConstraintsAndIndexes();
}

async function startSocatManager(){
	socatManager = new SocatManager();
}

async function startNodeManager(){
	primaryNodeManager = new nodeManager
	alogger.writeAlog(1, "Starting NodeManager", "yellowbright", true)
	primaryNodeManager.listUsedNodes()
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

	servercount += 1
	callservcount += 1
}

// --- Event subscriber ---
// Listens for cross-process events from the worker and mailer

async function startEventSubscriber(){
	eventSubscriber = createEventSubscriber((event) => {
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
	mailerManager.start();
	alogger.writeAlog(2, "  Embedded mailer started", "cyan");
}

async function startEmbeddedWorkers(){
	const { startEmbeddedWorkers: startWorkers } = await import("../src/queues/embedded.js");
	embeddedWorkers = await startWorkers({
		mailerManager: mailerManager,
	});
}

// --- Exit watch ---

async function exitWatch(){
	if (servercount != lastservercount){
		var servercountmsg = systemvermsg + "\n  There are now " + servercount + " server(s) running"
		alogger.writeAlog(1, servercountmsg, "yellowbright", true)
		lastservercount = servercount
	}
	if (servercount < 1){
		if (!logtoconsole){
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
	await prerunMaint()
	await startNodeManager()
	await startSocatManager()
	await startCallPools()
	await startWebServer()
	if (runwssrv){
		await startWebsockets()
	}

	// Mode-dependent startup
	if (processMode === 'embedded') {
		await startEmbeddedMailer()
		await startEmbeddedWorkers()
		alogger.writeAlog(1, "Running in EMBEDDED mode (all-in-one)", "yellowbright", true)
	} else {
		alogger.writeAlog(1, "Running in SEPARATE mode (gateway only)", "yellowbright", true)
	}

	// Event subscriber — runs in both modes
	await startEventSubscriber()

	// Register job schedules (polls, toss cycles, maintenance)
	await registerSchedules()
}

await main()
setTimeout(exitWatch, 4000)
