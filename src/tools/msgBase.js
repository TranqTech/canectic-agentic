import * as msgAreas from "../models/msgAreas.js";
import * as msgGroups from "../models/msgGroups.js";
import * as messages from "../models/messages.js";
import * as postgres from "../middleware/db/postgres.js";
import * as alogger from "../utils/alogger.js";

async function checkandCreateTables() {
	await msgAreas.createMsgTables();
}

async function testSubjectParse() {
	var message = {
		subject: "Re:Re:Something Else"
	};
	var checksubject = message.subject;
	if (message.subject.toUpperCase().startsWith('RE:')) {
		var i = 0;
		while (checksubject.toUpperCase().startsWith('RE:')) {
			checksubject = checksubject.substring(3).trim();
			i++;
			if (i > 10) break;
		}
	}
	alogger.writeAlog(5, "testSubjectParse: " + checksubject, "cyan");
}

async function testDate() {
	var threadtable = "mb_cgynet_gen_threads";
	var tdate       = "2025-04-27T00:34:26.000Z";
	var starttime   = new Date(tdate);
	starttime.setDate(starttime.getDate() - 14);
	var querytext = "SELECT * FROM " + threadtable + " WHERE subject = $1 AND started_at >= $2 AND started_at <= $3 ORDER BY started_at DESC";
	var results = await postgres.queryOne(querytext, ["Move", starttime, tdate]);
	alogger.writeAlog(5, "testDate result: " + JSON.stringify(results), "cyan");
}

async function finalThreadUpdates() {
	var updatearray = [];
	for (var thread of messages.threadUpdateArray) {
		var uObj = {
			id:        thread.split("[")[0],
			shortcode: thread.split("[")[1]
		};
		updatearray.push(uObj);
	}
	if (updatearray.length > 0) {
		alogger.writeAlog(5, "finalThreadUpdates: updating " + updatearray.length + " threads", "cyan");
		await messages.updateThreadArray(updatearray);
	} else {
		alogger.writeAlog(5, "finalThreadUpdates: no threads to update", "cyan");
	}
}

async function doMaint() {
	var shortcodeArray = await msgAreas.GetShortcodeList();
	for (var sc of shortcodeArray) {
		//await messages.applyThreadingForArea(sc)
		//await messages.updateAreaThreads(sc)
		await messages.updateDailyThreads(sc);
		await messages.mergeRecentThreads(sc);
	}
	await finalThreadUpdates();
	await msgAreas.updateAreaStats();
}

async function main() {
	await checkandCreateTables();
	await doMaint();
	//await testSubjectParse()
	//await testDate()
}

await main();
process.exit();