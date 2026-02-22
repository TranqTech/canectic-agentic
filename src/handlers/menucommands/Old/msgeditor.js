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


class postMessage{
	constructor(call, pauseonexit, returntype, return_target){
		this.call = call
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
		this.return_target = return_target
	}
	runCmd(){

	}
	setTimeouts(){
		if (this.cmdTO){
			this.stageTO = setTimeout(this.cmdTimeout.bind(this), cmdTO)
		}
	}
	clearTimeouts(){
		clearTimeout(this.stageTO)
	}
	cmdTimeout(){
		if (!this.finished){
			console.log("Hit timeout")
			this.exitCmd()
		}
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
				if (this.return_type == "Menu"){
					this.menuReturn()
					return;
				}
				this.finishStage()
			}			
		}
	}
	menuReturn(){
		console.log("Returning to Menu")
		this.clearTimeouts()
		this.finished = true
		if ((!this.call)||(!this.return_target)){
			//kill the zombie
			console.log("Uh oh")
			this.clearHandler()
			return;
		}
		if (this.return_target.currentModule == this){
			//console.log("Hurray!")
			this.return_target.moduleReturn(this)
			return
		}
		//is we get here, we're not the active module and should cleanup like a zombie
		console.log("Wut???")
		this.clearHandler()
		return;
	}
	finishStage(){
		console.log("Finishing Stage")
		this.clearTimeouts()
		this.call.call_stage += 1
		this.finished = true
		this.call.rtFromHandler(this)
	}
	clearHandler(){
		this.return_target = null
		this.call = null
		delete this
	}
	startStage(){
		this.runCmd()
	}
}

export{ postMessage }