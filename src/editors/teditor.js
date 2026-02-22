//imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getUserList} from "../models/useraccounts.js"
//setup
const df_field_clr = 13
const df_header_clr = 14
const df_input_clr = 11
const df_border_clr = 4
const df_prompt_clr = 14
const df_header_field_width = 30
const df_header_columns = 2
const df_msg_start_y = 4
const df_msg_x_margin = 0
const df_header_elements = ["MessageType", "WritingAs", "MessageTarget", "Recipient"]

//class and function space


class tEditor{
	constructor(call, pauseonexit, return_type, message_type, message_target, use_realname){
		this.call = call
		this.type = "Runner"
		this.cmdType = "Editor"
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
		this.line_array = []
		this.word_array = []
		this.wordbuffer = ""
		this.current_line_stringbuff = ""
		this.messagebuffer = ""
		this.recipient = ""
		this.return_type = return_type
		this.stringbuffer = ""
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
		this.header_elements = df_header_elements
		//this.border_block = this.call.charset.boxes[27]
		this.border_block = this.call.charset.getBoxBuff(26)
		this.border_line = this.border_block
	}
	runCmd(){
		this.getMenuPos()
		this.call.cmds.clearscreen()
		this.drawHeader()
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
		for (var hb=0;hb<(this.max_x-1);++hb){
			this.border_line = Buffer.concat([this.border_line, this.border_block])
		}
	}
	drawHeaderField(hfield){
		this.call.cmds.setfgcolor(this.header_clr)
		switch (hfield){
			case "WritingAs":
				this.call.cmds.senddata("   From: ")
				this.call.cmds.setfgcolor(this.field_clr)
				if (this.use_realname){
					this.call.cmds.senddata(this.call.caller_fullname)
					break;
				}
				this.call.cmds.senddata(this.call.caller_username)
				break;
			case "MessageType":				
				this.call.cmds.senddata("Posting: ")
				this.call.cmds.setfgcolor(this.field_clr)
				if (this.message_type == "Email" || "Netmail"){
					this.call.cmds.senddata(this.message_type)
				}else{
					this.call.cmds.senddata("Message")
				}
				break;
			case "Recipient":
				this.call.cmds.senddata("     To: ")
				this.call.cmds.setfgcolor(this.field_clr)
				if (this.recipient){
					this.call.cmds.senddata(this.recipient)
				}else{
					this.call.cmds.senddata("All")
				}				
				break;
			case "MessageTarget":
				this.call.cmds.senddata("   Area: ")
				this.call.cmds.setfgcolor(this.field_clr)
				this.call.cmds.senddata(this.message_target)
				break;
			default:
				console.log("Unknown Field")
				break;
		}
		this.call.cmds.resetcolors()
		return;
	}
	drawHeader(){
		for (var hfi=0;hfi<this.header_elements.length;++hfi){
			if (this.curr_header_x + this.header_field_width > this.max_x){
				console.log("Next Header Line")
				this.curr_header_x = this.start_x
				this.curr_header_y += 1
			}
			console.log("New Pos", this.curr_header_x, this.curr_header_y)
			this.call.cmds.movecursor(this.curr_header_x, this.curr_header_y)
			this.drawHeaderField(this.header_elements[hfi])
			console.log("Moving to next column", this.header_field_width, "chars over")
			this.curr_header_x += this.header_field_width
		}
		this.curr_header_y += 1
		this.call.cmds.movecursor(0, this.curr_header_y)
		this.call.cmds.setfgcolor(this.border_clr)
		//console.log(this.border_line)
		this.call.cmds.senddata(this.border_line)
		this.message_start_y = this.curr_header_y + 1
		this.cursor_screen_x = this.message_start_x
		this.cursor_screen_y = this.message_start_y
		this.call.cmds.movecursor(this.message_start_x, this.message_start_y)
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
		this.cursor_screen_x = this.message_start_x
		this.cursor_screen_y += 1
		this.last_text_line += 1
		this.cursor_text_line += 1
		lineobj.word_array = this.word_array
		this.line_array.push(lineobj)
		this.word_array = []
		this.call.cmds.movecursor(this.cursor_screen_x, this.cursor_screen_y)
	}
	checkKeyInput(keyinput){
		switch(keyinput){
			case "Enter":
				console.log("Enter!")
				if (this.cmdexit){
					this.exitready = true
					return;
				}
				this.doNewline()
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
				this.drawBackspace()
				break;
			case "^A":
				console.log("Abort Message")
				this.call.cmds.senddata("\r\n")
				this.call.cmds.setfgcolor(this.prompt_clr)
				this.call.cmds.senddata("  Aborting Message")
				this.call.cmds.senddata("\r\n")
				this.call.cmds.senddata("  Press Enter to continue")
				this.call.cmds.setfgcolor(this.input_clr)
				this.exitready = true
				break;
			case "^S":
				console.log("Save Message")
				this.call.cmds.senddata("\r\n")
				this.call.cmds.setfgcolor(this.prompt_clr)
				this.call.cmds.senddata("  Saving Message")
				this.call.cmds.senddata("\r\n")
				this.call.cmds.senddata("  Press Enter to continue")
				this.call.cmds.setfgcolor(this.input_clr)
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
				if (this.cursor_text_line > 0){
					this.moveUpOne()
				}
				break;
			case "DownArrow":
				if (this.cursor_text_line < this.last_text_line){
					this.moveDownOne()
				}
				//move down
				break;
			case "LeftArrow":
				//move left
				if ((this.cursor_text_line > 0)||(this.cursor_text_col > 0)){
					this.moveLeftOne()
				}
				break;
			case "RightArrow":
				if (this.cursor_text_col < this.current_line_stringbuff.length){
					this.moveRightOne()
				}
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
	checkCmdInput(commandinput){

	}
	scrollUpOne(){

	}
	scrollDownOne(){

	}
	loadLine(linenum){

	}
	moveUpOne(){
		console.log("Move Up")
		this.cursor_text_line -= 1
		this.cursor_screen_y -= 1
		this.call.cmds.moveupone()
	}
	moveDownOne(){
		console.log("Move Down")
		this.cursor_screen_y += 1
		this.cursor_text_line += 1
		this.call.cmds.movedownone()
	}
	moveRightOne(){
		console.log("Move Right")
		this.cursor_screen_x += 1
		this.cursor_text_col += 1
		this.call.cmds.moverightone()
	}
	moveLeftOne(){
		console.log("Move Left")
		if (this.cursor_text_col > 0){
			this.call.cmds.moveleftone()
			this.cursor_screen_x -= 1
			this.cursor_text_col -= 1
			return;
		}else{
			this.cursor_text_col = 79
			this.cursor_screen_x = this.message_end_x
			this.cursor_screen_y -= 1
			this.call.cmds.movecursor(this.cursor_screen_x, this.cursor_screen_y)
		}
	}
	decrementText(){
		if (this.cursor_text_line == this.last_text_line){
			var onlast = true
			this.last_text_col -= 1
		}
		this.cursor_screen_x -= 1
		this.cursor_text_col -= 1
		if (this.cursor_text_col < 0){
			if (this.cursor_text_line > 0){
				this.cursor_text_col = 79
				this.cursor_text_line -= 1
				this.cursor_screen_x = this.message_end_x
				this.cursor_screen_y -= 1
				this.loadLine(this.cursor_text_line)
				if (onlast){
					this.last_text_line -= 1
					this.last_text_col = this.current_line_stringbuff.length
				}
			}
			if (this.cursor_screen_y < this.message_start_y){
				//do scroll up
				this.scrollUpOne()
				this.cursor_screen_y = this.message_start_y
			}
			this.call.cmds.movecursor(this.cursor_screen_x, this.cursor_screen_y)
		}
	}
	incrementText(){
		if (this.cursor_text_line == this.last_text_line){
			var onlast = true
			this.last_text_col += 1
		}
		this.cursor_screen_x += 1
		this.cursor_text_col += 1
		if (this.cursor_text_col > 79){
			this.cursor_text_col = 0
			this.cursor_text_line += 1
			this.cursor_screen_x = this.message_start_x
			this.cursor_screen_y += 1			
			if (onlast){
				this.last_text_line += 1
				this.last_text_col = 0
			}
			if (this.cursor_screen_y > this.message_end_y){
				//do scroll down
				this.scrollDownOne()
				this.cursor_screen_y = this.message_end_y
			}
			this.call.cmds.movecursor(this.cursor_screen_x, this.cursor_screen_y)
		}
	}
	checkCharInput(stringchar){
		// do logic to check position and add to appropriate arrays for position. For first testing, just echo back.
		console.log(stringchar)		
		this.call.cmds.senddata(stringchar)
		this.current_line_stringbuff += stringchar
		this.incrementText()
	}
	decipherInput(inputstr){
		if (inputstr != "KEY_ESC"){
			console.log("Resetting Esc Count")
			this.esc_key_count = 0;
		}
		console.log(inputstr)
		if (inputstr.startsWith("KEY_")){
			console.log("Key!")
			this.checkKeyInput(inputstr.slice(4))
			return;
		}
		if (inputstr.startsWith("CHAR_")){
			console.log("String!")
			this.checkCharInput(inputstr.slice(5))
			return;
		}
		if (inputstr.startsWith("CMD_")){
			console.log("Command!")
			this.checkCmdInput(inputstr.slice(4))
		}
		return;
	}
	handleData(){
		if (!this.finished){
			if (!this.runningparser){
				this.runningparser = true
				//console.log(this.stringbuff)
				while(this.input_array.length > 0){
					var inputstr = this.input_array.shift()
					this.decipherInput(inputstr)
				}
				this.runningparser = false
				if (this.exitready){
					this.signalReturn()
					return;
				}
			}
		}else{
			//this.clearHandler()
			return;
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

export{ tEditor }