//node imports
import { EventEmitter } from 'node:events';
//3p imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getUserList} from "../models/useraccounts.js"
import {saveMessage} from "../models/messages.js"
//setup
const df_exit_timeout = 10000
const df_field_clr = 13
const df_header_clr = 14
const df_input_clr = 11
const df_border_clr = 4
const df_prompt_clr = 14
const df_cmd_clr = 2
const df_header_field_width = 35
const df_header_columns = 2
const df_msg_start_y = 4
const df_msg_x_margin = 0
const df_header_elements = ["MessageType", "WritingAs", "MessageTarget", "Recipient", "QuickCmds", "Subject"]

//class and function space


class simpleEditor{
	constructor(call, pauseonexit, return_type, message_type, message_target, use_realname, recipient, subject){
		this.call = call
		this.theme = this.call.theme
		this.type = "Runner"
		this.cmdType = "Editor"
		this.emitter = new EventEmitter();
		this.exit_timeout = df_exit_timeout
		// We are going to build an input parser that can be run at either the connection, callmanager, or menu handler level
		// and swapped out like the terminal command set depending on terminal or connection type.
		// This will allow much quicker and easier development of modules that do not need the more direct IO control on input.
		// This is also inherently much more easily compatible with Websockets.
		this.input_type = "KeyArray"
		this.input_array = []
		// The two above fields will be the data target and trigger to use the parser
		this.message_type = message_type
		this.message_target = message_target
		this.use_realname = use_realname
		if (this.use_realname){
			this.post_as = this.call.caller_fullname
		}else{
			this.post_as = this.call.caller_username
		}		
		this.line_array = []
		this.current_line_stringbuff = ""
		this.messagebuffer = ""
		this.recipient = recipient
		this.subject = subject
		this.return_type = return_type
		this.stringbuffer = ""
		this.fieldbuffer = ""
		this.current_field = ""
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.esc_key_count = 0
		this.pauseonexit = pauseonexit
		this.start_y = 2
		this.start_x = 2
		this.max_x = 80
		this.max_y = 24
		this.cursor_text_line = 0
		this.cursor_text_col = 0
		this.last_text_line = 0
		this.last_text_col = 0
		this.cursor_screen_x = 0
		this.cursor_screen_y = 0
		this.previous_header_length = 0
		this.message_start_y = df_msg_start_y
		this.message_start_x = df_msg_x_margin
		this.curr_header_x = this.start_x
		this.curr_header_y = this.start_y
		this.message_x_margin = df_msg_x_margin
		this.message_end_x = this.max_x - this.message_x_margin
		this.header_field_width = df_header_field_width
		this.header_colums = df_header_columns
		this.header_clr = df_header_clr
		this.input_clr = df_input_clr
		this.field_clr = df_field_clr
		this.border_clr = df_border_clr
		this.prompt_clr = df_prompt_clr
		this.cmd_clr = df_cmd_clr
		this.header_elements = df_header_elements
		//this.border_block = this.call.charset.boxes[27]
		this.border_block = this.call.charset.getBoxBuff(26)
		this.border_line = this.border_block
		this.zombieTO
	}
	runCmd(){
		this.getMenuPos()
		this.call.cmds.senddata("\r\n")
		this.call.cmds.clearscreen()
		if (!this.message_target){
			this.call.cmds.senddata("You MUST have a valid Area selected to post!\r\n")
			this.doAbortCmd()
			return;
		}
		if ((this.recipient)&&(this.subject)){
			this.drawHeader()
		}else{
			if (!this.recipient){
				this.getRecipient()
			}else{
				this.getSubject()
			}
		}		
	}
	checkRecipient(){
		//put some logic here to see if area is local. If so, check for user.
		return true;
	}
	getSubject(){
		this.call.cmds.senddata("\r\n")
		this.current_field = "Subject"
		this.fieldbuffer = ""
		this.call.cmds.setfgcolor(this.header_clr)
		this.call.cmds.senddata("Message Subject: ")
		this.call.cmds.setfgcolor(this.input_clr)
	}
	getRecipient(){
		this.current_field = "Recipient"
		this.call.cmds.setfgcolor(this.header_clr)
		this.call.cmds.senddata("To: ")
		this.call.cmds.setfgcolor(this.input_clr)
		this.fieldbuffer = "ALL"
		this.call.cmds.senddata("ALL")
	}
	getMenuPos(){
		if (this.call.term_type != "Dumb"){
			this.max_x = this.call.term_width
			this.max_y = this.call.term_height
			if (this.max_x > 80){
				var diff80 = this.call.term_width - 80
				var adj80 = Math.round(diff80/2)
				this.header_colums = Math.round(this.max_y/this.header_field_width)
				this.message_start_x = adj80 + this.message_x_margin
				this.message_end_x = this.max_x - adj80 - this.message_x_margin
			}
		}else{
			this.border_block = Buffer.from("#")
		}
		for (var hb=0;hb<(this.max_x-2);++hb){
			this.border_line = Buffer.concat([this.border_line, this.border_block])
		}
	}
	drawSpaces(num){
		for (var sn=0;sn<num;++sn){
			this.call.cmds.senddata(" ")
		}
	}
	drawHeaderField(hfield){
		this.call.cmds.setfgcolor(this.header_clr)
		switch (hfield){
			case "WritingAs":
				var countstring = "   From: " + this.post_as
				this.call.cmds.senddata("   From: ")
				this.call.cmds.setfgcolor(this.field_clr)
				this.call.cmds.senddata(this.post_as)
				this.previous_header_length = countstring.length
				break;
			case "MessageType":				
				this.call.cmds.senddata("Posting: ")
				this.call.cmds.setfgcolor(this.field_clr)
				if (this.message_type == "Email" || "Netmail"){
					var countstring = "Posting: " + this.message_type
					this.call.cmds.senddata(this.message_type)
				}else{
					var countstring = "Posting: Message"
					this.call.cmds.senddata("Message")
				}
				this.previous_header_length = countstring.length
				break;
			case "Recipient":
				var countstring = "     To: " + this.recipient
				this.call.cmds.senddata("     To: ")
				this.call.cmds.setfgcolor(this.field_clr)
				if (this.recipient){
					this.call.cmds.senddata(this.recipient)
				}
				this.previous_header_length = countstring.length			
				break;
			case "Subject":
				var countstring = "Subject: " + this.subject
				this.call.cmds.senddata("Subject: ")
				this.call.cmds.setfgcolor(this.field_clr)
				if (this.subject){
					this.call.cmds.senddata(this.subject)
				}
				this.previous_header_length = countstring.length
				break;
			case "MessageTarget":
				var countstring = "   Area: " + this.message_target
				this.call.cmds.senddata("   Area: ")
				this.call.cmds.setfgcolor(this.field_clr)
				this.call.cmds.senddata(this.message_target)
				this.previous_header_length = countstring.length
				break;
			case "QuickCmds":
				this.call.cmds.setfgcolor(this.cmd_clr)
				var countstring = " /s on blank line Saves"
				this.call.cmds.senddata(countstring)
				this.previous_header_length = countstring.length
				break;
			default:
				console.log("Unknown Field")
				break;
		}
		this.call.cmds.resetcolors()
		return;
	}
	drawHeader(){
		this.call.cmds.senddata("\r\n")
		this.call.cmds.clearscreen()
		for (var hfi=0;hfi<this.header_elements.length;++hfi){
			if (this.curr_header_x + this.header_field_width > this.max_x){
				console.log("Next Header Line")
				this.curr_header_x = this.start_x
				this.curr_header_y += 1
				this.call.cmds.senddata("\r\n")
			}else{
				if (hfi > 0){
					var nspaces = this.header_field_width - this.previous_header_length
					console.log("Drawing", nspaces, "Spaces")
					console.log("Prev Header was", this.previous_header_length, "Wide")
					this.drawSpaces(nspaces)
				}				
			}
			this.drawHeaderField(this.header_elements[hfi])
			this.curr_header_x += this.header_field_width
		}
		this.call.cmds.senddata("\r\n")
		this.curr_header_y += 1
		this.call.cmds.setfgcolor(this.border_clr)
		//console.log(this.border_line)
		this.call.cmds.senddata(this.border_line)
		this.call.cmds.senddata("\r\n")
		this.message_start_y = this.curr_header_y + 1
		this.call.cmds.setfgcolor(this.input_clr)
	}
	exitCmd(){
		this.clearTimeouts()
		this.cmdexit = true
		if (this.pauseonexit){
			if (this.call != null){
				this.call.cmds.resetcolors()
				this.call.cmds.senddata("\r\n Press Enter to continue")
				return;
			}			
		}else{
			this.exitready = true
			if (this.call != null){
				this.call.cmds.resetcolors()
				this.handleData()
				return;
			}			
		}
	}
	drawBackspace(){
		this.call.cmds.senddata("\b \b")
	}
	doNewline(){		
		this.messagebuffer += "\r\n"
		var lineobj = {}
		lineobj.linestring = this.current_line_stringbuff
		lineobj.linestring += "\r\n"
		this.cursor_screen_x = this.message_start_x
		this.cursor_screen_y += 1
		this.last_text_line += 1
		this.cursor_text_line += 1
		this.line_array.push(lineobj)
		this.current_line_stringbuff = ""
		this.call.cmds.senddata("\r\n")
		this.cursor_text_col = 0
	}
	checkLine(){
		if (this.current_field == "Recipient"){
			if (this.fieldbuffer.length > 1){
				var validsender = this.checkRecipient()
				if (validsender){
					this.recipient = this.fieldbuffer
					this.fieldbuffer = ""
					if (!this.subject){
						this.current_field = "Subject"
						this.getSubject()
						return;
					}else{
						this.current_field = "Body"
						this.drawHeader()
						return;
					}
					
				}
			}
			return;
		}
		if (this.current_field == "Subject"){
			if (this.fieldbuffer.length > 1){
				this.subject = this.fieldbuffer
				this.fieldbuffer = ""
				this.current_field = "Body"
				this.drawHeader()
				return;
			}
			return;
		}
		if ((this.current_line_stringbuff == "/s")||(this.current_line_stringbuff =="/S")){
			this.current_line_stringbuff = ""
			this.doSaveCmd()
			return;
		}
		if ((this.current_line_stringbuff == "/a")||(this.current_line_stringbuff =="/A")){
			this.current_line_stringbuff = ""
			this.doAbortCmd()
			return;
		}
		this.doNewline();
	}
	doSaveSuccess(){
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata("  Success!")
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata("  Press Enter to continue")
		this.call.cmds.setfgcolor(this.input_clr)
		this.cmdexit = true
	}
	doSaveFail(){
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata("  Unable to save message")
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata("  Press Enter to Exit")
		this.call.cmds.setfgcolor(this.input_clr)
		this.cmdexit = true
	}
	doSaveCmd(){
		this.messagebuffer = this.messagebuffer.slice(0, -2)
		console.log("Save Command")
		// console.log("Message that would be saved:")
		// console.log(this.messagebuffer)
		// console.log("Or as Lines")
		// for (var ml of this.line_array){
		// 	console.log(ml.linestring)
		// }
		this.call.cmds.senddata("\r\n")
		this.call.cmds.setfgcolor(this.prompt_clr)
		this.call.cmds.senddata("  Saving Message")
		saveMessage(this.post_as, this.recipient, this.message_target, this.subject, this.messagebuffer)
			.then(res =>{
				if (res.status){
					this.doSaveSuccess()
				}else{
					this.doSaveFail()
				}
			}).catch(err =>{
				this.doSaveFail()
				console.log(err)
			})
	}
	doAbortCmd(){
		console.log("Abort Command")
		this.call.cmds.senddata("\r\n")
		this.call.cmds.setfgcolor(this.prompt_clr)
		this.call.cmds.senddata("  Aborting Message")
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata("  Press Enter to continue")
		this.call.cmds.setfgcolor(this.input_clr)
		this.cmdexit = true
	}
	loadLine(linenum){

	}
	doBackspace(){
		if ((this.current_field == "Recipient")||(this.current_field == "Subject")){
			if (this.fieldbuffer.length > 0){
				this.fieldbuffer = this.fieldbuffer.slice(0,-1)
				this.drawBackspace()
				return;
			}
			return;
		}
		if (this.cursor_text_col > 0){
			this.current_line_stringbuff = this.current_line_stringbuff.slice(0, -1)
			this.messagebuffer = this.messagebuffer.slice(0, -1)
			this.drawBackspace()
			this.cursor_text_col -= 1
		}
	}
	checkChar(stringchar){
		if ((this.current_field == "Recipient")||(this.current_field == "Subject")){
			this.fieldbuffer += stringchar
			this.call.cmds.senddata(stringchar)
			return;
		}
		//console.log(stringchar)
		if (this.cursor_text_col < 79){
			this.call.cmds.senddata(stringchar)
			this.current_line_stringbuff += stringchar
			this.messagebuffer += stringchar
			this.cursor_text_col += 1
			return;
		}
		this.call.cmds.senddata("\b")
		this.current_line_stringbuff = this.current_line_stringbuff.slice(0, -1)
		this.messagebuffer = this.messagebuffer.slice(0, -1)
		this.current_line_stringbuff += stringchar
		this.messagebuffer += stringchar
		this.call.cmds.senddata(stringchar)
	}
	checkKey(keyinput){
		switch(keyinput){
			case "Enter":
				console.log("Enter!")
				if (this.cmdexit){
					this.exitready = true
					return;
				}
				this.checkLine()
				break;
			case "ESC":
				this.esc_key_count += 1
				//console.log("ESC")				
				//do some escaping
				break;
			case "Space":
				this.checkCharInput(" ")
				break;
			case "Backspace":
				console.log("BS")
				this.doBackspace()
				break;
			case "^A":
				console.log("Abort Message")
				this.doAbortCmd()
				break;
			case "^S":
				console.log("Save Message")
				this.doSaveCmd()
				break;
			case "^Z":
				console.log("Message Options")
				this.call.cmds.senddata("\r\n")
				this.call.cmds.setfgcolor(this.prompt_clr)
				this.call.cmds.senddata("  Options would display here....")
				this.call.cmds.setfgcolor(this.input_clr)
				break;
			case "UpArrow":
				//move up

				break;
			case "DownArrow":
				//move down
				break;
			case "LeftArrow":
				//move left

				break;
			case "RightArrow":
				//move right
				break;
			default:
				console.log("Unhandled Key")
				console.log(keyinput)
				return;
		}
		if (this.esc_key_count >= 2){
			console.log("Aborting!")
			this.call.cmds.senddata("\r\n")
			this.call.cmds.setfgcolor(this.prompt_clr)
			this.call.cmds.senddata("  Aborting Message")
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata("  Press Enter to continue")
			this.call.cmds.setfgcolor(this.input_clr)
			this.exitready = true
		}
	}
	checkCmd(inputcmd){

	}
	checkInput(inputkey){
		if (inputkey != "KEY_ESC"){
			//console.log("Resetting Esc Count")
			this.esc_key_count = 0;
		}
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
		if (!this.finished){
			if (!this.runningparser){
				this.runningparser = true
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
			}
		}else{
			this.clearHandler()
			return;
		}
	}
	signalReturn(){
		this.setZombieTO()
		console.log("Signalling For Editor Exit")
		this.emitter.emit('ModuleReturn')
		this.finished = true
	}
	setZombieTO(){
		if (this.call != null){
			this.zombieTO = setTimeout(this.zombieChecker.bind(this), this.exit_timeout)
		}
	}
	zombieChecker(){
		//emit again and then cleanup		
		if (this.call != null){
			this.emitter.emit('ModuleReturn')
			this.clearHandler()
		}
	}
	setTimeouts(){
		if (this.cmdTO){
			this.stageTO = setTimeout(this.cmdTimeout.bind(this), cmdTO)
		}
	}
	clearTimeouts(){
		clearTimeout(this.zombieTO)
		clearTimeout(this.stageTO)
	}
	cmdTimeout(){
		if (!this.finished){
			console.log("Hit timeout")
			this.exitCmd()
		}
	}
	clearHandler(){
		this.clearTimeouts()
		this.call = null
		this.theme = null
		delete this
	}
	startStage(){
		this.runCmd()
	}
}

export{ simpleEditor }