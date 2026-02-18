//imports
import * as dotenv from 'dotenv';
import { DateTime } from "luxon";

//setup
dotenv.config();

//variables
const vsoftwarename = "Canectic BBS Door Server"
const vsystemver = "0.02a"
const vsystemvermsg = vsoftwarename + " v" + vsystemver
const boardname = process.env.boardname
const boardlocation = process.env.boardlocation


function versionMsg(){
	return vsystemvermsg
}

function softwareName(){
	return vsoftwarename;
}

function softwareVersion(){
	return vsystemver;
}

function getSystemInfo(){	
	var iobj = {}
	iobj.longestline = 0
	iobj.validlines = 0
	iobj.systemver = vsystemvermsg
	// if (vsystemvermsg){
	// 	iobj.validlines += 1
	// }
	iobj.longestline = iobj.systemver.length
	iobj.boardname = boardname
	if (boardname != ""){
		iobj.validlines += 1
	}
	if (boardname.length > iobj.longestline){
		iobj.longestline = boardname.length
	}
	iobj.location = boardlocation
	if (boardlocation != ""){
		//console.log("Location", boardlocation)
		iobj.validlines += 1
	}
	if (boardlocation.length > iobj.longestline){
		iobj.longestline = boardlocation.length
	}
	iobj.connecttime = DateTime.now().toLocaleString(DateTime.DATETIME_MED).replace(/\u202f/g, ' ')
	if (iobj.connecttime.length > iobj.longestline){
		iobj.longestline = iobj.connecttime.length
	}
	if (iobj.connecttime != ""){
		iobj.validlines += 1
	}
	return iobj
}


export{versionMsg, softwareName, softwareVersion, getSystemInfo}