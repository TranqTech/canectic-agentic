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
class userList{
	constructor(call, pauseonexit, returntype){
		this.call = call
		this.emitter = new EventEmitter();
		this.type = "Runner"
		this.cmdType = "Command"
		this.exit_timeout = df_exit_timeout
		this.return_type = returntype
		this.stringbuffer = ""
		this.input_array = []
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.pausedlist = false
		this.liststartx = 3
		this.col2x = 27
		this.col3x = 47
		this.col4x = 73
		this.liststarty = 2
		this.listfinished = false
		//this.entriesy = this.liststarty + 2
		this.currntidx = 0
		this.pauseonexit = pauseonexit
	}
	showuserlist(){
		this.pausedlist = false
		this.call.cmds.clearscreen()
		var currY = this.liststarty
		this.call.cmds.movecursor(this.liststartx, currY)
		this.call.cmds.setfgcolor(headclr)
		this.call.cmds.senddata("Username")
		this.call.cmds.movecursor(this.col2x, currY)
		this.call.cmds.senddata("First On")
		this.call.cmds.movecursor(this.col3x, currY)
		this.call.cmds.senddata("Last On")
		this.call.cmds.movecursor((this.col4x - 2), currY)
		this.call.cmds.senddata("Calls")
		currY += 1
		this.call.cmds.movecursor(this.liststartx, currY)
		this.call.cmds.setfgcolor(headclr)
		this.call.cmds.senddata("--------")
		this.call.cmds.movecursor(this.col2x, currY)
		this.call.cmds.senddata("--------")
		this.call.cmds.movecursor(this.col3x, currY)
		this.call.cmds.senddata("-------")
		this.call.cmds.movecursor((this.col4x - 2), currY)
		this.call.cmds.senddata("-----")
		currY += 1
		for (var ul=this.currntidx;ul<this.userlist.length;++ul){
			this.call.cmds.movecursor(this.liststartx, currY)
			this.call.cmds.setfgcolor(unameclr)
			this.call.cmds.senddata(this.userlist[ul].username)
			this.call.cmds.movecursor(this.col2x, currY)
			this.call.cmds.setfgcolor(fcallclr)
			if (this.userlist[ul].firstlogon){
				var flstr = DateTime.fromJSDate(this.userlist[ul].firstlogon).toFormat('MMMM dd, yyyy')
				this.call.cmds.senddata(flstr)
			}			
			this.call.cmds.movecursor(this.col3x, currY)
			this.call.cmds.setfgcolor(lcallclr)
			if (this.userlist[ul].lastlogon){
				var llstr = DateTime.fromJSDate(this.userlist[ul].lastlogon).toFormat('MMMM dd, yyyy')
				this.call.cmds.senddata(llstr)
			}
			this.call.cmds.movecursor(this.col4x, currY)
			this.call.cmds.setfgcolor(ccntclr)
			if (this.userlist[ul].logoncount){
				var sstr = this.userlist[ul].logoncount.toString()
				this.call.cmds.senddata(sstr)
			}
			this.currntidx = ul
			currY += 1
			if (currY >= this.call.term_height - 1){
				this.call.cmds.movecursor(this.liststartx, currY)
				this.call.cmds.setfgcolor(msgclr)
				var listpcnt = Math.round(this.currntidx/this.userlist.length * 100).toString() + "%"
				this.call.cmds.senddata("[Pause] Enter for more.")
				this.call.cmds.movecursor(this.col4x, currY)
				this.call.cmds.senddata(listpcnt)
				this.pausedlist = true
				return;
			}
		}
		currY += 1
		this.call.cmds.setfgcolor(msgclr)
		this.call.cmds.movecursor(this.liststartx, currY)
		this.call.cmds.senddata("List Complete, Press enter to exit")
		this.listfinished = true
		return;
		//this.exitready = true
	}
	runCmd(){
		getUserList()
			.then(res =>{
				this.userlist = res
				this.showuserlist()				
			}).catch(err =>{
				console.log(err)
				this.exitCmd()
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
	checkChar(stringchar){
		if (this.pausedlist){
			//console.log("This is the droid you're looking for")
			this.showuserlist()
			return;
		}
		if (this.cmdexit){
			this.exitready = true	
		}
		if (this.listfinished){
			this.exitready = true
		}
		//console.log("This is the 2droid you're looking for")
	}
	checkKey(inputkey){
		if (this.pausedlist){
			//console.log("This is the droid you're looking for")
			this.showuserlist()
			return;
		}
		if (this.cmdexit){
			this.exitready = true	
		}
		if (this.listfinished){
			this.exitready = true
		}
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
			//this.checkCmd(inputkey)
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

export{ userList}