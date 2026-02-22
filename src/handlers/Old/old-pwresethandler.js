//imports
import { EventEmitter } from 'node:events';

//internal modules
import * as alogger from "../utils/alogger.js"
import {checkUserPass, getUserRecord} from "../db/useraccounts.js"

//setup
const validunamechars = new RegExp("[A-Za-z0-9\ ]")
const validrnamechars = new RegExp("[A-Za-z\ ]")
const validpwchars = new RegExp("[A-Za-z0-9]")
const loginlimit = 3

//colors
const df_exit_timeout = 10000
const border_clr = 4
const unameclr = 11
const pwclr = 11
const unamelabel = 10
const pwlabel = 13
const charcounter = 4
const logonmsgclr = 15
const logonmsgbg = 2
const prompt_clr = 14


//var config

//class and function space
class pwresetHandler{
	constructor(call, logonHandler, system_name){
		this.call = call
		this.logonHandler = logonHandler
		this.emitter = new EventEmitter();
		this.exit_timeout = df_exit_timeout
		this.type = "PwReset"
		this.stringbuffer = ""
		this.input_array = []
		this.username = ""
		this.password = ""
		this.userrecord
		this.validlogin = false
		this.loginattempts = 0
		this.exitready = false
		this.runningparser = false
		this.current_field = "Username"
		this.system_name = system_name
		this.logonmessage = " Reset Password "
		this.logonmessagex = 0
		this.logonmessagey = 0
		this.box_start_x = 0
		this.box_start_y = 0
		this.box_width = 48		
		this.resultheight = 6
		this.box_height = this.resultheight + 4
		this.exitmsg = "Press Enter to Exit"
		this.passwordx = 0
		this.passwordy = 0
		this.resultx = 0
		this.resulty = 0
		this.exitmsgx = 0
		this.exitmsgy = 0
		this.usernamex = 0
		this.usernamey = 0
		//this.fieldspaces = 0
		//this.spacesbuff = Buffer.from("")
		//this.singlespbuff = Buffer.from(" ")
		this.menuTL = this.call.charset.getBoxBuff(22)
		this.menuTR = this.call.charset.getBoxBuff(8)
		this.menuBL = this.call.charset.getBoxBuff(21)
		this.menuBR = this.call.charset.getBoxBuff(9)
		this.menuLT = this.call.charset.getBoxBuff(25)
		this.menuRT = this.call.charset.getBoxBuff(6)
		this.menu_hz_block = this.call.charset.getBoxBuff(26)
		this.menu_vert_block = this.call.charset.getBoxBuff(7)
		this.menu_top_line = this.menuTL
		this.menu_mid_line = this.menuLT
		this.menu_bottom_line = this.menuBL
	}
	sendreset(){
		//
		this.current_field = "WaitforExit"
		this.sendexitprompt()
	}
	getMenuPos(){
		if (this.call.term_width > 0){
			this.box_start_x = (Math.round(this.call.term_width/2) - Math.round(this.box_width/2))
			this.box_start_y = (Math.round(this.call.term_height/2) - Math.round(this.box_height/2))
			this.resultx = this.box_start_x + 2
			this.usernamex = this.box_start_x + 12
			this.usernamey = this.box_start_y + 2
			this.resulty = this.usernamey + 2
			this.exitmsgx = (Math.round(this.call.term_width/2) - Math.round(this.exitmsg.length/2))
			this.exitmsgy = this.resulty + this.resultheight - 1
			this.box_end_x = this.box_start_x + this.box_width
			this.logonmessagex = (Math.round(this.call.term_width/2) - Math.round(this.logonmessage.length/2))
			if ((this.box_start_y - 2) > 0){
				this.logonmessagey = this.box_start_y - 2
			}else{
				this.logonmessagey = 1
			}
			//this.fieldspaces = this.box_width - 12
			console.log("Start coords:", this.passwordx, this.usernamex, this.usernamey, this.passwordy)
		}
		//create top line
		for (var tl=0;tl<(this.box_width-1);++tl){
			this.menu_top_line = Buffer.concat([this.menu_top_line, this.menu_hz_block])
		}
		this.menu_top_line = Buffer.concat([this.menu_top_line, this.menuTR])
		//creat mid line
		for (var ml=0;ml<(this.box_width-1);++ml){
			this.menu_mid_line = Buffer.concat([this.menu_mid_line, this.menu_hz_block])
		}
		this.menu_mid_line = Buffer.concat([this.menu_mid_line, this.menuRT])
		//creat bottom line
		for (var bl=0;bl<(this.box_width-1);++bl){
			this.menu_bottom_line = Buffer.concat([this.menu_bottom_line, this.menu_hz_block])
		}
		this.menu_bottom_line = Buffer.concat([this.menu_bottom_line, this.menuBR])
		this.contmessagex = this.box_end_x - 28
		this.contmessagey = this.box_start_y + this.box_height
	}
	drawBox(){
		this.call.cmds.movecursor(this.logonmessagex, this.logonmessagey)
		this.call.cmds.setbgcolor(logonmsgbg)
		this.call.cmds.setfgcolor(logonmsgclr)
		this.call.cmds.senddata(this.logonmessage)
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
		this.call.cmds.movecursor(this.box_end_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_vert_block)
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_mid_line)
		currY += 1
		for (var rl=0;rl<this.resultheight;++rl){
			this.call.cmds.movecursor(this.box_start_x, currY)
			this.call.cmds.senddata(this.menu_vert_block)
			this.call.cmds.movecursor(this.box_end_x, currY)
			this.call.cmds.setfgcolor(border_clr)
			this.call.cmds.senddata(this.menu_vert_block)
			currY += 1
		}		
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_bottom_line)
		console.log("Moving to username pos:", this.usernamex, this.usernamey)
		this.call.cmds.movecursor(this.usernamex, this.usernamey)
		this.call.cmds.setfgcolor(unameclr)

	}
	sendunameprompt(){
		if (this.box_start_x > 0){
			this.call.cmds.movecursor(this.usernamex, this.usernamey)
			this.call.cmds.cleartoeol()
			this.call.cmds.movecursor(this.passwordx, this.passwordy)
			this.call.cmds.cleartoeol()
			this.call.cmds.setfgcolor(border_clr)
			this.call.cmds.movecursor(this.box_end_x, this.usernamey)
			this.call.cmds.senddata(this.menu_vert_block)
			this.call.cmds.movecursor(this.box_end_x, this.passwordy)
			this.call.cmds.senddata(this.menu_vert_block)
			this.call.cmds.movecursor(this.usernamex, this.usernamey)
			this.call.cmds.setfgcolor(unameclr)
		}else{
			this.call.sendstring("\x1b[0;32m")
			this.call.sendstring("\r\n Username: ")
			this.call.sendstring("\x1b[35m")
		}		

	}
	sendexitprompt(){
		if (this.box_start_x > 0){
			this.call.cmds.movecursor(this.resultx, this.resulty)
			console.log(this.resultx, this.resulty)
			this.call.cmds.setfgcolor(prompt_clr)
			var msgstring = "If there is an account for \"" + this.username + "\", a password reset message will be sent."
			var xpos = this.resultx
			var currY = this.resulty
			var msgstringarr = msgstring.split(" ")
			//console.log(msgstringarr)
			for (var ma=0;ma<msgstringarr.length;++ma){
				//console.log(msgstringarr[ma])
				if (ma>0){
					if (xpos + 1 < this.box_end_x - 1){
						this.call.cmds.senddata(" ")
						xpos += 1
					}else{
						xpos = this.resultx
						currY += 1
						this.call.cmds.movecursor(this.resultx, currY)
					}
				}
				if((xpos + msgstringarr[ma].length) < (this.box_end_x - 1)){
					console.log(msgstringarr[ma])
					this.call.cmds.senddata(msgstringarr[ma])
					xpos += msgstringarr[ma].length
				}else{
					xpos = this.resultx
					currY += 1
					this.call.cmds.movecursor(this.resultx, currY)
					console.log(msgstringarr[ma])
					this.call.cmds.senddata(msgstringarr[ma])
					xpos += msgstringarr[ma].length
				}
			}
			//this.call.cmds.senddata(msgstring)
			this.call.cmds.movecursor(this.exitmsgx, this.exitmsgy)
			this.call.cmds.setfgcolor(11)
			this.call.cmds.senddata(this.exitmsg)

		}else{
			this.call.sendstring("\x1b[33m")
			this.call.sendstring("\r\n Password: ")
			this.call.sendstring("\x1b[1;33m")
		}
	}
	sendinvalidmsg(){
		if (this.box_start_x > 0){
			this.call.cmds.movecursor(this.box_start_x, this.box_start_y)
			this.call.cmds.setfgcolor(1)
			this.call.cmds.senddata(" Invalid Login. Try Again.")
		}else{
			this.call.sendstring("\x1b[1;31;1m")
			this.call.sendstring("   Invalid Login. Try Again.")
			this.call.cmds.resetcolors()
		}		
	}
	startpwreset(){
		//console.log(this.call)
		this.call.cmds.clearscreen();
		this.emitter.emit("DrawSysInfo")
		if (this.box_start_x > 0){
			this.drawBox()
		}else{
			this.call.cmds.movecursor(2,3);
			this.sendunameprompt()
		}
	}
	doexit(){
		this.exitready = true
		this.handleData()
		return;
	}
	checkCharo(stringchar){
		if ((stringchar)&&(stringchar != null)){
			if (stringchar == "undefined"){
				console.log("Where is this coming from?")
				return;
			}
			if (this.current_field == "Username"){
				if (stringchar == "\x1b"){
					this.exitready = true
					return;
				}
				if (stringchar == "\r"){
					if (this.username.length > 0){
						this.sendreset()
						return;
					}else{
						//send beep
					}					
					return;
				}
				if (stringchar == "\b"){
					//remove last char
					if (this.username.length > 0){
						this.username = this.username.slice(0, -1)
						this.call.sendstring("\b \b")
					}					
					return;
				}
				if (validunamechars.test(stringchar)){
					this.username += stringchar
					this.call.cmds.senddata(stringchar)
					return;
				}
			}
			if (this.current_field == "WaitforExit"){				
				if (stringchar == "\r"){
					this.doexit()
				}
				return;
			}

		}

	}
	restartlogin(){
		this.username = ""
		this.password = ""
		this.current_field = "Username"
		this.sendunameprompt()
		return;
	}
	doBackspace(){
		if (this.username.length > 0){
			this.username = this.username.slice(0, -1)
			this.call.sendstring("\b \b")
		}
		return;
	}
	checkChar(stringchar){
		if (this.current_field == "WaitforExit"){
			this.doexit()
			return;
		}
		if (validunamechars.test(stringchar)){
			this.username += stringchar
			this.call.cmds.senddata(stringchar)
			return;
		}
	}
	checkKey(inputkey){
		if (this.current_field == "WaitforExit"){
			this.doexit()
			return;
		}
		switch(inputkey){
			case "Enter":
				if (this.username.length > 0){
					this.sendreset()
					return;
				}else{
					this.call.cmds.sendbeep()
				}
				return;
			case "Backspace":
				this.doBackspace()
				return;
			case "ESC":
				this.exitready = true;
				return;
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
			//console.log(this.stringbuff)
			while(this.input_array.length >0){
				var inputkey = this.input_array.shift()
				this.checkInput(inputkey)
			}
			this.runningparser = false
			if (this.exitready){
				this.finishStage()
			}			
		}
	}
	checklogin(){
		//put logic to check creds here
		console.log("Checking Login", this.username, this.password)
		checkUserPass(this.username, this.password)
			.then(loginresult => {
				if (loginresult.isvalid){
					this.validlogin = true
					this.exitready = true
					this.call.caller_username = loginresult.useraccount.username
					this.call.caller_fullname = loginresult.useraccount.fullname
					this.loginok()
					this.handleData()
					return;
				}
				this.invalidlogin()
			})
			.catch(err => {
				console.log(err)
				this.invalidlogin()
		})
	}
	loginlimit(){
		this.call.sendstring("\r\nToo Many Incorrect Attempts. Goodbye")
		this.call.hangUpCall()
	}
	invalidlogin(){
		this.username = ""
		this.password = ""
		this.validlogin = false
		this.current_field = "Username"
		this.loginattempts += 1;
		if (this.loginattempts >= loginlimit){
			this.loginlimit()
			return;
		}
		this.sendinvalidmsg()
		this.sendunameprompt()
	}
	loginok(){
		if (this.box_start_x > 0){
			this.call.cmds.movecursor(this.box_start_x, this.box_start_y)
			this.call.cmds.cleartoeol()
			this.call.cmds.setfgcolor(10)
			this.call.cmds.senddata(" Login OK! Welcome, ")
			this.call.cmds.senddata(this.call.caller_username)
			//console.log(" Login OK! Welcome,", this.call.caller_username)
			this.call.cmds.movecursor(this.contmessagex, this.contmessagey)
			this.call.cmds.senddata("Press any key to continue...")
			this.call.cmds.resetcolors()
			return;
		}else{
			this.call.sendstring("\x1b[1;32m")
			this.call.sendstring("\r\n Login OK!\r\n")
			this.call.resetcolors()
		}		
	}
	returnToLogon(){
		clearTimeout(this.respTO)
		//this.call.call_stage += 1		
		this.signalReturn()
	}
	signalReturn(){
		this.finished = true
		this.emitter.emit('ModuleReturn')
	}
	finishStage(){
		//this.call.call_stage += 1
		if (this.validlogin){
			clearTimeout(this.respTO)
			this.finished = true
			if (this.logonHandler){
				this.logonHandler.rtFromModule(this, true)
			}else{
				console.log("Uh oh... why do we not have the parent handler defined")
			}
		}else{
			this.returnToLogon()
		}
	}
	clearTimeouts(){
		clearTimeout(this.respTO)
	}
	clearHandler(){
		this.clearTimeouts()
		this.call = null
		delete this
	}
	startStage(){
		this.getMenuPos()
		this.startpwreset()
	}
}


//exports
export{pwresetHandler}