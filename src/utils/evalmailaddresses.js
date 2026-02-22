//imports

//internal modules
import {checkNetmailUnique} from "../models/useraccounts.js";

//class and function space
function evaluateNetmail(address){
	if (!address){
		console.log("Emty netmail string")
		return false
	}
	console.log("Evaluating", address, "as netmail")
	var comparr = address.split("@")
	if (comparr.length != 2){
		return false
	}
	var harr = comparr[1].split(":")
	if (harr.length != 2){
		return false
	}
	var narr = harr[1].split("/")
	if (narr.length != 2){
		return false
	}
	var parr = narr[1].split(".")
	if (parr.length > 2){
		return false
	}
	console.log("Appears valid")
	return true;
}


function evaluateEmail(address){
	if (!address){
		console.log("Empty string")
		return false
	}
	console.log("Evaluating", address, "as email")
	var comparr = address.split("@")
	if (comparr.length != 2){
		return false
	}
	var subarr = comparr[1].split(".")
	if (subarr.length < 2){
		return false
	}
	if (comparr[1].endsWith(".")){
		return false
	}
	console.log("Appears valid")
	return true;
}

async function checkRegMailAddress(address){
	var returnobj = {}
	returnobj.status = false
	returnobj.isvalid = false
	returnobj.errormessages = []
	returnobj.resultmsg = ""
	if (address.includes("/")){
		console.log("Checking", address)
		var isvalid = evaluateNetmail(address)
	}else{
		console.log("Checking", address)
		var isvalid = evaluateEmail(address)
	}
	if (isvalid){
		returnobj.isvalid = true
		//check if it's unique
		var isunique = await checkNetmailUnique(address)
		if (isunique){
			returnobj.inuse = false
			returnobj.status = true
			returnobj.resultmsg = "Valid format, and Appears unique."
			return returnobj;
		}
		returnobj.inuse = true
		returnobj.resultmsg = "Valid format, but is already in use"
	}
	returnobj.errormessages.push("Address is not formatted correctly")
	return returnobj
}


export{evaluateNetmail, evaluateEmail, checkRegMailAddress}