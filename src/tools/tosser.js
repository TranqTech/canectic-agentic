#!/usr/bin/env node

import * as fs from 'fs';
import * as ftn from "../models/ftnClasses.js"
import * as ftnTosser from "../middleware/ftnTosser.js"
import * as msgAreas from "../models/msgAreas.js"
import * as echomail from "../models/echomail.js"
import * as nntpTosser from "../models/nntpTosser.js"
import * as qwkTosser from "../models/qwkTosser.js"
import * as peerConnections from "../models/peerConnections.js"
import { DateTime } from "luxon";

const PID_FILE = '/tmp/can_toss.pid';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
// Usage: node tosser.js [--in | --out] [--ftn] [--nntp] [--qwk]
//
// Direction flags (default: both):
//   --in       Inbound only (pull/toss inbound)
//   --out      Outbound only (push/toss outbound)
//              If neither is specified, both directions run.
//
// Network type flags (default: all):
//   --ftn      FTN connections only
//   --nntp     NNTP connections only
//   --qwk      QWK connections only
//              Multiple can be combined: --ftn --qwk
//              If none specified, all types run.
//
// Other:
//   --help     Show usage and exit

function parseArgs() {
	var args = process.argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		console.log('Usage: node tosser.js [--in | --out] [--ftn] [--nntp] [--qwk]');
		console.log('');
		console.log('Direction:');
		console.log('  --in       Inbound only');
		console.log('  --out      Outbound only');
		console.log('             (default: both)');
		console.log('');
		console.log('Network type (combinable, default: all):');
		console.log('  --ftn      FTN connections');
		console.log('  --nntp     NNTP connections');
		console.log('  --qwk      QWK connections');
		process.exit(0);
	}

	var hasIn  = args.includes('--in');
	var hasOut = args.includes('--out');

	// If neither direction specified, run both
	var doInbound  = hasIn  || (!hasIn && !hasOut);
	var doOutbound = hasOut || (!hasIn && !hasOut);

	var hasFtn  = args.includes('--ftn');
	var hasNntp = args.includes('--nntp');
	var hasQwk  = args.includes('--qwk');
	var anyType = hasFtn || hasNntp || hasQwk;

	// If no type flags specified, run all types
	var doFtn  = hasFtn  || !anyType;
	var doNntp = hasNntp || !anyType;
	var doQwk  = hasQwk  || !anyType;

	return { doInbound, doOutbound, doFtn, doNntp, doQwk };
}

// ---------------------------------------------------------------------------
// Toss functions
// ---------------------------------------------------------------------------

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

async function runtosser(opts){
	await currentTime()

	var dirLabel = (opts.doInbound && opts.doOutbound) ? 'in+out'
		: opts.doInbound ? 'inbound only'
		: 'outbound only';
	var typeLabels = [];
	if (opts.doFtn)  typeLabels.push('FTN');
	if (opts.doNntp) typeLabels.push('NNTP');
	if (opts.doQwk)  typeLabels.push('QWK');
	console.log('Tosser running: ' + dirLabel + ' — types: ' + typeLabels.join(', '));

	// FTN
	if (opts.doFtn) {
		var activeFTN = await peerConnections.getActiveConnectionsByNetworkType("FTN");
		if (activeFTN && activeFTN.length > 0) {
			console.log("FTN: " + activeFTN.length + " active connection(s)");
			if (opts.doInbound) {
				//await ftnTosser.FindAndExtractArchives()
				await ftnTosser.TossInbound()
			}
			if (opts.doOutbound) {
				await ftnTosser.TossOutbound()
			}
		} else {
			console.log("FTN: no active connections — skipping");
		}
	}

	// NNTP
	if (opts.doNntp) {
		var activeNNTP = await peerConnections.getActiveConnectionsByNetworkType("NNTP");
		if (activeNNTP && activeNNTP.length > 0) {
			console.log("NNTP: " + activeNNTP.length + " active connection(s)");
			if (opts.doInbound) {
				await nntpTosser.pullAllNNTP();
			}
			if (opts.doOutbound) {
				await nntpTosser.pushAllNNTP();
			}
		} else {
			console.log("NNTP: no active connections — skipping");
		}
	}

	// QWK
	if (opts.doQwk) {
		var activeQWK = await peerConnections.getActiveConnectionsByNetworkType("QWK");
		if (activeQWK && activeQWK.length > 0) {
			console.log("QWK: " + activeQWK.length + " active connection(s)");
			if (opts.doInbound) {
				await qwkTosser.pullAllQWK();
			}
			if (opts.doOutbound) {
				await qwkTosser.pushAllQWK();
			}
		} else {
			console.log("QWK: no active connections — skipping");
		}
	}

	await postTossMaint()
}


async function main(){
	var opts = parseArgs();

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
	    await runtosser(opts)
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