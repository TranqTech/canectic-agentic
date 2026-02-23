//imports
//internal modules
import { checkMailUnique } from "../models/useraccounts.js";

//class and function space

function evaluateNetmail(address) {
	if (!address) return false;
	var comparr = address.split("@");
	if (comparr.length !== 2) return false;
	var harr = comparr[1].split(":");
	if (harr.length !== 2) return false;
	var narr = harr[1].split("/");
	if (narr.length !== 2) return false;
	var parr = narr[1].split(".");
	if (parr.length > 2) return false;
	return true;
}

function evaluateEmail(address) {
	if (!address) return false;
	var comparr = address.split("@");
	if (comparr.length !== 2) return false;
	var subarr = comparr[1].split(".");
	if (subarr.length < 2) return false;
	if (comparr[1].endsWith(".")) return false;
	return true;
}

// Determines if an address is netmail or email format.
// Returns "netmail", "email", or null if neither.
function getMailType(address) {
	if (!address) return null;
	if (address.includes("/") && evaluateNetmail(address)) {
		return "netmail";
	}
	if (evaluateEmail(address)) {
		return "email";
	}
	return null;
}

async function checkRegMailAddress(address) {
	var returnobj = {
		status: false,
		isvalid: false,
		inuse: false,
		mailtype: null,
		errormessages: [],
		resultmsg: ""
	};

	var mailtype = getMailType(address);

	if (!mailtype) {
		returnobj.errormessages.push("Address is not formatted correctly");
		return returnobj;
	}

	returnobj.isvalid = true;
	returnobj.mailtype = mailtype;

	var isunique = await checkMailUnique(address);
	if (isunique) {
		returnobj.inuse = false;
		returnobj.status = true;
		returnobj.resultmsg = "Valid " + mailtype + " format, and appears unique.";
	} else {
		returnobj.inuse = true;
		returnobj.resultmsg = "Valid " + mailtype + " format, but is already in use";
	}

	return returnobj;
}

export { evaluateNetmail, evaluateEmail, getMailType, checkRegMailAddress };