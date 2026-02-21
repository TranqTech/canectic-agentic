//requires

//internal modules
import chalk from 'chalk';
import * as alogger from "../src/utils/alogger.js"
//import {WsManager, WsPool} from "../src/servers/websock-server.js"
import {WsManager, WsPool} from "../src/servers/websockets.js"
import * as dotenv from 'dotenv';
import * as systeminfo from "../src/utils/systeminfo.js"
import * as http from "http"
import {CallManager, CallPool} from "../src/managers/callmanager.js"
import {nodeManager} from "../src/managers/nodemanager.js"
import { SocatManager } from "../src/managers/socatmanager.js";
import {webserver} from "../src/servers/webserver.js"


//variable setup
const systemver = systeminfo.softwareVersion()
const vsoftwarename = systeminfo.softwareName()
const systemvermsg = systeminfo.versionMsg()
var systemstartupmsg = systemvermsg + "\n  System Startup"
var systemshutdownmsg = systemvermsg + "\n  System Shutdown"
dotenv.config();
const DefaultWsServPort = process.env.dwsport || 8086;
const webport = process.env.webport || 8080
var runwssrv = true
var servercount = 0
var callservcount = 0
var lastservercount = 0
var connectionpools = []
var wsManager
var primaryWsPool
var callManager
var primaryCallPool
var primaryNodeManager
var socatManager
var httpServer

//global safety catch
process.on('uncaughtException', (err) => {
	alogger.writeAlog(0, `Uncaught exception: ${err.stack}`, "redbright");
	// Don't exit — keep the BBS running
});

process.on('unhandledRejection', (reason) => {
	alogger.writeAlog(0, `Unhandled rejection: ${reason}`, "redbright");
});

// On clean shutdown
process.on('SIGINT', () => {
	socatManager.shutdown();
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
	//do express config here
	httpServer = http.createServer(webserver);
	alogger.writeAlog(1, "Starting Public Webserver", "bluebright")

	httpServer.listen(webport, () => {
	  alogger.writeAlog(1, "HTTP running on port " + webport, "bluebright");
	  servercount += 1
	})
}

async function startWsSrv(){
	//open Websocks here
	alogger.writeAlog(1, "Creating Websocket Server(s)", "cyanbright")
	wsManager = await new WsManager();
	primaryWsPool = await wsManager.createNewPool(DefaultWsServPort, "Primary Websocket Pool")
	connectionpools.push(primaryWsPool)
	//console.log(connectionpools)
}

async function startWebsockets(){
	wsManager = await new WsManager(httpServer);
	primaryWsPool = await wsManager.createNewPool('/ws/doorserver', "Doorserver Websocket Pool")
	const catchallWsPool = await wsManager.createNewPool('/', "Catchall Websocket Pool")
	connectionpools.push(primaryWsPool)
	connectionpools.push(catchallWsPool)
	servercount += 1
	callservcount += 1
}

async function startCallManager(){
	alogger.writeAlog(1, "Starting Call Manager", "cyanbright", true)
	callManager = await new CallManager(primaryNodeManager)
	primaryCallPool = await callManager.createNewPool("Primary Pool")
	callManager.listPools()
	//add to servers. Just assign all connection pools to the primary call pool until better pool organization logic exists
	for await (var pool of connectionpools){
		pool.setCallPool(primaryCallPool)
	}
	//primaryWsPool.setCallPool(primaryCallPool)
	//primaryCallPool.floworder = "Standard"
	callManager.socatManager = socatManager;
	primaryCallPool.socatManager = socatManager;
}

async function exitWatch(){
	//console.log("There are ", servercount, lastservercount)
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
	await startWebServer()
	if (runwssrv){
		await startWebsockets()
	}
	if (callservcount > 0){
		await startCallManager()
	}
}

await main()
//exitwatch()
setTimeout(exitWatch, 4000)