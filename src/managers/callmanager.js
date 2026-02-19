//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from "luxon";
import { EventEmitter } from 'node:events';
import * as path from 'path';
import {appendFileSync, existsSync, mkdirSync, readdir, readdirSync, readFile} from 'fs';

//internal modules
import * as alogger from "../utils/alogger.js"
import * as systeminfo from "../utils/systeminfo.js"
import {ansiInputParser, tcpCommands, websockCommands, telnetCommands} from "../commandsets/terminalcommands.js"

//handler modules
import {LoginHandler} from "../handlers/loginhandler.js"
import { DoorAuthHandler } from "../handlers/doorauthhandler.js"
import { DoorRunner, LAUNCH_TYPES } from "../handlers/doorrunner.js";
import { OutputRingBuffer } from "../handlers/ringbuffer.js";

//setup
dotenv.config()
const system_ver_msg = systeminfo.versionMsg()
const connect_msg = system_ver_msg
const theme = process.env.theme
const configdir = path.join(path.dirname("./"), 'config');
const configcount = 1

// handler registry
const handlerRegistry = {
	"login":        (call) => new LoginHandler(call, process.env.system_name || "BBS"),
	"door_auth":    (call) => new DoorAuthHandler(call),
	//"main_menu":    (call) => new MainMenuHandler(call),
	//"top":    (call) => new MainMenuHandler(call),
	//"menu":    (call) => new MenuHandler(call, this.currentmenu),
	//"message_viewer": (call) => new MessageViewHandler(call),
	//"message_editor": (call) => new MessageEditHandler(call),
	//"terminal_negotiator": (call) => new terminalNegotiationHandler(call),
};

//function space

class IncomingCall{
	constructor(connection, callpool, newnodenum, floworder){
		console.log("Creating Call!")
		this.floworder = floworder || "Standard"
		this.socatManager = callpool.socatManager
		this.outputBuffer = new OutputRingBuffer(2000);
		this.overrideBuffer = false
		this.currentMenu = "Main"
		this.previousMenu = "Main"
		this.rawmode = false
		this.sockethandle = 75
		this.rawtarget
		this.rawformat = "Buffer"
		this.receiveEmitter = new EventEmitter
		this.uuid = uuidv4();
		this.connection = connection;
		this.connection_type = connection.connectionType;
		this.config_load_count = 0;
		this.port = connection.port;
		this.callPool = callpool;
		this.term_type = "Unknown"
		this.term_encoding = "Unknown"
		this.term_width = 0
		this.term_height = 0
		this.term_rip_major = 0
		this.term_rip_minor = 0
		this.term_rip_string = ""
		this.use_rip = false
		this.call_type = "Incoming";
		this.call_status = "Setting Up";
		this.call_stage = 0
		this.caller_username = "";
		this.caller_fullname = ""
		this.caller_location = ""
		this.caller_bbs = ""
		this.msg_group = ""
		this.msg_group_title = ""
		this.msg_area = ""
		this.msg_area_title = ""
		this.file_group = ""
		this.file_group_title = ""
		this.file_area = ""
		this.file_area_title = ""
		this.echo_on = true
		this.escapebuffer = ""
		this.nodenum = newnodenum
		this.stringbuffer
		this.currentHandler = null
		this.inputParser
		this.user_record
		this.timeleft = 9999
		this.hangupnow = false
		this.loggedend = false
		if (connection.reportBaud){
			this.baudRate = connection.reportBaud
		}
		else{
			this.baudRate = 38400
		}
		this.cmds
		this.callerId = connection.callerId;
		this.connect_time = DateTime.now();
		this.loggingId = "Call From " + this.callerId
		this.callEvent = new EventEmitter();
	}
	//writes to the output buffer for sysop nodespy - do this on connection send. Checks for override bit when subprocess takes over writes
	writeOutputBuffer(data){
		if (!this.overrideBuffer){
			this.outputBuffer.write(data)
		}
	}
	//The alternative method to the above for use on dosemu children, or other subprocesses that need to write a different sysop view.
	writeOverrideBuffer(data) {
		if (this.overrideBuffer) {
			this.outputBuffer.write(data);
		}
	}
	// --- Handler lifecycle ---
	loadHandler(stageName){
		// Clean up previous handler
		if (this.currentHandler){
			try{
				this.currentHandler.clearHandler();
			}catch(_){}
			this.currentHandler = null;
		}

		// Look up factory
		const factory = handlerRegistry[stageName];
		if (!factory){
			var logmsg = this.loggingId + "\n  Unknown or null stage: " + stageName;
			alogger.writeAlog(3, logmsg, "redbright");
			this.hangUpCall();
			return;
		}

		try{
			const handler = factory(this);
			this.currentHandler = handler;
			this.call_status = stageName;

			// Wire handler events to call flow routing
			this._wireHandlerEvents(handler, stageName);

			handler.startStage();
		}catch(err){
			var logmsg = this.loggingId + "\n  Failed to load stage: " + stageName + "\n  " + (err?.stack || err);
			alogger.writeAlog(3, logmsg, "redbright");
			this.hangUpCall();
		}
	}

	_wireHandlerEvents(handler, stageName){
		// Login-specific events
		handler.emitter.on("LoginOK", () => {
			var logmsg = this.loggingId + "\n  Login successful for " + this.caller_username;
			alogger.writeAlog(4, logmsg, "greenbright");
			this._onHandlerComplete("main_menu");
		});

		handler.emitter.on("LoginLimit", () => {
			var logmsg = this.loggingId + "\n  Login limit reached.";
			alogger.writeAlog(4, logmsg, "yellowbright");
			this.hangUpCall();
		});
		//door auth
		handler.emitter.on("DoorAuthOK", () => {
			var logmsg = this.loggingId + "\n  Door auth complete, loading door session";
			alogger.writeAlog(4, logmsg, "greenbright");
			this._onHandlerComplete("door_session");
		});

		handler.emitter.on("AuthFailed", () => {
			this.hangUpCall();
		});
		// Generic events any handler can use
		handler.emitter.on("ModuleReturn", () => {
			this._onHandlerReturn(stageName);
		});

		handler.emitter.on("NextStage", (nextStage) => {
			this._onHandlerComplete(nextStage);
		});
	}

	_onHandlerComplete(nextStage){
		if (!nextStage){
			this.hangUpCall();
			return;
		}
		var logmsg = this.loggingId + "\n  Stage complete. Loading: " + nextStage;
		alogger.writeAlog(5, logmsg, "greenbright");
		this.loadHandler(nextStage);
	}

	_onHandlerReturn(fromStage){
		// Handler exited without advancing (ESC from login, back from a menu, etc.)
		// Could implement a stage stack here later for back-navigation
		var logmsg = this.loggingId + "\n  Handler returned from: " + fromStage;
		alogger.writeAlog(4, logmsg, "cyanbright");
		this.hangUpCall();
	}

	// --- Data routing ---
	handleData(data){
		if (!this.connection) return;
		try{
			if (this.rawmode && this.rawtarget){
				this.rawtarget(data);
				return;
			}
			//do check for raw, otherwise add to parser
			this.inputParser.hexbuffer += data.toString('hex')
			this.inputParser.handleData()
		}catch(err){
			var logmsg = this.loggingId + "\n  Data handling error\n  " + (err?.stack || err);
			alogger.writeAlog(3, logmsg, "redbright");
		}
	}

	// --- Connection management ---
	setCommandSet(){
		switch (this.connection_type){
			case "TCP":
				this.cmds = new tcpCommands(this.connection.socket)
				break;
			case "Websock":
			case "Websocket":
				this.cmds = new websockCommands(this.connection.socket)

				if (!this.inputParser){
					this.inputParser = new ansiInputParser(this);
				}
				break;
			case "Telnet":
				this.cmds = new telnetCommands(this.connection.socket)
				break;
			default:
				console.log("Could not determine connection type. Assuming TCP")
				this.cmds = new tcpCommands(this.connection.socket)
				return;
		}
		if (this.cmds == null){
			console.log("Did not set command set.... this is a problem")
		}
	}

	handleNoSocket(){
		var closemsg = this.loggingId + "\n  Could not find a valid socket for call. Cancelling call."
		alogger.writeAlog(3, closemsg, "cyanbright")
		if (this.connection){
			this.connection.hangUpCall()
		}
		this.connectionClosed()
	}

	sendString(stringdata){
		if ((!this.connection)||(!this.connection.socket)){
			this.handleNoSocket()
			return;
		}
		this.connection.sendString(stringdata)
	}

	connectionClosed(){
		if (this.call_status !== "Finished"){
			var closemsg = this.loggingId + "\n  Connection dropped. Cancelling call."
			alogger.writeAlog(3, closemsg, "cyanbright")
		}
		// Clean up handler safely
		if (this.currentHandler){
			try{
				this.currentHandler.clearHandler();
			}catch(_){}
			this.currentHandler = null;
		}
		this.logCallEnd()
		this.connection = null
		this.callPool.removeCall(this)
	}

	hangUpCall(){
		if (this.call_status === "Finished") return;
		var callfinishmsg = this.loggingId + "\n  Call Finished. Hanging Up."
		alogger.writeAlog(3, callfinishmsg, "cyanbright")
		this.call_status = "Finished"
		// Clean up handler before goodbye
		if (this.currentHandler){
			try{
				this.currentHandler.clearHandler();
			}catch(_){}
			this.currentHandler = null;
		}
		try{
			this.cmds.sendstring("\r\nEnding Call...\r\n")
			this.cmds.drawrandomscreen("Goodbye", true)
		}catch(_){}
		this.logCallEnd()
		if (this.connection){
			this.connection.hangUpCall()
		}
	}

	notifyRemoteHangup(){
		this.connectionClosed()
	}

	setupCall(){
		this.setCommandSet()
		console.log("Connected on Node", this.nodenum)
		console.log("Sending Welcome")
		this.connection.welcomeMessage()
		// Start the call flow
		this.loadHandler("door_auth")
		//this.loadHandler("login")
	}

	logCallStart(){
		//
	}

	logCallEnd(){
		if (this.loggedend) return;
		this.loggedend = true;
		alogger.writeAlog(4, this.loggingId + "\n  Call Ended.", "cyanbright");
	}
	// Call helper for launching doors from menus
	launchDoor(doorConfig) {
		// Clean up current handler (the menu)
		if (this.currentHandler) {
			try { this.currentHandler.clearHandler(); } catch (_) {}
			this.currentHandler = null;
		}

		try {
			var handler = new DoorRunner(this, doorConfig, this.socatManager);
			this.currentHandler = handler;
			this.call_status = "Door: " + doorConfig.cmd;

			handler.emitter.on("ModuleReturn", () => {
				// Door exited — go back to menu
				this._onHandlerComplete("main_menu");
			});

			handler.emitter.on("NextStage", (nextStage) => {
				this._onHandlerComplete(nextStage);
			});

			handler.startStage();
		} catch (err) {
			var logmsg = this.loggingId + "\n  Failed to launch door: " + (err?.stack || err);
			alogger.writeAlog(3, logmsg, "redbright");
			this._onHandlerComplete("main_menu");
		}
	}
}

class CallPool{
	constructor(name, connectsto, connectedpool){
		this.name = name;
		this.uuid = uuidv4()
		if (connectsto){
			this.connectto = connectsto
		}else{
			this.connectto = "Internal"
		}
		this.connectedpool = connectedpool
		this.callcount = 0
		this.connectedcalls = []
		this.loggingId = "Call Pool " + name
		this.nodeManager
		this.floworder = "Standard"
	}
	setNodeManager(nodemanager){
		this.nodeManager = nodemanager
		this.nodeManager.listUsedNodes()
	}
	createCall(connection){
		if (this.connectto == "Internal"){
			var newnodenum = this.nodeManager.getAvailNodeNum()
			var newcall = new IncomingCall(connection, this, newnodenum, this.floworder);
			this.connectedcalls.push(newcall)
			var callcountmsg = this.loggingId + "\n  There are now " + this.connectedcalls.length + " active calls on this pool"
			alogger.writeAlog(4, callcountmsg, "bluebright")
			return newcall
		}else{
			console.log("Could not find a valid call type to create for this pool")
		}
	}
	removeCall(call){
		if (!call){
			console.log("Can't remove a null call")
			return;
		}
		for (var i = 0; i < this.connectedcalls.length; i++){
			if (this.connectedcalls[i] == call){
				this.nodeManager.releaseNodeNum(call.nodenum)
				call.callPool = null;
				this.connectedcalls[i] = null;
				this.connectedcalls.splice(i, 1)
				var callcountmsg = this.loggingId + "\n  There are now " + this.connectedcalls.length + " active calls on this pool"
				alogger.writeAlog(4, callcountmsg, "bluebright")
				call = null;
				return;
			}
		}
	}
}

class CallManager{
	constructor(nodemanager){
		this.uuid = uuidv4()
		this.pools = []
		this.nodeManager = nodemanager
	}
	createNewPool(name, connectsto, connectedpool){
		var newpool = new CallPool(name, connectsto, connectedpool);
		newpool.setNodeManager(this.nodeManager)
		this.pools.push(newpool)
		return newpool;
	}
	listPools(){
		var numpools = this.pools.length
		var i = 0;
		var poollist = "Call Pool Listing:\n  ----------------------"
		while (i < numpools){
			var pool = this.pools[i];
			var poolinfo = "\n  #" + Number(i+1) + "\n  Name: " + pool.name + "\n  Active Calls: " + pool.connectedcalls.length + "\n  ----------------------"
			poollist += poolinfo;
			i += 1;
		}
		alogger.writeAlog(2, poollist, "yellowbright")
	}
	getPool(name){

	}
}

export{CallManager, CallPool}