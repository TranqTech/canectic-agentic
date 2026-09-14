// updateCommands.js -- running things, and making directories.
//
// Split out of updateRunner.js for one reason, and it is a hard constraint
// rather than tidiness: THE INSTALL PATH RUNS BEFORE npm install HAS EVER
// HAPPENED. A fresh machine has an extracted release and nothing else, so every
// module the installer imports, transitively, has to resolve with no
// node_modules at all.
//
// updateRunner.js imports appConfig, which reaches dotenv, and baseCache, which
// reaches alogger, which reaches luxon and chalk. None of that can be on the
// install path. These three functions can, so they live here and both the
// updater and the installer take them from here.
//
// tests/installPath.test.js walks the installer's import graph and fails if
// anything non-builtin appears in it, because this is the kind of constraint
// that is obeyed until somebody adds one convenient import.

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runtimeDirs } from '../release/runtimeDirs.js';

var COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run a command in the installation.
 *
 * `shell: true` because the stop and start commands are sysop-configured
 * strings, not argument vectors. Output is returned rather than inherited so it
 * can go to the run log, which is the only place anybody will read it from once
 * the gateway is gone.
 */
function runCommand(command, cwd, log) {
	log('$ ' + command);
	var res = spawnSync(command, {
		cwd: cwd, shell: true, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS,
		maxBuffer: 32 * 1024 * 1024
	});
	var out = ((res.stdout || '') + (res.stderr || '')).trim();
	if (out) for (var line of out.split('\n').slice(-40)) log('  ' + line);
	if (res.error) throw new Error(command + ': ' + res.error.message);
	if (res.status !== 0) throw new Error(command + ' exited ' + res.status);
	return out;
}

/**
 * Create every runtime directory an installation needs, idempotently.
 *
 * Lives here rather than in installer.js because that module imports runCommand
 * from this one, and putting it there would make the two import each other.
 */
function createRuntimeDirs(target) {
	var made = [];
	for (var rel of runtimeDirs()) {
		var abs = path.join(target, rel);
		if (fs.existsSync(abs)) continue;
		fs.mkdirSync(abs, { recursive: true });
		made.push(rel);
	}
	return made;
}

/** Never a bare `node`: the interpreter is whichever one is running this. */
function nodeCommand(script) {
	return JSON.stringify(process.execPath) + ' ' + script;
}

export {
	COMMAND_TIMEOUT_MS,
	runCommand,
	nodeCommand,
	createRuntimeDirs
};
