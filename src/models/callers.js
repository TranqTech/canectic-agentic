//imports
import { DateTime } from "luxon";
//internal modules
import * as postgres from '../middleware/db/postgres.js';

//helpers
function millisToMinutes(millis) {
	var minutes = Math.floor(millis / 60000);
	return minutes;
}

async function logCall(userrecord, calltype, callerid, location) {
	var newcount = (userrecord.logoncount || 0) + 1;
	var currtime = new Date();

	var dbObj = {
		username: userrecord.username,
		logoncount: newcount,
		starttime: currtime,
		endtime: null,
		duration: null,
		source: calltype,
		location: location,
		callerid: callerid,
		created_at: currtime,
		updated_at: null
	};

	var result = await postgres.insertObject(dbObj, "calls");
	if (result.status && result.insertId) {
		return result.insertId;
	}
	return null;
}

async function logCallDuration(callId) {
	var callrecord = await postgres.queryOne('SELECT * FROM calls WHERE id = $1', [callId]);
	if (!callrecord) {
		console.log("Invalid call record for id:", callId);
		return;
	}

	var currtime = new Date();
	var callduration = millisToMinutes(currtime - callrecord.starttime);

	await postgres.write(
		'UPDATE calls SET endtime = $1, duration = $2, updated_at = $3 WHERE id = $4',
		[currtime, callduration, currtime, callId]
	);
}

async function getLastCallers(callercount) {
	var limit = callercount || 12;
	var rows = await postgres.query(
		'SELECT * FROM calls ORDER BY starttime DESC LIMIT $1',
		[limit]
	);
	return rows;
}

export { logCall, logCallDuration, getLastCallers };