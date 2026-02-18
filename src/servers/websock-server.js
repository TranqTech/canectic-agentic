//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'node:events';
import * as net from 'net';
import * as alogger from "../utils/alogger.js"


// variable setup
dotenv.config();
const terminator = Buffer.from("0d0a", 'hex')
const noringtolimit = 6000;
const ringlimit = 6
const msgdly = 500
const convert = (from, to) => str => Buffer.from(str, from).toString(to)
const utf8ToHex = convert('utf8', 'hex')
const hexToUtf8 = convert('hex', 'utf8')
var blockchar = hexToUtf8('e29688')
var shadeblock = hexToUtf8('e29692')
var defaulttcp = "bbs.undermine.ca"
var defaulttcpport = 23
var dotcpconnect = true

class WsConnection{
	constructor(socket, rawsocket, pool){
		this.uuid = uuidv4()
		this.connectionType = "Websocket"
		this.socket = socket
		this.rawsocket = rawsocket.socket
		this.parentPool = pool
		this.wsPort = this.parentPool.listenport
		this.port = this.parentPool.listenport
		this.loggingId = "Ws Port: " + this.wsPort + " - Client: " + this.rawsocket.remoteAddress
		this.callerId = this.rawsocket.remoteAddress
		this.callStatus = "Dialing"
		this.nodeRingCount = 0;
		this.callhandler
		this.obconn = null;
		this.socketstried = []
		this.socket.on('message', (data) =>{
			this.handleData(data)
		})
		this.socket.once('close', () =>{
			this.announceClose()
		})
		this.socket.on('error', (error) => {
			this.connectionError(error)
		})
		this.announceConnection();
	}
	announceConnection(){
		var connectionmsg = "Ws Port: " + this.parentPool.listenport + "\n  New WS connection from " + this.rawsocket.remoteAddress
		alogger.writeAlog(3, connectionmsg, "magenta", true)
		//setTimeout(this.welcomemessage.bind(this), 2000)
		//this.welcomemessage();
		if (this.parentPool.forwardtoPool){
			console.log("Forwarding Call to pool", this.parentPool.callPool.name)
			this.callhandler = this.parentPool.callPool.createCall(this)
			this.callhandler.setupCall()
			//this.socket.destroy()
		}else{
			this.socket.write("Sorry, no call handlers available. Goodbye\r\n")
			this.socket.destroy()
		}
	}
	welcomeMessage(){
		this.socket.send("\r\n")
		var wcmsg = "Hello and welcome!\r\nYou are connected to " + this.parentPool.loggingId + "\r\n"
		//this.socket.send("Hello and welcome!\r\n");
		this.socket.send(wcmsg)		
		//this.sendlinecounter(3,5)
	}
	notifyremotehangup(){
		this.socket.send("Remote Hangup\r\n")
		this.callStatus == "Waiting"
		this.socket.close()
	}
	remotedisconnect(){
		this.socket.send("Remote Disconnected")
		this.callStatus == "Waiting"
		this.socket.close()
	}
	announceClose(){
		clearTimeout(this.noRingTO);
		var closemsg = this.loggingId + "\n  Remote Connection Closed"
		alogger.writeAlog(3, closemsg, "magenta", true)
		this.callStatus = "Disconnected"
		if (this.obconn){
			this.obconn.notifyhangup()
		}
		if (this.callhandler){
			this.callhandler.connectionClosed(this)
		}
		this.callhandler = null
		//delete references to this so garbage collection can clean it up
		this.parentPool.removeconnection(this)
		return;
	}
	connectionError(error){
		var ermsg = this.loggingId + "\n  Connection Error:\n  " + error
		alogger.writeAlog(3, ermsg, "red")
	}
	sendtext(text){
		this.socket.send(text)
	}
	sendString(stringdata){
		this.socket.send(stringdata)
	}
	sendData(data){
		this.socket.send(data)
	}
	handleData(data){
		if (this.callhandler){
			this.callhandler.handleWebsockData(data)
			return;
		}
	}
	oldhandleData(data){
		//console.log("Msg from " + this.loggingId)
		//console.log(data.toString())
		if (this.callStatus == "Connected"){
			//console.log("Sending")
			console.log(data)
			this.obconn.socket.write(Buffer.from(data))
		}else{
			console.log(data.toString())
		}
		//this.socket.send("Received!")
	}
	hangUpCall(){
		console.log("Request to hangup")
		this.socket.send("\r\nGoodbye!\r\n")
		this.socket.close()
	}
}


class WsPool{
	constructor(port, name){
		this.name = name;
		this.uuid = uuidv4();
		this.connections = []
		this.callPool = ""
		this.forwardtoPool = false
		this.listenport = Number(port)
		this.loggingId = "WsPool " + name
		if(!isNaN(this.listenport)){
			this.server = new WebSocketServer({ port: this.listenport }, () =>{
				this.serverOpen();
			});
			this.server.on('connection', (socket, rawsocket) => {
				console.log("Websocket Connection")
				this.handleConnection(socket, rawsocket)
			})
			//this.server.on('connection', this.handleConnection.bind(this), ws, req)
			this.server.on('error', this.handleServerError)
		}else{
			//log port error
		}
	}
	setCallPool(callpool){
		this.callPool = callpool
		this.forwardtoPool = true
	}
	handleConnection(socket, rawsocket){
		var newconnection = new WsConnection(socket, rawsocket, this)
		this.connections.push(newconnection)
		var connectioncountmsg = this.loggingId + "\n  There are now " + this.connections.length + " active connections to this pool"
		alogger.writeAlog(3, connectioncountmsg, "blue")
		console.log("handled", this.connections.length)
	}
	removeconnection(connection){
		//console.log(this.connections.length, "Connections")
		if (!connection){
			return;
		}
		for( var i = 0; i < this.connections.length; i++){
			if (this.connections[i] == connection){
				this.connections[i] = null;
				this.connections.splice(i,1)
				var connectioncountmsg = this.loggingId + "\n  There are now " + this.connections.length + " active connections to this pool"
				alogger.writeAlog(3, connectioncountmsg, "blue")
				connection = null;
				return;
			}
		}

	}
	handleServerError(error){
		console.log(error)
	}
	serverOpen(){
		var serveraddress = this.server.address();
		var createmsg = "Ws Server listening\n  Binding Address: " + serveraddress.address + "\n  Type: " + serveraddress.family + "\n  Port: " + serveraddress.port
		alogger.writeAlog(2, createmsg, "magenta")
	}
}


class WsManager{
	constructor(){
		this.uuid = uuidv4()
		this.pools = []
	}
	createNewPool(port, name, defmodempool){
		var newpool = new WsPool(port, name, defmodempool);
		this.pools.push(newpool);
		return newpool;
	}
}

export{WsManager, WsPool}