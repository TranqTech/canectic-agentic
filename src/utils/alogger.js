//includes and requires
//import * as fs from 'fs';
import { DateTime } from "luxon";
import {appendFileSync, existsSync, mkdirSync} from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import * as dotenv from 'dotenv';

// local modules
//var arraything = require('./arraything')

// set variables
dotenv.config();
const nodeenv = process.env.NODE_ENV || 'development';
const loglevel = process.env.loglevel || 3;
const logtoconsole = process.env.logtoconsole;
const logallindev = process.env.logeverything
const logfileindev = process.env.logfileindev
const logpath = path.join(path.dirname("./"), 'logs', nodeenv);
//const logpath = path.join(path.dirname.toString(), '/', 'logs');
const logfilename = process.env.defaultlogfile || "system.log"
const logfile = logpath + '/' + logfilename;


//function space
async function getchalked(chalkcolour, message){
	//check if can find valid colour and log with colour if so
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
			//log without chalking if no valid colour found
			console.log(message)
	}
}

async function boldchalked(chalkcolour, message){
	//check if can find valid colour and log with colour if so
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
			//log without chalking if no valid colour found
			console.log(message)
	}
}

//all purpose logging function
async function writeAlog(level, message, chalkcolour, bold){
	// attach timestamp to log message
	var currenttime = await DateTime.now();
	//Luxon sometimes puts a slim nbsp into time string. Replace with standard space for logging
	var prettytime = await currenttime.toLocaleString(DateTime.DATETIME_MED).replace(/\u202f/g, ' ')
	var messagewtime = '\n' + prettytime + ':\n- ' + message;
	//var messagewtime = '\n' + prettytime + ':\n- ' + message + '\n';

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
					appendFileSync(logfile, messagewtime);	
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
				appendFileSync(logfile, messagewtime);	
			}catch(error){
				console.log(chalk.bold.red("Could not write to log file."));
				console.log(chalk.red(error));
			}
			
		}else{
			//console.log("Not at log level")
		}
	}

}

//for writing to specifig log file
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

}

function setTerminalTitle(title)
{
  process.stdout.write(
    String.fromCharCode(27) + "]0;" + title + String.fromCharCode(7)
  );
}

export{writeAlog, writeClog, setTerminalTitle}

// module.exports = {
// 	writelog: (level, message, chalkcolour, bold) => writelog(level, message, chalkcolour, bold),
// 	writeclog: (level, message, filename, chalkcolour, bold) => writeclog(level, message, filename, chalkcolour, bold)
// }