// updateRunStore.js -- where an update run's progress is written down.
//
// A JSON file rather than a database row, deliberately. The updater is
// replacing src/, which includes the database layer, and it may be running
// while the BBS is stopped; making progress reporting depend on Postgres would
// mean the one record of what happened is the thing most likely to be
// unavailable when it is needed.
//
// It lives under the installation's logs/ directory, which is a data directory:
// not in staging, which is deleted per update, and not in a code directory,
// which is replaced by the update itself.
//
// Writes are atomic. A reader that catches a half-written state file gets JSON
// it cannot parse, and the page reading it would report a broken update rather
// than a running one, so every write is to a temporary name and renamed.

import * as fs from 'fs';
import * as path from 'path';

var RUN_DIR = 'logs/update';
var LATEST = 'latest.json';

function runDir(target) {
	return path.join(target, RUN_DIR);
}

function statePath(target, runId) {
	return path.join(runDir(target), runId + '.json');
}

function logPath(target, runId) {
	return path.join(runDir(target), runId + '.log');
}

function runFilePath(target, runId) {
	return path.join(runDir(target), runId + '.run.json');
}

function ensureDir(target) {
	fs.mkdirSync(runDir(target), { recursive: true });
	return runDir(target);
}

function writeAtomic(file, text) {
	var tmp = file + '.tmp';
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

/**
 * Persist a run state.
 *
 * `latest.json` is a copy rather than a symlink so that reading it never
 * depends on the run file still being there, and so a Windows or
 * restricted-permission install behaves the same.
 */
function save(target, state) {
	ensureDir(target);
	var text = JSON.stringify(state, null, 2) + '\n';
	writeAtomic(statePath(target, state.runId), text);
	writeAtomic(path.join(runDir(target), LATEST), text);
	return state;
}

function load(target, runId) {
	try {
		return JSON.parse(fs.readFileSync(statePath(target, runId), 'utf8'));
	} catch (_) {
		return null;
	}
}

/** The most recent run, or null when this install has never updated. */
function latest(target) {
	try {
		return JSON.parse(fs.readFileSync(path.join(runDir(target), LATEST), 'utf8'));
	} catch (_) {
		return null;
	}
}

/** Run ids newest first. */
function list(target, limit) {
	var ids = [];
	try {
		for (var name of fs.readdirSync(runDir(target))) {
			if (name === LATEST) continue;
			if (!/\.json$/.test(name) || /\.run\.json$/.test(name)) continue;
			ids.push(name.replace(/\.json$/, ''));
		}
	} catch (_) {
		return [];
	}
	ids.sort().reverse();
	return limit ? ids.slice(0, limit) : ids;
}

/**
 * The instructions handed to the updater.
 *
 * Written by the OLD release and read by the NEW one, which is the whole reason
 * it is a file rather than a command line: the contract between two versions
 * has to be able to grow. A newer updater reading a file an older release wrote
 * finds fields missing and defaults them; an older updater reading a newer file
 * ignores what it does not know. A positional argument list can do neither.
 */
function writeRunFile(target, runId, instructions) {
	ensureDir(target);
	var file = runFilePath(target, runId);
	writeAtomic(file, JSON.stringify(instructions, null, 2) + '\n');
	return file;
}

function readRunFile(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export {
	RUN_DIR,
	runDir,
	statePath,
	logPath,
	runFilePath,
	ensureDir,
	save,
	load,
	latest,
	list,
	writeRunFile,
	readRunFile
};
