//node imports
import { EventEmitter } from 'node:events';
//imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getMessages, getMessage, getMessageCount} from "../models/messages.js"

//const df_header_elements = ["MessageType", "WritingAs", "MessageTarget", "Recipient", "QuickCmds", "Subject"]
const df_header_elements = ["MessageTarget", "WritingAs", "MessageDate", "Recipient", "MessageNum", "Subject"]

class simpleMessageReader{
	constructor(call, msgarea, startidx){
		this.call = call
		if (this.call.term_type == "Dumb"){
			this.dumb = true
		}else{
			this.dumb = false
		}
		this.theme = this.call.theme
		this.message_area = msgarea
		this.message_idx = startidx
		this.min_idx = 0
		this.max_idx = 0
		this.max_msg = 0
		this.emitter = new EventEmitter()
		this.input_array = []
		this.stringbuffer = ""
		this.current_message
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.esc_key_count = 0
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
		this.message_start_y = 0
		this.message_start_x = 0
		this.curr_header_x = this.start_x
		this.curr_header_y = this.start_y
		this.message_x_margin = 0
		this.message_end_x = this.max_x - this.message_x_margin
		this.header_field_width = 35
		this.header_colums = 2
		this.header_elements = df_header_elements
		//this.border_block = this.call.charset.boxes[27]
		this.border_block = this.call.charset.getBoxBuff(26)
		this.border_line = this.border_block
		this.zombieTO
	}
	getMenuPos(){
		if (!this.dumb){
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
		this.call.cmds.setfgcolor(this.theme.header_clr)
		switch (hfield){
			case "WritingAs":
				var countstring = "   From: " + this.current_message.from
				this.call.cmds.senddata("   From: ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				this.call.cmds.senddata(this.current_message.from)
				this.previous_header_length = countstring.length
				break;
			case "MessageType":				
				this.call.cmds.senddata("Reading: ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				var countstring = "Reading: Message"
				this.call.cmds.senddata("Message")
				this.previous_header_length = countstring.length
				break;
			case "Recipient":
				var countstring = "     To: " + this.current_message.to
				this.call.cmds.senddata("     To: ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				if (this.current_message.to){
					this.call.cmds.senddata(this.current_message.to)
				}
				this.previous_header_length = countstring.length			
				break;
			case "Subject":
				var countstring = "Subject: " + this.current_message.subject
				this.call.cmds.senddata("Subject: ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				if (this.current_message.subject){
					this.call.cmds.senddata(this.current_message.subject)
				}
				this.previous_header_length = countstring.length
				break;
			case "MessageTarget":
				var countstring = "   Area: " + this.message_area
				this.call.cmds.senddata("   Area: ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				this.call.cmds.senddata(this.message_area)
				this.previous_header_length = countstring.length
				break;
			case "MessageDate":
				if (this.current_message.msg_date){
					var ltob = DateTime.fromJSDate(this.current_message.msg_date)
				}else{
					var ltob = DateTime.fromJSDate(this.current_message.created_at)
				}				
				if (ltob.hasSame(DateTime.local(), "day")){
					var flstr = ltob.toFormat('HH:mm')
				}else{
					var flstr = ltob.toFormat('MMMM dd, yyyy')
				}
				var msgdate = flstr
				var countstring = "   Date: " + msgdate
				this.call.cmds.senddata("   Date: ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				this.call.cmds.senddata(msgdate)
				this.previous_header_length = countstring.length
				break;
			case "MessageNum":
				var msgnum = this.message_idx + 1
				msgnum = msgnum.toString()
				var lmn = this.max_msg.toString()
				var countstring = "  Msg #: " + msgnum + " of " + lmn
				this.call.cmds.senddata("  Msg #: ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				this.call.cmds.senddata(msgnum)
				this.call.cmds.setfgcolor(this.theme.header_clr)
				this.call.cmds.senddata(" of ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				this.call.cmds.senddata(lmn)
				this.previous_header_length = countstring.length
				break;
			case "LastMessageNum":
				var lmn = this.max_msg.toString()
				var countstring = "   Last: " + lmn
				this.call.cmds.senddata("   Last: ")
				this.call.cmds.setfgcolor(this.theme.field_clr)
				this.call.cmds.senddata(lmn)
				this.previous_header_length = countstring.length
				break;
			case "QuickCmds":
				this.call.cmds.setfgcolor(this.theme.cmd_clr)
				var countstring = " Enter to Advance"
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
		//this.call.cmds.senddata("\r\n")
		this.curr_header_y = this.start_y
		this.curr_header_x = this.start_x
		this.call.cmds.clearscreen()
		for (var hfi=0;hfi<this.header_elements.length;++hfi){
			if (this.curr_header_x + this.header_field_width > this.max_x){
				//console.log("Next Header Line")
				this.curr_header_x = this.start_x
				this.curr_header_y += 1
				this.call.cmds.senddata("\r\n")
			}else{
				if (hfi > 0){
					var nspaces = this.header_field_width - this.previous_header_length
					//console.log("Drawing", nspaces, "Spaces")
					//console.log("Prev Header was", this.previous_header_length, "Wide")
					this.drawSpaces(nspaces)
				}				
			}
			this.drawHeaderField(this.header_elements[hfi])
			this.curr_header_x += this.header_field_width
		}
		this.call.cmds.senddata("\r\n")
		this.curr_header_y += 1
		this.call.cmds.setfgcolor(this.theme.border_clr)
		//console.log(this.border_line)
		this.call.cmds.senddata(this.border_line)
		this.call.cmds.senddata("\r\n")
		this.message_start_y = this.curr_header_y + 1
		this.call.cmds.setfgcolor(this.theme.input_clr)
	}
	drawMessage(){
		if (this.current_message.body.length > 0){
			//this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata(this.current_message.body)
		}		
	}
	getMessage(){		
		console.log("Getting message", this.message_idx)
		if (this.message_idx <= this.max_idx){
			getMessage(this.message_area, this.message_idx)
				.then(res =>{
					if (!res){
						this.call.cmds.senddata("Something went wrong")
						this.signalReturn()
						return;
					}
					this.current_message = res[0]
					this.drawHeader()
					this.drawMessage()
				}).catch(err =>{
					console.log(err)
					this.call.cmds.senddata("Something went wrong")
					this.signalReturn()
					return;
				})
			}else{
				this.signalReturn()
			}
		
		//
	}
	showMessage(){
		//
	}
	getAreaInfo(){
		getMessageCount(this.message_area)
			.then(res =>{
				if (!res){
					this.call.cmds.senddata("Something went wrong.")
					this.signalReturn()
					return;
				}
				if (res > 0){
					this.max_idx = res -1
					this.max_msg = res
				}				
				this.getMessage()
			}).catch(err =>{
				console.logs(err)
				this.call.cmds.senddata("Something went wrong.")
				this.signalReturn()
			})
	}
	runCmd(){
		this.getMenuPos()
		this.getAreaInfo()
	}
	exitCmd(){
		this.clearTimeouts()
		this.cmdexit = true
		//we use socket to write, but destroy with specific reference

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
	checkChar(stringchar){
		if (stringchar.toLowerCase() == "q"){
			this.signalReturn()
			return;
		}
	}
	checkKey(inputcmd){
		if (inputcmd == "Enter"){
			if (this.cmdexit){
				this.exitready = true	
			}else{
				console.log("Getting next message")
				this.message_idx += 1
				this.getMessage()
				return;
			}
			return;
		}
		if (inputcmd == "LeftArrow"){
			if (this.message_idx > this.min_idx){
				this.message_idx -= 1
			}			
			this.getMessage()
			return;
		}
		if (inputcmd == "RightArrow"){
			if (this.message_idx < this.max_idx){
				this.message_idx += 1
			}
			this.getMessage()
			return;
		}
		//don't use up/down for Nav... use for scroll where needed
		// if (inputcmd == "DownArrow"){
		// 	if (this.message_idx < this.max_idx){
		// 		this.message_idx += 1
		// 	}
		// 	this.getMessage()
		// 	return;
		// }
		//don't use up/down for Nav... use for scroll where needed
		// if (inputcmd == "UpArrow"){
		// 	if (this.message_idx > this.min_idx){
		// 		this.message_idx -= 1
		// 	}			
		// 	this.getMessage()
		// 	return;
		// }
		if (inputcmd == "ESC"){
			this.signalReturn()
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
				this.signalReturn()
			}			
		}
	}
	signalReturn(){
		this.setZombieTO()
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


export{simpleMessageReader}