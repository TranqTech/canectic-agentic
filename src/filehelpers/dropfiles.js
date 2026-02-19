//imports
//internal modules
import * as alogger from "../utils/alogger.js"
//setup
//variable config

//function and class space

class doorSys(){
	constructor(comport, baudrate, fullname){
		this.comport = comport
		this.baudrate = baudrate
		this.parity = 8
		this.screendisplay = "Y"
		this.printertoggle = "Y"
		this.pagebell = "Y"
		this.calleralarm = "Y"
		this.fullname = fullname
	}
	writefile(location){
		//
	}
}

class door32Sys(){
	constructor(){

	}
}

class dorinfoDef(){
	constructor(){

	}
}

class doorfileSR(){
	constructor(){

	}
}

export{doorSys, door32Sys, dorinfoDef, doorfileSR}