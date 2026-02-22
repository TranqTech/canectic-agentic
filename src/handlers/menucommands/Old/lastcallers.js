//node imports
import { EventEmitter } from 'node:events';
//imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getUserList} from "../db/useraccounts.js"
import {getLastCallers} from "../db/callers.js"
//setup
const df_exit_timeout = 10000
const unameclr = 13
const fcallclr = 6
const lcallclr = 12
const ccntclr = 14
const headclr = 11
const msgclr = 10

//class and function space
class lastCallers{
	constructor(call, pauseonexit, returntype, return_target){
		this.call = call
		this.type = "Runner"
		this.cmdType = "Command"
		if(this.call.term_type == "Dumb"){
			this.dumb = true
		}else{
			this.dumb = false
		}
		this.exit_timeout = df_exit_timeout
		this.emitter = new EventEmitter();
		this.title = "Last Callers"
		this.titleclr = 10
		this.return_type = returntype
		this.stringbuffer = ""
		this.input_array = []
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.pausedlist = false
		this.titlex = 2
		this.titley = 2
		this.liststartx = 3
		this.col2x = 27
		this.col3x = 53
		this.col4x = 73
		this.liststarty = this.titley + 2
		this.listfinished = false
		//this.entriesy = this.liststarty + 2
		this.currntidx = 0
		this.pauseonexit = pauseonexit
		this.return_target = return_target
	}
	getMenuPos(){
		if (!this.dumb){
			this.titlex = Math.round(this.call.term_width/2) - Math.round(this.title.length/2)
		}else{
			this.dumbline = " Username"
			for (var i=this.dumbline.length;i<this.col2x;++i){
				this.dumbline += " "
			}
			this.dumbline += "Time"
			for (var i=this.dumbline.length;i<this.col3x;++i){
				this.dumbline += " "
			}
			this.dumbline += "Location"
			for (var i=this.dumbline.length;i<this.col4x;++i){
				this.dumbline += " "
			}
			this.dumbline += "Calls"
			this.dumbhead = "-"
			for (var i=this.dumbhead.length;i<79;++i){
				this.dumbhead += "-"
			}
		}
	}
	showcallerlistdumb(){
		if (!this.pausedlist){
			var currY = 3
			this.call.cmds.senddata("\r\n  ")
			this.call.cmds.senddata(this.title)
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata(this.dumbline)
			this.call.cmds.senddata("\r\n")
			this.call.cmds.senddata(this.dumbhead)
		}else{
			var currY = 0
		}
		this.pausedlist = false
		//
		for (var ul=this.currntidx;ul<this.callerlist.length;++ul){
			//
			this.call.cmds.senddata("\r\n")
			var displine = " "
			displine += this.callerlist[ul].username
			for (var i=displine.length;i<this.col2x;++i){
				displine += " "
			}
			if (this.callerlist[ul].starttime){
				//var dtobj = new Date(this.callerlist[ul].starttime)
				//var flstr = DateTime.fromJSDate(dtobj).toFormat('MMMM dd  HH:mm')
				var ltob = DateTime.fromJSDate(this.callerlist[ul].starttime)
				if (ltob.hasSame(DateTime.local(), "day")){
					var flstr = ltob.toFormat('HH:mm')
				}else{
					var flstr = DateTime.fromJSDate(this.callerlist[ul].starttime).toFormat('MMMM dd')
				}				
				displine += flstr
			}
			for (var ii=displine.length;ii<this.col3x;++ii){
				displine += " "
			}
			if (this.callerlist[ul].location){
				displine += this.callerlist[ul].location
			}else{
				displine += "Unknown"
			}
			for (var ii=displine.length;ii<this.col4x;++ii){
				displine += " "
			}
			if (this.callerlist[ul].logoncount){
				displine += this.callerlist[ul].logoncount.toString()
			}
			this.call.cmds.senddata(displine)
			currY += 1
			this.currntidx = ul
			if (currY >= 23){
				this.call.cmds.senddata("\r\n")
				var listpcnt = Math.round(this.currntidx/this.callerlist.length * 100).toString() + "%"
				var stline = " [Pause] Enter for more.  - "
				stline += listpcnt
				this.call.cmds.senddata(stline)
				this.pausedlist = true
				return;
			}			
		}
		this.call.cmds.senddata("\r\n")
		this.call.cmds.senddata(" Press Enter to continue")
		this.listfinished = true
		return;
	}
	showcallerlist(){		
		if (this.dumb){
			this.showcallerlistdumb()
			return;
		}
		this.pausedlist = false
		this.call.cmds.clearscreen()
		this.call.cmds.resetcolors()
		this.call.cmds.movecursor(this.titlex, this.titley)
		this.call.cmds.setfgcolor(this.titleclr)
		this.call.cmds.senddata(this.title)
		var currY = this.liststarty
		this.call.cmds.movecursor(this.liststartx, currY)
		this.call.cmds.setfgcolor(headclr)
		this.call.cmds.senddata("Username")
		this.call.cmds.movecursor(this.col2x, currY)
		this.call.cmds.senddata("Time")
		this.call.cmds.movecursor(this.col3x, currY)
		this.call.cmds.senddata("Location")
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
		for (var ul=this.currntidx;ul<this.callerlist.length;++ul){
			this.call.cmds.movecursor(this.liststartx, currY)
			this.call.cmds.setfgcolor(unameclr)
			this.call.cmds.senddata(this.callerlist[ul].username)
			this.call.cmds.movecursor(this.col2x, currY)
			this.call.cmds.setfgcolor(fcallclr)
			if (this.callerlist[ul].starttime){
				//var dtobj = new Date(this.callerlist[ul].starttime)
				//var flstr = DateTime.fromJSDate(dtobj).toFormat('MMMM dd  HH:mm')
				var ltob = DateTime.fromJSDate(this.callerlist[ul].starttime)
				if (ltob.hasSame(DateTime.local(), "day")){
					var flstr = ltob.toFormat('HH:mm')
				}else{
					var flstr = DateTime.fromJSDate(this.callerlist[ul].starttime).toFormat('MMMM dd')
				}				
				this.call.cmds.senddata(flstr)
			}			
			this.call.cmds.movecursor((this.col3x + 2), currY)
			this.call.cmds.setfgcolor(lcallclr)
			if (this.callerlist[ul].location){
				this.call.cmds.senddata(this.callerlist[ul].location)
			}else{
				if (this.callerlist[ul].source){
					this.call.cmds.senddata(this.callerlist[ul].source)
				}
			}
			
			this.call.cmds.movecursor(this.col4x, currY)
			this.call.cmds.setfgcolor(ccntclr)
			if (this.callerlist[ul].logoncount){
				var sstr = this.callerlist[ul].logoncount.toString()
				this.call.cmds.senddata(sstr)
			}
			this.currntidx = ul
			currY += 1
			if (currY >= this.call.term_height - 1){
				this.call.cmds.movecursor(this.liststartx, currY)
				this.call.cmds.setfgcolor(msgclr)
				var listpcnt = Math.round(this.currntidx/this.callerlist.length * 100).toString() + "%"
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
		this.call.cmds.senddata("Press Enter to continue")
		this.listfinished = true
		return;
		//this.exitready = true
	}
	runCmd(){
		this.getMenuPos()
		getLastCallers()
			.then(res =>{
				this.callerlist = res.reverse()
				this.showcallerlist()
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
	checkInput(inputkey){
		if (this.pausedlist){
			this.showcallerlist()
			return;
		}
		if (this.cmdexit){
			this.exitready = true
		}
		if (this.listfinished){
			this.exitready = true
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
		this.theme = null
		this.call = null
		delete this
	}
	startStage(){
		this.runCmd()
	}
}

export{ lastCallers}