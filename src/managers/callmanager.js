//imports
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from "luxon";
import { EventEmitter } from 'node:events';
import * as path from 'path';
import {appendFileSync, existsSync, mkdirSync, readdir, readdirSync, readFile} from 'fs';

//internal modules
import * as alogger from "../utils/alogger.js"
import * as systeminfo from "../utils/systeminfo.js"
import {ansiInputParser, tcpCommands, websockCommands, telnetCommands} from "../commandsets/terminalcommands.js"
import { cp437ToUtf8 } from "../utils/codepageConversions.js"

//handler modules
import {LoginHandler} from "../handlers/loginhandler.js"
import {LogonHandler} from "../handlers/logonhandler.js"
import { DoorAuthHandler } from "../handlers/doorauthhandler.js"
import { DoorRunner, LAUNCH_TYPES } from "../handlers/doorrunner.js";
import { SyncJSDoorRunner } from "../handlers/syncjsdoor_runner.js";
import { OutputRingBuffer } from "../handlers/ringbuffer.js";
import { TerminalNegotiator } from "../handlers/terminalnegotiator.js";
import { MenuHandler } from "../handlers/menuhandler.js";
import { DoorLaunchHandler } from "../handlers/doorlaunchhandler.js";
import { WebDoorAuthHandler } from "../handlers/webdoorauthhandler.js";
import { SubModuleAdapter } from "../handlers/submoduleadapter.js";
import { LastCallers } from "../handlers/lastcallers.js";
import { WhosOnline } from "../handlers/whosonline.js";
import { AnnouncementHandler } from "../handlers/announcementhandler.js";
import { WallHandler } from "../handlers/menucommands/wallHandler.js";
import { SysInfo } from "../handlers/menucommands/sysInfo.js";
import { BulletinViewer } from "../handlers/menucommands/bulletinViewer.js";
import { pmCheck } from "../handlers/menucommands/pmCheck.js";
import { fileBatchCheck } from "../handlers/menucommands/fileBatchCheck.js";
import { whosOnlineCheck } from "../handlers/menucommands/whosOnlineCheck.js";
import { mailVerifyCheck } from "../handlers/menucommands/mailVerifyCheck.js";
import { DisplayScreen } from "../handlers/menucommands/displayScreen.js";

//models
import {getDoorConfig, mayLaunchDoor} from "../models/doors.js"
import * as remoteRegistry from "../models/doorserverRemotes.js"
import { RemoteDoorRunner } from "../handlers/remotedoorrunner.js"
import {logCall, logCallDuration} from "../models/callers.js"
import * as themes from "../models/themes.js"
import appConfig from "../config/appConfig.js"

//setup
const system_ver_msg = systeminfo.versionMsg()
const connect_msg = system_ver_msg
const configdir = path.join(path.dirname("./"), 'config');

// --- Handler registry ---
// Maps stage names to factory functions
const handlerRegistry = {
	"negotiate":    (call) => new TerminalNegotiator(call),
	"logon":        (call) => new LogonHandler(call),
	"login":        (call) => new LoginHandler(call, appConfig.get('system_name', "Canectic BBS")),
	"door_auth":    (call) => new DoorAuthHandler(call),
	"webdoor_auth": (call) => new WebDoorAuthHandler(call),
	"event_login":  (call) => new DoorAuthHandler(call),
	"menu":         (call) => new MenuHandler(call),
	"door_launch":  (call) => new DoorLaunchHandler(call, false),
	"last_callers": (call) => new SubModuleAdapter(call, LastCallers, "LastCallers"),
	"whos_online":  (call) => new SubModuleAdapter(call, WhosOnline, "WhosOnline"),
	"check_email":  (call) => new SubModuleAdapter(call, pmCheck, "PmCheck"),
	"check_batch":  (call) => new SubModuleAdapter(call, fileBatchCheck, "FileBatchCheck"),
	"check_online": (call) => new SubModuleAdapter(call, whosOnlineCheck, "WhosOnlineCheck"),
	"announcements": (call) => new SubModuleAdapter(call, AnnouncementHandler, "Announcements"),
	"wall":          (call) => new SubModuleAdapter(call, WallHandler, "Wall"),
	"sysinfo":       (call) => new SubModuleAdapter(call, SysInfo, "SysInfo"),
	"bulletins":     (call) => new SubModuleAdapter(call, BulletinViewer, "Bulletins"),
	"verify_mail":   (call) => new SubModuleAdapter(call, mailVerifyCheck, "MailVerifyCheck"),
	"displayScreen": (call, args) => new SubModuleAdapter(call, DisplayScreen, "DisplayScreen", { arg: args && args.arg || '' }),
	//"main_menu":    (call) => new MainMenuHandler(call),
	//"top":          (call) => new TopMenuHandler(call),
	//"logoff":       (call) => new LogoffHandler(call),
};

// --- Call flow definitions ---
// DB-backed via call_flows table. Hardcoded fallbacks used if DB is empty.
// Flows are arrays of stage entries: strings or { stage, arg } objects.
// "goodbye" is a reserved name that triggers hangup.
var callFlows = {
	"Standard": [
		"negotiate", "logon", "last_callers", "check_online",
		"announcements", "wall", "verify_mail", "check_email",
		"check_batch", "menu", "goodbye",
	],
	"Doorserver": ["door_auth", "door_launch", "goodbye"],
	"WebDoor": ["webdoor_auth", "door_launch", "goodbye"],
	"Test": ["negotiate", "goodbye"],
};

// Load flows from DB, overriding hardcoded defaults
async function loadFlowsFromDB() {
	try {
		var callFlowsModel = (await import('../models/callFlows.js'));
		var dbFlows = await callFlowsModel.getActiveFlows();
		if (dbFlows && dbFlows.length > 0) {
			for (var row of dbFlows) {
				// Terminal flows only. The web call flow's stages are web
				// blocks, which the handler registry would hang up on, and a
				// pool naming it must fall back to Standard rather than run it.
				if (row.kind && row.kind !== 'terminal') continue;
				var stages = row.stages;
				if (typeof stages === 'string') {
					try { stages = JSON.parse(stages); } catch (_) { stages = []; }
				}
				if (Array.isArray(stages) && stages.length > 0) {
					callFlows[row.name] = stages;
				}
			}
			alogger.writeAlog(5, 'Loaded ' + dbFlows.length + ' call flow(s) from DB', 'cyan');
		}
	} catch (err) {
		alogger.writeAlog(3, 'Failed to load call flows from DB, using defaults: ' + err.message, 'yellow');
	}
}

// --- Resolve the flow name, with fallback ---
function getCallFlow(floworder) {
	// Case-insensitive lookup
	for (var key in callFlows) {
		if (key.toLowerCase() === floworder.toLowerCase()) {
			return callFlows[key];
		}
	}
	alogger.writeAlog(3, "Unknown flow order: " + floworder + ", falling back to Standard", "yellowbright");
	return callFlows["Standard"];
}

//function space

class IncomingCall{
	constructor(connection, callpool, newnodenum, floworder){
		console.log("Creating Call!")
		this.call_id
		this.floworder = floworder || "Standard"
		this.flow = getCallFlow(this.floworder)
		this.flowPosition = 0
		this.socatManager = callpool.socatManager
		this.outputBuffer = new OutputRingBuffer(2000);
		this.overrideBuffer = false
		this.pendingChat = null   // { sysopCall, callback } -- set by NodeSpy when chat is queued
		this.currentMenu = "Main"
		this.menuHistory = []
		this.menuHistoryMax = 20
		this.rawmode = false
		this.sockethandle = 75
		this.rawtarget
		this.rawformat = "Buffer"
		this.receiveEmitter = new EventEmitter
		this.uuid = uuidv4();
		this.connection = connection;
		this.connection_type = connection.connectionType;
		this.port = connection.port;
		this.callPool = callpool;
		this.nodeManager = callpool.nodeManager;
		this.term_encoding = "Unknown"
		this.term_id = ""
		this.term_version = ""
		this.term_type = "Unknown"
		this.term_width = 0
		this.term_height = 0
		this.term_rip_major = 0
		this.term_rip_minor = 0
		this.term_rip_string = ""
		this.use_rip = false
		this.use_sixel = false
		// ZMODEM CRC mode: safe default based on connection type.
		// WebSocket non-legacy = modern, TCP = conservative.
		// Terminal negotiator upgrades this for known modern terminals.
		this.zmodem_crc_mode = (this.connection_type === "Websocket" && !connection.legacy)
			? "zbin32" : "zbin_crc16";
		this.call_type = "Incoming";
		this.call_status = "Setting Up";
		this.call_stage = 0
		this.caller_username = "";
		this.caller_fullname = ""
		this.caller_location = ""
		this.caller_bbs = ""
		this.security = 0
		this.permissionflags = []
		this.restrictionflags = []
		this.doorTarget = null
		this._doorFromMenu = false
		this.msg_group = ""
		this.msg_group_title = ""
		this.msg_area = ""
		this.msg_area_title = ""
		this.file_group = ""
		this.file_group_title = ""
		this.file_area = ""
		this.file_area_title = ""
		this.file_batch = []        // tagged files for batch download [{uuid, id, filename, file_size, area_shortcode}]
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

	// --- Flow management ---
	// Returns the next stage name from the flow, or null if exhausted
	// Normalize a flow entry — returns { stage, args } whether entry is a string or object
	_normalizeFlowEntry(entry) {
		if (!entry) return null;
		if (typeof entry === "string") return { stage: entry, args: null };
		if (typeof entry === "object" && entry.stage) {
			var args = Object.assign({}, entry);
			delete args.stage;
			return { stage: entry.stage, args: Object.keys(args).length > 0 ? args : null };
		}
		return null;
	}

	// Extract just the stage name from a flow entry (string or object)
	_flowEntryName(entry) {
		if (!entry) return null;
		if (typeof entry === "string") return entry;
		if (typeof entry === "object" && entry.stage) return entry.stage;
		return null;
	}

	_getNextFlowStage() {
		this.flowPosition++;
		if (this.flowPosition < this.flow.length) {
			return this._normalizeFlowEntry(this.flow[this.flowPosition]);
		}
		return null;
	}

	// Find a stage in the flow by name and set position to it
	// Returns true if found, false if not
	_seekFlowTo(stageName) {
		for (var i = 0; i < this.flow.length; i++) {
			if (this._flowEntryName(this.flow[i]) === stageName) {
				this.flowPosition = i;
				return true;
			}
		}
		return false;
	}

	// Resolve what stage to load next.
	// If nextStage is provided (handler requested a specific destination), use that.
	// Otherwise advance through the flow.
	_resolveNextStage(nextStage) {
		if (nextStage) {
			// Handler explicitly requested a stage — honour it
			// Also sync flow position if the stage exists in the flow
			this._seekFlowTo(nextStage);
			return { stage: nextStage, args: null };
		}
		// No explicit next stage — advance through the flow
		return this._getNextFlowStage();
	}

	loadConfigs(){
		this.loadTheme();
	}
	async loadTheme(){
		var themeName = appConfig.get('theme', 'canectic');
		var themeRow = await themes.getThemeBySlug(themeName);
		if (!themeRow) {
			// Fall back to default theme
			themeRow = await themes.getDefaultTheme();
		}
		if (!themeRow) {
			// Final fallback: load legacy JSON file if no DB themes exist yet
			var tfwpath = configdir + "/themes/" + themeName + ".json";
			readFile(tfwpath, 'utf8', (error, data) => {
				if (error) {
					alogger.writeAlog(1, 'Theme load failed: no DB theme and no JSON fallback', 'redbright');
					this.theme = {};
					return;
				}
				this.theme = JSON.parse(data);
			});
			return;
		}
		this.theme = themes.themeToConfig(themeRow);
	}

	// Writes to the output buffer for sysop nodespy
	writeOutputBuffer(data){
		if (!this.overrideBuffer){
			this.outputBuffer.write(data)
		}
	}

	// Alternative method for dosemu children or other subprocesses.
	// Converts CP437 high bytes to UTF-8 so the ring buffer is always UTF-8.
	writeOverrideBuffer(data) {
		if (!this.overrideBuffer) return;
		var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		var enc = this.term_encoding || 'CP437';
		if (enc === 'UTF8' || enc === 'utf-8' || enc === 'utf8') {
			this.outputBuffer.write(buf);
			return;
		}
		this.outputBuffer.write(Buffer.from(cp437ToUtf8(buf), 'utf8'));
	}

	// --- Node status ---
	updateNodeStatus(status, detail, detailDisplay) {
		if (this.nodeManager) {
			this.nodeManager.updateNode(this.nodenum, status, detail, detailDisplay);
		}
		// If a sysop chat is queued and the user has reached a menu, fire it
		if (status === 'menu' && this.pendingChat) {
			var pending = this.pendingChat;
			this.pendingChat = null;
			// Defer to next tick so the menu finishes drawing first
			setTimeout(() => {
				if (pending.callback) pending.callback();
			}, 500);
		}
	}

	// --- Handler lifecycle ---
	loadHandler(stageName, stageArgs){
		// "goodbye" is a reserved directive — always triggers hangup
		if (stageName === "goodbye") {
			this.hangUpCall();
			return;
		}

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
			var logmsg = this.loggingId + "\n  Unknown or null stage: " + stageName + " — hanging up";
			alogger.writeAlog(3, logmsg, "redbright");
			this.hangUpCall();
			return;
		}

		try{
			const handler = factory(this, stageArgs);
			this.currentHandler = handler;
			this.call_status = stageName;

			// Update node registry with current activity
			var detail = (stageName === "menu") ? this.currentMenu : "";
			this.updateNodeStatus(stageName, detail);

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
		handler.emitter.on("LoginOK", async () => {
			var logmsg = this.loggingId + "\n  Login successful for " + this.caller_username;
			alogger.writeAlog(4, logmsg, "greenbright");
			// Update node registry with the logged-in username
			if (this.nodeManager) {
				this.nodeManager.setNodeUsername(this.nodenum, this.caller_username);
				this.nodeManager.setNodeCallId(this.nodenum, this.uuid);
			}
			// Load persisted file batch from DB
			if (this.user_record && this.user_record.id) {
				try {
					var batchMod = await import('../models/userFileBatch.js');
					this.file_batch = await batchMod.loadBatch(this.user_record.id);
					if (this.file_batch.length > 0) {
						alogger.writeAlog(5, this.loggingId + "\n  Loaded " + this.file_batch.length + " file(s) in download batch", "cyan");
					}
				} catch (batchErr) {
					alogger.writeAlog(4, "Failed to load file batch: " + batchErr.message, "yellow");
					this.file_batch = [];
				}
			}
			// LoginOK — await so call row exists before last_callers queries it
			await this.logCallStart();
			this._onHandlerComplete(null);
		});

		handler.emitter.on("LoginLimit", () => {
			var logmsg = this.loggingId + "\n  Login limit reached.";
			alogger.writeAlog(4, logmsg, "yellowbright");
			this.hangUpCall();
		});

		// Door auth
		handler.emitter.on("DoorAuthOK", () => {
			var logmsg = this.loggingId + "\n  Door auth complete";
			alogger.writeAlog(4, logmsg, "greenbright");
			// Update node registry with the door session username
			if (this.nodeManager) {
				this.nodeManager.setNodeUsername(this.nodenum, this.caller_username);
				this.nodeManager.setNodeCallId(this.nodenum, this.uuid);
				if (this.web_originated) {
					this.nodeManager.setNodeWebOriginated(this.nodenum, true);
				}
			}
			this._onHandlerComplete(null);
		});

		handler.emitter.on("HangupSignal", () => {
			this.hangUpCall();
		});

		handler.emitter.on("AuthFailed", () => {
			this.hangUpCall();
		});

		// Generic events any handler can use
		handler.emitter.on("ModuleReturn", () => {
			this._onHandlerReturn(stageName);
		});

		// Handler explicitly requests a specific next stage
		handler.emitter.on("NextStage", (nextStage) => {
			this._onHandlerComplete(nextStage);
		});

		handler.emitter.on("NegotiateComplete", () => {
			var logmsg = this.loggingId + "\n  Terminal negotiation complete";
			alogger.writeAlog(4, logmsg, "greenbright");
			// Advance through flow
			this._onHandlerComplete(null);
		});

		handler.emitter.on("RegistrationOK", async () => {
			var logmsg = this.loggingId + "\n  Registration successful for " + this.caller_username;
			alogger.writeAlog(4, logmsg, "greenbright");
			// Update node registry with the newly registered username
			if (this.nodeManager) {
				this.nodeManager.setNodeUsername(this.nodenum, this.caller_username);
				this.nodeManager.setNodeCallId(this.nodenum, this.uuid);
			}
			await this.logCallStart();
			this._onHandlerComplete(null);
		});
	}

	_onHandlerComplete(nextStage){
		var resolved = this._resolveNextStage(nextStage);

		if (!resolved) {
			// Fell off the end of the flow
			var logmsg = this.loggingId + "\n  Flow exhausted. Hanging up.";
			alogger.writeAlog(4, logmsg, "cyanbright");
			this.hangUpCall();
			return;
		}

		// Apply any args from the flow entry to the call object
		if (resolved.args) {
			for (var key in resolved.args) {
				this[key] = resolved.args[key];
			}
		}

		var logmsg = this.loggingId + "\n  Stage complete. Loading: " + resolved.stage;
		alogger.writeAlog(5, logmsg, "greenbright");
		this.loadHandler(resolved.stage, resolved.args);
	}

	_onHandlerReturn(fromStage){
		// Handler exited without advancing (ESC from login, back from a menu, etc.)
		// Advance through the flow rather than hanging up
		var resolved = this._getNextFlowStage();

		if (!resolved) {
			var logmsg = this.loggingId + "\n  Handler returned from: " + fromStage + " — flow exhausted, hanging up.";
			alogger.writeAlog(3, logmsg, "cyanbright");
			this.hangUpCall();
			return;
		}

		// Apply any args from the flow entry
		if (resolved.args) {
			for (var key in resolved.args) {
				this[key] = resolved.args[key];
			}
		}

		var logmsg = this.loggingId + "\n  Handler returned from: " + fromStage + ". Advancing to: " + resolved.stage;
		alogger.writeAlog(4, logmsg, "cyanbright");
		this.loadHandler(resolved.stage, resolved.args);
	}

	// --- Data routing ---
	handleData(data){
		if (!this.connection) return;
		try{
			if (this.rawmode && this.rawtarget){
				this.rawtarget(data);
				return;
			}
			this.inputParser.hexbuffer += data.toString('hex')
			this.inputParser.handleData()
		}catch(err){
			var logmsg = this.loggingId + "\n  Data handling error\n  " + (err?.stack || err);
			alogger.writeAlog(3, logmsg, "redbright");
		}
	}

	// --- Connection management ---
	setCommandSet() {
		switch (this.connection_type) {
			case "TCP":
				this.cmds = new tcpCommands(this.connection.socket, this);
				if (!this.inputParser) {
					this.inputParser = new ansiInputParser(this);
				}
				break;
			case "Websock":
			case "Websocket":
				this.cmds = new websockCommands(this.connection.socket, this);
				if (!this.inputParser) {
					this.inputParser = new ansiInputParser(this);
				}
				break;
			case "Telnet":
				this.cmds = new telnetCommands(this.connection.socket, this);
				if (!this.inputParser) {
					this.inputParser = new ansiInputParser(this);
				}
				break;
			default:
				console.log("Could not determine connection type. Assuming TCP");
				this.cmds = new tcpCommands(this.connection.socket, this);
				break;
		}
		if (this.cmds == null) {
			console.log("Did not set command set.... this is a problem");
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
		if (this.currentHandler){
			try{
				this.currentHandler.clearHandler();
			}catch(_){}
			this.currentHandler = null;
		}
		this.logCallEnd()
		if (this.outputBuffer) {
			this.outputBuffer.destroy();
		}
		this.connection = null
		this.callPool.removeCall(this)
	}

	hangUpCall(){
		if (this.call_status === "Finished") return;
		var callfinishmsg = this.loggingId + "\n  Call Finished. Hanging Up."
		alogger.writeAlog(3, callfinishmsg, "cyanbright")
		this.call_status = "Finished"
		this.updateNodeStatus("disconnecting", "");
		if (this.currentHandler){
			try{
				this.currentHandler.clearHandler();
			}catch(_){}
			this.currentHandler = null;
		}
		try{
			this.cmds.sendstring("\r\nEnding Call...\r\n")
			this.cmds.drawrandomscreen("Goodbye", true)
			this.cmds.setfgcolorname("yellowBright")
		}catch(_){}

		this.logCallEnd()
		setTimeout(() => {
			if (this.connection){
				this.connection.hangUpCall()
			}
		}, 500)
	}

	notifyRemoteHangup(){
		this.connectionClosed()
	}

	setupCall(){
		this.setCommandSet()
		console.log("Connected on Node", this.nodenum)
		this.loadConfigs()
		// Register the connection type on the node
		if (this.nodeManager) {
			this.nodeManager.setNodeConnectionType(this.nodenum, this.connection_type);
		}
		// Start at position 0 in the flow
		this.flowPosition = 0;
		var firstEntry = this._normalizeFlowEntry(this.flow[0]);
		if (!firstEntry) {
			alogger.writeAlog(3, this.loggingId + "\n  Empty flow for: " + this.floworder, "redbright");
			this.hangUpCall();
			return;
		}
		// Apply any args from the first flow entry
		if (firstEntry.args) {
			for (var key in firstEntry.args) {
				this[key] = firstEntry.args[key];
			}
		}
		this.loadHandler(firstEntry.stage);
	}

	async logCallStart(){
		if (this.user_record){
			try {
				var res = await logCall(this.user_record, this.connection_type, this.callerId, this.caller_location);
				if (res) this.call_id = res;
			} catch (err) {
				console.log(err);
			}
		} else if (this.doorsession) {
			// A remote BBS's caller (#86): no local account, logged under the
			// prefixed name with the remote BBS as the location.
			try {
				var dres = await logCall({ username: this.caller_username, logoncount: 0 }, 'Doorserver', this.callerId,
					this.caller_bbs_name || this.caller_bbs);
				if (dres) this.call_id = dres;
			} catch (err) {
				console.log(err);
			}
		}
	}

	logCallEnd(){
		if (this.loggedend) return;
		if ((this.user_record || this.doorsession)&&(this.call_id)){
			this.loggedend = true	;		
			logCallDuration(this.call_id)
		}
		alogger.writeAlog(4, this.loggingId + "\n  Call Ended.", "cyanbright");
	}

	// Launch a door by slug name — async because getDoorConfig hits the DB
	async launchDoor(slugname, fromMenu) {
		alogger.writeAlog(5, this.loggingId + "\n  Launch door: " + slugname + (fromMenu ? " (from menu)" : " (from flow)"), "greenbright");
		this._doorFromMenu = fromMenu || false;

		var doorConfig
		try {
			doorConfig = await getDoorConfig(slugname)
		} catch (err) {
			var logmsg = this.loggingId + "\n  Failed to get door config for: " + slugname + "\n  " + (err?.stack || err)
			alogger.writeAlog(3, logmsg, "redbright")
			this._doorReturn()
			return
		}

		if (!doorConfig) {
			alogger.writeAlog(3, this.loggingId + "\n  No door config found for: " + slugname, "yellowbright")
			this._doorReturn()
			return
		}

		// A remote BBS's caller may run only doors made available to the
		// door server (#86). The slug comes from the remote client.
		var launchCheck = mayLaunchDoor(this, doorConfig)
		if (!launchCheck.ok) {
			alogger.writeAlog(2, this.loggingId + "\n  Refused door " + slugname + " for " + (this.caller_username || '?') +
				(this.caller_bbs ? " from " + this.caller_bbs : "") + ": " + launchCheck.reason, "yellowbright")
			this._doorReturn()
			return
		}

		// Check door capacity
		var maxnodes = doorConfig.maxnodes || 0;
		if (this.nodeManager && !this.nodeManager.doorHasCapacity(slugname, maxnodes)) {
			alogger.writeAlog(4, this.loggingId + "\n  Door at capacity: " + slugname + " (" + maxnodes + " max)", "yellowbright");
			try {
				this.cmds.senddata("\r\nThat door is currently at capacity. Please try again later.");
				this.cmds.senddata("\r\nPress any key to continue...");
			} catch (_) {}
			this._waitForKeyThen(() => {
				this._doorReturn();
			});
			return;
		}

		// A door on another system (#89): its provider runs it
		if (doorConfig.launchType === "Remote") {
			await this._launchRemote(doorConfig.remoteProvider, doorConfig.remoteDoor || "", fromMenu, doorConfig.name || slugname);
			return;
		}

		// Clean up current handler
		if (this.currentHandler) {
			try { this.currentHandler.clearHandler(); } catch (_) {}
			this.currentHandler = null;
		}

		// Update node status to show we're in a door
		// Pass the friendly display name (from config) alongside the slug
		var doorDisplayName = doorConfig.name || doorConfig.title || slugname;
		this.updateNodeStatus("door", slugname, doorDisplayName);

		try {
			var handler;
			if (doorConfig.launchType === "SyncJSDoor") {
				handler = new SyncJSDoorRunner(this, doorConfig);
			} else {
				handler = new DoorRunner(this, doorConfig, this.socatManager);
			}
			this.currentHandler = handler;
			this.call_status = "Door: " + (doorConfig.cmd || doorConfig.doorScript);

			handler.emitter.on("ModuleReturn", () => {
				this._doorReturn();
			});

			handler.emitter.on("NextStage", (nextStage) => {
				this._onHandlerComplete(nextStage);
			});

			handler.startStage();
		} catch (err) {
			var logmsg = this.loggingId + "\n  Failed to launch door: " + (err?.stack || err);
			alogger.writeAlog(3, logmsg, "redbright");
			this._doorReturn();
		}
	}

	// Send the caller to a door on another Canectic door server (#86). arg is
	// "<remote name>" or "<remote name>:<door slug>" from the menu entry.
	async launchRemoteDoor(arg, fromMenu) {
		var parsed = remoteRegistry.parseRemoteArg(arg);
		await this._launchRemote(parsed.name, parsed.door, fromMenu, null);
	}

	// Run door `door` (a code, or '' for the provider's own menu) on the door
	// provider named `name`, from a Remote door entry or a remoteDoor menu
	// command. The caller must be logged in at the provider's minimum security.
	async _launchRemote(name, door, fromMenu, label) {
		this._doorFromMenu = fromMenu || false;
		var parsed = { name: String(name || "").toLowerCase(), door: door || "" };
		var remote = null;
		try { remote = parsed.name ? await remoteRegistry.getByName(parsed.name) : null; } catch (_) { remote = null; }
		var refuse = (reason) => {
			try { this.cmds.senddata("\r\n" + reason + "\r\n Press any key to continue..."); } catch (_) {}
			this._waitForKeyThen(() => { this._doorReturn(); });
		};
		if (!remote || !remote.active) {
			alogger.writeAlog(3, this.loggingId + "\n  No active door provider named: " + parsed.name, "yellowbright");
			refuse("That door server is not available.");
			return;
		}
		var may = remoteRegistry.mayUseRemote(this, remote, appConfig);
		if (!may.ok) {
			alogger.writeAlog(3, this.loggingId + "\n  Refused door on " + remote.name + " for " + (this.caller_username || "?") + ": " + may.reason, "yellowbright");
			refuse(may.reason);
			return;
		}

		if (this.currentHandler) {
			try { this.currentHandler.clearHandler(); } catch (_) {}
			this.currentHandler = null;
		}
		this.updateNodeStatus("door", "remote:" + remote.name + (parsed.door ? ":" + parsed.door : ""), label || remote.title || remote.name);
		this.call_status = "Remote door: " + remote.name + (parsed.door ? ":" + parsed.door : "");

		var handler = new RemoteDoorRunner(this, remote, parsed.door);
		this.currentHandler = handler;
		handler.emitter.on("ModuleReturn", () => { this._doorReturn(); });
		handler.emitter.on("HangupSignal", () => { this.hangUpCall(); });
		handler.startStage();
	}

	// Temporarily enters raw mode to wait for a single keypress, then calls the callback
	_waitForKeyThen(callback) {
		var prevRawmode = this.rawmode;
		var prevRawtarget = this.rawtarget;
		this.rawmode = true;
		this.rawtarget = () => {
			this.rawmode = prevRawmode;
			this.rawtarget = prevRawtarget;
			callback();
		};
	}

	_doorReturn() {
		if (this._doorFromMenu) {
			// Launched from a menu — return to that menu
			this._onHandlerComplete("menu");
		} else {
			// Launched from call flow — advance to next flow stage
			this._onHandlerComplete(null);
		}
	}
}

class CallPool{
	constructor(name, connectsto, connectedpool, floworder){
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
		this.floworder = floworder || "Standard"
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
		newpool.callManager = this;
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
		for (var i = 0; i < this.pools.length; i++) {
			if (this.pools[i].name === name) return this.pools[i];
		}
		return null;
	}

	// Find an active call by node number across all pools
	getCallByNode(nodenum) {
		for (var i = 0; i < this.pools.length; i++) {
			var pool = this.pools[i];
			for (var j = 0; j < pool.connectedcalls.length; j++) {
				var call = pool.connectedcalls[j];
				if (call && call.nodenum === nodenum) return call;
			}
		}
		return null;
	}
}

export{CallManager, CallPool, IncomingCall, loadFlowsFromDB}