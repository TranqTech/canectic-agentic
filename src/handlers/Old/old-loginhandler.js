//imports
import * as dotenv from 'dotenv';
import { EventEmitter } from 'node:events';

//internal modules
import * as alogger from "../utils/alogger.js"
import {checkUserPass, getUserRecord, updateUserCalls} from "../db/useraccounts.js"

//setup
dotenv.config()
const loginTO = Number(process.env.connectTO) || 60000
const warnbuff = Number(process.env.warnbuff) || 10000
const warnmsg = process.env.warnmsg || "Are you there?"
const inactivemsg = process.env.inactivemsg || "You have been inactive too long"
const validunamechars = new RegExp("[A-Za-z0-9\ ]")
const validrnamechars = new RegExp("[A-Za-z\ ]")
const validpwchars = new RegExp("[A-Za-z0-9]")
const login_limit = 3

//colors
const df_exit_timeout = 10000
const warn_clr = 2
const border_clr = 4
const unameclr = 11
const pwclr = 11
const unamelabel = 10
const pwlabel = 13
const charcounter = 4
const logonmsgclr = 15
const logonmsgbg = 2


//var config


//class and function space
class loginHandler{
	constructor(call, system_name){
		this.call = call
		this.type = "Login"
		if(this.call.term_type == "Dumb"){
			this.dumb = true
		}else{
			this.dumb = false
		}
		this.emitter = new EventEmitter();
		this.exit_timeout = df_exit_timeout
		this.stringbuffer = ""
		this.input_array = []
		this.username = ""
		this.password = ""
		this.fieldspaces = ""
		this.user_record
		this.validlogin = false
		this.login_attempts = 0
		this.exitready = false
		this.runningparser = false
		this.current_field = "Username"
		this.system_name = system_name
		this.logon_message = " Logging into " + system_name + " "
		this.logon_message_x = 0
		this.logon_message_y = 0
		this.warn_x = 0
		this.warn_y = 25
		this.haswarning = false
		this.box_start_x = 0
		this.box_start_y = 0
		this.box_width = 42
		this.box_height = 6
		this.password_x = 0
		this.password_y = 0
		this.username_x = 0
		this.username_y = 0
		this.theme = this.call.theme
		this.loggingID = "Login System (" + this.call.connection_type + ")"
		this.menu_tl_corner = this.call.charset.getBoxBuff(22)
		this.menu_tr_corner = this.call.charset.getBoxBuff(8)
		this.menu_bl_corner = this.call.charset.getBoxBuff(21)
		this.menu_br_corner = this.call.charset.getBoxBuff(9)
		this.menu_lt_corner = this.call.charset.getBoxBuff(25)
		this.menu_rt_corner = this.call.charset.getBoxBuff(6)
		this.menu_hz_block = this.call.charset.getBoxBuff(26)
		this.menu_vert_block = this.call.charset.getBoxBuff(7)
		this.menu_top_line = this.menu_tl_corner
		this.menu_mid_line = this.menu_lt_corner
		this.menu_bottom_line = this.menu_bl_corner
		if (loginTO - warnbuff > 0){
			this.warnTO = loginTO - warnbuff
		}else{
			this.warnTO = Math.round(loginTO/2)
		}
		this.zombieTO
	}
	drawArt(){
		this.call.cmds.drawrandomscreen("Login")

	}
	getMenuPos(){
		if (!this.dumb){
			this.box_start_x = (Math.round(this.call.term_width/2) - Math.round(this.box_width/2))
			this.box_start_y = (Math.round(this.call.term_height/2) - Math.round(this.box_height/2))
			this.password_x = this.box_start_x + 12
			this.username_x = this.password_x
			this.username_y = this.box_start_y + 2
			this.password_y = this.username_y + 2
			this.box_end_x = this.box_start_x + this.box_width
			this.logon_message_x = (Math.round(this.call.term_width/2) - Math.round(this.logon_message.length/2))
			if ((this.box_start_y - 2) > 0){
				this.logon_message_y = this.box_start_y - 2
			}else{
				this.logon_message_y = 1
			}
			this.warn_x = this.logon_message_x
			this.warn_y = this.box_start_y + this.box_height + 1
			//this.fieldspaces = this.box_width - 12
			//debug msg
			//console.log("Start coords:", this.password_x, this.username_x, this.username_y, this.password_y)
			var spacecount = this.box_end_x - (this.box_start_x + 11)
			for (var sc=0;sc<spacecount;++sc){
				this.fieldspaces += " "
			}
		}
		//create top line
		for (var tl=0;tl<(this.box_width-1);++tl){
			this.menu_top_line = Buffer.concat([this.menu_top_line, this.menu_hz_block])
		}
		this.menu_top_line = Buffer.concat([this.menu_top_line, this.menu_tr_corner])
		//creat mid line
		for (var ml=0;ml<(this.box_width-1);++ml){
			this.menu_mid_line = Buffer.concat([this.menu_mid_line, this.menu_hz_block])
		}
		this.menu_mid_line = Buffer.concat([this.menu_mid_line, this.menu_rt_corner])
		//creat bottom line
		for (var bl=0;bl<(this.box_width-1);++bl){
			this.menu_bottom_line = Buffer.concat([this.menu_bottom_line, this.menu_hz_block])
		}
		this.menu_bottom_line = Buffer.concat([this.menu_bottom_line, this.menu_br_corner])
		this.cont_message_x = this.box_end_x - 28
		this.cont_message_y = this.box_start_y + this.box_height
	}
	drawBox(){
		this.call.cmds.movecursor(this.logon_message_x, this.logon_message_y)
		this.call.cmds.setbgcolor(logonmsgbg)
		this.call.cmds.setfgcolor(logonmsgclr)
		this.call.cmds.senddata(this.logon_message)
		this.call.cmds.resetcolors()
		//drawtopline
		var currY = this.box_start_y
		//start pos will be charcounter
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_top_line)
		currY += 1
		//drawleft
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.senddata(this.menu_vert_block)
		this.call.cmds.setfgcolor(unamelabel)
		this.call.cmds.senddata(" Username: ")
		this.call.cmds.senddata(this.fieldspaces)
		this.call.cmds.movecursor(this.box_end_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_vert_block)
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_mid_line)
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.senddata(this.menu_vert_block)
		this.call.cmds.setfgcolor(pwlabel)
		this.call.cmds.senddata(" Password: ")
		this.call.cmds.senddata(this.fieldspaces)
		this.call.cmds.movecursor(this.box_end_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_vert_block)
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_bottom_line)
		this.call.cmds.movecursor(this.username_x, this.username_y)
		this.call.cmds.setfgcolor(unameclr)

	}
	sendUnamePrompt(){
		if (!this.dumb){
			this.call.cmds.movecursor(this.username_x, this.username_y)
			this.call.cmds.cleartoeol()
			this.call.cmds.movecursor(this.password_x, this.password_y)
			this.call.cmds.cleartoeol()
			this.call.cmds.setfgcolor(border_clr)
			this.call.cmds.movecursor(this.box_end_x, this.username_y)
			this.call.cmds.senddata(this.menu_vert_block)
			this.call.cmds.movecursor(this.box_end_x, this.password_y)
			this.call.cmds.senddata(this.menu_vert_block)
			this.call.cmds.movecursor(this.username_x, this.username_y)
			this.call.cmds.setfgcolor(unameclr)
		}else{
			//this.call.cmds.senddata("\x1b[0;32m")
			this.call.cmds.senddata("\r\n Username: ")
			//this.call.cmds.senddata("\x1b[35m")
		}		

	}
	sendPwPrompt(){
		if (!this.dumb){
			this.call.cmds.movecursor(this.password_x, this.password_y)
			this.call.cmds.setfgcolor(pwclr)
		}else{
			//this.call.cmds.senddata("\x1b[33m")
			this.call.cmds.senddata("\r\n Password: ")
			//this.call.cmds.senddata("\x1b[1;33m")
		}
	}
	sendInvalidMsg(){
		if (!this.dumb){
			this.call.cmds.movecursor(this.box_start_x, this.box_start_y)
			this.call.cmds.setfgcolor(1)
			this.call.cmds.senddata(" Invalid Login. Try Again.")
		}else{
			//this.call.cmds.senddata("\x1b[1;31;1m")
			this.call.cmds.senddata("\r\n   Invalid Login. Try Again.\r\n")
			//this.call.cmds.resetcolors()
		}		
	}
	startLogin(){
		//console.log(this.call)
		this.call.cmds.clearscreen();
		this.drawArt()
		if (!this.dumb){
			this.emitter.emit("DrawSysInfo")
			this.drawBox()
		}else{
			//this.call.cmds.movecursor(2,3);
			this.call.cmds.senddata("\r\n")
			this.sendUnamePrompt()
		}
	}
	prevField(){
		if (this.current_field == "Username"){
			this.exitready = true
			return;
		}
		if ((this.current_field == "Password")&&(!this.finished)){
			this.restartLogin()
			return;
		}

	}
	nextField(){
		if (this.current_field == "Username"){
			if (this.username.length > 0){
				this.current_field = "Password"
				this.sendPwPrompt()
			}else{
				this.call.cmds.sendbeep()
			}
			return;
		}
		if ((this.current_field == "Password")&&(!this.finished)){
			this.checkLogin()
			return;
		}
	}
	checkKey(inputkey){
		//console.log(inputkey)
		switch (inputkey){
			case "ESC":
				this.prevField()
				return;
			case "^A":
				//abort!
				this.exitready = true
				return;
			case "Enter":
				this.nextField()
				return;
			case "Tab":
				this.nextField()
				return;
			case "DownArrow":
				this.nextField()
				return;
			case "RightArrow":
				this.nextField()
				return;
			case "UpArrow":
				this.prevField()
				return;
			case "LeftArrow":
				this.prevField()
				return;
			case "Backspace":
				if (this.current_field == "Username"){
					if (this.username.length > 0){
						this.username = this.username.slice(0, -1)
						this.call.cmds.senddata("\b \b")
					}					
					return;
				}
				if ((this.current_field == "Password")&&(!this.finished)){
					if (this.password.length > 0){
						this.password = this.password.slice(0, -1)
						this.call.cmds.senddata("\b \b")
					}
					return;
				}
				break;
			default:
				//console.log("Can't find destination!")
				//console.log(inputkey)
				break;
		}
	}
	checkChar(stringchar){
		if (this.current_field == "Username"){
			if (validunamechars.test(stringchar)){
				this.username += stringchar
				this.call.cmds.senddata(stringchar)
				return;
			}

		}
		if (this.current_field == "Password"){
			if (validpwchars.test(stringchar)){
				this.password += stringchar
				this.call.cmds.senddata("*")
				return;
			}
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
	restartLogin(){
		this.username = ""
		this.password = ""
		this.current_field = "Username"
		this.sendUnamePrompt()
		return;
	}
	handleData(){
		if (!this.runningparser){
			if (this.haswarning){
				this.clearWarning()
			}			
			this.runningparser = true
			this.clearTimeouts()
			//console.log(this.stringbuff)
			while(this.input_array.length >0){
				var inputkey = this.input_array.shift()
				this.checkInput(inputkey)
			}
			//console.log("Finished parsing")
			this.runningparser = false
			if (this.exitready){
				//console.log("Signalling Return")
				this.signalReturn()
				return;
			}
			this.setTimeouts()
		}
	}
	clearWarning(){
		this.call.cmds.movecursor(this.warn_x, this.warn_y)
		this.call.cmds.cleartoeol()
		this.haswarning = false
		//need to move cursor to where it should be after clearing.
		if (this.current_field == "Username"){
			this.call.cmds.setfgcolor(unameclr)
			this.call.cmds.movecursor((this.username_x + this.username.length), this.username_y)
		}
		if (this.current_field == "Password"){
			this.call.cmds.setfgcolor(pwclr)
			this.call.cmds.movecursor((this.password_x + this.password.length), this.password_y)
		}
	}
	inactivityWarn(){
		try{
			if (this.call != null){
				this.haswarning = true
				if (!this.dumb){
					this.call.cmds.movecursor(this.warn_x, this.warn_y)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(warn_clr)
				}				
				this.call.cmds.senddata(warnmsg)
			}			
		}catch(err){
			var logmsg = this.loggingId + "\r\n  Inactivity warning error\r\n  " + err
			alogger.writeAlog(5, logmsg, "red", true)
			this.zombieChecker()
		}
	}
	inactivityResult(){
		try{
			if (this.call != null){
				if ((this.exitready) && (!this.triedexit)){
					this.triedexit = true
					this.inactiveTO = setTimeout(this.inactivityResult.bind(this), 5000)
					this.signalReturn()
					return;
				}
				try{
					if (!this.dumb){
						this.call.cmds.movecursor(this.warn_x, this.warn_y)
						this.call.cmds.setfgcolor(warn_clr)
						this.call.cmds.cleartoeol()
					}					
					this.call.cmds.senddata(inactivemsg)
				}catch(err){
					console.log(err)
				}
				this.call.hangUpCall()
				return;
			}
		}catch(err){
			console.log("TO Error from Login")
			if (err){
				console.log(err)
				var logmsg = this.loggingId + "\r\n  Inactivity timeout error\r\n  " + err
				alogger.writeAlog(5, logmsg, "red", true)
			}			
			this.clearHandler()
		}
	}
	checkLogin(){
		checkUserPass(this.username, this.password)
			.then(loginresult => {
				if (loginresult.isvalid){
					if (this.call != null){
						this.validlogin = true
						this.exitready = true
						this.call.caller_username = loginresult.useraccount.username
						this.call.caller_fullname = loginresult.useraccount.fullname
						this.call.caller_location = loginresult.useraccount.location
						this.call.user_record = loginresult.useraccount
						if (loginresult.useraccount.msg_group){
							this.call.msg_group = loginresult.useraccount.msg_group
						}
						if (loginresult.useraccount.msg_area){
							this.call.msg_area = loginresult.useraccount.msg_area
						}
						if (loginresult.useraccount.file_group){
							this.call.file_group = loginresult.useraccount.file_group
						}
						if (loginresult.useraccount.file_area){
							this.call.file_area = loginresult.useraccount.file_area
						}
						this.username = loginresult.useraccount.username
						updateUserCalls(loginresult.useraccount)
						this.loginOK()
						//this.handleData()
					}
					return;
				}else{
					this.invalidLogin()
					return;
				}
			})
			.catch(err => {
				console.log("Error getting result")
				console.log(err)
				//this.invalidLogin()
		})
	}
	doLoginLimit(){
		this.call.cmds.senddata("\r\nToo Many Incorrect Attempts. Goodbye")
		this.clearTimeouts()
		this.emitter.emit("LoginLimit")
	}
	invalidLogin(){
		this.username = ""
		this.password = ""
		this.validlogin = false
		this.current_field = "Username"
		this.login_attempts += 1;
		if (this.login_attempts >= login_limit){
			this.doLoginLimit()
			return;
		}
		this.sendInvalidMsg()
		this.sendUnamePrompt()
	}
	loginOK(){
		var loginlogmsg = ""
		if (!this.dumb){
			this.call.cmds.movecursor(this.box_start_x, this.box_start_y)
			this.call.cmds.cleartoeol()
			this.call.cmds.setfgcolor(10)
			this.call.cmds.senddata(" Login OK! Welcome, ")
			this.call.cmds.senddata(this.call.caller_username)
			//console.log(" Login OK! Welcome,", this.call.caller_username)
			this.call.cmds.movecursor(this.cont_message_x, this.cont_message_y)
			this.call.cmds.senddata("Press any key to continue...")
			this.call.cmds.resetcolors()
			return;
		}else{
			//this.call.cmds.senddata("\x1b[1;32m")
			this.call.cmds.senddata("\r\n Login OK!\r\n")
			this.call.cmds.senddata("Press any key to continue...")
			return;
			//this.call.cmds.resetcolors()
		}
	}
	signalReturn(){
		this.setZombieTO()
		if (this.validlogin){
			console.log("Signalling Login is Good!")
			this.emitter.emit("LoginOK")
		}else{
			this.emitter.emit('ModuleReturn')
		}		
		this.finished = true		
	}
	setZombieTO(){
		if (this.call != null){
			this.zombieTO = setTimeout(this.zombieChecker.bind(this), this.exit_timeout)
		}
	}
	zombieChecker(){
		console.log("Login Zombie")
		//emit again and then cleanup
		if (this.call != null){
			if (this.validlogin){
				console.log("Signalling Login is Good!")
				this.emitter.emit("LoginOK")
			}else{
				this.emitter.emit('ModuleReturn')
			}
			this.clearHandler()
		}
	}
	setTimeouts(){
		if (!this.finished){
			this.inactiveTO = setTimeout(this.inactivityResult.bind(this), loginTO)
			this.dowarnTO = setTimeout(this.inactivityWarn.bind(this), this.warnTO)
			return;
		}
		//debug log option incase this is being triggered when it shouldn't be
		//console.log("Something trying to set timeouts in login module after exit")
	}
	clearTimeouts(){
		clearTimeout(this.zombieTO)
		clearTimeout(this.inactiveTO)
		clearTimeout(this.dowarnTO)
	}
	clearHandler(){
		console.log("Clearing Login Module")
		this.clearTimeouts()
		this.call = null
		this.theme = null
		delete this
	}
	startStage(){
		this.getMenuPos()
		//this.drawArt()
		this.startLogin()
		this.setTimeouts()
	}
}


//exports
export{loginHandler}