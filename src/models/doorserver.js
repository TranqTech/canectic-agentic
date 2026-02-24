//imports
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { DateTime } from "luxon";

//internal modules
import * as postgres from '../middleware/db/postgres.js'

var testBBS = {
	id: "MY_BBS_01",
	auth_token: "12345654",
	name: "Test BBS",
	username_prefix: "test",
	location: "Calgary, AB",
}

async function getClientBBS(bbsid){
	return testBBS
}

export {getClientBBS}