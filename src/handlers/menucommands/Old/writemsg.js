//node imports
import { EventEmitter } from 'node:events';
//3p imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getUserList} from "../db/useraccounts.js"
import {tEditor} from "../editors/teditor.js"
import {simpleEditor} from "../editors/simple.js"
//setup
const escape_intermed = new RegExp("[!\"#$%&'()*+,-./]")
const escape_terminator1 = new RegExp("[A-Za-z]")
const escape_terminator2 = new RegExp("[@\\[\\]^_`\\{\\}\\|~]")
const valid_escape_chars = new RegExp("[0-9:;?= ]")
//defaults
const df_exit_timeout = 10000
const unameclr = 13
const fcallclr = 6
const lcallclr = 12
const ccntclr = 14
const headclr = 11
const msgclr = 10
const df_esc_timeout = 50

//class and function space


class writeMessage{
	constructor(call, pauseonexit, return_type, message_type, message_target, use_realname){
		this.call = call
		this.type = "Runner"
		this.cmdType = "Command"
		this.exit_timeout = df_exit_timeout
		this.emitter = new EventEmitter();
		this.return_type = return_type
		this.stringbuffer = ""
		this.escapebuffer = ""
		this.input_array = []
		this.recipient = "All"
		if (this.call.use_fse){
			console.log("Full screen editor selected")
			this.editor = new tEditor(call, pauseonexit, "Command", message_type, message_target, use_realname)
		}else{
			console.log("Using simple editor")
			this.editor = new simpleEditor(call, pauseonexit, return_type, message_type, message_target, use_realname)
		}		
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.escapemode = false
		this.esc_timeout = df_esc_timeout
		this.pauseonexit = pauseonexit
		this.zombieTO
	}
	runCmd(){
		this.editor.startStage()
		this.editor.emitter.on('ModuleReturn', ()=>{
			console.log("Module gave exit signal!")
			this.doModuleReturn()
			return;
		})
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
	// sendToEditor(inputitem){
	// 	this.editor.input_array.push(inputitem)
	// 	this.editor.handleData();
	// 	return;
	// }
	// doEscape(){
	// 	if (this.escapemode){
	// 		this.escapemode = false
	// 		if (this.escapebuffer.length < 1){
	// 			if (this.editor){
	// 				this.sendToEditor("KEY_ESC")
	// 				return;
	// 			}			
	// 		}
	// 		switch (this.escapebuffer){
	// 			case "[A":
	// 				//console.log("Arrows!")
	// 				var keyname = "KEY_UpArrow"
	// 				break;
	// 			case "[B":
	// 				//console.log("Arrows!")
	// 				var keyname = "KEY_DownArrow"
	// 				break;
	// 			case "[C":
	// 				//console.log("Arrows!")
	// 				var keyname = "KEY_RightArrow"
	// 				break;
	// 			case "[D":
	// 				//console.log("Arrows!")
	// 				var keyname = "KEY_LeftArrow"
	// 				break;
	// 			default:
	// 				console.log("Unknown Character")
	// 				break;
	// 		}
	// 		this.escapebuffer = ""
	// 		if (keyname){
	// 			this.sendToEditor(keyname)
	// 		}
	// 	}		
	// }
	checkChar(stringchar){
		if (stringchar == "\r"){
			if (this.cmdexit){
				this.exitready = true	
			}
		}
	}
	// decipherChar(stringchar){
	// 	//console.log("Checking", stringchar)
	// 	clearTimeout(this.escTO)
	// 	if (this.cmdexit){
	// 		this.checkChar(stringchar)
	// 		return;
	// 	}
	// 	if (this.escapemode){
	// 		if ((this.escapebuffer.length == 0) && (stringchar == "[")){
	// 			//console.log("intermediate [")
	// 			this.escapebuffer += stringchar
	// 			return;
	// 		}
	// 		console.log("Checking escape char", stringchar)
	// 		if (escape_intermed.test(stringchar)){
	// 			this.escapebuffer += stringchar
	// 			return;
	// 		}
	// 		if (valid_escape_chars.test(stringchar)){
	// 			//console.log("Popping on", stringchar)
	// 			this.escapebuffer += stringchar
	// 			return;
	// 		}
	// 		if (escape_terminator1.test(stringchar)){
	// 			//console.log("Terminating With", stringchar)
	// 			this.escapebuffer += stringchar
	// 			this.doEscape()
	// 			return;
	// 		}
	// 		if (escape_terminator2.test(stringchar)){
	// 			//console.log("Terminating With", stringchar)
	// 			this.escapebuffer += stringchar
	// 			this.doEscape()
	// 			return;
	// 		}
	// 		if (stringchar = "\x1b"){
	// 			if (this.escapebuffer.length < 1){
	// 				this.sendToEditor("KEY_ESC")
	// 				this.escTO = setTimeout(this.doEscape.bind(this), this.esc_timeout)
	// 			}
	// 			this.escapebuffer = ""
	// 			return;
	// 		}
	// 		console.log(stringchar, "Not valid ESC")
	// 		this.escapemode = false
	// 	}
	// 	if (stringchar == "\x1b"){
	// 		this.escTO = setTimeout(this.doEscape.bind(this), this.esc_timeout)
	// 		this.escapemode = true
	// 		return;
	// 	}
	// 	//console.log("Hitting switch check")
	// 	var keyname = ""
	// 	switch (stringchar){			
	// 		case "\r":
	// 			keyname = "KEY_Enter"
	// 			break;
	// 		case "\b":
	// 			keyname = "KEY_Backspace"
	// 			break;
	// 		case "\x01":
	// 			keyname = "KEY_^A"
	// 			console.log("Control A!")
	// 			break;
	// 		case "\x13":
	// 			console.log("Control S?")
	// 			keyname = "KEY_^S"
	// 			break;
	// 		case "\x1a":
	// 			console.log("Control Z?")
	// 			keyname = "KEY_^Z"
	// 			break;
	// 		default:
	// 			keyname = "CHAR_" + stringchar
	// 			break;
	// 	}		
	// 	if (keyname){
	// 		//console.log("Sending", keyname)
	// 		this.sendToEditor(keyname);
	// 	}else{
	// 		console.log("No Key Parsed")
	// 	}	
	// 	return;
	// }
	checkChar(stringchar){
		if (this.cmdexit){
			this.exitready = true
		}
	}
	checkKey(inputkey){
		if (this.cmdexit){
			this.exitready = true
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
			if (this.editor){
				while(this.input_array.length > 0){
					var inputkey = this.input_array.shift()
					this.editor.input_array.push(inputkey)
				}
				this.runningparser = false
				this.editor.handleData()
				return;
			}
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
	// handleData(){
	// 	if (!this.runningparser){
	// 		this.runningparser = true
	// 		//console.log(this.stringbuff)
	// 		while(this.stringbuffer.length > 0){
	// 			var stringchar = this.stringbuffer.substr(0,1)
	// 			this.stringbuffer = this.stringbuffer.slice(1);
	// 			this.decipherChar(stringchar)
	// 		}
	// 		this.runningparser = false
	// 		if (this.exitready){
	// 			this.signalReturn()
	// 			return;
	// 		}			
	// 	}
	// }
	doModuleReturn(){
		console.log("Clearing Editor")
		if (this.editor){
			try{
				this.editor.clearHandler()
			}catch(err){
				console.log(err)
			}
		}		
		this.editor = null
		this.cmdexit = true
		this.signalReturn()
	}
	signalReturn(){
		this.setZombieTO()
		console.log("Signalling Edit CMD Exit")
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

export{ writeMessage }