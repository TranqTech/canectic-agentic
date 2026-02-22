//node imports
import { EventEmitter } from 'node:events';
//imports
import { DateTime } from "luxon";
//internal modules
import * as alogger from "../utils/alogger.js"
import {getUserList, updateUserMsgArea} from "../db/useraccounts.js"
import {listMsgGroups, getMsgGroup, getAreasInGroup} from "../db/messages.js"
//setup
const number_regex = new RegExp("[0-9]")
const df_error_clr = 2
const df_input_clr = 13
const df_prompt_clr = 11
const df_title_clr = 14
const df_list_clr = 15

//class and function space

class msgAreaChange{
	constructor(call, pauseonexit, return_type){
		this.call = call
		this.type = "MsgGroupSelect"
		this.cmd_type = "Command"
		this.emitter = new EventEmitter();
		if (this.call.msg_group){
			this.title = "Message Areas in " + this.call.msg_group
		}else{
			this.title = "Message Areas in Unknown Group"
		}
		this.return_type = return_type
		this.stringbuffer = ""
		this.inputbuffer = ""
		this.input_array = []
		this.finished = false
		this.exitready = false
		this.cmdexit = false
		this.isrunning = false
		this.runningparser = false
		this.title_x = 2
		this.title_y = 2
		this.list_start_x = this.title_x + 2
		this.list_start_y = this.title_y + 2
		this.prompt_x = 2
		this.prompt_y = 0
		this.error_x = 2
		this.error_y = 0
		this.input_x = 2
		this.input_y = 0
		this.currntidx = 0
		this.currselect = 0
		this.haserror = false
		this.title_clr = df_title_clr
		this.prompt_clr = df_prompt_clr
		this.error_clr = df_error_clr
		this.input_clr = df_input_clr
		this.list_clr = df_list_clr
		this.msg_area_arr = []
		if (this.call.msg_area){
			this.prompt_str = "Message Area Select -> [" + this.call.msg_area + "] -> " + this.call.caller_username + ":"
		}else{
			this.prompt_str = "Message Area Select -> " + this.call.caller_username + ":"
		}		
		this.pauseonexit = pauseonexit
	}
	updateListArr(){
		getAreasInGroup(this.call.msg_group)
			.then(res =>{
				if (res){
					this.msg_area_arr = res
					console.log("Found", res.length, "Area(s)")
					this.doMenu()
					return;
				}
			})
			.catch(err =>{
				console.log(err)
				this.doMenu()
			})
	}
	doMenu(){
		this.getMenuPos()
		this.drawMenu()
	}
	getMenuPos(){
		if (this.call.term_type != "Dumb"){
			this.prompt_y = this.call.term_height - 1
			this.input_x = this.prompt_x + this.prompt_str.length + 1
			this.input_y = this.prompt_y
			this.error_x = this.prompt_x
			this.error_y = this.call.term_height
		}

	}
	drawError(errormsg){
		this.clearInputDisplay()
		this.call.cmds.movecursor(this.error_x, this.error_y)
		this.call.cmds.cleartoeol()
		this.call.cmds.setfgcolor(this.error_clr)
		this.call.cmds.senddata(errormsg)
		this.call.cmds.setfgcolor(this.input_clr)
		this.call.cmds.movecursor(this.input_x, this.input_y)
		this.haserror = true
	}
	clearInputDisplay(){
		this.call.cmds.movecursor(this.input_x, this.input_y)
		this.call.cmds.cleartoeol()
		this.call.cmds.setfgcolor(this.input_clr)
		this.call.cmds.movecursor(this.input_x, this.input_y)
	}
	eraseError(){
		this.call.cmds.movecursor(this.error_x, this.error_y)
		this.call.cmds.cleartoeol()
		this.call.cmds.setfgcolor(this.input_clr)
		this.call.cmds.movecursor(this.input_x, this.input_y)
	}
	drawMenu(){
		this.call.cmds.clearscreen()
		this.call.cmds.resetcolors()
		this.call.cmds.movecursor(this.title_x, this.title_y)
		this.call.cmds.setfgcolor(this.title_clr)
		this.call.cmds.senddata(this.title)
		var currY = this.list_start_y
		var currX = this.list_start_x
		console.log("Prep list at:", currX, currY)
		for (var mg of this.msg_area_arr){
			console.log("Move for entry:", currX, currY)
			this.call.cmds.movecursor(currX, currY)
			this.call.cmds.setfgcolor(this.list_clr)
			var entrystr = this.msg_area_arr.indexOf(mg) + 1
			entrystr += ") "
			this.call.cmds.senddata(entrystr)
			this.call.cmds.senddata(mg.title)
			this.currntidx +=1
			currY += 1
		}
		this.call.cmds.setfgcolor(this.prompt_clr)
		this.call.cmds.movecursor(this.prompt_x, this.prompt_y)
		this.call.cmds.senddata(this.prompt_str)
		this.call.cmds.setfgcolor(this.input_clr)
		this.call.cmds.movecursor(this.input_x, this.input_y)
	}
	runCmd(){
		this.updateListArr()
		//this.getMenuPos()
		//this.drawMenu()
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
	lbAreaSelect(){
		console.log("Whoo")
	}
	invalidArea(){
		var errormsg = "Invalid Selection"
		this.drawError(errormsg)
		this.inputbuffer = ""
		return;
	}
	inputAreaSelect(){
		var inputint = Number(this.inputbuffer)
		if (inputint == "isNaN"){
			this.inputbuffer = ""
			console.log("Invalid selection")
			return;
		}
		if (inputint < 1){
			this.invalidArea()
		}
		if (!this.msg_area_arr[inputint - 1]){
			this.invalidArea()
			return;
		}
		var selectedarea = this.msg_area_arr[inputint - 1]
		//do select
		this.clearInputDisplay()
		this.call.cmds.senddata(selectedarea.title)
		this.inputbuffer = ""
		this.call.msg_area = selectedarea.name
		this.call.msg_area_title = selectedarea.title
		updateUserMsgArea(this.call.caller_username, selectedarea.name)
		this.signalReturn()
		return;
	}
	checkSelect(){
		if (this.inputbuffer.length > 0){
			this.inputAreaSelect()
			return
		}
		this.lbAreaSelect()
		return;
	}
	checkChar(stringchar){
		if (number_regex.test(stringchar)){
			this.inputbuffer += stringchar
			this.call.cmds.senddata(stringchar)
			if (this.msg_area_arr.length < 10){
				this.inputAreaSelect()
				return;
			}
			if ((this.inputbuffer.length > 1)&&(this.msg_group_arr.length < 100)){
				this.inputAreaSelect()
				return;
			}
		}
		if (stringchar.toLowerCase() == "q"){
			console.log("Quit Selection")
			this.signalReturn();
			return;
		}
	}
	checkKey(inputkey){
		if (inputkey == "Enter"){
			if (this.cmdexit){
				this.exitready = true
				return;
			}
			this.checkSelect();
			return;
		}
		if (inputkey ==  "ESC"){
			console.log("Quit Selection")
			this.signalReturn();
			return;
		}
		if (inputkey == "Backspace"){
			if (this.inputbuffer.length > 0){
				this.call.cmds.senddata("\b \b")
				this.inputbuffer = this.inputbuffer.slice(0, -1)
				return;
			}
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
				this.signalReturn();
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
		this.call = null
		this.theme = null
		delete this
	}
	startStage(){
		this.runCmd()
	}
}


export{ msgAreaChange }