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


//variable setup
const systemver = systeminfo.softwareVersion()
const vsoftwarename = systeminfo.softwareName()
const systemvermsg = systeminfo.versionMsg()
var systemstartupmsg = systemvermsg + "\n  System Startup"
var systemshutdownmsg = systemvermsg + "\n  System Shutdown"
dotenv.config();
const webport = process.env.webport || 8080
var runwssrv = true
var servercount = 0
var callservcount = 0
var lastservercount = 0
var wsManager
var callManager
var primaryNodeManager
var socatManager
var httpServer

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

process.on('SIGINT', () => {
	socatManager.shutdown();
	pgpool.end();
	process.exit(0);
});

process.on('SIGTERM', () => {
	socatManager.shutdown();
	process.exit(0);
});

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


async function main(){
	await startNodeManager()
	await startSocatManager()
	await startCallPools()
	await startWebServer()
	if (runwssrv){
		await startWebsockets()
	}
}

await main()
setTimeout(exitWatch, 4000)