//node imports
import { EventEmitter } from 'node:events';
//imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getUserList} from "../db/useraccounts.js"
import {simpleMessageReader} from "../readers/simplereader.js"
import {tranqMessageReader} from "../readers/treader.js"
//setup

//class and function space

class readMessages{
	constructor(call, pauseonexit, returntype){
		this.call = call
		this.theme = this.call.theme
		this.type = "Runner"
		this.cmdType = "Command"
		this.emitter = new EventEmitter();
		this.return_type = returntype
		this.stringbuffer = ""
		this.input_array = []
		this.current_message_idx = 0
		this.msg_area = ""
		this.msgReader
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.pauseonexit = pauseonexit
	}
	getIdxAndArea(){
		if (this.call.current_message_idx){
			this.current_message_idx = this.call.current_message_idx
		}
		if (this.call.msg_area){
			this.msg_area = this.call.msg_area
		}

	}
	runReader(){
		if (this.call.use_reader){
			switch (this.call.use_reader){
				case "tranqMessageReader":
					this.msgReader = new tranqMessageReader(this.call, this.msg_area, this.current_message_idx)
					break;
				default:
					this.msgReader = new simpleMessageReader(this.call, this.msg_area, this.current_message_idx)
					break;
			}
		}else{
			this.msgReader = new simpleMessageReader(this.call, this.msg_area, this.current_message_idx)
		}		
		this.msgReader.emitter.on('ModuleReturn', ()=>{
			this.doModuleReturn()
		})
		this.msgReader.startStage()
	}
	doModuleReturn(){
		this.msgReader.clearHandler()
		this.signalReturn()
	}
	runCmd(){
		this.getIdxAndArea()
		this.runReader()
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
		if (stringchar == "\q"){
			this.doModuleReturn()
			this.signalReturn()
			return;
		}
	}
	checkKey(inputcmd){
		if (inputcmd == "Enter"){
			if (this.cmdexit){
				this.exitready = true	
			}
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
			if (this.msgReader){
				while(this.input_array.length > 0){
					var inputkey = this.input_array.shift()
					this.msgReader.input_array.push(inputkey)
				}
				this.runningparser = false
				this.msgReader.handleData()
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

export{ readMessages }