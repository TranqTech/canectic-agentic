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
import { spawn, spawnSync } from 'child_process';
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
 * Run a program without blocking, streaming each line of its output to `log`.
 *
 * The updater uses this rather than spawnSync because it serves a progress
 * page while the BBS is stopped (updateStatusServer.js), from the same event
 * loop. spawnSync would freeze that page for the whole of npm install, the
 * database dump and the migration, which is most of what it is there to show.
 * The installer keeps runCommand: it has no page to serve.
 *
 * Resolves with the combined output (the last part of it, if huge); rejects on
 * a spawn error, a non-zero exit, or the timeout, killing the child first.
 *
 * @param {string} file         program, or a whole command line when opts.shell
 * @param {string[]} args
 * @param {object} opts         { cwd, env, shell, timeoutMs, label, log }
 */
function spawnAsync(file, args, opts) {
	var o = opts || {};
	var log = typeof o.log === 'function' ? o.log : function () {};
	var label = o.label || file;
	var timeoutMs = o.timeoutMs || COMMAND_TIMEOUT_MS;
	var MAX_KEPT = 1024 * 1024;

	return new Promise(function (resolve, reject) {
		var child;
		try {
			child = spawn(file, args || [], { cwd: o.cwd, env: o.env || process.env, shell: !!o.shell });
		} catch (err) {
			return reject(new Error(label + ': ' + err.message));
		}

		var kept = '';
		var partial = { out: '', err: '' };
		var timedOut = false;
		var settled = false;

		function take(which, buf) {
			var text = buf.toString('utf8');
			kept += text;
			if (kept.length > MAX_KEPT) kept = kept.slice(-MAX_KEPT);
			var lines = (partial[which] + text).split('\n');
			partial[which] = lines.pop();
			for (var line of lines) {
				line = line.replace(/\r/g, '');
				if (line.trim()) log('  ' + line);
			}
		}
		function flush() {
			for (var which of ['out', 'err']) {
				if (partial[which].trim()) log('  ' + partial[which].replace(/\r/g, ''));
				partial[which] = '';
			}
		}

		if (child.stdout) child.stdout.on('data', function (b) { take('out', b); });
		if (child.stderr) child.stderr.on('data', function (b) { take('err', b); });

		var timer = setTimeout(function () {
			timedOut = true;
			child.kill('SIGTERM');
			var hard = setTimeout(function () { child.kill('SIGKILL'); }, 5000);
			if (hard.unref) hard.unref();
		}, timeoutMs);

		child.on('error', function (err) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(label + ': ' + err.message));
		});
		child.on('close', function (code, signal) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			flush();
			if (timedOut) return reject(new Error(label + ' timed out after ' + Math.round(timeoutMs / 1000) + 's'));
			if (code !== 0) return reject(new Error(label + ' exited ' + (code === null ? signal : code)));
			resolve(kept.trim());
		});
	});
}

/** runCommand without blocking: a shell command line, output streamed to `log`. */
function runCommandAsync(command, cwd, log) {
	var say = typeof log === 'function' ? log : function () {};
	say('$ ' + command);
	return spawnAsync(command, [], { cwd: cwd, shell: true, log: say, label: command });
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
	spawnAsync,
	runCommandAsync,
	COMMAND_TIMEOUT_MS,
	runCommand,
	nodeCommand,
	createRuntimeDirs
};
