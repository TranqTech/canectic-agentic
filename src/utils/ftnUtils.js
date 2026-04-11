import { DateTime } from "luxon";

async function getDateTimeString(){
	var militime = await Date.now()
	var timestring = DateTime.fromMillis(militime).toFormat('dd LLL yy  HH:mm:ss')
	return timestring
}

// -------------------------------------------------------------------------
// MSGID serial generation
//
// FTS-0009 specifies the MSGID serial as "any eight character hexadecimal
// string" -- a 32-bit value, written as exactly 8 hex characters. Our
// previous implementation did `Date.now().toString(16).padStart(8, '0')`
// which produces 11+ characters in 2026 (epoch milliseconds exceeded 32
// bits back in 2004) and non-compliantly violates the spec every time.
// `padStart` only pads UP, it never truncates, so we never actually fit
// inside 8 chars.
//
// Correct layout: pack 16 bits of wall-clock seconds with a 16-bit
// per-process monotonic counter. The time half gives us natural
// distribution across sessions; the counter half guarantees uniqueness
// within the same second even under burst traffic. Wraps roughly every
// 18 hours on the time side and every 65536 calls on the counter side
// -- collision requires BOTH to wrap simultaneously, which would take
// ~18 hours × 65536 calls-per-second to set up.
//
// Single 32-bit unsigned value, hex-encoded to exactly 8 characters.
// -------------------------------------------------------------------------

var _msgIdSeq = 0;

function _nextMsgIdSerial() {
	_msgIdSeq = (_msgIdSeq + 1) & 0xFFFF;
	var secondsPart = Math.floor(Date.now() / 1000) & 0xFFFF;
	var value = ((secondsPart << 16) | _msgIdSeq) >>> 0;
	return value.toString(16).padStart(8, '0');
}

// FTS-0009 MSGID serial: exactly 8 hex characters. Used by
// `netmail.js` when stamping outbound netmail with an @MSGID kludge.
// Kept async for backward compatibility with existing callers.
async function genMsgId() {
	return _nextMsgIdSerial();
}

// FTS-0009 MSGID serial: exactly 8 hex characters. Used by
// `messages.js` when stamping outbound echomail on new threads
// and replies. Despite the name, this is NOT a raw milli-hex
// dump of the clock -- see _nextMsgIdSerial() above for why.
// Sync entry point for convenience.
function getMilliHex() {
	return _nextMsgIdSerial();
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