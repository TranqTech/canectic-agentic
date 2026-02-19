//imports
import { EventEmitter } from 'node:events';
import { spawn, spawnSync, exec, execSync } from "child_process"
import {homedir} from "os";
import { DateTime } from "luxon";
import * as dotenv from 'dotenv';
import * as fs from 'fs';

//internal modules
import * as alogger from "../utils/alogger.js"

//setup
dotenv.config();
const pauseonxtrn = true
const vdevdir = homedir() + "/vdev"
const socatpref = vdevdir + "/p"
const doordir = process.env.doordir
const xtrnTO = process.env.extrnTO || 10000
const sysopname = process.env.sysopname || "John Doe"
const sysopalias = process.env.sysopalias || "Sysop"


async function set_doorsys(call, runnersettings){
	console.log("Getting Door.sys Array")
	console.log(call.user_record)
	//records that need some luxon parsing
	var lastlogon = Date.parse(call.user_record.lastlogon)
	lastlogon = DateTime.fromMillis(lastlogon)
	var lastcalldate = lastlogon.toFormat('MM/dd/yy')
	var lastcalltime = lastlogon.toFormat('HH:mm')
	var callrawtime = Date.parse(call.connect_time)
	callrawtime = DateTime.fromMillis(callrawtime)
	var calltime = callrawtime.toFormat('HH:mm')
	var shortbirthdate = "00/00/00"
	if (call.user_record.birthdate){
		var prepbirthdate = call.user_record.birthdate.slice(2)
		var bdayarray = prepbirthdate.split("/")
		shortbirthdate = bdayarray[2] + "/" + bdayarray[1] + "/" + bdayarray[0]
	}
	var rundir = process.cwd()
	var dfarray = []
	var comstring = "COM" + runnersettings.comport + ":"
	dfarray.push(comstring)
	dfarray.push(call.baudRate)
	//parity (7 or 8)
	dfarray.push(8)	
	dfarray.push(call.nodenum)
	dfarray.push(call.baudRate)
	//Screen Display
	dfarray.push("Y")
	//Printer Toggle
	dfarray.push("Y")
	//Page Bell
	dfarray.push("Y")
	//Caller Alarm
	dfarray.push("Y")
	//Full Name
	dfarray.push(call.caller_fullname)
	//calling from
	dfarray.push(call.user_record.location)
	//home phone
	dfarray.push("")
	//work/data phone
	dfarray.push("")
	//password
	dfarray.push("PASSWORD")
	//Security
	dfarray.push(call.user_record.security)
	//Call Count - right?
	dfarray.push(call.user_record.logoncount)
	//Last Call (mm/dd/yy)
	dfarray.push(lastcalldate)
	//seconds remaining - Might need to need set limit of 32767?
	dfarray.push(call.timeleft)
	//minutes remaining - Might need to need set limit of 32767
	var minleft = Math.round(call.timeleft / 60)
	dfarray.push(minleft)
	//graphics mode
	dfarray.push("GR")
	//page length
	dfarray.push(call.term_height)
	//user mode (Y- expert n- novice)
	dfarray.push("N")
	//Forums registerd in
	dfarray.push("")
	//Conference door loaded from
	dfarray.push("0")
	//User expiration date
	dfarray.push("00/00/00")
	//user file record number
	if (call.user_record.usernumber){
		dfarray.push(call.user_record.usernumber)
	}else{
		dfarray.push("42")
	}	
	//default protocol
	if (call.user_record.defaultprotocol){
		dfarray.push(call.user_record.defaultprotocol)
	}else{
		dfarray.push("Z")
	}	
	//total uploads
	if (call.user_record.uploadcount){
		dfarray.push(call.user_record.uploadcount)
	}else{
		dfarray.push("0")
	}
	//total downloads
	if (call.user_record.downloadcount){
		dfarray.push(call.user_record.downloadcount)
	}else{
		dfarray.push("0")
	}
	//daily download k total
	if (call.user_record.dailydownloadktotal){
		dfarray.push(call.user_record.dailydownloadktotal)
	}else{
		dfarray.push("0")
	}
	//daily download k limit
	if (call.user_record.dailydownloadklimit){
		dfarray.push(call.user_record.dailydownloadklimit)
	}else{
		dfarray.push("0")
	}
	//caller birthday (mm/dd/yy)	
	dfarray.push(shortbirthdate)
	//Userfile dir (Node?)
	var nodedir = rundir + "/nodes/" + call.nodenum
	dfarray.push(nodedir)
	//GEN directory (Data)
	var datadir = rundir + "/data"
	dfarray.push(datadir)
	//Sysop Name
	dfarray.push(sysopalias)
	//User Alias
	dfarray.push(call.user_record.username)
	//Event Time (hh:mm)
	dfarray.push("00:00")
	//Error Correcting Connection
	dfarray.push("Y")
	//Ansi Support and Caller using NG Mode
	dfarray.push("N")
	//User Record Locking
	dfarray.push("Y")
	//BBS Default Color (CGA 1-15)
	dfarray.push("15")
	//Time Credits (minutes)
	dfarray.push("0")
	//Last new file scan date
	if (call.user_record.lastnewfilescan_short){
		dfarray.push(call.user_record.lastnewfilescan_short)
	}else{
		dfarray.push("00/00/00")
	}
	//Call time (hh:mm)
	dfarray.push(calltime)
	//Last call time (hh:mm)
	dfarray.push(lastcalltime)
	//Max daily files
	if (call.user_record.maxdailyfiles){
		dfarray.push(call.user_record.maxdailyfiles)
	}else{
		dfarray.push("0")
	}
	//daily download count
	if (call.user_record.dailydownloadcount){
		dfarray.push(call.user_record.dailydownloadcount)
	}else{
		dfarray.push("0")
	}
	//Total K uploaded
	if (call.user_record.totaluploadk){
		dfarray.push(call.user_record.totaluploadk)
	}else{
		dfarray.push("0")
	}
	//Total K downloaded
	if (call.user_record.totaldownloadk){
		dfarray.push(call.user_record.totaldownloadk)
	}else{
		dfarray.push("0")
	}
	//User Comment
	if (call.user_record.user_comment){
		dfarray.push(call.user_record.user_comment)
	}else{
		dfarray.push("Canectic Rules")
	}
	//Total Doors Opened
	if (call.user_record.lifetimedoortotal){
		dfarray.push(call.user_record.lifetimedoortotal)
	}else{
		dfarray.push("0")
	}
	//Total Messages Left
	dfarray.push("9999")

	return dfarray
}

async function set_door32(call, runnersettings){
	var dfarray = []
	//line 1 - comm type (0=local, 1=serial, 2=telnet)
	dfarray.push(runnersettings.comtype)
	//comm or socket handle
	if (call.sockethandle){
		dfarray.push(call.sockethandle)
	}else{
		dfarray.push(0)
	}	
	//baud rate
	dfarray.push(call.baudRate)
	//bbsid
	dfarray.push("Canectic BBS")
	//user record
	if (call.user_record.usernumber){
		dfarray.push(call.user_record.usernumber)
	}else{
		dfarray.push(0)
	}	
	//real name
	dfarray.push(call.user_record.fullname)
	//alias
	dfarray.push(call.caller_username)
	//security level
	dfarray.push(call.user_record.security)
	//time left
	dfarray.push(call.timeleft)
	//terminal emulation. Check for Ansi and use this table. Setting Ansi by default for testing
	//0 = Ascii
	//1 = Ansi
	//2 = Avatar
	//3 = RIP
	//4 = Max Graphics
	if (call.use_rip == true){
		dfarray.push(3)
	}else{
		if ((call.term_encoding == "CP437")||(call.term_encoding == "UTF8")){
			dfarray.push(1)
		}else{
			dfarray.push(0)
		}
	}
	//node number
	dfarray.push(call.nodenum)
	//dfarray.push(call.term_type)

	return dfarray
}

async function set_canectic(call, runnersettings){
	var dfarray = []
	dfarray.push(call.nodenum)
	dfarray.push(call.term_encoding)
	dfarray.push(call.caller_username)
	dfarray.push(call.user_record.fullname)	
	dfarray.push(call.user_record.security)
	dfarray.push("Canectic BBS")
	dfarray.push(call.term_type)	
	dfarray.push(call.timeleft)
	return dfarray
}

async function set_dorinfo(call, runnersettings){
	var dfarray = []

	return dfarray
}

async function dfarray_setter(call, filetype, runnersettings){
	var dfobj = {}
	//console.log("Checking filetype", filetype, runnersettings)
	if (!filetype){
		filetype = ""
	}
	switch(filetype.toLowerCase()){
		case "doorsys":
			dfobj.filename = "door.sys"
			dfobj.dfarray = await set_doorsys(call, runnersettings)
			dfobj.status = true
			break;
		case "door32":
			dfobj.filename = "door32.sys"
			dfobj.dfarray = await set_door32(call, runnersettings)
			dfobj.status = true
			break;
		case "canectic":
			dfobj.filename = "canectic.sys"
			dfobj.dfarray = await set_canectic(call, runnersettings)
			dfobj.status = true
			break;
		case "dorinfo":
			dfobj.filename = "dorinfo" + call.nodenum + ".def"
			dfobj.dfarray = await set_dorinfo(call, runnersettings)
			dfobj.status = true
			break;
		default:
			var msgstring = "Unable to determine dropfile type. Cannot continue"
			dfobj.status = false
			alogger.writeAlog(1, msgstring, "redbright", true)
	}
	return dfobj

}


class dropfileWriter{
	constructor(call, filetype, dfdir, runnersettings){
		//console.log("Setting", dfdir, runnersettings)
		this.call = call
		this.emitter = new EventEmitter();
		this.type = filetype
		this.stringbuffer = ""
		this.input_array = []
		this.finished = false
		this.exitready = false
		this.xtrnexit = false
		this.dfarray = []
		this.filename = ""
		this.dfdir = dfdir
		this.runnersettings = runnersettings
		this.isrunning = false
		this.runningparser = false
		//this.set_Array()
	}
	doSetup(){
		//console.log("Setting dropfile array")
		if ((this.type == "")||(this.type == "None")||(!this.type)){
			//console.log("No Dropfile Specified. Assuming not required")
			this.emitter.emit('NoDropfileNeeded')
			//this.emitter.emit('DropfileError')
		}else{
			dfarray_setter(this.call, this.type, this.runnersettings).then(res =>{
				if (res.status == true){
					this.dfarray = res.dfarray
					this.filename = res.filename
					try{
						this.writeFile()
					}catch(err){
						console.log(err)
						this.emitter.emit('DropfileError')
					}
					
				}else{
					//do something if no dropfile data
					console.log("Cannot write dropfile.")
					this.emitter.emit('DropfileError')
				}
			}).catch(err =>{
				console.log(err)
			})
		}		
	}
	getDosNodeDir(){
		var nodedir = process.cwd()
		nodedir += "/doors/Dos/nodes/" + this.call.nodenum
		//console.log("Current dir", process.cwd())
		//console.log("Dos Node Dir", nodedir)
		return nodedir
	}
	getNodeDir(){
		var nodedir = process.cwd()
		nodedir += "/nodes/" + this.call.nodenum
		//console.log("Current dir", process.cwd())
		//console.log("Node Dir", nodedir)
		return nodedir
	}
	getDoorsDir(){
		var doorsdir = process.cwd()
		doorsdir += "/doors"
		//console.log("Current dir", process.cwd())
		//console.log("Doors Dir", doorsdir)
		return doorsdir
	}
	getShortcodeDir(dircode){
		var dirobj = {}
		dirobj.status = false
		//console.log("Checking shortcode", this.dfdir, this.runnersettings)
		switch(dircode){			
			case "Node":
				//console.log("Setting Node Directory")
				var dir = this.getNodeDir()
				if (dir){
					dirobj.dir = dir
					dirobj.status = true
				}
				break;
			case "DosNode":
				//console.log("Setting Dos Node Directory")
				var dir = this.getDosNodeDir()
				if (dir){
					dirobj.dir = dir
					dirobj.status = true
				}
				break;
			case "Doors":
				//console.log("Setting Doors Directory")
				var dir = this.getDoorsDir()
				if (dir){
					dirobj.dir = dir
					dirobj.status = true
				}
				break;
			default:
				//console.log("Could not find shortcode")
		}
		return dirobj
	}
	getShortcodeSub(){
		var dirobj = {}
		dirobj.status = false
		var dirobjarr = this.dfdir.split("/")
		var sdirobj = this.getShortcodeDir(dirobjarr[0])
		if (sdirobj.status == true){
			dirobj.status = true
			dirobj.dir = sdirobj.dir
			var i = 0
			for (var ai of dirobjarr){
				if (i != 0){
					dirobj.dir += "/"
					dirobj.dir += ai
				}
				i += 1
			}
		}
		return dirobj
	}
	getDropDir(){
		var dirobj = {}
		dirobj.status = false
		if (this.dfdir){
			//console.log("Checking dfdir stage one", this.dfdir)
			//check dir for shortcodes and set directory
			//else check for preceding /, and set either as subdir or full path
			if (!this.dfdir.includes("/")){
				var sdirobj = this.getShortcodeDir(this.dfdir)
				if (sdirobj.status == true){
					dirobj.status = true
					dirobj.dir = sdirobj.dir
				}
			}else{
				//console.log("DF needs additional checking")
				if (this.dfdir.charAt(0) == "/"){
					dirobj.dir = this.dfdir
					dirobj.status = true
				}else{
					var sdirobj = this.getShortcodeSub()
					if (sdirobj.status == true){
						dirobj.status = true
						dirobj.dir = sdirobj.dir
					}
				}
			}
		}else{
			//console.log("DFdir not set")
		}

		return dirobj
	}
	fatalError(){
		this.emitter.emit('DropfileError')
	}
	writeFile(){
		//console.log(this.dfarray)
		//console.log("Writing dropfile")
		var dfmsg = "Dropfile"
		var dirobj = this.getDropDir()
		
		if (dirobj.status == true){
			//check if directory exists. Attempt to create if not
			//console.log("Checking if", dirobj.dir, "Exists")
			if (fs.existsSync(dirobj.dir)) {
				//console.log("Dir exists")
			}else{
				//console.log("Dir does not exist. Attempting to create")
				try{
					fs.mkdirSync(dirobj.dir)
				}catch(error){
					//console.log("Unable to create directory")
					//console.log(error)
					//handle errors
					this.fatalError()
					return;
				}		
			}
			//add filename to get full pathfile
			var dfpath = dirobj.dir + "/" + this.filename
			//check if file exists and delete for overwrite if so
			if (fs.existsSync(dfpath)) {
				//console.log("File exists. Attempting to clear for overwrite")
				//delete or empty file here
				try{
					fs.unlinkSync(dfpath);
				}catch(error){
					//console.log("Error overwriting file")
					this.fatalError()
					return;
				}				
			}

			//write each element of array to new line of file
			//console.log("Writing to file")
			var i = 0
			for (var dfline of this.dfarray){
				//
				var fileline = ""
				if (i != 0){
					fileline += "\r\n"
				}
				if (dfline){
					fileline += dfline.toString()
				}				
				fs.appendFileSync(dfpath, fileline, 'utf8');
				i += 1
			}
			//console.log("Completed")
			dfmsg += " " + dfpath + " written successfully."

		}else{
			//console.log("Could not find directory information.")
			//handle errors
			this.fatalError()
			return;
		}
		alogger.writeAlog(1, dfmsg, "yellowbright", true)
		this.emitter.emit('DropfileCompleted')
		console.log("Complete Emmitted")

	}
}

export{dropfileWriter}