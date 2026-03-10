#!/usr/bin/env node

import * as fs from 'fs';
import * as ftn from "../models/ftnClasses.js"
import * as ftnTosser from "../middleware/ftnTosser.js"
import * as msgAreas from "../models/msgAreas.js"
import * as echomail from "../models/echomail.js"
import * as nntpTosser from "../models/nntpTosser.js"
import * as peerConnections from "../models/peerConnections.js"
import { DateTime } from "luxon";

const PID_FILE = '/tmp/can_toss.pid';

async function finalThreadUpdates(){
	var updatearray = []
	for await (var thread of echomail.threadUpdateArray){
		var uObj = {
			id: thread.split("[")[0],
			shortcode: thread.split("[")[1]
		}
		updatearray.push(uObj)		
	}
	if (updatearray.length > 0){
		console.log("Updating", updatearray.length, "threads")
		await echomail.updateThreadArray(updatearray)
	}else{
		console.log("No threads to update")
	}
}


async function currentTime(){
	var militime = await Date.now()
	var strTime = DateTime.fromMillis(militime).toFormat('dd LLL yy  HH:mm:ss')
	console.log("\r\nRunning At", strTime)
}

async function postTossMaint(){
	var shortcodeArray = await msgAreas.GetShortcodeList()
	//console.log("Doing threading")
	// for await (var sc of shortcodeArray){
	// 	await echomail.updateDailyThreads(sc)
	// 	await echomail.mergeRecentThreads(sc)
		
	// }
	await finalThreadUpdates()
	await msgAreas.updateAreaStats()
}

async function runtosser(){
	await currentTime()

	// Discover which network types have active connections so we only
	// invoke tossers that have work to do
	var activeFTN  = await peerConnections.getActiveConnectionsByNetworkType("FTN");
	var activeNNTP = await peerConnections.getActiveConnectionsByNetworkType("NNTP");

	if (activeFTN && activeFTN.length > 0) {
		console.log("FTN: " + activeFTN.length + " active connection(s) — running FTN toss");
		//await ftnTosser.FindAndExtractArchives()
		await ftnTosser.TossInbound()
		await ftnTosser.TossOutbound()
	} else {
		console.log("FTN: no active connections — skipping FTN toss");
	}

	if (activeNNTP && activeNNTP.length > 0) {
		console.log("NNTP: " + activeNNTP.length + " active connection(s) — running NNTP pull then push");
		await nntpTosser.pullAllNNTP();
		await nntpTosser.pushAllNNTP();
	} else {
		console.log("NNTP: no active connections — skipping NNTP toss");
	}

	await postTossMaint()
}


async function main(){
	try {
	  const existingPid = fs.readFileSync(PID_FILE, 'utf8');
	  // Check if the process with this PID is still running
	  process.kill(parseInt(existingPid), 0); // Signal 0 checks existence without killing
	  console.log(`Another instance with PID ${existingPid} is already running.`);
	  process.exit(1);
	} catch (err) {
	  if (err.code === 'ENOENT' || err.code === 'ESRCH') { // File not found or process not found
	    console.log('No other instance found. Starting new instance...');
	    await fs.writeFileSync(PID_FILE, process.pid.toString());
	    await runtosser()
	    process.on('exit', () => {
	    	console.log("Cleaning up PID")
			fs.unlinkSync(PID_FILE); // Clean up PID file on exit
	    });
	  } else {
	    console.error('Error checking PID file:', err);
	  }
	}
}


await main()
process.exit()

//TODO: Add argument option to only run inbound or outbound when needed