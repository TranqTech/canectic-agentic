/**
 * syncjsdoor_worker.js — Worker thread entry point for Synchronet JS doors
 *
 * This runs inside a worker_threads Worker. It:
 * 1. Receives workerData with the SharedArrayBuffer, door config, and user info
 * 2. Instantiates the DorkitShim (replacement dk object)
 * 3. Sets up the Synchronet global polyfills (File, random, time, etc.)
 * 4. Loads and executes the door script (e.g. lord.js)
 * 5. Signals exit when the door completes
 */

import { workerData, parentPort } from 'node:worker_threads';
import { createContext, Script } from 'node:vm';
import { WorkerSide, MSG_OUTPUT, MSG_READY, MSG_EXIT, MSG_ERROR } from '../comm/syncjsdoor_comm.js';
import { DorkitShim } from '../shims/dorkit_shim.js';
import { installSyncnetGlobals, _transpileSpiderMonkey } from '../shims/syncnet_globals.js';

// --- Unpack worker data ---
var sharedBuffer = workerData.sharedBuffer;
var doorScript   = workerData.doorScript;
var doorDir      = workerData.doorDir;
var dbSubdir     = workerData.dbSubdir;
var doorConfig   = workerData.doorConfig;
var userInfo     = workerData.userInfo;

// --- Create communication channel ---
var comm = new WorkerSide(sharedBuffer);

// --- Output helper ---
// All terminal output goes through this to the main thread
function sendOutput(data) {
	var buf;
	if (typeof data === 'string') {
		buf = Buffer.from(data, 'binary');
	} else if (Buffer.isBuffer(data)) {
		buf = data;
	} else {
		buf = Buffer.from(data);
	}
	parentPort.postMessage({ type: MSG_OUTPUT, data: buf });
}

// --- Create the dorkit shim ---
var dk = new DorkitShim(comm, sendOutput, userInfo);

// --- Install Synchronet-compatible globals ---
installSyncnetGlobals(dk, doorDir, dbSubdir, parentPort, workerData.doorArgs);

// --- Signal ready ---
parentPort.postMessage({ type: MSG_READY });

// --- Load and run the door ---
try {
	// Dynamic import of the door script
	// Note: The door script will need to be adapted or wrapped
	// to work as an ES module, or we use a loader that evals it
	// in the shimmed global context.
	//
	// For now we use a simple eval-based approach since Synchronet
	// scripts expect a global scope with dk, File, random, etc.

	var fs = await import('node:fs');
	var scriptPath = doorDir + '/' + doorScript;
	var scriptSource = _transpileSpiderMonkey(fs.readFileSync(scriptPath, 'utf-8'));

	// Execute lord.js in the worker's global scope via vm.Script.
	// runInThisContext() ensures all function/var declarations (gamedir,
	// foreground, player, state, sclrscr, lw, sln, etc.) become true
	// globalThis properties accessible to IGMs loaded later via js.exec().
	// (Indirect eval from ESM strict-mode context can fail to hoist
	// function declarations to globalThis in V8.)
	new Script(scriptSource, { filename: scriptPath }).runInThisContext();

	// Door completed normally
	parentPort.postMessage({ type: MSG_EXIT, code: 0 });

} catch (err) {
	if (err.message === 'DOOR_EXIT') {
		// Normal exit via exit() call
		parentPort.postMessage({ type: MSG_EXIT, code: err.exitCode || 0 });
	} else {
		// Unexpected error
		parentPort.postMessage({
			type: MSG_ERROR,
			error: err.stack || err.message || String(err)
		});
	}
}