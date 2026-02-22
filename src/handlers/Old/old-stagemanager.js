//imports
import * as dotenv from 'dotenv';

//internal modules
import * as alogger from "../utils/alogger.js"
import {terminalNegotiator} from '../handlers/terminalnegotiator.js'
import {logonHandler} from '../handlers/logonhandler.js'
import {logoffHandler, goodbyeScreen} from '../handlers/logoffhandler.js'
import {xtrnRunner} from '../handlers/xtrnrunner.js'
import {topMenu} from '../handlers/topmenu.js'
import {menuHandler} from '../handlers/menuhandler.js'
import {eventHandler} from '../handlers/eventhandler.js'
import {userLoader} from '../handlers/userLoader.js'
import {announcementHandler} from '../handlers/announcementhandler.js'
import {lastCallers} from '../menucommands/lastcallers.js'


//setup
var floworder
const standardFO = ["", "TermSetup", "Logon", "LastCallers", "Announcements", "TopMenu", "Logoff"]
const testFO = ["", "TermSetup", "SetTestUser", "TopMenu"]
const testFO2 = ["", "TermSetup", "SetTestUser", "TestMenu"]

//var config
dotenv.config();
var testusername = process.env.testusername || "Testuser"

//class and function space

function stageManager(stage, call){
	if (call.floworder){
		switch(call.floworder.toLowerCase()){
			case "test":
				floworder = testFO
				break;
			case "standard":
				floworder = standardFO
				break;
			default:
				floworder = standardFO
				break;
		}
	}else{
		floworder = standardFO
	}
	if (!stage){
		return new goodbyeScreen(call)
	}
	if (stage == 255){
		//last handler errored. Do Error goodbye. For now just use standard
		return new goodbyeScreen(call)
	}
	if (floworder[stage]){
		var stage = floworder[stage]
	}else{
		var stage = "Logoff"
	}
	switch (stage){
		case "TermSetup":
			return new terminalNegotiator(call)
			break;
		case "Logon":
			return new logonHandler(call)
			break;
		case "TopMenu":
			return new topMenu(call)
			break;
		case "LastCallers":
			return new lastCallers(call, true, "Stage", call)
			break;
		case "Menus":
			return new menuHandler(call)
			break;
		case "LogonEvent":
			return new eventHandler(call, "Logon")
			break;
		case "LogoffEvent":
			return new eventHandler(call, "Logoff")
			break;
		case "Announcements":
			return new announcementHandler(call)
			break;
		case "Logoff":
			return new goodbyeScreen(call)
			break;
		case "SetTestUser":
			return new userLoader(call, testusername)
			break;
		case "TestMenu":
			return new topMenu(call)
			break;
		default:
			console.log("Error figuring stage", stage)
			call.hangUpCall()
			return null
	}
}

//exports
export{stageManager}