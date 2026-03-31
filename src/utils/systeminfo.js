//imports
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DateTime } from "luxon";
import appConfig from "../config/appConfig.js";

//variables
const vsoftwarename = "Canectic BBS"
var vsystemver = "0.0.0";
try {
	var __filename = fileURLToPath(import.meta.url);
	var __dirname = dirname(__filename);
	var pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
	vsystemver = pkg.version || vsystemver;
} catch (_) {}
const vsystemvermsg = vsoftwarename + " v" + vsystemver


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
	var boardname = appConfig.get('boardname', 'Canectic BBS');
	var boardlocation = appConfig.get('boardlocation', 'The Ether');
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