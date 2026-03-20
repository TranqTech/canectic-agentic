//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { DateTime } from "luxon";

//internal modules
import * as postgres from '../middleware/db/postgres.js'

var testingarray = [
{
	slug: "test",
	name: "LoRD",
	doorScript: "lord.js",
	doorDir: "/home/kostie/Doors/JS/lord",
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: false,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
},
{
	slug: "lod",
	name: "Land of Devastation",
	cmd: "\"c:\\bat\\test.bat\"",
	launchType: "DosemuPty",
	dropfileType: "doorsys",
	dropfileDir: "/home/kostie/.dosemu/drive_c/doors/LOD",
	usereal_local: false,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 1
},
{
	slug: "lord",
	name: "LoRD",
	doorScript: "lord.js",
	doorDir: "/home/kostie/Doors/JS/lord",
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: false,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
},
{
	slug: "lordmaint",
	name: "LoRD Maintenance",
	doorScript: "lord.js",
	doorDir: "/home/kostie/Doors/JS/lord",
	doorArgs: ["-m"],
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: false,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
},
{
	slug: "lordreset",
	name: "LoRD reset",
	doorScript: "lord.js",
	doorDir: "/home/kostie/Doors/JS/lord",
	doorArgs: ["RESET"],
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: false,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
},
{
	slug: "lord2",
	name: "LoRD 2",
	doorScript: "lord2.js",
	doorDir: "/home/kostie/Doors/JS/lord2",
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: true,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
},
{
	slug: "druglord",
	name: "Druglord",
	doorScript: "druglord.js",
	doorDir: "/home/kostie/Doors/JS/druglord",
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: true,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
},
{
	slug: "dice",
	name: "Dice Warz",
	doorScript: "dice.js",
	doorDir: "/home/kostie/Doors/JS/dicewarz",
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: true,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
},
{
	slug: "dice2",
	name: "Dice Warz 2",
	doorScript: "dice2.js",
	doorDir: "/home/kostie/Doors/JS/dicewarz2",
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: true,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
},
{
	slug: "hamtest",
	name: "Ham Test",
	doorScript: "hamtest.js",
	doorDir: "/home/kostie/Doors/JS/hamtest",
	launchType: "SyncJSDoor",
	dbSubdir: "DB",
	usereal_local: true,
	usereal_doorsession: false,
	pauseOnExit: true,
	maxnodes: 0
}
]


async function getDoorConfig(slugname){
	const testingdoor = testingarray.find(door => door.slug === slugname)
	if (testingdoor){
		return testingdoor
	}else{
		return null
	}
}

export{ getDoorConfig }