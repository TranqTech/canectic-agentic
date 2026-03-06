import { DateTime } from "luxon";

async function getDateTimeString(){
	var militime = await Date.now()
	var timestring = DateTime.fromMillis(militime).toFormat('dd LLL yy  HH:mm:ss')
	return timestring
}

async function genMsgId(){
	var militime = await Date.now()
	var msgId = militime.toString(16).padStart(8, '0');
	return msgId
}

function getMilliHex(){
	var militime = Date.now()
	var milihex = militime.toString(16).padStart(8, '0');
	return milihex
}

function getMonthNumberFromDate(monthAbbreviation) {
  // Create a Date object with a dummy day and year to parse the month
  const date = new Date(`${monthAbbreviation} 1, 2000`);
  return String(date.getMonth() + 1).padStart(2, '0');; // Add 1 because getMonth() is zero-indexed
}

async function getSystemTime(dtstring, TZString){
	var stString = ""
	var dtarray = dtstring.split(" ")
	var yearstring = "20"
	if (parseInt(dtarray[2]) > 80){
		yearstring = "19"
	}
	yearstring += dtarray[2]
	var monthnum = getMonthNumberFromDate(dtarray[1])
	stString += yearstring + "-" + monthnum + "-" + dtarray[0] + "T" + dtarray[4] + ".000Z"
	var systemTime = new Date(stString)
	//console.log("Converting", systemTime, "With Offset", TZString)
	if ((TZString)&&(TZString != "")){
		//adjust systemtime for tzutc
		var adjustmins = 0
		var direction = "Subtract"
		var hourstring = ""
		var minutestring = ""
		if (TZString.startsWith("-")){
			direction = "Add"
			hourstring = TZString.substring(1,3)
			minutestring = TZString.substring(3,5)
		}else{
			hourstring = TZString.substring(0,2)
			minutestring = TZString.substring(2,4)
		}
		adjustmins += (parseInt(hourstring)*60)
		adjustmins += (parseInt(minutestring))
		if (direction == "Add"){
			systemTime.setMinutes(systemTime.getMinutes() + adjustmins);
		}else if (direction == "Subtract"){
			systemTime.setMinutes(systemTime.getMinutes() - adjustmins);
		}		
	}
	console.log(systemTime)
	return systemTime
}

export{
	getDateTimeString,
	genMsgId,
	getMilliHex,
	getSystemTime
}