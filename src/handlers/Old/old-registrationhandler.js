//imports
import { EventEmitter } from 'node:events';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from "luxon";

//internal modules
import * as alogger from "../utils/alogger.js"
import {checkUserPass, getUserRecord, checkUsernameAvailable, checkNetmailUnique, createNewUser} from "../db/useraccounts.js"
import {evaluateNetmail, evaluateEmail, checkRegMailAddress} from "../utils/evalmailaddresses.js"

//setup
dotenv.config();
const inputTO = Number(process.env.inputTO) || 20000
const warnbuff = Number(process.env.warnbuff) || 10000
const warnmsg = process.env.warnmsg || "Are you there?"
const inactivemsg = process.env.inactivemsg || "You have been inactive too long"
const validunamechars = new RegExp("[A-Za-z0-9\ ]")
const validnamechars = new RegExp("[A-Za-z\ ]")
const validlocationchars = new RegExp("[A-Za-z0-9,\ ]")
const validrnamechars = new RegExp("[A-Za-z]")
const validnetmailchars = new RegExp("[A-Za-z0-9:/\.\@]")
const validpwchars = new RegExp("[A-Za-z0-9]")
const validdatechars = new RegExp("[0-9]")
const escapeterminator1 = new RegExp("[A-Za-z]")
const escapeterminator2 = new RegExp("[@\\[\\]^_`\\{\\}\\|~]")
const validescapechars = new RegExp("[0-9:;?= ]")
const loginlimit = 3
const regstages = [
	{display: "Age Verification", field_name: "AgeVerification", prompt: "Are you over the age of 13?", prompt2: "Enter Y/N", inputtype: "YesNo", continueonno: false, prompt_clr: "11"},
	{display: "Username", field_name: "Username", prompt: "Please enter your desired Username/Alias", inputtype: "Username", prompt_clr: "11"},
	{display: "Password", field_name: "Password", prompt: "Please enter your desired Password", inputtype: "Password", prompt_clr: "11"},
	{display: "Password Confirmation", field_name: "PasswordConfirm", prompt: "Please re-enter your password", inputtype: "Password", prompt_clr: "11"},
	{display: "First Name", field_name: "Firstname", prompt: "Please enter your full First (given) name", inputtype: "RealName", prompt_clr: "11"},
	{display: "Last Name", field_name: "Lastname", prompt: "Please enter your full Last (family) name", inputtype: "RealName", prompt_clr: "11"},
	{display: "Location", field_name: "Location", prompt: "Where are you calling from?", inputtype: "Location", prompt_clr: "11"},
	{display: "Netmail", field_name: "Netmail", prompt: "Please enter an Email or Netmail address you can be reached at", inputtype: "Netmail", prompt_clr: "11"},
	{display: "Birthdate", field_name: "Birthdate", prompt: "Please enter your birthdate as YYYY/MM/DD", inputtype: "Date", prompt_clr: "11"},
	]
//var config
const pwmin = Number(process.env.pwmin) || 12
const minage = Number(process.env.minage) || 13
const df_exit_timeout = 10000
const border_clr = 4
const label_clr = 15
const progress_clr = 14
const title_clr = 15
const title_bg_clr = 2
const error_clr = 1
const success_clr = 2
const input_clr = 14
const esc_clr = 13
const nav_clr = 15
const pwl_clr = 13
const warn_clr = 2


//class and function space
class registrationHandler{
	constructor(call, system_name){
		this.call = call
		this.type = "Registration"
		this.emitter = new EventEmitter();
		this.system_name = system_name
		this.exit_timeout = df_exit_timeout
		this.fatal_error = false
		this.stringbuffer = ""
		this.inputbuffer = ""
		this.input_array = []
		this.firstname = ""
		this.lastname = ""
		this.fullname = ""
		this.username = ""
		this.password = ""
		this.location = ""		
		this.birth_month = ""
		this.birth_day = ""
		this.birth_year = ""
		this.birthdate = ""
		this.netmail = ""
		this.escapemode = false
		this.escapebuffer = ""
		this.current_field = 0
		this.current_input_type = ""
		this.field_name = ""
		this.box_width = 42
		this.box_height = 12
		this.box_start_x = 0
		this.box_start_y = 0
		this.prompt_height = 3
		this.input_height = 1
		this.label_x = 0
		this.label_y = 0
		this.prompt_x = 0
		this.prompt_y = 0
		this.input_x = 0
		this.input_y = 0
		this.title_x = 0
		this.title_y = 0
		this.errorx = 0
		this.errory = 0
		this.cursor_x = 0
		this.cursor_y = 0
		this.entries = 0
		this.confirm_x = 3
		this.confirm_y = 3
		this.warnx = 0
		this.warny = 25
		this.haswarning = false
		this.nav_x = 3
		this.nav_y = 0
		this.last_completed = null
		this.validRegistration = false
		this.nav_msg = "Arrows move forward and back"
		this.esc_msg = "ESC Twice to abort"
		this.loggingId = "Registration System (" + this.call.connection_type + ")"
		this.title = " " + system_name + " - New User Registration "		
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
		if (inputTO - warnbuff > 0){
			this.warnTO = inputTO - warnbuff
		}else{
			this.warnTO = Math.round(inputTO/2)
		}
	}
	drawArt(){
		this.call.cmds.drawrandomscreen("Login")

	}
	getMenuPos(){
		if (this.call.term_width > 0){
			this.box_start_x = (Math.round(this.call.term_width/2) - Math.round(this.box_width/2))
			this.box_start_y = (Math.round(this.call.term_height/2) - Math.round(this.box_height/2))
			this.title_x = (Math.round(this.call.term_width/2) - Math.round(this.title.length/2))
			this.label_x = this.box_start_x + 2
			this.label_y = this.box_start_y + 1
			this.title_y = this.box_start_y - 2
			this.prompt_x = this.box_start_x + 2
			this.prompt_y = this.label_y + 2
			this.input_x = this.box_start_x + 2
			this.input_y = this.prompt_y + this.prompt_height + 1
			this.errorx = this.box_start_x + 1
			this.errory = this.input_y + 2
			this.box_end_x = this.box_start_x + this.box_width
			this.warnx = this.errorx
			this.warny = this.errory
			this.nav_y = this.call.term_height - 3
			//this.fieldspaces = this.box_width - 12
			//console.log("Start coords:", this.label_x, this.label_y, this.prompt_x, this.prompt_y)
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
		//this.contmessagex = this.box_end_x - 28
		//this.contmessagey = this.box_start_y + this.box_height
	}
	clearlabel(){
		this.call.cmds.movecursor(this.label_x, this.label_y)
		this.call.cmds.cleartoeol()
		this.call.cmds.movecursor(this.box_end_x, this.label_y)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_vert_block)
		this.call.cmds.resetcolors()
	}
	clearPrompt(){
		var currY = this.prompt_y
		for (var i=0;i<this.prompt_height;++i){
			this.call.cmds.movecursor(this.prompt_x, currY)
			this.call.cmds.cleartoeol()
			this.call.cmds.movecursor(this.box_end_x, currY)
			this.call.cmds.setfgcolor(border_clr)
			this.call.cmds.senddata(this.menu_vert_block)
			currY += 1
		}		
		this.call.cmds.resetcolors()
	}
	clearInput(){
		this.call.cmds.movecursor(this.input_x, this.input_y)
		this.call.cmds.cleartoeol()
		this.call.cmds.movecursor(this.box_end_x, this.input_y)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_vert_block)
		this.call.cmds.resetcolors()
	}
	drawBox(){
		//console.log("Drawing a Box")
		this.call.cmds.clearscreen()
		this.emitter.emit("DrawSysInfo")
		this.call.cmds.movecursor(this.title_x, this.title_y)
		this.call.cmds.setbgcolor(title_bg_clr)
		this.call.cmds.setfgcolor(title_clr)
		this.call.cmds.senddata(this.title)
		this.call.cmds.resetcolors()
		var currY = this.box_start_y
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.setfgcolor(border_clr)
		this.call.cmds.senddata(this.menu_top_line)
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.senddata(this.menu_vert_block)
		this.call.cmds.movecursor(this.box_end_x, currY)
		this.call.cmds.senddata(this.menu_vert_block)
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.senddata(this.menu_mid_line)
		currY += 1		
		for (var ph=0;ph<this.prompt_height;++ph){
			this.call.cmds.movecursor(this.box_start_x, currY)
			this.call.cmds.senddata(this.menu_vert_block)
			this.call.cmds.movecursor(this.box_end_x, currY)
			this.call.cmds.senddata(this.menu_vert_block)
			currY +=1			
		}
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.senddata(this.menu_mid_line)
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.senddata(this.menu_vert_block)
		this.call.cmds.movecursor(this.box_end_x, currY)
		this.call.cmds.senddata(this.menu_vert_block)
		currY += 1
		this.call.cmds.movecursor(this.box_start_x, currY)
		this.call.cmds.senddata(this.menu_bottom_line)
	}
	confirmEntries(){
		this.field_name = "Confirmation"
		this.current_input_type = "YesNoQuit"
		//display and get confirmation. Restart, create user, or exit
		this.call.cmds.clearscreen()
		var currY = this.confirm_y
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.setfgcolor(11)
		this.call.cmds.senddata("Confirm User Data:")
		currY += 2
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.setfgcolor(2)
		this.call.cmds.senddata("Real Name: ")
		this.call.cmds.setfgcolor(14)
		this.call.cmds.senddata(this.fullname)
		currY += 1
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.setfgcolor(2)
		this.call.cmds.senddata("Username : ")
		this.call.cmds.setfgcolor(14)
		this.call.cmds.senddata(this.username)
		currY += 1
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.setfgcolor(2)
		this.call.cmds.senddata("Location : ")
		this.call.cmds.setfgcolor(14)
		this.call.cmds.senddata(this.location)
		currY += 1
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.setfgcolor(2)
		this.call.cmds.senddata("Password : ")
		this.call.cmds.setfgcolor(14)
		this.call.cmds.senddata("*********")
		currY += 1
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.setfgcolor(2)
		this.call.cmds.senddata("Netmail  : ")
		this.call.cmds.setfgcolor(14)
		this.call.cmds.senddata(this.netmail)
		currY += 1
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.setfgcolor(2)
		this.call.cmds.senddata("Birthday : ")
		this.call.cmds.setfgcolor(14)
		this.call.cmds.senddata(this.birthdate)
		currY += 2
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.setfgcolor(11)		
		this.call.cmds.senddata("Do you wish to complete registration?")
		currY += 1
		this.call.cmds.movecursor(this.confirm_x, currY)
		this.call.cmds.senddata("Y/N/Q:")
		//this.runningparser = false
		//console.log("Should be marked clear here...")
		return;
	}
	createUser(){
		//console.log("Creating User Record")
		var logmsg = this.loggingId + "\r\n  Attempting to create user record"
		alogger.writeAlog(5, logmsg, "green")
		var newres = {
			username: this.username,
			firstname: this.firstname,
			lastname: this.lastname,
			fullname: this.firstname + " " + this.lastname,
			password: this.password,
			netmail: this.netmail,
			location: this.location,
			birthdate: this.birthdate,
			birth_day: this.birth_day,
			birth_month: this.birth_month,
			birth_year: this.birth_year
		}
		createNewUser(newres)
			.then(res => {
				if (res.status){
					//console.log("User created! Let's exit and continue")
					var logmsg = this.loggingId + "\r\n  New user registration complete!\r\n  Username: " + this.username + "\r\n  DbID: " + res.resultid
					alogger.writeAlog(5, logmsg, "greenbright", true)
					alogger.writeClog(3, logmsg, "NewUsers", "greenbright", true)
					this.validRegistration = true
					this.dbid = res.resultid
					this.validReg()
				}else{
					this.doRegError()					
				}								
			})
			.catch(err =>{
				var logmsg = this.loggingId + "\r\n  Error creating user\r\n" + err
				alogger.writeAlog(3, logmsg, "red")
				return;
			})
		//console.log("Waiting?")
		//return;
	}
	fillPrompt(){
		switch (this.field_name){
			case "Username":
				if (this.username){
					this.inputbuffer = this.username
					this.call.cmds.senddata(this.username)
					this.cursor_x += this.username.length
				}
				break;
			case "Firstname":
				if (this.firstname){
					this.inputbuffer = this.firstname
					this.call.cmds.senddata(this.firstname)
					this.cursor_x += this.firstname.length
				}
				break;
			case "Lastname":
				if (this.lastname){
					this.inputbuffer = this.lastname
					this.call.cmds.senddata(this.lastname)
					this.cursor_x += this.lastname.length
				}
				break;
			case "Password":
				//console.log("Password field")
				var minlmsg = "Min length: " + pwmin
				this.call.cmds.movecursor(this.input_x, (this.input_y-2))
				this.call.cmds.setfgcolor(pwl_clr)
				this.call.cmds.senddata(minlmsg)
				this.call.cmds.movecursor(this.input_x, this.input_y)
				this.call.cmds.setfgcolor(input_clr)
				if (this.password){
					this.inputbuffer = this.password
					var pwstring = ""
					for (var pl=0;pl<this.password.length;++pl){
						pwstring += "*"
					}
					this.call.cmds.senddata(pwstring)
					this.cursor_x += pwstring.length
				}
				break;
			case "Birthdate":
				if (this.birthdate){
					this.inputbuffer = this.birthdate
					this.call.cmds.senddata(this.birthdate)
					this.cursor_x += this.birthdate.length
				}
				break;
			case "Location":
				if (this.location){
					this.inputbuffer = this.location
					this.call.cmds.senddata(this.location)
					this.cursor_x += this.location.length
				}
				break;
			default:
				//
				break;
		}
	}
	sendPrompt(){
		if (this.current_field >= regstages.length){
			//console.log("Appear to have reached the end.")
			//do final check here, create record, and set to exit
			this.confirmEntries()
			return;
		}
		if (this.current_field > 0){
			if (this.last_completed == null){
				this.last_completed = (this.current_field - 1)
			}else{
				if (this.current_field-1 > this.last_completed){
					this.last_completed = this.current_field-1
				}
			}
		}
		if (this.entries > 0){
			this.clearlabel()
			this.clearPrompt()
			this.clearInput()
		}
		this.current_input_type = regstages[this.current_field].inputtype
		this.field_name = regstages[this.current_field].field_name
		if (this.current_field > 0){
			var completepcnt = Math.round(this.current_field/regstages.length * 100) + "%"
		}
		else{
			var completepcnt = "0%"
		}
		var percentx = this.box_end_x-(completepcnt.length + 2)
		this.call.cmds.movecursor(this.label_x, this.label_y)
		this.call.cmds.setfgcolor(label_clr)
		this.call.cmds.senddata(regstages[this.current_field].display)
		this.call.cmds.movecursor(percentx, this.label_y)
		this.call.cmds.setfgcolor(progress_clr)
		this.call.cmds.senddata(completepcnt)
		var currY = this.prompt_y
		this.call.cmds.movecursor(this.prompt_x, currY)
		this.call.cmds.setfgcolor(regstages[this.current_field].prompt_clr)
		var promptwordarr = regstages[this.current_field].prompt.split(" ")
		var xpos = this.prompt_x
		for (var pri=0;pri<promptwordarr.length;++pri){
			if (pri != 0){
				if (xpos < (this.box_end_x - 1)){
					this.call.cmds.senddata(" ")
					xpos += 1
				}else{
					xpos = this.prompt_x
					currY +=1
					this.call.cmds.movecursor(xpos, currY)
				}
			}
			if ((xpos + promptwordarr[pri].length) < this.box_end_x){
				this.call.cmds.senddata(promptwordarr[pri])
				xpos = xpos + promptwordarr[pri].length
			}else{
				xpos = this.prompt_x
				currY += 1
				this.call.cmds.movecursor(xpos, currY)
				this.call.cmds.senddata(promptwordarr[pri])
				xpos = xpos + promptwordarr[pri].length
			}
		}
		if (regstages[this.current_field].prompt2){
			currY +=1
			if (currY < this.prompt_y + (this.prompt_height-1)){
				currY = this.prompt_y + (this.prompt_height-1)
			}
			this.call.cmds.movecursor(this.prompt_x, currY)
			this.call.cmds.senddata(regstages[this.current_field].prompt2)
		}
		this.call.cmds.movecursor(this.input_x, this.input_y)
		this.cursor_x = this.input_x
		this.cursor_y = this.input_y
		this.call.cmds.setfgcolor(input_clr)
		this.fillPrompt()
	}
	startRegistration(){
		var logmsg = this.loggingId + "\r\n  Starting new Registration"
		alogger.writeAlog(5, logmsg, "greenbright", true)
		this.drawBox()
		this.drawCmds()
		this.sendPrompt()
	}
	evalInput(){
		this.entries += 1
		//console.log(this.field_name)
		switch (this.field_name){
			case "Confirmation":
				//console.log("Confirmation: ", this.inputbuffer)
				if (this.inputbuffer.toLowerCase() == "y"){
					//console.log("This is where we try to write the DB")
					this.inputbuffer = ""
					this.createUser()
					return;
				}
				this.current_field = 0
				this.inputbuffer = ""
				this.current_input_type = ""
				this.field_name = ""
				this.startRegistration()
				return;
			case "AgeVerification":
				//
				if (this.inputbuffer.toLowerCase() == "y"){
					this.call.cmds.movecursor(this.errorx, this.errory)
					//this.call.cmds.setfgcolor(success_clr)
					//this.call.cmds.senddata("Password OK!")
					this.call.cmds.resetcolors()
					this.inputbuffer = ""
					this.current_field += 1
					this.sendPrompt()
					return;
				}
				this.inputbuffer = ""
				this.call.cmds.movecursor(this.errorx, this.errory)
				this.call.cmds.setfgcolor(error_clr)
				this.call.cmds.senddata("You must be 13 to access this site")
				this.call.cmds.movecursor(this.errorx, (this.errory + 1))
				this.call.cmds.senddata("Press any key to exit Registration")
				this.exitready = true
				this.call.cmds.resetcolors()
				//this.sendPrompt()
				return;
			case "Firstname":
				if (this.inputbuffer.length > 0){
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(success_clr)
					//this.call.cmds.senddata("Username Available")
					this.call.cmds.resetcolors()
					this.firstname = this.inputbuffer
					this.inputbuffer = ""
					this.current_field += 1
					this.sendPrompt()
					return;					
				}
				this.inputbuffer = ""
				this.call.cmds.movecursor(this.errorx, this.errory)
				this.call.cmds.cleartoeol()
				this.call.cmds.setfgcolor(error_clr)
				this.call.cmds.senddata("Please try again")
				this.call.cmds.resetcolors()
				this.sendPrompt()
				return;
			case "Lastname":
				if (this.inputbuffer.length > 0){
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(success_clr)
					//this.call.cmds.senddata("Username Available")
					this.call.cmds.resetcolors()
					this.lastname = this.inputbuffer
					this.fullname = this.firstname + " " + this.lastname
					this.inputbuffer = ""
					this.current_field += 1
					this.sendPrompt()
					return;					
				}
				this.inputbuffer = ""
				this.call.cmds.movecursor(this.errorx, this.errory)
				this.call.cmds.cleartoeol()
				this.call.cmds.setfgcolor(error_clr)
				this.call.cmds.senddata("Please try again")
				this.call.cmds.resetcolors()
				this.sendPrompt()
				return;
			case "Location":
				if (this.inputbuffer.length > 0){
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(success_clr)
					//this.call.cmds.senddata("Username Available")
					this.call.cmds.resetcolors()
					this.location = this.inputbuffer
					this.inputbuffer = ""
					this.current_field += 1
					this.sendPrompt()
					return;					
				}
				this.inputbuffer = ""
				this.call.cmds.movecursor(this.errorx, this.errory)
				this.call.cmds.cleartoeol()
				this.call.cmds.setfgcolor(error_clr)
				this.call.cmds.senddata("Please try again")
				this.call.cmds.resetcolors()
				this.sendPrompt()
				return;
			case "Netmail":
				if (this.inputbuffer.length > 0){
					var checkaddr = this.inputbuffer
					checkRegMailAddress(checkaddr)
						.then(res =>{
							if (res.status){
								this.call.cmds.movecursor(this.errorx, this.errory)
								this.call.cmds.cleartoeol()
								this.call.cmds.setfgcolor(success_clr)
								//this.call.cmds.senddata("Unique and valid address!")
								this.call.cmds.resetcolors()
								this.netmail = checkaddr
								this.inputbuffer = ""
								this.current_field += 1
								this.sendPrompt()
								return;
							}
							this.inputbuffer = ""
							this.call.cmds.movecursor(this.errorx, this.errory)
							this.call.cmds.cleartoeol()
							this.call.cmds.setfgcolor(error_clr)
							if (res.isvalid && res.inuse){
								this.call.cmds.senddata("Address already in use")
							}else{
								this.call.cmds.senddata("That does not appear to be a valid address")
							}							
							this.call.cmds.resetcolors()
							this.sendPrompt()
							return;
						})
						.catch(err =>{
							console.log(err)
							this.inputbuffer = ""
							this.call.cmds.movecursor(this.errorx, this.errory)
							this.call.cmds.cleartoeol()
							this.call.cmds.setfgcolor(error_clr)
							this.call.cmds.senddata("Error validating address")
							this.call.cmds.resetcolors()
							this.sendPrompt()
							return;
						})
				}
				return;
			case "Username":
				var username = this.inputbuffer
				checkUsernameAvailable(this.inputbuffer)
					.then(res =>{
						if (res == true){
							//username avail
							this.call.cmds.movecursor(this.errorx, this.errory)
							this.call.cmds.cleartoeol()
							this.call.cmds.setfgcolor(success_clr)
							this.call.cmds.senddata("Username Available")
							this.call.cmds.resetcolors()
							console.log("Setting username", this.inputbuffer)
							this.username = username
							this.inputbuffer = ""
							this.current_field += 1
							this.sendPrompt()
							return;
						}					
					})
					.catch(err => {
						var logmsg = this.loggingId + "\r\n  Error checking username\r\n" + err
						alogger.writeAlog(5, logmsg, "green")
					})
					this.inputbuffer = ""
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(error_clr)
					this.call.cmds.senddata("Username in use. Try again")
					this.call.cmds.resetcolors()
					this.sendPrompt()
					return;
			case "Password":
				//console.log("Password received")
				if (this.inputbuffer.length > pwmin){
					//pw good. continue					
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(success_clr)
					this.call.cmds.senddata("Password OK!")
					this.call.cmds.resetcolors()
					this.password = this.inputbuffer
					this.inputbuffer = ""
					this.current_field += 1
					this.sendPrompt()
				}else{
					//pw no good repeat
					this.inputbuffer = ""
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(error_clr)
					this.call.cmds.senddata("Password too short.")
					this.call.cmds.resetcolors()
					this.sendPrompt()
					return;
				}
				break
			case "PasswordConfirm":
				//console.log("Password Confirmation")
				if (this.inputbuffer == this.password){
					//pw good. continue
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(success_clr)
					this.call.cmds.senddata("Password OK!")
					this.call.cmds.resetcolors()
					this.password = this.inputbuffer
					this.inputbuffer = ""
					this.current_field += 1
					this.sendPrompt()
				}else{
					//pw no good. Restart password stage
					this.inputbuffer = ""
					this.password = ""
					this.current_field -= 1
					this.last_completed = this.current_field
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(error_clr)
					this.call.cmds.senddata("Passwords don't match")
					this.call.cmds.resetcolors()
					this.sendPrompt()
					return;
				}
				break
			case "Birthdate":
				//console.log("Birthdate received")
				var datearr = this.inputbuffer.split("/")
				var currentyear = DateTime.now().toFormat('yyyy')
				//console.log("Current year", currentyear)				
				var roughuserage = currentyear - datearr[0]
				console.log("New user Age: ", roughuserage)
				if (roughuserage < 13){
					//to young.
					this.inputbuffer = ""
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(error_clr)
					this.call.cmds.senddata("That birth_day would make you too young for access.")
					this.call.cmds.resetcolors()
					this.sendPrompt()
					return;
				}
				if (roughuserage > 110){
					//this seems really unbelievable
					this.inputbuffer = ""
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(error_clr)
					this.call.cmds.senddata("You're over 110? Really?")
					this.call.cmds.resetcolors()
					this.sendPrompt()
					return;
				}
				if (datearr[1] > 12){
					this.inputbuffer = ""
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(error_clr)
					this.call.cmds.senddata("Invalid Date String")
					this.call.cmds.resetcolors()
					this.sendPrompt()
					return;
				}
				if (datearr[2]>31){
					//we should ensure that the day is ok for the month... but this will work for a start
					this.inputbuffer = ""
					this.call.cmds.movecursor(this.errorx, this.errory)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(error_clr)
					this.call.cmds.senddata("Invalid Date String")
					this.call.cmds.resetcolors()
					this.sendPrompt()
					return;
				}
				//date good. continue
				this.call.cmds.movecursor(this.errorx, this.errory)
				this.call.cmds.cleartoeol()
				this.call.cmds.setfgcolor(success_clr)
				//this.call.cmds.senddata("Password OK!")
				this.call.cmds.resetcolors()
				this.birth_day = datearr[2]
				this.birth_month = datearr[1]
				this.birth_year = datearr[0]
				this.birthdate = this.inputbuffer
				this.inputbuffer = ""
				this.current_field += 1
				this.sendPrompt()
				return;
			default:
				console.log("Unable to find evaluation rule or target for field")
				this.inputbuffer = ""
				this.call.cmds.movecursor(this.errorx, this.errory)
				this.call.cmds.cleartoeol()
				this.call.cmds.setfgcolor(error_clr)
				this.call.cmds.senddata("Something went wrong. Try again.")
				this.call.cmds.resetcolors()
				this.sendPrompt()
				return;
		}

	}
	drawCmds(){
		var currY = this.nav_y
		this.call.cmds.movecursor(this.nav_x, currY)
		this.call.cmds.setfgcolor(nav_clr)
		this.call.cmds.senddata(this.nav_msg)
		currY += 1
		this.call.cmds.movecursor(this.nav_x, currY)
		this.call.cmds.setfgcolor(esc_clr)
		this.call.cmds.senddata(this.esc_msg)
	}
	doBackspace(){
		if (this.inputbuffer.length > 0){
			this.inputbuffer = this.inputbuffer.slice(0, -1)
			this.call.cmds.senddata("\b \b")
			this.cursor_x -= 1
		}
	}
	doDateBackspace(){
		if (this.inputbuffer.length > 0){
			if ((this.inputbuffer.length == 5)||(this.inputbuffer.length == 8)){
				this.inputbuffer = this.inputbuffer.slice(0, -1)
				this.call.cmds.senddata("\b \b")
				this.cursor_x -= 1
			}
			this.inputbuffer = this.inputbuffer.slice(0, -1)
			this.call.cmds.senddata("\b \b")
			this.cursor_x -= 1
		}					
		return;
	}
	checkChar(stringchar){
		switch (this.current_input_type){
			case "YesNo":
				//
				if ((stringchar.toLowerCase() == "y")||(stringchar.toLowerCase() == "n")){
					this.call.cmds.senddata(stringchar)
					this.inputbuffer += stringchar
					this.evalInput()
				}						
				break;
			case "YesNoQuit":
				//
				if (stringchar.toLowerCase() == "q"){
					//console.log("Quit registration")
					this.exitready = true
					return;
				}
				if ((stringchar.toLowerCase() == "y")||(stringchar.toLowerCase() == "n")){
					this.call.cmds.senddata(stringchar)
					this.inputbuffer += stringchar
					this.evalInput()
				}						
				break;
			case "Name":
				if (this.inputbuffer.length < 1){
					stringchar = stringchar.toUpperCase()
				}
				if (validnamechars.test(stringchar)){
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.cursor_x += 1
				}
				break;
			case "Netmail":
				stringchar = stringchar.toLowerCase()
				if (validnetmailchars.test(stringchar)){
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.cursor_x += 1
				}
				//console.log(stringchar)
				break;
			case "RealName":
				if (this.inputbuffer.length < 1){
					stringchar = stringchar.toUpperCase()
				}
				if (validrnamechars.test(stringchar)){
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.cursor_x += 1
				}
				break;
			case "Location":
				if (this.inputbuffer.length < 1){
					stringchar = stringchar.toUpperCase()
				}
				if (validlocationchars.test(stringchar)){
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.cursor_x += 1
				}
				break;
			case "Username":
				if (validunamechars.test(stringchar)){
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.cursor_x += 1
				}
				break;
			case "Password":
				if (validpwchars.test(stringchar)){
					this.inputbuffer += stringchar
					this.call.cmds.senddata("*")
					this.cursor_x += 1
				}
				break;
			case "Date":
				if (!validdatechars.test(stringchar)){
					return;
				}
				if (this.inputbuffer.length < 1){
					if ((stringchar != 0) && (stringchar < 3)){
						this.inputbuffer += stringchar
						this.call.cmds.senddata(stringchar)
						this.cursor_x += 1
					}
					return;
				}
				if (this.inputbuffer.length == 1){
					if ((stringchar == 0) || (stringchar == 9)){
						this.inputbuffer += stringchar
						this.call.cmds.senddata(stringchar)
						this.cursor_x += 1
					}
					return;
				}
				if (this.inputbuffer.length == 2){
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.cursor_x += 1
					return;
				}
				if (this.inputbuffer.length == 3){
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.cursor_x += 1
					this.inputbuffer += "/"
					this.call.cmds.senddata("/")
					this.cursor_x += 1
					return;
				}
				if (this.inputbuffer.length == 5){
					if ((stringchar == 0) || (stringchar == 1)){
						this.inputbuffer += stringchar
						this.call.cmds.senddata(stringchar)
						this.cursor_x += 1
					}
					return;
				}
				if (this.inputbuffer.length == 6){
					if (this.inputbuffer.slice(6) == 1){
						if (stringchar < 3){
							this.inputbuffer += stringchar
							this.call.cmds.senddata(stringchar)
							this.cursor_x += 1
							this.inputbuffer += "/"
							this.call.cmds.senddata("/")
							this.cursor_x += 1
						}
						return;
					}
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.inputbuffer += "/"
					this.call.cmds.senddata("/")
					return;

				}
				if (this.inputbuffer.length == 8){
					if (stringchar < 4){
						this.inputbuffer += stringchar
						this.call.cmds.senddata(stringchar)
						this.cursor_x += 1
					}
					return;
				}
				if (this.inputbuffer.length == 9){
					this.inputbuffer += stringchar
					this.call.cmds.senddata(stringchar)
					this.cursor_x += 1
					return;
				}
				//console.log("No rule found in date")
				break;
			default:
				//
				//console.log("No input type found for ", stringchar)
				break
		}
	}
	checkEnter(){
		switch(this.current_input_type){
			case "YesNo":
				this.call.cmds.sendbeep()
				break;
			case "YesNoQuit":
				this.call.cmds.sendbeep()
				break;
			case "Date":
				if (this.inputbuffer.length == 10){
					this.evalInput()
					return;
				}else{
					this.call.cmds.sendbeep()
				}
				break;
			default:
				if (this.inputbuffer.length > 0){
					this.evalInput()
					return;
				}else{
					this.call.cmds.sendbeep()
				}
		}
	}
	nextField(){
		if (this.last_completed != null){
			if (this.current_field <= this.last_completed){
				this.current_field += 1
				if (regstages[this.current_field].field_name == "PasswordConfirm"){
					if (this.current_field <= this.last_completed){
						this.current_field = this.current_field +1
					}
				}
				this.sendPrompt()
				return;
			}
		}
		this.call.cmds.sendbeep()
	}
	prevField(){
		if (this.current_field > 0){
			this.current_field = this.current_field - 1
			if (regstages[this.current_field].field_name == "PasswordConfirm"){
				this.current_field = this.current_field -1
			}
			this.sendPrompt()
			return;
		}
		this.call.cmds.sendbeep()
	}
	doAbortCmd(){
		this.exitready = true
		this.signalReturn()
		return;
	}
	checkKey(inputkey){
		switch (inputkey){
			case "Enter":
				this.checkEnter()
				return;
			case "Backspace":
				if (this.inputtype == "Date"){
					this.doDateBackspace()
					return;
				}else{
					this.doBackspace()
					return;
				}
				break;
			case "UpArrow":
				this.prevField()
				return;
			case "DownArrow":
				this.nextField()
				return;
			case "LeftArrow":
				this.prevField()
				return;
			case "RightArrow":
				this.nextField()
				return;
			case "Tab":
				this.nextField()
				return;
			case "ESC":
				this.doAbortCmd()
				return;
			case "^A":
				this.doAbortCmd()
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
			this.clearTimeouts()
			if (this.haswarning){
				this.clearWarning()
			}
			//console.log(this.stringbuff)
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
		if (this.call){
			this.call.cmds.movecursor(this.warnx, this.warny)
			this.call.cmds.cleartoeol()
			this.haswarning = false
			//need to move cursor to where it should be after clearing.
			//not an issue on this module, but could be on others
			this.call.cmds.setfgcolor(input_clr)
			this.call.cmds.movecursor(this.cursor_x, this.cursor_y)
		}		
	}
	inactivityWarn(){
		try{
			if (this.call){
				if (!this.finished){
					this.haswarning = true
					this.call.cmds.movecursor(this.warnx, this.warny)
					this.call.cmds.cleartoeol()
					this.call.cmds.setfgcolor(warn_clr)
					this.call.cmds.senddata(warnmsg)
				}
			}
		}catch(err){
			//console.log("TO Error from Registration", err)
			this.zombieChecker()
		}
	}
	inactivityResult(){
		try{
			if (this.call){
				if (!this.finished){
					if ((this.exitready) && (!this.triedexit)){
						this.triedexit = true
						this.inactiveTO = setTimeout(this.inactivityResult.bind(this), 5000)
						this.signalReturn()
						return;
					}
					this.call.cmds.movecursor(this.warnx, this.warny)
					this.call.cmds.setfgcolor(warn_clr)
					this.call.cmds.cleartoeol()
					this.call.cmds.senddata(inactivemsg)
					var logmsg = this.loggingId + "\r\n  Call from " + this.call.callerId + " inactivity disconnect."
					alogger.writeAlog(3, logmsg, "cyan")
					this.emitter.emit("HangupSignal")
					return;
				}
				this.clearHandler()
			}
		}catch(err){
			var logmsg = this.loggingId + "\r\n  Inactivity timeout error\r\n  " + err
			alogger.writeAlog(5, logmsg, "red", true)
			this.zombieChecker()
		}
	}
	afterSuccessPrompt(){
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata("User Creation Success!\r\n  Press Enter to Continue...")
		this.exitready = true
	}
	validReg(){
		this.clearTimeouts()
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata("Record written to DB!\r\nTesting it can be retrieved...")
		this.call.caller_fullname = this.fullname
		this.call.caller_username = this.username
		this.call.caller_location = this.location
		console.log("Loading created record")
		getUserRecord(this.username)
			.then(urecord =>{
				if (urecord){
					this.call.user_record = urecord
					this.afterSuccessPrompt()
				}else{
					this.doRegError()
				}
			}).catch(err =>{
				console.log(err)
				this.doRegError()
			})
	}
	doRegError(){
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata("Something went wrong saving your registration\r\n Please try again later, but unfortunately we must exit now\r\n  Press Enter to Hangup...")
		this.validRegistration = false
		this.fatal_error = true
		this.setTimeouts()
		this.exitready = true
	}
	signalReturn(){
		this.setZombieTO()
		if (this.validRegistration){
			console.log("Signalling Registration is Good!")
			this.emitter.emit("RegistrationOK")		
		}else{
			if (this.fatal_error){
				this.emitter.emit("InvalidReg")
			}else{
				this.emitter.emit('ModuleReturn')
			}
		}
		this.finished = true
	}
	setZombieTO(){
		//check this hasn't already been cleared before setting a zombie timer.
		if (this.call != null){
			this.zombieTO = setTimeout(this.zombieChecker.bind(this), this.exit_timeout)
		}
	}
	zombieChecker(){
		console.log("Registration Zombie")
		//emit again and then cleanup
		if (this.call != null){
			if (this.validRegistration){
				console.log("Signalling Registration is Good!")
				this.emitter.emit("RegistrationOK")
			}else{
				if (this.fatal_error){
					this.emitter.emit("InvalidReg")
				}else{
					this.emitter.emit('ModuleReturn')
				}
			}
		}
	}
	setTimeouts(){
		if (!this.finished){
			this.inactiveTO = setTimeout(this.inactivityResult.bind(this), inputTO)
			this.dowarnTO = setTimeout(this.inactivityWarn.bind(this), this.warnTO)
			return;
		}
		//console.log("Something trying to set timeouts in reg handler after exit")
	}
	clearTimeouts(){
		clearTimeout(this.inactiveTO)
		clearTimeout(this.dowarnTO)
		clearTimeout(this.zombieTO)
	}
	clearHandler(){
		this.clearTimeouts()
		this.call = null
		this.theme = null
		delete this
	}
	startStage(){
		//console.log("Starting Registration Handler")
		if (this.call != null){
			this.getMenuPos()
			this.drawArt()
			this.startRegistration()
			this.setTimeouts()
		}
	}

}


//exports
export{registrationHandler}