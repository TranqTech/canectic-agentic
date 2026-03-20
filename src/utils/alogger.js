//includes and requires
import { DateTime } from "luxon";
import {appendFileSync, existsSync, mkdirSync} from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import * as dotenv from 'dotenv';

// set variables
dotenv.config();
const nodeenv = process.env.NODE_ENV || 'development';
const loglevel = process.env.loglevel || 3;
const logtoconsole = process.env.logtoconsole;
const logallindev = process.env.logeverything
const logfileindev = process.env.logfileindev
const logpath = path.join(path.dirname("./"), 'logs', nodeenv);
const logfilename = process.env.defaultlogfile || "system.log"
const logfile = logpath + '/' + logfilename;

// -----------------------------------------------------------------------
// Log bus — Redis pub/sub + sorted set history
//
// Publishes every log entry to a Redis channel for real-time admin views.
// Caches entries in per-process sorted sets for history backfill.
// Entirely optional — if Redis isn't configured or initLogBus() isn't
// called, logging continues normally to console and file.
//
// Entry format (JSON):
// {
//   process:  "gateway",     — source process
//   level:    2,             — log level (lower = more important)
//   message:  "...",         — raw message text (no timestamp prefix)
//   color:    "bluebright",  — chalk color name or null
//   bold:     false,         — bold flag
//   filename: null,          — custom log filename or null
//   ts:       1711000000000, — epoch milliseconds
//   seq:      42             — per-process sequence number
// }
//
// Redis keys:
//   alog:stream                — pub/sub channel for real-time
//   alog:history:gateway       — sorted set (score = epoch ms)
//   alog:history:worker        — sorted set
//   alog:history:mailer        — sorted set
//
// Env:
//   LOG_BUS_RETENTION_HOURS    — history retention (default: 8)
// -----------------------------------------------------------------------

const LOG_CHANNEL = 'alog:stream';
const HISTORY_PREFIX = 'alog:history:';
const LOG_BUS_RETENTION = (parseInt(process.env.LOG_BUS_RETENTION_HOURS) || 8) * 60 * 60 * 1000;
const TRIM_INTERVAL = 15 * 60 * 1000;  // trim every 15 minutes

var _processName = 'unknown';
var _busClient = null;
var _busReady = false;
var _busSeq = 0;
var _trimTimer = null;

/**
 * Set the process name for log bus entries.
 * Call once at process startup before any logging.
 *
 *   import * as alogger from '../src/utils/alogger.js';
 *   alogger.setProcessName('gateway');
 */
function setProcessName(name) {
	_processName = name || 'unknown';
}

/**
 * Initialize the log bus Redis connection.
 * Call once at process startup after dotenv.  Safe to skip — logging
 * works without it.
 *
 * Uses the application's existing redis module (shared connection)
 * to avoid adding a separate dependency just for logging.
 */
async function initLogBus() {
	try {
		var redis = await import('../middleware/db/redis.js');
		_busClient = await redis.getClient();
		_busReady = true;

		// Start periodic trim of old entries
		_trimTimer = setInterval(() => _trimHistory(), TRIM_INTERVAL);
		// Don't let the trim timer prevent process exit
		if (_trimTimer.unref) _trimTimer.unref();

	} catch (err) {
		// Redis not available — log bus disabled, normal logging continues
		_busReady = false;
	}
}

/**
 * Shutdown the log bus.  Clears the trim timer.
 * Call from process SIGINT/SIGTERM handlers.
 */
function shutdownLogBus() {
	if (_trimTimer) {
		clearInterval(_trimTimer);
		_trimTimer = null;
	}
	_busReady = false;
	// Don't disconnect _busClient — it's shared with the app's redis module
}

/**
 * Publish a log entry to the Redis bus (fire-and-forget).
 * Never throws, never blocks the caller.
 */
function _publishEntry(entry) {
	if (!_busReady || !_busClient) return;

	try {
		var payload = JSON.stringify(entry);

		// Publish to real-time channel (fire-and-forget — no await)
		_busClient.publish(LOG_CHANNEL, payload).catch(function(){});

		// Add to per-process sorted set for history backfill
		var historyKey = HISTORY_PREFIX + entry.process;
		_busClient.zAdd(historyKey, [{ score: entry.ts, value: payload }]).catch(function(){});

	} catch (_) {
		// Swallow — never let log bus failures affect normal operation
	}
}

/**
 * Trim entries older than the retention window from all known process
 * history sets.  Runs on a timer, not on every write.
 */
async function _trimHistory() {
	if (!_busReady || !_busClient) return;

	var cutoff = Date.now() - LOG_BUS_RETENTION;

	// Trim known process names plus the current one (in case of custom names)
	var processes = new Set(['gateway', 'worker', 'mailer', _processName]);

	for (var proc of processes) {
		try {
			var key = HISTORY_PREFIX + proc;
			await _busClient.zRemRangeByScore(key, '-inf', cutoff);
		} catch (_) {
			// Swallow
		}
	}
}

/**
 * Build a structured log entry from writeAlog/writeClog parameters.
 */
function _buildEntry(level, message, chalkcolour, bold, filename) {
	_busSeq++;
	return {
		process:  _processName,
		level:    level,
		message:  message,
		color:    chalkcolour || null,
		bold:     !!bold,
		filename: filename || null,
		ts:       Date.now(),
		seq:      _busSeq
	};
}


// -----------------------------------------------------------------------
// Chalk helpers (unchanged)
// -----------------------------------------------------------------------

async function getchalked(chalkcolour, message){
	var lowercolour = chalkcolour.toLowerCase()
	switch(lowercolour){
		case "black":
			console.log(chalk.black(message));
			break;
		case "red":
			console.log(chalk.red(message));
			break;
		case "green":
			console.log(chalk.green(message));
			break;
		case "yellow":
			console.log(chalk.yellow(message));
			break;
		case "blue":
			console.log(chalk.blue(message));
			break;
		case "magenta":
			console.log(chalk.magenta(message));
			break;
		case "cyan":
			console.log(chalk.cyan(message));
			break;
		case "white":
			console.log(chalk.white(message));
			break;
		case "gray":
			console.log(chalk.gray(message));
			break;
		case "redbright":
			console.log(chalk.redBright(message));
			break;
		case "greenbright":
			console.log(chalk.greenBright(message));
			break;
		case "yellowbright":
			console.log(chalk.yellowBright(message));
			break;
		case "bluebright":
			console.log(chalk.blueBright(message));
			break;
		case "magentabright":
			console.log(chalk.magentaBright(message));
			break;
		case "cyanbright":
			console.log(chalk.cyanBright(message));
			break;
		case "whitebright":
			console.log(chalk.whiteBright(message));
			break;
		default:
			console.log(message)
	}
}

async function boldchalked(chalkcolour, message){
	var lowercolour = chalkcolour.toLowerCase()
	switch(lowercolour){
		case "black":
			console.log(chalk.black.bold(message));
			break;
		case "red":
			console.log(chalk.red.bold(message));
			break;
		case "green":
			console.log(chalk.green.bold(message));
			break;
		case "yellow":
			console.log(chalk.yellow.bold(message));
			break;
		case "blue":
			console.log(chalk.blue.bold(message));
			break;
		case "magenta":
			console.log(chalk.magenta.bold(message));
			break;
		case "cyan":
			console.log(chalk.cyan.bold(message));
			break;
		case "white":
			console.log(chalk.white.bold(message));
			break;
		case "gray":
			console.log(chalk.gray.bold(message));
			break;
		case "redbright":
			console.log(chalk.redBright.bold(message));
			break;
		case "greenbright":
			console.log(chalk.greenBright.bold(message));
			break;
		case "yellowbright":
			console.log(chalk.yellowBright.bold(message));
			break;
		case "bluebright":
			console.log(chalk.blueBright.bold(message));
			break;
		case "magentabright":
			console.log(chalk.magentaBright.bold(message));
			break;
		case "cyanbright":
			console.log(chalk.cyanBright.bold(message));
			break;
		case "whitebright":
			console.log(chalk.whiteBright.bold(message));
			break;
		default:
			console.log(message)
	}
}


// -----------------------------------------------------------------------
// Core logging functions
// -----------------------------------------------------------------------

//all purpose logging function
async function writeAlog(level, message, chalkcolour, bold, filename){
	var alogfile = logfile
	if (filename){
		alogfile = logpath + '/' + filename + ".log";
	}
	// attach timestamp to log message
	var currenttime = await DateTime.now();
	//Luxon sometimes puts a slim nbsp into time string. Replace with standard space for logging
	var prettytime = await currenttime.toLocaleString(DateTime.DATETIME_MED).replace(/\u202f/g, ' ')
	var messagewtime = '\n' + prettytime + ':\n- ' + message;

	if (nodeenv.toLowerCase() == "development"){
		//check if the set loglevel is greater than the level of the incoming message
		//more important messages should have a lower level, dev or debug messages should be set 4 or higher
		//alternatively, logeverything can be set in env to disregard levels in dev
		if ((loglevel >= level)||(logallindev)){
			if (chalkcolour){
				if (bold){
					boldchalked(chalkcolour, messagewtime)
				}else{
					getchalked(chalkcolour, messagewtime)
				}			
			}else{
				console.log(messagewtime);	
			}
			if(logfileindev){
				try{
					if (!existsSync(logpath)){
						mkdirSync(logpath);
					}
					appendFileSync(alogfile, messagewtime);	
				}catch(error){
					console.log(chalk.bold.red("Could not write to log file."));
					console.log(chalk.red(error));
				}
			}
		}		
	}else{
		//check if the set loglevel is greater than the level of the incoming message
		//more important messages should have a lower level, dev or debug messages should be set 4 or higher
		if(loglevel >= level){
						
			//check if env variable set to always log to console
			if (logtoconsole){
				if (chalkcolour){
					if (bold){
						boldchalked(chalkcolour, messagewtime)
					}else{
						getchalked(chalkcolour, messagewtime)
					}					
				}else{
					console.log(messagewtime);
				}
			}
			//write to logfile. catch errors writing logfile and display to local console.
			try{
				if (!existsSync(logpath)){
					mkdirSync(logpath);
				}
				appendFileSync(alogfile, messagewtime);	
			}catch(error){
				console.log(chalk.bold.red("Could not write to log file."));
				console.log(chalk.red(error));
			}
			
		}
	}

	// Publish to log bus (fire-and-forget, ALL levels — admin view filters client-side)
	_publishEntry(_buildEntry(level, message, chalkcolour, bold, filename));
}

//for writing to specific log file
async function writeClog(level, message, filename, chalkcolour, bold, noconsole){
	// attach timestamp to log message
	var currenttime = await new Date();
	var prettytime = await currenttime.toLocaleString(DateTime.DATETIME_MED).replace(/\u202f/g, ' ')
	var messagewtime = '\n' + prettytime + ':\n- ' + message + '\n';

	// set custom logfile
	const clogfile = logpath + '/' + filename + ".log";

	if (nodeenv.toLowerCase() == "development"){
		//check if the set loglevel is greater than the level of the incoming message
		//more important messages should have a lower level, dev or debug messages should be set 4 or higher
		//alternatively, logeverything can be set in env to disregard levels in dev
		if ((loglevel >= level)||(logallindev)){
			if (!noconsole){
				if (chalkcolour){
					if (bold){
						boldchalked(chalkcolour, messagewtime)
					}else{
						getchalked(chalkcolour, messagewtime)
					}			
				}else{
					console.log(messagewtime);	
				}
			}			
			if(logfileindev){
				try{
					if (!existsSync(logpath)){
						mkdirSync(logpath);
					}
					appendFileSync(clogfile, messagewtime);	
				}catch(error){
					console.log(chalk.bold.red("Could not write to log file."));
					console.log(chalk.red(error));
				}
			}
		}		
	}else{
		//check if the set loglevel is greater than the level of the incoming message
		//more important messages should have a lower level, dev or debug messages should be set 4 or higher
		if(loglevel >= level){
						
			//check if env variable set to always log to console
			if ((logtoconsole)&&(!noconsole)){
				if (chalkcolour){
					if (bold){
						boldchalked(chalkcolour, messagewtime)
					}else{
						getchalked(messagewtime)
					}					
				}else{
					console.log(messagewtime);
				}
			}
			
			//write to logfile. catch errors writing logfile and display to local console.
			try{
				appendFileSync(clogfile, messagewtime);	
			}catch(error){
				console.log(chalk.bold.red("Could not write to log file."));
				console.log(chalk.red(error));
			}
			
		}
	}

	// Publish to log bus (fire-and-forget, ALL levels — admin view filters client-side)
	_publishEntry(_buildEntry(level, message, chalkcolour, bold, filename));
}

function setTerminalTitle(title)
{
  process.stdout.write(
    String.fromCharCode(27) + "]0;" + title + String.fromCharCode(7)
  );
}

export{
	writeAlog,
	writeClog,
	setTerminalTitle,
	setProcessName,
	initLogBus,
	shutdownLogBus,
	LOG_CHANNEL,
	HISTORY_PREFIX
}
