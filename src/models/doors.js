//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { DateTime } from "luxon";

//internal modules
import * as postgres from '../middleware/db/postgres.js'

//testing placeholder
const testdoor = {
	cmd: "\"c:\\bat\\test.bat\"",
	launchType: "DosemuPty",
	dropfileType: "doorsys",
	dropfileDir: "/home/kostie/.dosemu/drive_c/doors/LOD",
	pauseOnExit: true,	
}


async function getDoorConfig(slugname){
	//do lookup
	if (slugname === "testdoor"){
		return testdoor
	}
	return null
}

export{ getDoorConfig }