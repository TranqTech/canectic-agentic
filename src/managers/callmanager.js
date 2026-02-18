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
//import {stageManager} from "./stagemanager.js"
import {ansiInputParser, tcpCommands, websockCommands, telnetCommands} from "../commandsets/terminalcommands.js"
//import {logCall, logCallDuration, getLastCallers} from "../db/callers.js"

//setup
//const callEvent = new EventEmitter();
//variable definitions
dotenv.config()
const system_ver_msg = systeminfo.versionMsg()
const connect_msg = system_ver_msg
const theme = process.env.theme
const configdir = path.join(path.dirname("./"), 'config');
const configcount = 1

//function space

class IncomingCall{
	constructor(connection, callpool, newnodenum, floworder){
		console.log("Creating Call!")
		this.floworder = floworder || "Standard"
		this.rawmode = false
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
		this.call_status = "Seting Up";
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
		this.currentHandler
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
	setCommandSet(){
		switch (this.connection_type){
			case "TCP":
				this.cmds = new tcpCommands(this.connection.socket)
				break;
			case "Websock":
				this.cmds = new websockCommands(this.connection.socket)
				break;
			case "Websocket":
				this.cmds = new websockCommands(this.connection.socket)
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
		if (this.callStatus != "Finished"){
			var closemsg = this.loggingId + "\n  Connection dropped. Cancelling call."
			alogger.writeAlog(3, closemsg, "cyanbright")
		}
		this.logCallEnd()
		this.connection = null
		if (this.currentHandler){
			this.currentHandler.clearHandler()
		}
		this.callPool.removeCall(this)
	}
	hangUpCall(){
		var callfinishmsg = this.loggingId + "\n  Call Finished. Hanging Up."
		alogger.writeAlog(4, callfinishmsg, "cyanbright")
		//console.log("Call flow finished. Hangup.")
		this.cmds.drawrandomscreen("Goodbye", true)
		this.callStatus = "Finished"
		this.logCallEnd()
		if (this.connection){
			this.connection.hangUpCall()
		}		
	}
	notifyRemoteHangup(){
		this.connectionClosed()
		return;
	}
	setupCall(){
		this.setCommandSet()
		//Do Authentication and door/menu selection stuff here.
		console.log("Connected on Node", this.nodenum)
		console.log("Sending Welcome")
		this.connection.welcomeMessage()
		//this.sendString("Hello there!")
	}
	logCallStart(){
		//
	}
	logCallEnd(){
		console.log("Call Ended!")
	}
	handleWebsockData(data){
		if (this.currentHandler != null){
			//do stuff
		}else{
			if (data.toString() == "q"){
				this.hangUpCall()
				return;
			}
		}
		if (this.echo_on){
			this.connection.sendData(data)
		}
		console.log(data.toString())
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
		//console.log("Set nodemanager")
		this.nodeManager.listUsedNodes()
	}
	createCall(connection){
		//console.log(connection)
		if (this.connectto == "Internal"){
			//console.log("Creating new Incoming Call Type")
			var newnodenum = this.nodeManager.getAvailNodeNum()
			var newcall = new IncomingCall(connection, this, newnodenum, this.floworder);
			this.connectedcalls.push(newcall)
			//console.log(newcall.uuid)
			//newcall.showcallstats()
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
		for( var i = 0; i < this.connectedcalls.length; i++){
			if (this.connectedcalls[i] == call){
				this.nodeManager.releaseNodeNum(call.nodenum)
				call.callPool = null;
				this.connectedcalls[i] = null;
				this.connectedcalls.splice(i,1)
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