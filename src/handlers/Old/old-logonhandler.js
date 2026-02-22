//imports
import { EventEmitter } from 'node:events';
import * as dotenv from 'dotenv';

//internal modules
import * as alogger from "../utils/alogger.js"
import {loginHandler} from "./loginhandler.js"
import {registrationHandler} from "./registrationhandler.js"
import {pwresetHandler} from "./pwresethandler.js"
import {getSystemInfo} from "../utils/systeminfo.js"
import { DateTime } from "luxon";

//setup
dotenv.config();
const connectTO = Number(process.env.connectTO) || 30000
const warnbuff = Number(process.env.warnbuff) || 10000
const warnmsg = process.env.warnmsg || "Are you there?"
const inactivemsg = process.env.inactivemsg || "You have been inactive too long"
const menuoptions = [
	{display: "Login", destination: "Login"},
	{display: "New User (Register)", destination: "Registration"},
	{display: "Reset Password", destination: "PasswordReset"},
	{display: "Disconnect", destination: "Goodbye"}
	]
const df_exit_timeout = 10000
const spacebuffer = 2
const installdir = process.env.installdir
const textdir = process.env.textdir
//defailt colours
// const border_clr = 4
// const commandclr = 11
// const optclr = 7
// const lboptclr = 15 
// const lbclr = 12
// const verclr = 4
// const bnameclr = 14
// const locclr = 10
// const timeclr = 11
// const error_clr = 2
// const warn_clr = 2

//regex checks
const escapeterminator = new RegExp("[A-Za-z\@\[\]\^\{\}\|\`\~\\]")
const escapeterminator1 = new RegExp("[A-Za-z]")
const escapeterminator2 = new RegExp("[@\\[\\]^_`\\{\\}\\|~]")
const validescapechars = new RegExp("[0-9:;?= ]")
const disconnectmsg = "Ok, Goodbye!"
//var config

//class and function space
class logonHandler{
	constructor(call){
		this.call = call
		this.type = "Logon"
		this.emitter = new EventEmitter();
		this.exit_timeout = df_exit_timeout
		if(this.call.term_type == "Dumb"){
			this.dumb = true
		}else{
			this.dumb = false
		}
		this.input_array = []
		this.stringbuffer = ""
		this.exitready = false
		this.runningparser = false
		this.menuposition = 0
		this.prevmenupos = 0
		this.current_field = "Username"
		this.menuwidth = 0
		this.menuheight = 0
		this.lbwidth = 0
		this.errorx = 0
		this.errory = 0
		this.warnx = 0
		this.warny = 25
		this.haswarning = false
		this.menustartx = 10
		this.menustarty = 8
		this.lightbarx = this.menustartx + 1
		this.escapebuffer = ""
		this.escapemode = false
		this.displayingmsg = false
		this.sysinfox = 0
		this.sysinfoy = 0
		this.sysinfo = getSystemInfo()
		this.theme = this.call.theme
		this.loggingId = "Logon System (" + this.call.connection_type + ")"
		this.running_module = false
		this.currentModule
		this.zombieTO
		this.inactiveTO
		this.dowarnTO
		if (this.sysinfo.boardname){
			this.system_name = this.sysinfo.boardname
		}else{
			this.system_name = "Default BBS"
		}
		if ((connectTO - warnbuff) > 0){
			this.warnTO = connectTO - warnbuff
		}else{
			this.warnTO = Math.round(connectTO/2)
		}
	}
	moveNextOption(){
		this.prevmenupos = this.menuposition
		if (this.menuposition < (menuoptions.length - 1)){
			this.menuposition = this.menuposition + 1
		}else{
			this.menuposition = 0
		}
		this.drawLightbar()
	}
	movePrevOption(){
		this.prevmenupos = this.menuposition
		if (this.menuposition > 0){
			this.menuposition = this.menuposition - 1
		}else{
			this.menuposition = menuoptions.length - 1
		}
		this.drawLightbar()
	}
	doEscape(){
		this.escapemode = false
		switch (this.escapebuffer){
			case "[":
				//console.log("Unknown escape for this context")
				//console.log(this.escapebuffer)
				this.escapebuffer = ""
				break;
			case "":
				console.log("Escape on it's own!")
				break;
			case "[C":
				//console.log("Right Arrow Key!")
				this.moveNextOption()
				break;
			case "[D":
				//console.log("Left? Arrow Key!")
				this.movePrevOption()
				break;
			case "[A":
				//console.log("Up? Arrow Key!")
				this.movePrevOption()
				break;
			case "[B":
				//console.log("Down? Arrow Key!")
				this.moveNextOption()
				break;
			default:
				//console.log("Unknown escape for this context")
				//console.log(this.escapebuffer)
				this.escapebuffer = ""
				break;
		}
	}
	drawArt(){
		this.call.cmds.drawrandomscreen("Logon")

	}
	getMenuPos(){
		for(var mo=0; mo<menuoptions.length;++mo){
			var optwidth = menuoptions[mo].display.length + spacebuffer
			if (optwidth > this.lbwidth){
				this.menuwidth = optwidth + 2
				this.lbwidth = optwidth
			}
		}
		this.menuheight = menuoptions.length + 2
		//console.log("Menu is", this.menuwidth, "wide")
		if (!this.dumb){
			this.menustartx = Math.round(this.call.term_width/2) - Math.round(this.menuwidth/2)
			this.menustarty = Math.round(this.call.term_height/2) - Math.round(this.menuheight/2)
			this.lightbarx = this.menustartx + 1
			if (this.sysinfo.longestline + 1 < this.call.term_width){
				this.sysinfox = this.call.term_width - (this.sysinfo.longestline + 1)
			}else{
				this.sysinfox = 0
			}
			this.sysinfoy = this.call.term_height - this.sysinfo.validlines
			this.errory = this.menustarty + this.menuheight + 2
			this.errorx = this.menustartx
			this.warnx = this.errorx
			this.warny = this.errory
			console.log(this.menustarty, this.menustartx, this.lightbarx, this.sysinfoy, this.sysinfox, this.call.term_height, this.call.term_width)
			//this.sysinfoy = this.menustarty + this.menuheight + 2
		}
	}
	drawOpt(opti){
		this.call.cmds.resetcolors()
		this.call.cmds.senddata(Buffer.from(" "))
		this.call.cmds.setfgcolor(this.theme.lb_cmd_clr)
		this.call.cmds.senddata(Buffer.from(menuoptions[opti].display.substr(0,1)))
		this.call.cmds.setfgcolor(this.theme.opt_clr)
		//this.call.cmds.senddata(Buffer.from(menuoptions[i].display.slice(1)))
		var menuline = menuoptions[opti].display.slice(1)
		for (var si = (menuoptions[opti].display.length + 3); si< this.menuwidth; ++si){
			menuline += " "
		}
		//console.log(menuline)
		this.call.cmds.senddata(menuline)
	}
	drawLitOpt(opti){
		this.call.cmds.resetcolors()
		this.call.cmds.setbgcolor(this.theme.lb_clr)
		this.call.cmds.senddata(Buffer.from(" "))
		this.call.cmds.setfgcolor(this.theme.lb_cmd_clr)
		this.call.cmds.senddata(Buffer.from(menuoptions[opti].display.substr(0,1)))
		this.call.cmds.setfgcolor(this.theme.lb_opt_clr)
		//this.call.cmds.senddata(Buffer.from(menuoptions[i].display.slice(1)))
		var menuline = menuoptions[opti].display.slice(1)
		for (var si = (menuoptions[opti].display.length + 3); si< this.menuwidth; ++si){
			menuline += " "
		}
		//console.log(menuline)
		this.call.cmds.senddata(menuline)		
	}
	drawLightbar(){
		if (!this.dumb){
			//previous line y location
			var pldy = this.prevmenupos + 1 + this.menustarty
			//currnt line y location
			var nldy = this.menuposition + 1 + this.menustarty
			//figure out how many extra lit spaces are needed
			var trailingspaces = menuoptions[this.menuposition] + 3
			//check how many extra spaces need to be reset on prev bar
			var prevposspaces = menuoptions[this.prevmenupos] + 3
			//move cursor to previous position
			this.call.cmds.movecursor(this.lightbarx, pldy)
			//reset colors
			this.call.cmds.resetcolors()
			//overwrite line
			this.drawOpt(this.prevmenupos)
			//move cursor to new position
			//do
			this.call.cmds.movecursor(this.lightbarx, nldy)
			//set colors
			//do
			this.drawLitOpt(this.menuposition)
			this.call.cmds.movecursor((this.lightbarx + menuoptions[this.menuposition].display.length + 1), nldy)
			this.call.cmds.resetcolors()
		}
	}
	drawSysInfo(){
		//
		if (this.dumb){
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata(this.sysinfo.systemver)
			if (this.sysinfo.boardname){
				this.call.cmds.senddata("\r\n")
				this.call.cmds.senddata(this.sysinfo.boardname)
			}else{
				this.call.cmds.senddata("\r\n")
				this.call.cmds.senddata("Default BBS")
			}
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata(this.sysinfo.location)
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata(this.sysinfo.connecttime)
			this.call.cmds.senddata("\r\n")
			return;
		}
		var currY = this.sysinfoy
		//console.log("Drawing sysinfo. Starting at", this.sysinfox, this.sysinfoy)
		//console.log("Sysinfo has", this.sysinfo.validlines, "Valid Lines")
		this.call.cmds.resetcolors()
		if (this.sysinfo.systemver){
			this.call.cmds.movecursor(2, 1)
			this.call.cmds.setfgcolor(this.theme.ver_clr)
			this.call.cmds.senddata(this.sysinfo.systemver)
		}		
		this.call.cmds.movecursor(this.sysinfox, this.sysinfoy)
		this.call.cmds.setfgcolor(this.theme.board_name_clr)
		if (this.sysinfo.boardname){
			this.call.cmds.senddata(this.sysinfo.boardname)
		}else{
			this.call.cmds.senddata("Default BBS")
		}
		if (this.sysinfo.location){
			currY += 1
			this.call.cmds.movecursor(this.sysinfox, currY)
			this.call.cmds.setfgcolor(this.theme.board_loc_clr)
			this.call.cmds.senddata(this.sysinfo.location)
		}		
		if (this.sysinfo.connecttime){
			currY += 1
			this.call.cmds.movecursor(this.sysinfox, currY)
			this.call.cmds.setfgcolor(this.theme.time_clr)
			this.call.cmds.senddata(this.sysinfo.connecttime)
		}
		this.call.cmds.resetcolors();
	}
	sendMenu(){
		if (this.dumb){
			this.call.cmds.senddata("\r\n")
			for (var i=0;i<menuoptions.length;++i){
				this.call.cmds.senddata("\r\n  ")
				this.call.cmds.senddata(Buffer.from(menuoptions[i].display.substr(0,1)))
				this.call.cmds.senddata(") ")
				this.call.cmds.senddata(Buffer.from(menuoptions[i].display))
			}
			this.call.cmds.senddata("\r\n")
			return;
		}
		this.call.cmds.resetcolors()
		var menubarchar = this.call.charset.getBoxBuff(26)
		var menuvertchar = this.call.charset.getBoxBuff(7)
		var menuTL = this.call.charset.getBoxBuff(22)
		var menuTR = this.call.charset.getBoxBuff(8)
		var menuBL = this.call.charset.getBoxBuff(21)
		var menuBR = this.call.charset.getBoxBuff(9)

		//move cursor to start pos
		this.call.cmds.movecursor(this.menustartx, this.menustarty)
		//set border color
		this.call.cmds.setfgcolor(this.theme.box_border_clr)
		//left top corner
		this.call.cmds.senddata(menuTL)
		
		//top bar
		for (var i=0;i<this.lbwidth;++i){
			this.call.cmds.senddata(menubarchar)
		}
		//right top corner
		this.call.cmds.senddata(menuTR)
		//this.call.cmds.senddata("\r\n")
		for (var i=0;i<menuoptions.length;++i){
			//move cursor to box start for line
			this.call.cmds.movecursor(this.menustartx, (this.menustarty + 1 + i))
			this.call.cmds.setfgcolor(this.theme.box_border_clr)
			this.call.cmds.senddata(menuvertchar)
			this.drawOpt(i)
			this.call.cmds.setfgcolor(this.theme.box_border_clr)
			this.call.cmds.senddata(menuvertchar)
		}
		//move cursor to bottom line start		
		this.call.cmds.movecursor(this.menustartx, (this.menustarty + menuoptions.length + 1))
		//set border color
		this.call.cmds.setfgcolor(this.theme.box_border_clr)
		//bottom left corner
		this.call.cmds.senddata(menuBL)
		for (var i=0;i<this.lbwidth;++i){
			this.call.cmds.senddata(menubarchar)
		}
		//bottom right corner
		this.call.cmds.senddata(menuBR)


	}
	doDisconnect(){
		this.clearTimeouts()
		if (!this.dumb){
			this.call.cmds.movecursor(this.lightbarx, (this.menustarty + this.menuheight))
			this.call.cmds.resetcolors()
			this.call.cmds.setfgcolor(this.theme.cmd_clr)
			this.call.cmds.senddata("Disconnect")
			this.call.cmds.movecursor(this.lightbarx, (this.menustarty + this.menuheight + 1))
			this.call.cmds.senddata(disconnectmsg)
			this.call.cmds.resetcolors()
		}else{
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata("Disconnect")
		}
		this.setZombieTO()
		this.emitter.emit("HangupSignal")
	}
	doLogin(){
		//console.log("Do Login")
		if (!this.call){
			return;
		}
		var logmsg = this.loggingId + "\r\n  Starting Login Sub-Module"
		alogger.writeAlog(5, logmsg, "green")
		if (!this.dumb){		
			this.call.cmds.movecursor(this.lightbarx, (this.menustarty + this.menuheight))
			this.call.cmds.resetcolors()
			this.call.cmds.setfgcolor(this.theme.cmd_clr)
			this.call.cmds.senddata("Login")
			this.call.cmds.movecursor(this.lightbarx, (this.menustarty + this.menuheight + 1))
			this.call.cmds.senddata("Loading. Please Wait...")
		}else{
			this.call.cmds.senddata("\r\n  Login\r\n")
			this.call.cmds.senddata("  Loading. Please Wait...\r\n")
		}
		this.running_module = true
		this.currentModule = new loginHandler(this.call, this.system_name)
		this.currentModule.emitter.on('ModuleReturn', ()=>{
			this.doModuleReturn()
			this.startStage()
			return;
		})
		this.currentModule.emitter.on('DrawSysInfo', ()=>{
			if ((this.currentModule)&&(this.currentModule.type == "Login")){
				this.drawSysInfo()
			}
			return;
		})
		this.currentModule.emitter.on('LoginOK', ()=>{			
			if ((this.currentModule)&&(this.currentModule.type == "Login")){
				this.doModuleReturn()
				this.emitter.emit("LogCallStart")
				this.signalReturn()
			}			
			return;
		})
		this.currentModule.emitter.on('LoginLimit', ()=>{
			if ((this.currentModule)&&(this.currentModule.type == "Login")){
				this.doModuleReturn()
				this.emitter.emit("HangupSignal")
			}
			return;
		})
		this.currentModule.startStage();
		this.clearTimeouts()
	}
	doRegistration(){
		//console.log("Do Registration")
		var logmsg = this.loggingId + "\r\n  Starting Registration Sub-Module"
		alogger.writeAlog(5, logmsg, "green")
		this.call.cmds.movecursor(this.lightbarx, (this.menustarty + this.menuheight))
		this.call.cmds.resetcolors()
		this.call.cmds.setfgcolor(this.theme.cmd_clr)
		this.call.cmds.senddata("Registration")
		this.call.cmds.movecursor(this.lightbarx, (this.menustarty + this.menuheight + 1))
		this.call.cmds.senddata("Loading. Please Wait...")
		this.call.cmds.resetcolors()
		this.running_module = true
		this.currentModule = new registrationHandler(this.call, this.system_name)
		this.currentModule.emitter.on('InvalidReg', ()=>{
			if ((this.currentModule)&&(this.currentModule.type == "Registration")){
				this.doModuleReturn()
				this.emitter.emit("HangupSignal")
			}
			return;
		})
		this.currentModule.emitter.on('HangupSignal', ()=>{
			if ((this.currentModule)&&(this.currentModule.type == "Registration")){
				this.doModuleReturn()
				this.emitter.emit("HangupSignal")
			}
			return;
		})
		this.currentModule.emitter.on('DrawSysInfo', ()=>{
			if ((this.currentModule)&&(this.currentModule.type == "Registration")){
				this.drawSysInfo()
			}
			return;
		})
		this.currentModule.emitter.on('ModuleReturn', ()=>{
			if ((this.currentModule)&&(this.currentModule.type == "Registration")){
				this.doModuleReturn()
				this.startStage()
			}
			return;
		})
		this.currentModule.emitter.on('RegistrationOK', ()=>{
			if ((this.currentModule)&&(this.currentModule.type == "Registration")){
				this.doModuleReturn()
				this.emitter.emit("LogCallStart")
				this.signalReturn()
			}
			return;
		})
		this.currentModule.startStage();
		this.clearTimeouts()
	}
	doPwReset(){
		//console.log("Do PW Reset")
		var logmsg = this.loggingId + "\r\n  Starting PW Reset Sub-Module"
		alogger.writeAlog(5, logmsg, "green")
		this.call.cmds.movecursor(this.lightbarx, (this.menustarty + this.menuheight))
		this.call.cmds.resetcolors()
		this.call.cmds.setfgcolor(this.theme.cmd_clr)
		this.call.cmds.senddata("PW Reset")
		this.call.cmds.movecursor(this.lightbarx, (this.menustarty + this.menuheight + 1))
		this.call.cmds.senddata("Loading. Please Wait...")
		this.call.cmds.resetcolors()
		this.running_module = true
		this.currentModule = new pwresetHandler(this.call, this.system_name)
		this.currentModule.emitter.on('ModuleReturn', ()=>{
			if ((this.currentModule)&&(this.currentModule.type == "PwReset")){
				this.doModuleReturn()
				this.startStage()
			}
			return;
		})
		this.currentModule.startStage();
		this.clearTimeouts()
	}
	doCmd(){
		var docmd = menuoptions[this.menuposition].destination
		switch (docmd){
			case "Login":
				//do cmd
				this.doLogin()
				break;
			case "Registration":
				//do cmd
				this.doRegistration()
				break;
			case "PasswordReset":						
				//do cmd
				this.doPwReset()
				break;
			case "Disconnect":
				this.doDisconnect()
				break;
			case "Goodbye":
				this.doDisconnect()
				break;
			default:
				console.log("Can't find destination!")
				break;
		}
	}
	checkKey(inputkey){
		switch (inputkey){
			case "Enter":
				this.doCmd()
				break;
			case "DownArrow":
				this.moveNextOption()
				break;
			case "RightArrow":
				this.moveNextOption()
				break;
			case "UpArrow":
				this.movePrevOption()
				break;
			case "LeftArrow":
				this.movePrevOption()
				break;
			default:
				//console.log("Can't find destination!")
				break;
		}
	}
	checkChar(inputchar){
		switch(inputchar){
			case "L":
				this.doLogin()
				break;
			case "l":
				this.doLogin()
				break;
			case "N":
				this.doRegistration()
				break;
			case "n":
				this.doRegistration()
				break;
			case "D":
				this.doDisconnect()
				break;
			case "d":
				this.doDisconnect()
				break;
			case "R":
				this.doPwReset()
				break;
			case "r":
				this.doPwReset()
				break;
			default:
				//
				break;
		}

	}
	checkCmd(inputcmd){

	}
	checkInput(inputkey){
		if (inputkey.startsWith("KEY_")){
			inputkey = inputkey.slice(4)
			this.checkKey(inputkey)
			return
		}
		if (inputkey.startsWith("CHAR_")){
			inputkey = inputkey.slice(5)
			this.checkChar(inputkey)
			return
		}
		if (inputkey.startsWith("CMD_")){
			inputkey = inputkey.slice(4)
			this.checkCmd(inputkey)
			return;
		}
	}
	handleData(){				
		if (!this.runningparser){			
			this.runningparser = true
			this.clearTimeouts()
			if (this.running_module){
				while(this.input_array.length > 0){
					var ii = this.input_array.shift()
					this.currentModule.input_array.push(ii)
				}
				this.runningparser = false
				this.currentModule.handleData()				
				return;
			}			
			if (this.haswarning){
				this.clearWarning()
			}
			while(this.input_array.length >0){
				var inputkey = this.input_array.shift()
				this.checkInput(inputkey)
			}
			this.runningparser = false
			if (this.exitready){
				this.signalReturn()
				return;
			}
			this.setTimeouts()
		}		
	}
	clearWarning(){		
		this.call.cmds.movecursor(this.warnx, this.warny)
		this.call.cmds.cleartoeol()
		this.haswarning = false
	}
	inactivityWarn(){
		if ((!this.running_module)&&(this.call != null)){
			//wrap in try in case timeout stays alive and gets triggered after a call is dropped, so it doesn't take down the whole system
			//reference to call should be nullified on proper exit, so do not need super robust checks
			try{
				this.haswarning = true
				this.call.cmds.movecursor(this.warnx, this.warny)
				this.call.cmds.cleartoeol()
				this.call.cmds.setfgcolor(this.theme.warn_clr)
				this.call.cmds.senddata(warnmsg)
				return;
			}catch(err){
				var logmsg = "Warning error from logonHandler\r\n" + err
				alogger.writeAlog(3, logmsg, "red")
				return;
			}
		}
		console.log("Invalid Timeout triggered in Logon.")
	}
	inactivityResult(){
		if (!this.running_module){
			//wrap in try in case timeout stays alive and gets triggered after a call is dropped, so it doesn't take down the whole system
			//reference to call should be nullified on proper exit, so do not need super robust checks
			try{
				if (this.call != null){

					if ((this.exitready) && (!this.triedexit)){
						this.triedexit = true
						this.inactiveTO = setTimeout(this.inactivityResult.bind(this), 5000)
						this.signalReturn()
						return;
					}
					this.call.cmds.movecursor(this.warnx, this.warny)
					this.call.cmds.setfgcolor(this.theme.warn_clr)
					this.call.cmds.cleartoeol()
					this.call.cmds.senddata(inactivemsg)
					var logmsg = this.loggingId + "\r\n  Call from " + this.call.callerId + " inactivity disconnect."
					alogger.writeAlog(3, logmsg, "cyan")
					//console.log("Inactive trigger in logon")
					this.clearTimeouts()
					this.emitter.emit("HangupSignal")					
					return;

				}
				console.log("Timeout on null.")

			}catch(err){
				var logmsg = "Timeout error from logonHandler\r\n" + err
				alogger.writeAlog(3, logmsg, "red")
				return;
			}
		}
		console.log("Invalid Timeout triggered in Logon.")
	}
	doModuleReturn(){
		if (this.currentModule){
			try{
				this.currentModule.clearHandler()
			}catch(err){
				console.log(err)
			}
		}
		this.running_module = false
		this.currentModule = null		
	}
	signalReturn(){
		this.setZombieTO()
		this.triedexit = true
		this.emitter.emit('ModuleReturn')
		this.finished = true
	}
	setZombieTO(){
		if (this.call != null){
			this.zombieTO = setTimeout(this.zombieChecker.bind(this), this.exit_timeout)
		}		
	}
	zombieChecker(){
		console.log("Logon Zombie")
		//emit again and then cleanup
		//additional logic for what kind of signal to re-issue is required. Commenting out for now to avoid additional issues.
		//this.emitter.emit('ModuleReturn')
		// if (this.call != null){
		// 	this.clearHandler()
		// }
	}
	setTimeouts(){
		//check to ensure timeout only gets set when this handler is active. Children have their own timeout systems.
		if ((!this.running_module)&&(this.call != null)){
			this.inactiveTO = setTimeout(this.inactivityResult.bind(this), connectTO)
			this.dowarnTO = setTimeout(this.inactivityWarn.bind(this), this.warnTO)
			return;
		}
		//for debug to check if anything (aside from the last datahandle cycle) is trying to set timeouts
		//console.log("Timeout set request while running a module")
	}
	clearTimeouts(){
		clearTimeout(this.zombieTO)
		clearTimeout(this.inactiveTO)
		clearTimeout(this.dowarnTO)
	}
	clearHandler(){
		this.clearTimeouts()
		//console.log("Clearing Logon Module")
		var logmsg = this.loggingId + "\r\n  Clearing Logon Module"
		alogger.writeAlog(5, logmsg, "green")
		if (this.running_module){
			if (this.currentModule){
				this.currentModule.clearHandler()
			}			
		}
		this.currentModule = null
		this.running_module = false
		this.call = null
		this.theme = null
		delete this
	}
	startStage(){
		if (this.finished){
			return
		}
		if (this.call != null){
			this.setTimeouts()
			this.getMenuPos()
			this.call.cmds.clearscreen()
			this.drawArt()
			this.drawSysInfo()
			this.sendMenu()			
			this.drawLightbar()
		}		
	}
}



//exports
export{logonHandler}