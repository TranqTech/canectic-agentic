//node imports
import { EventEmitter } from 'node:events';
//imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getUserList} from "../db/useraccounts.js"
//setup
const df_exit_timeout = 10000
const unameclr = 13
const fcallclr = 6
const lcallclr = 12
const ccntclr = 14
const headclr = 11
const msgclr = 10

//class and function space


class cmdRunner{
	constructor(call, pauseonexit, returntype, return_target){
		this.call = call
		this.type = "Runner"
		this.cmdType = "Command"
		this.exit_timeout = df_exit_timeout
		this.emitter = new EventEmitter();
		this.return_type = returntype
		this.stringbuffer = ""
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.pauseonexit = pauseonexit
		this.return_target = return_target
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
				return;
			}			
		}
	}
	signalReturn(){
		this.setZombieTO()
		this.emitter.emit('ModuleReturn')
		this.finished = true
	}
	setZombieTO(){
		this.zombieTO = setTimeout(this.zombieChecker.bind(this), this.exit_timeout)
	}
	zombieChecker(){
		this.clearTimeouts()
		//emit again and then cleanup
		this.emitter.emit('ModuleReturn')
		if (this.call != null){
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
		delete this
	}
	startStage(){
		this.runCmd()
	}
}

export{ cmdRunner }