//node imports
import { EventEmitter } from 'node:events';
//imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getUserList} from "../db/useraccounts.js"
//setup
const unameclr = 13
const fcallclr = 6
const lcallclr = 12
const ccntclr = 14
const headclr = 11
const msgclr = 10

//class and function space


class listMessages{
	constructor(call, pauseonexit, returntype){
		this.call = call
		this.theme = this.call.theme
		this.type = "Runner"
		this.cmdType = "Command"
		this.emitter = new EventEmitter();
		this.return_type = returntype
		this.stringbuffer = ""
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.pauseonexit = pauseonexit
	}
	runCmd(){

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
		if (stringchar == "\r"){
			if (this.cmdexit){
				this.exitready = true	
			}
		}
	}
	decipherChar(stringchar){
		if (this.cmdexit){
			this.checkChar(stringchar)
			return;
		}
		return;
	}
	handleData(){
		if (!this.runningparser){
			this.runningparser = true
			//console.log(this.stringbuff)
			while(this.stringbuffer.length > 0){
				var stringchar = this.stringbuffer.substr(0,1)
				this.stringbuffer = this.stringbuffer.slice(1);
				this.decipherChar(stringchar)
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

export{ listMessages }