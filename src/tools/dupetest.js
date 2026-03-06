import * as postgres from "../middleware/db/postgres.js";
import * as alogger from "../utils/alogger.js";

async function dupeshort() {
	var tablename = "message_areas";
	var param     = "shortcode";
	var value     = "cgygen";
	var unique    = await postgres.checkValueUnique(param, value, tablename);
	alogger.writeAlog(5, "dupeshort: isUnique=" + unique, "cyan");
}

function getMonthNumberFromDate(monthAbbreviation) {
	const date = new Date(`${monthAbbreviation} 1, 2000`);
	return String(date.getMonth() + 1).padStart(2, '0');
}

async function dtstring() {
	var dtstring = "21 Jul 25  19:57:29";
	var TZString = "-0600";
	var dtarray  = dtstring.split(" ");

	var yearstring = parseInt(dtarray[2]) > 80 ? "19" : "20";
	yearstring += dtarray[2];

	var monthnum  = getMonthNumberFromDate(dtarray[1]);
	var stString  = yearstring + "-" + monthnum + "-" + dtarray[0] + "T" + dtarray[4] + ".000Z";
	var systemTime = new Date(stString);

	alogger.writeAlog(5, "dtstring: parsed UTC base = " + systemTime.toISOString(), "cyan");

	if (TZString && TZString !== "") {
		var adjustmins  = 0;
		var direction   = "Subtract";
		var hourstring, minutestring;

		// Negative offset means behind UTC — add hours to get UTC (matches ftnutils.js)
		if (TZString.startsWith("-")) {
			direction    = "Add";
			hourstring   = TZString.substring(1, 3);
			minutestring = TZString.substring(3, 5);
		} else {
			hourstring   = TZString.substring(0, 2);
			minutestring = TZString.substring(2, 4);
		}

		adjustmins += (parseInt(hourstring) * 60);
		adjustmins += parseInt(minutestring);

		if (direction === "Add") {
			systemTime.setMinutes(systemTime.getMinutes() + adjustmins);
		} else {
			systemTime.setMinutes(systemTime.getMinutes() - adjustmins);
		}
	}

	alogger.writeAlog(5, "dtstring: adjusted systemTime = " + systemTime.toISOString(), "cyan");
}

async function main() {
	await dupeshort();
	await dtstring();
}

await main();
process.exit();