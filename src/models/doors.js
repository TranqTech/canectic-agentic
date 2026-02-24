//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { DateTime } from "luxon";

//internal modules
import * as postgres from '../middleware/db/postgres.js'

//testing placeholder
const testdoor = {
	slug: "test",
	name: "Land of Devastation",
	cmd: "\"c:\\bat\\test.bat\"",
	launchType: "DosemuPty",
	dropfileType: "doorsys",
	dropfileDir: "/home/kostie/.dosemu/drive_c/doors/LOD",
	usereal_local: true,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 1
}


async function getDoorConfig(slugname){
	//do lookup
	if ((slugname === "testdoor")||(slugname == "test")){
		return testdoor
	}
	return null
}

export{ getDoorConfig }