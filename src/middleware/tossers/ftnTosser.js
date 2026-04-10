//imports
import * as fs from 'fs';
import * as  fileType from 'file-type';
import { exec } from 'child_process';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as  util  from 'util';

const pexec = util.promisify(exec);

//internals
import {Message, Packet} from '../../models/ftnClasses.js'
import * as ftnNetmailAdapter from '../../models/ftnNetmailAdapter.js'
import * as privateMessages from '../../models/privateMessages.js'
import * as systemAddresses from '../../models/systemAddresses.js'
import * as echomail from '../../models/echomail.js'
import * as messages from '../../models/messages.js'
import * as ftnUtils from "../../utils/ftnUtils.js"
import * as peerConnections from '../../models/peerConnections.js'
import * as codepageConversions from "../../utils/codepageConversions.js"
import appConfig from "../../config/appConfig.js"


//setup and variables
const TosserName = "Canectic Tosser v0.1"
const SystemTZUTC = "-0600"
const defaultZone = 1
// Tossed packet handling: determined by ftn_keep_tossed_days config.
// 0 = delete immediately, 999 = keep forever (move to tossed dir), 1+ = move and purge later.
function _shouldRemove() { return appConfig.getNumber('ftn_keep_tossed_days', 7) === 0; }
function _shouldMove() { return appConfig.getNumber('ftn_keep_tossed_days', 7) > 0; }
const netmailkeys = ["SourceZone", "DestinationZone", "SourceNode", "SourceNet", "DestinationNode", "DestinationNet", "Subject", "FromUser", "ToUser", "DateTime", "BodyText", "Id", "OriginLine"]
//set max msg count per pkt
//typically this has been a size constraint, but should be less of an issue with modern systems.
//this is here more to keep things debuggable.
//However, we may want to address this as a size limitation for radio based transfers of files in the future. (LoRa, etc.)
const maxMsg = 256

// --- Ensure all required FTN directories exist ---
function ensureDirectories() {
	var dirs = [
		appConfig.get('ftninbound', 'ftn/in'),
		appConfig.get('ftnoutbound', 'ftn/out'),
		appConfig.get('ftntossed', 'ftn/tossed'),
		appConfig.get('ftnbad', 'ftn/bad'),
		appConfig.get('MAILER_TEMP_DIR', 'ftn/tmp')
	];
	for (var dir of dirs) {
		if (dir && !fs.existsSync(dir)) {
			try {
				fs.mkdirSync(dir, { recursive: true });
			} catch (_) {}
		}
	}
}

// --- BSO zone-aware outbound directory resolver ---
// Zone 1 (default): ftn/out/
// Other zones:      ftn/out.NNN/ (3-digit hex zone)
function getOutboundDirForZone(zone) {
	var baseDir = appConfig.get('ftnoutbound', 'ftn/out');
	var z = parseInt(zone) || 1;
	if (z === 1) return baseDir;
	var zoneHex = z.toString(16).padStart(3, '0');
	return baseDir + '.' + zoneHex;
}

// --- 8.3-safe unique packet filename generator ---
// 4 hex chars from lower 16 bits of epoch seconds (time-ordered, ~18hr cycle)
// + 4 hex chars from a monotonic counter (wraps at 0xFFFF, 65536 per cycle)
// Filesystem collision check as final safety net.
var _pktSeq = 0;
function generatePktFilename(outDir) {
	if (!fs.existsSync(outDir)) {
		fs.mkdirSync(outDir, { recursive: true });
	}
	var timePart = (Math.floor(Date.now() / 1000) & 0xFFFF).toString(16).padStart(4, '0');
	var seqPart = (_pktSeq & 0xFFFF).toString(16).padStart(4, '0');
	_pktSeq++;
	var name = timePart + seqPart;
	var filepath = outDir + '/' + name + '.pkt';

	// Collision check — if file exists, add random jitter to seq portion
	var attempts = 0;
	while (fs.existsSync(filepath) && attempts < 16) {
		seqPart = (Math.floor(Math.random() * 0xFFFF)).toString(16).padStart(4, '0');
		name = timePart + seqPart;
		filepath = outDir + '/' + name + '.pkt';
		attempts++;
	}

	return { name: name, filepath: filepath };
}

async function getFileType(filePath) {
  try {
    const buffer = await fs.promises.readFile(filePath);
    const type = await fileType.fileTypeFromBuffer(buffer);
    //return type && type.ext === 'zip';
    if (type){
    	return type.ext
    }else{
    	return null
    }
  } catch (error) {
    console.error('Error checking file type:', error);
    return false;
  }
}

// FTN BSO arcmail bundle extensions per FTS-5000 / FSC-0057.
// Day-of-week prefix (mo/tu/we/th/fr/sa/su) plus a single hex-like counter
// character 0-9 or a-z. Matching bundles are archived (ZIP/ARJ/LHA) containers
// of .pkt files and should be extracted in the inbound directory.
// Non-matching archives (e.g. TIC-attached ZIPs, nodelist bundles, infopacks)
// must NOT be touched here -- TIC processing and other scanners handle them.
function isMailBundleFilename(filename) {
	if (!filename) return false;
	var ext = path.extname(filename).toLowerCase().replace(/^\./, '');
	return /^(mo|tu|we|th|fr|sa|su)[0-9a-z]$/.test(ext);
}

async function FindAndExtractArchives(inboundDir){
	var inDir = appConfig.get('ftninbound', 'ftn/in')
	if (inboundDir){
		inDir = inboundDir
	}
	if (!fs.existsSync(inDir)) return { zipArray: [], pktArray: [] };
	var zipArray = []
	var pktArray = []
	const filelist = fs.readdirSync(inDir);
	
	//filelist.forEach(file => {
	for await (var file of filelist){
		var filepath = inDir + "/" + file
		var ftype = await getFileType(filepath)
		if (ftype){
			switch(ftype){
				case "zip":
					if (isMailBundleFilename(file)) {
						console.log(file, "is a mail bundle (ZIP)")
						zipArray.push(filepath)
					} else {
						console.log(file, "is a ZIP but not a mail bundle -- skipping")
					}
					break;
				case "arj":
					if (isMailBundleFilename(file)) {
						console.log(file, "is a mail bundle (ARJ)")
					} else {
						console.log(file, "is an ARJ but not a mail bundle -- skipping")
					}
					break;
				default:
					pktArray.push(file)
			}
		}
	}
	if (zipArray.length > 0){
		console.log("There are", zipArray.length, "Zip files to process")
		for await (var filepath of zipArray){
			//start
			try{
				const { stdout, stderr } = await pexec(`unzip -o ${filepath} && rm ${filepath}`)
				console.log(stdout);
				if (stderr){
					console.error('stderr:', stderr);
				}				
			}catch(error){
				console.log(error)
			}
		}
	}
}

//ideally we should process non archives, extract archives, then run the process loop again.
async function TossInbound(inboundDir){
	console.log("\r\n-------------------\r\nTossing Inbound\r\n-------------------")
	ensureDirectories();
	var successcount = 0
	var importcount = 0
	var dupecount = 0
	var skipcount = 0
	var processcount = 0
	var pktcount = 0

	var inDir = appConfig.get('ftninbound', 'ftn/in')
	if (inboundDir){
		inDir = inboundDir
	}
	var zipArray = []
	var arjArray = []
	var pktArray = []
	var ticArray = []
	if (!fs.existsSync(inDir)) {
		console.log("Inbound directory does not exist: " + inDir);
		return { successcount, importcount, dupecount, skipcount, processcount };
	}
	const filelist = await fs.readdirSync(inDir);

	//filelist.forEach(file => {
	for await (var file of filelist){
		var filepath = inDir + "/" + file
		var ftype = await getFileType(filepath)
		if (ftype){
			switch(ftype){
				case "zip":
					// Only extract if the filename matches the FTN BSO arcmail bundle
					// extension pattern (.mo0, .tu5, .su9, etc.). Other ZIPs are
					// TIC attachments, nodelist archives, or infopacks and must be
					// left untouched for their respective processors.
					if (isMailBundleFilename(file)) {
						console.log(file, "is a mail bundle (ZIP)")
						zipArray.push(filepath)
					} else {
						console.log(file, "is a ZIP but not a mail bundle -- leaving for TIC/other processors")
					}
					break;
				case "arj":
					if (isMailBundleFilename(file)) {
						console.log(file, "is a mail bundle (ARJ)")
						arjArray.push(filepath)
					} else {
						console.log(file, "is an ARJ but not a mail bundle -- leaving for TIC/other processors")
					}
					break;
				default:
					console.log(ftype)
					//TODO:
					//do another call to a second switch function based on extension
					//then we can call this both here and under the other else
					//and prep arrays for other files like .tic etc.
					if (path.extname(file).toUpperCase() === ".PKT"){
						var fileobj = {filepath: filepath, movepath: appConfig.get('ftntossed', 'ftn/tossed') + "/" + file}
						pktArray.push(fileobj)
					}
			}
		}else{
			console.log("Unknown file type", file)
			if (path.extname(file).toUpperCase() === ".PKT"){
				var fileobj = {filepath: filepath, movepath: appConfig.get('ftntossed', 'ftn/tossed') + "/" + file}
				pktArray.push(fileobj)
			}
		}
	}
	if (pktArray.length > 0){
		for await (var pkt of pktArray){
			var returnObj = await TossInboundFile(pkt.filepath, pkt.movepath)
			if (returnObj){
				pktcount ++
				importcount += returnObj.pktimportcount
				dupecount += returnObj.pktdupecount
				skipcount += returnObj.pktskipcount
				processcount += returnObj.pktprocesscount
				successcount += returnObj.pktsuccesscount
			}
		}
	}
	if (zipArray.length > 0){
		console.log("There are", zipArray.length, "Zip files to process")
		for await (var filepath of zipArray){
			//start
			try{
				//const { stdout, stderr } = await pexec(`unzip -o ${filepath} && rm ${filepath}`)
				const { stdout, stderr } = await pexec(`unzip -o ${filepath} -d ${inDir} && rm ${filepath}`)
				console.log(stdout);
				if (stderr){
					console.error('stderr:', stderr);
				}				
			}catch(error){
				console.log(error)
			}
		}
	}
	//read directory file list again.
	const filelist2 = await fs.readdirSync(inDir)
	for await (var file of filelist2){
		//console.log(file)
		if (path.extname(file).toUpperCase() === ".PKT"){
			//console.log(file, "is pkt")
			//try tossing all files again to catch newly unzipped.
			//should check extension and only try if .pkt
			var filepath = inDir + "/" + file
			var movepath = appConfig.get('ftntossed', 'ftn/tossed') + "/" + file
			var returnObj = await TossInboundFile(filepath, movepath)
			if (returnObj){
				pktcount ++
				importcount += returnObj.pktimportcount
				dupecount += returnObj.pktdupecount
				skipcount += returnObj.pktskipcount
				processcount += returnObj.pktprocesscount
				successcount += returnObj.pktsuccesscount
			}else{
				console.log("Could not process file")
			}
		}else{
			console.log(file, "is not pkt")
		}
	}
	//todo: write stats to db or similar
	console.log("Completed. Stats:\r\n")
	console.log("Packets:", pktcount)
	console.log("Imported:", importcount)
	console.log("Duplicate:", dupecount)
	console.log("Skipped:", skipcount)
	console.log("\r\nTotal Processed:", processcount)
	// Thread updates are handled by postTossMaint() after the toss job completes
}


function ReadPkt(filepath) {
	var buffer
	let offset = 0;
	try{
		buffer = fs.readFileSync(filepath);		
	}catch(error){
		throw new Error(`Failed to open pkt file: ${error.message}`);
		return null
	}
	try{
		const packet = new Packet();
		
		// Read packet header according to FTS-0001 specification
		packet.SourceNode = buffer.readUInt16LE(offset); offset += 2;
		packet.DestinationNode = buffer.readUInt16LE(offset); offset += 2;
		packet.Year = buffer.readUInt16LE(offset); offset += 2;
		packet.Month = buffer.readUInt16LE(offset); offset += 2;
		packet.Day = buffer.readUInt16LE(offset); offset += 2;
		packet.Hour = buffer.readUInt16LE(offset); offset += 2;
		packet.Minute = buffer.readUInt16LE(offset); offset += 2;
		packet.Second = buffer.readUInt16LE(offset); offset += 2;
		packet.Baud = buffer.readUInt16LE(offset); offset += 2;
		packet.PacketType = buffer.readUInt16LE(offset); offset += 2;
		packet.SourceNet = buffer.readUInt16LE(offset); offset += 2;
		packet.DestinationNet = buffer.readUInt16LE(offset); offset += 2;
		packet.ProdCode = buffer.readUInt8(offset); offset += 1;
		packet.Serial = buffer.readUInt8(offset); offset += 1;
		
		// Read password (8 bytes, null padded)
		packet.Password = buffer.toString('ascii', offset, offset + 8).split('\0')[0];
		offset += 8;
		
		// Read optional zone fields. Default to zone 1 when not specified
		packet.SourceZone = Math.max(1, buffer.readUInt16LE(offset)); offset += 2;
		packet.DestinationZone = Math.max(1, buffer.readUInt16LE(offset)); offset += 2;
		
		// Skip fill bytes (20 bytes)
		offset += 20;
		
		// Format addresses as zone:net/node
		packet.Source = `${packet.SourceZone}:${packet.SourceNet}/${packet.SourceNode}`;
		packet.Destination = `${packet.DestinationZone}:${packet.DestinationNet}/${packet.DestinationNode}`;
		
		// Set DateTime
		packet.DateTime = new Date(packet.Year, packet.Month, packet.Day, packet.Hour, packet.Minute, packet.Second);
		
		// Read messages
		packet.MessageCount = 0;
		
		while (offset < buffer.length - 1) {
			// Check for end of packet marker (0000H)
			const messageType = buffer.readUInt16LE(offset);
			if (messageType === 0x0000) {
				break;
			}
			
			// Verify message type is 0200H
			if (messageType !== 0x0002) {
				throw new Error(`Invalid message type: ${messageType.toString(16)}`);
			}
			
			offset += 2; // Skip message type
			
			const message = new Message();
			
			// Read packed message header
			message.SourceNode = buffer.readUInt16LE(offset); offset += 2;
			message.DestinationNode = buffer.readUInt16LE(offset); offset += 2;
			message.SourceNet = buffer.readUInt16LE(offset); offset += 2;
			message.DestinationNet = buffer.readUInt16LE(offset); offset += 2;
			message.Attribute = buffer.readUInt16LE(offset); offset += 2;
			message.Cost = buffer.readUInt16LE(offset); offset += 2;
			
			// Read DateTime (20 bytes, null terminated)
			const dateTimeBytes = buffer.subarray(offset, offset + 20);
			message.DateTime = dateTimeBytes.toString('ascii').replace(/\0.*$/, '');
			offset += 20;
			
			// Read null-terminated strings
			message.ToUser = readNullTerminatedString(buffer, offset);
			offset += message.ToUser.length + 1;
			
			message.FromUser = readNullTerminatedString(buffer, offset);
			offset += message.FromUser.length + 1;
			
			message.Subject = readNullTerminatedString(buffer, offset);
			offset += message.Subject.length + 1;
			
			var TextBuffer = readNullTerminatedByteArray(buffer, offset);
			
			message.RawText = codepageConversions.cp437ToUtf8(TextBuffer);
			offset += message.RawText.length + 1;
			
			// Process message text for control lines and body text
			processMessageText(message);
			
			packet.Messages.push(message);
			packet.MessageCount++;
		}
		
		return packet;
	}catch(error){
		//throw new Error(`Error parsing file: ${error.message}`);
		console.log(`Error parsing file: ${error.message}`)
		return null
	}

}

function readNullTerminatedByteArray(buffer, offset){
	let end = offset;
	while (end < buffer.length && buffer[end] !== 0) {
		end++;
	}
	return buffer.subarray(offset, end);
}

function readNullTerminatedString(buffer, offset) {
	let end = offset;
	while (end < buffer.length && buffer[end] !== 0) {
		end++;
	}
	return buffer.subarray(offset, end).toString('ascii');
}

function processMessageText(message) {
	// Normalise line endings before splitting: \r\n -> \r, lone \n -> \r
	var normalised = message.RawText.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
	const lines = normalised.split(/\r/);
	//message.utf8 = codepageConversions.cp437ToUtf8(message.TextBuffer)  //message.TextBuffer
	const bodyLines = [];
	
	for (const line of lines) {
		if (line.startsWith('AREA')){
			message.Type = "Echomail"
			message.AreaTag = line.split(':')[1].trim()
		}else if (line.startsWith('\x01')) {
			// Control line - parse optional attributes
			const controlLine = line.substring(1);
			const colonIndex = controlLine.indexOf(':');
			if (colonIndex > 0) {
				const attribute = controlLine.substring(0, colonIndex).trim();
				const value = controlLine.substring(colonIndex + 1).trim();
				
				switch (attribute) {
					case 'MSGID':
						message.MsgId = value;
						message.OptionalAttributes.push({ attribute, value });
						break;
					case "REPLY":
						message.ReplyTo = value;
						message.OptionalAttributes.push({ attribute, value });
						break;
					case "THREAD":
						message.ThreadId = value;
						message.OptionalAttributes.push({ attribute, value });
						break;
					case 'TID':
						message.TosserId = value;
						message.OptionalAttributes.push({ attribute, value });
						break;
					case 'PID':
						message.TosserId = value;
						message.OptionalAttributes.push({ attribute, value });
						break;
					case "TZUTC":
						message.TZUTC = value
						message.OptionalAttributes.push({ attribute, value });
						break;
					case 'TOPT':
					case 'FMPT':
					case 'PATH':
						message.Path = value
						message.OptionalAttributes.push({ attribute, value });
						break;
					case 'INTL':
						//console.log("Process intl")
						const split = line.substring(1).split(" ")
						//console.log(split)
						attribute = split[0]
						value = split[1] + value
						const destsource = value.split(" ")
						message.source = destsource[0]
						message.destination = destsource[1]
						message.OptionalAttributes.push({ attribute, value });
						break;
					default:
						if (attribute.startsWith("INTL")){
							const split = line.substring(1).split(" ")
							message.Source = split[2]
							message.Destination = split[1]
							const newval = split[1] + " " + split[2]
							message.OptionalAttributes.push({ attribute: "INTL", value: newval });
							break;
						}
						if ((attribute.startsWith("VIA"))||(attribute.startsWith("Via"))){
							const split = line.substring(1).split(" ")
							const newval = split[1] + " " + split[2]
							message.OptionalAttributes.push({ attribute: split[0], value: newval });
							break;
						}
						message.OptionalAttributes.push({ attribute, value });
				}
			}
		}else if (line.startsWith('SEEN-BY')){
			message.SeenBy = line.split(':')[1].trim()

		}else {
			// Regular message text
			bodyLines.push(line);
		}
	}
	
	message.BodyText = bodyLines.join('\r').replace(/\x8D/g, ''); //remove any reverse cr chars
	if (!message.Source){
		//console.log("Creating Source")
		message.Source = defaultZone + ":" + message.SourceNet + "/" + message.SourceNode
	}
	if (!message.Destination){
		//console.log("Creating Dest")
		message.Destination = defaultZone + ":" + message.DestinationNet + "/" + message.DestinationNode
	}
	message.utf8 = message.BodyText
}

async function TossInboundFile(pktfilepath, movepktpath){
	var returnObj = {
		pktsuccesscount: 0,
		pktimportcount: 0,
		pktdupecount: 0,
		pktskipcount: 0,
		pktprocesscount: 0
	}
	const pkt = ReadPkt(pktfilepath)
	if (!pkt){
		return null;
	}

	// Look up who sent us this file (from inbound file log)
	var _senderInfo = {};
	try {
		var inboundFileLog = (await import('../../models/inboundFileLog.js'));
		var pktFilename = path.basename(pktfilepath);
		var sender = await inboundFileLog.lookupSender(pktFilename);
		if (sender) {
			_senderInfo = { address: sender.peer_address, connectionId: sender.peer_connection_id };
		}
	} catch (_) {}

	var targetsuccess = pkt.Messages.length
	//pkt.Messages.forEach(message =>{
	for await (var message of pkt.Messages){			
		if (message.Type === "Netmail"){
			var result = await ftnNetmailAdapter.importFtnNetmail(message)
			if (result.status === true){
				if (result.duplicate){
					returnObj.pktdupecount ++
				}else{
					returnObj.pktimportcount ++
				}
				returnObj.pktsuccesscount ++

				// If a processor generated a response message, queue it for outbound
				if (result.responseMessage) {
					try {
						var respPkt = WritePkts([result.responseMessage])
						if (respPkt && respPkt.pktcount > 0) {
							alogger.writeClog(3, 'Queued processor response netmail to ' + result.responseMessage.Destination, 'tosser', 'cyan', false, false)
						}
					} catch (respErr) {
						alogger.writeClog(3, 'Failed to queue processor response: ' + respErr.message, 'tosser', 'redbright', false, false)
					}
				}
			}else{
				//
			}
		}else if (message.Type === "Echomail"){
			var result = await messages.handleInboundEchoMessage(message)
			if (result.status === true){
				if (result.duplicate){
					returnObj.pktdupecount ++
				}else if (result.imported){
					returnObj.pktimportcount ++

				}
				returnObj.pktsuccesscount ++
			}else{
				// Unknown areatag or toss error — store in bad echomail holding table
				try {
					var badEchomail = (await import('../../models/badEchomail.js'));
					await badEchomail.storeBadMessage(message, _senderInfo);
				} catch (badErr) {
					alogger.writeClog(3, 'Failed to store bad echomail: ' + badErr.message, 'tosser', 'yellow');
				}
				returnObj.pktsuccesscount ++ // Count as handled so packet doesn't retry endlessly
			}
		}else{
			//Add any additional type handlers.
		}
		returnObj.pktprocesscount ++
	}
	//remove pkt file if success
	if (returnObj.pktsuccesscount >= targetsuccess){
		if (_shouldRemove()){
			await fs.promises.rm(pktfilepath)
		}else if (_shouldMove()){
			console.log("Moving Completed Pkt...")
			await fs.promises.rename(pktfilepath, movepktpath)
		}
	}
	return returnObj
}

async function OldTossInbound(inboundDir){
	var inDir = appConfig.get('ftninbound', 'ftn/in')
	if (inboundDir){
		inDir = inboundDir
	}
	if (!fs.existsSync(inDir)) {
		console.log("Inbound directory does not exist: " + inDir);
		return;
	}
	var importcount = 0
	var dupecount = 0
	var skipcount = 0
	var processcount = 0
	var pktcount = 0
	const filelist = fs.readdirSync(inDir);
	
	//filelist.forEach(file => {	
	for await (var file of filelist){
		pktcount ++
		var pktfilepath = inDir + "/" + file
		var movepktpath = appConfig.get('ftntossed', 'ftn/tossed') + "/" + file
		const pkt = ReadPkt(pktfilepath)
		if (!pkt){
			break;
		}

		// Look up who sent us this file
		var _senderInfo2 = {};
		try {
			var inboundFileLog2 = (await import('../../models/inboundFileLog.js'));
			var sender2 = await inboundFileLog2.lookupSender(file);
			if (sender2) {
				_senderInfo2 = { address: sender2.peer_address, connectionId: sender2.peer_connection_id };
			}
		} catch (_) {}

		var targetsuccess = pkt.Messages.length
		var pktsuccesscount = 0
		var pktdupecount = 0
		var pktskipcount = 0
		var pktimportcount = 0
		var pktprocesscount = 0
		//pkt.Messages.forEach(message =>{
		for await (var message of pkt.Messages){			
			if (message.Type === "Netmail"){
				var result = await ftnNetmailAdapter.importFtnNetmail(message)
				if (result.status === true){
					if (result.duplicate){
						pktdupecount ++
					}else{
						pktimportcount ++
					}
					pktsuccesscount ++

					// Queue processor response if generated
					if (result.responseMessage) {
						try {
							var respPkt = WritePkts([result.responseMessage])
							if (respPkt && respPkt.pktcount > 0) {
								alogger.writeClog(3, 'Queued processor response netmail to ' + result.responseMessage.Destination, 'tosser', 'cyan', false, false)
							}
						} catch (respErr) {
							alogger.writeClog(3, 'Failed to queue processor response: ' + respErr.message, 'tosser', 'redbright', false, false)
						}
					}
				}else{
					//
				}
			}else if (message.Type === "Echomail"){
				var result = await messages.handleInboundEchoMessage(message)
				if (result.status === true){
					if (result.duplicate){
						pktdupecount ++
					}else if (result.imported){
						pktimportcount ++
	
					}
					pktsuccesscount ++
				}else{
					// Unknown areatag or toss error — store in bad echomail holding table
					try {
						var badEchomail = (await import('../../models/badEchomail.js'));
						await badEchomail.storeBadMessage(message, _senderInfo2);
					} catch (badErr) {
						alogger.writeClog(3, 'Failed to store bad echomail: ' + badErr.message, 'tosser', 'yellow');
					}
					pktsuccesscount ++ // Count as handled so packet doesn't retry endlessly
				}
			}else{
				//Add any additional type handlers.
			}
			pktprocesscount ++
		}
		//remove pkt file if success
		if (pktsuccesscount >= targetsuccess){
			if (_shouldRemove()){
				await fs.promises.rm(pktfilepath)
			}else if (_shouldMove()){
				console.log("Moving Completed Pkts...")
				await fs.promises.rename(pktfilepath, movepktpath)
			}
		}
		importcount += pktimportcount
		dupecount += pktdupecount
		skipcount += pktskipcount
		processcount += pktprocesscount
	}
	//todo: write stats to db or similar
	console.log("\r\n------------------\r\nCompleted. Stats:")
	console.log("Packets:", pktcount)
	console.log("Imported:", importcount)
	console.log("Duplicate:", dupecount)
	console.log("Skipped:", skipcount)
	console.log("\r\nTotal Processed:", processcount)
	// Thread updates are handled by postTossMaint() after the toss job completes
}

function WritePktToNode(messageArray, conn, systemaddress){
	var returnObj = {
		processedcount: 0,
		processednetmail: [],
		processedechomail: [],
		processedother: [],
		failedmsgs: []
	}
	// connection_data holds FTN transport fields
	var cd = conn.connection_data || {}
	//determine destination address.
	var destinationAddress
	if (!cd.direct){
		if (!cd.route_to){
			console.log("Cannot determine address for Packet!")
			return false
		}
		destinationAddress = cd.route_to
	}else{
		destinationAddress = cd.address
	}
	if (!destinationAddress){
		console.log("Panic! No packet to address")
		return false
	}else{
		console.log("Using destination address", destinationAddress)
		console.log("Using System Address", systemaddress)
	}
	
	const packet = new Packet()
	packet.SourceZone = systemaddress.zone
	packet.DestinationZone = destinationAddress.split(":")[0]
	packet.SourceNet = systemaddress.net
	packet.SourceNode = systemaddress.node
	packet.DestinationNet = destinationAddress.split(":")[1].split("/")[0]
	packet.DestinationNode = destinationAddress.split(":")[1].split("/")[1]
	packet.Source = systemaddress.address
	packet.Destination = destinationAddress

	// Set current time
	const now = new Date();
	packet.Year = now.getFullYear();
	packet.Month = now.getMonth();
	packet.Day = now.getDate();
	packet.Hour = now.getHours();
	packet.Minute = now.getMinutes();
	packet.Second = now.getSeconds();
	packet.DateTime = now;
	packet.Baud = 0;
	packet.PacketType = 2;
	packet.ProdCode = 0xFE;
	packet.Serial = 0x01;
	packet.Password = '';
	if (cd.packet_password){
		packet.Password = cd.packet_password
	}
	//packet.Messages = messageArray;
	packet.MessageCount = messageArray.length;

	// Build buffer — calculate required size (header + all messages + terminator)
	var bufferSize = 58 + 2; // 58-byte packet header + 2-byte terminator
	for (var bsMsg of messageArray) {
		// 14-byte msg header + 20-byte datetime + null-terminated strings + body estimate
		bufferSize += 14 + 20;
		bufferSize += Buffer.byteLength((bsMsg.ToUser || '') + '\0');
		bufferSize += Buffer.byteLength((bsMsg.FromUser || '') + '\0');
		bufferSize += Buffer.byteLength((bsMsg.Subject || '') + '\0');
		bufferSize += Buffer.byteLength((bsMsg.BodyText || '') + '\0') + 4096; // kludges, SEEN-BY, PATH overhead
	}
	const buffer = Buffer.alloc(bufferSize);
	let offset = 0;

	// Write packet header
	buffer.writeUInt16LE(packet.SourceNode, offset); offset += 2;
	buffer.writeUInt16LE(packet.DestinationNode, offset); offset += 2;
	buffer.writeUInt16LE(packet.Year, offset); offset += 2;
	buffer.writeUInt16LE(packet.Month, offset); offset += 2;
	buffer.writeUInt16LE(packet.Day, offset); offset += 2;
	buffer.writeUInt16LE(packet.Hour, offset); offset += 2;
	buffer.writeUInt16LE(packet.Minute, offset); offset += 2;
	buffer.writeUInt16LE(packet.Second, offset); offset += 2;
	buffer.writeUInt16LE(packet.Baud, offset); offset += 2;
	buffer.writeUInt16LE(packet.PacketType, offset); offset += 2;
	buffer.writeUInt16LE(packet.SourceNet, offset); offset += 2;
	buffer.writeUInt16LE(packet.DestinationNet, offset); offset += 2;
	buffer.writeUInt8(packet.ProdCode, offset); offset += 1;
	buffer.writeUInt8(packet.Serial, offset); offset += 1;

	// Password (8 bytes, null-padded)
	const pwdBuf = Buffer.from(packet.Password.padEnd(8, '\0'));
	pwdBuf.copy(buffer, offset); offset += 8;

	// Zones
	buffer.writeUInt16LE(packet.SourceZone, offset); offset += 2;
	buffer.writeUInt16LE(packet.DestinationZone, offset); offset += 2;

	// Fill bytes (20 zeros)
	for (let i = 0; i < 20; i++) {
	    buffer.writeUInt8(0, offset++);
	}

	// Write messages
	for (const msg of messageArray) {
		// Parse and populate required attributes if empty.
		var setattribs = {
			msgid: false,
			reply: false,
			tid: false,
			tz: false,
		}

		for (const attrib of msg.OptionalAttributes){
			switch (attrib.attribute){
				case "MSGID":
					setattribs.msgid = true
					if ((msg.MsgId) && (attrib.value != msg.MsgId)){
						attrib.value = msg.MsgId
					}
					break;
				case "REPLY":
					setattribs.reply = true
					if ((msg.ReplyTo) && (attrib.value != msg.ReplyTo)){
						attrib.value = msg.ReplyTo
					}
					break;
				case "TID":
					setattribs.tid = true
					attrib.value = TosserName
					break;
				case "TZUTC":
					setattribs.tz = true
					attrib.value = SystemTZUTC
					break;
				case "CHRS":
					setattribs.chrs = true
					break;
				default:
					//
			}
		}
		if (!setattribs.msgid){
			const newattrib = {
				attribute: "MSGID",
				value: msg.MsgId
			}
			msg.OptionalAttributes.push(newattrib)
		}
		if (!setattribs.reply && msg.ReplyTo){
			msg.OptionalAttributes.push({
				attribute: "REPLY",
				value: msg.ReplyTo
			})
		}
		if (!setattribs.tid){
			const newattrib = {
				attribute: "TID",
				value: TosserName
			}
			msg.OptionalAttributes.push(newattrib)
		}
		if (!setattribs.tz){
			const newattrib = {
				attribute: "TZUTC",
				value: SystemTZUTC
			}
			msg.OptionalAttributes.push(newattrib)
		}

		// Message type 0002
		buffer.writeUInt16LE(0x0002, offset); offset += 2;

		// Message header
		buffer.writeUInt16LE(msg.SourceNode, offset); offset += 2;
		buffer.writeUInt16LE(msg.DestinationNode, offset); offset += 2;
		buffer.writeUInt16LE(msg.SourceNet, offset); offset += 2;
		buffer.writeUInt16LE(msg.DestinationNet, offset); offset += 2;
		buffer.writeUInt16LE(msg.Attribute, offset); offset += 2;
		buffer.writeUInt16LE(msg.Cost, offset); offset += 2;

		// DateTime (20 bytes)
		const dtStr = (msg.DateTime || '').padEnd(20, '\0');
		Buffer.from(dtStr).copy(buffer, offset); offset += 20;

		// Null-terminated strings
		const writeNullStr = (str) => {
			const b = Buffer.from(str + '\0');
			b.copy(buffer, offset);
			offset += b.length;
		};

		writeNullStr(msg.ToUser || '');
		writeNullStr(msg.FromUser || '');
		writeNullStr(msg.Subject || '');

		// Reconstruct RawText
		let rawText = '';
		if (msg.Type === 'Echomail' && msg.AreaTag) {
			rawText += `AREA:${msg.AreaTag}\r`;
		}
		for (const attr of msg.OptionalAttributes || []) {
			rawText += `\x01${attr.attribute}:${attr.value}\r`;
		}
		// Body text (join with \r)
		const bodyLines = (msg.BodyText || '').split('\r\n');
		rawText += bodyLines.join('\r');
		// Tear line, optional tagline, origin line (FTS-0004 format)
		rawText += "\r"
		if (msg.SignatureString) {
			// Tagline present: bare tear line, then tagline on its own line
			rawText += "\r---"
			rawText += "\r" + msg.SignatureString
			if (msg.ProductLine) rawText += "\r--- " + msg.ProductLine
		} else if (msg.ProductLine) {
			// No tagline: tear line with product identifier
			rawText += "\r--- " + msg.ProductLine
		} else {
			rawText += "\r---"
		}
		if (msg.Type === "Echomail"){
			if (msg.OriginLine){
				rawText += "\r * Origin: " + msg.OriginLine
			}
			if (msg.SeenBy) {
				rawText += `\rSEEN-BY: ${msg.SeenBy}`;
			}
			if (msg.Path) {
				rawText += `\r\x01PATH: ${msg.Path}`;
			}
		}
		rawText += "\r"


		writeNullStr(rawText);
		console.log("Pushing processed", msg.Id)
		if (msg.Type === "Echomail"){
			returnObj.processedechomail.push(msg.Id)
		}else if (msg.Type === "Netmail"){
			returnObj.processednetmail.push(msg.Id)
		}else{
			returnObj.processedother.push(msg.Id)
		}
		returnObj.processedcount += 1
		
	}

	// End of packet
	buffer.writeUInt16LE(0x0000, offset); offset += 2;

	// Trim buffer
	const finalBuffer = buffer.subarray(0, offset);

	// Filename — zone-aware outbound directory
	var outDir = getOutboundDirForZone(packet.DestinationZone);
	const pktFile = generatePktFilename(outDir)
	const netHex = parseInt(packet.DestinationNet).toString(16).padStart(4, '0');
	const nodeHex = parseInt(packet.DestinationNode).toString(16).padStart(4, '0');
	const filename = pktFile.filepath;
	// Write file
	try {
		fs.writeFileSync(filename, finalBuffer);
		//increment pkt count
		//count++;
		const desthex = netHex + nodeHex
		UpcertMailerFile(filename, desthex, "Normal", packet.DestinationZone)
	} catch (error) {
		alogger.writeClog(3, 'WritePkts: failed to write ' + filename + ': ' + error.message, 'tosser', 'redbright');
		return false;
	}
	return returnObj
}

async function WritePktsToNode(messageArray, conn, systemaddress){
	var returnObj = {
		processedcount: 0,
		processednetmail: [],
		processedechomail: [],
		failedmsgs: [],
		pktcount: 0
	}
	if (!messageArray || !Array.isArray(messageArray)) {
		throw new Error(`Invalid message data!`);
		return false;
	}
	if (messageArray.length === 0){
		return 0
	}
	//TODO: determine zone vs defaultzone and define directory to check before checking
    try {
		// Ensure export directory exists
		if (!fs.existsSync('export')) {
			fs.mkdirSync('export', { recursive: true });
		}
	}catch(error){
		throw new Error(`Failure ensuring export directory present: ${error.message}`);
		return false
	}
	//need loop to do pkts undil msgarray is empty
	while (messageArray.length > 0){
		//strip messages from array to new array until max count, then pass to write function
		var pktmsgarray = messageArray.splice(0, maxMsg);
		var pktres = await WritePktToNode(pktmsgarray, conn, systemaddress)
		if ((pktres)&&(pktres.processedcount)){
			console.log(pktres)
			//increment pkt count and concat processed lists.
			returnObj.pktcount ++
			returnObj.processedcount += pktres.processedcount
			returnObj.processednetmail = returnObj.processednetmail.concat(pktres.processednetmail)
			returnObj.processedechomail = returnObj.processedechomail.concat(pktres.processedechomail)			
		}else{
			if (pktres){
				console.log("Semi noticed")
				console.log(pktres)
				returnObj.processedcount = 100
			}else{
				console.log("Sub process no result")
			}
			
		}
	}
		
	return returnObj
}

function WritePkts(messageArray){
	var returnObj = {
		processedmsgs: [],
		failedmsgs: [],
		pktcount: 0
	}
	if (!messageArray || !Array.isArray(messageArray)) {
		throw new Error(`Invalid message data!`);
		return false;
	}
	if (messageArray.length === 0){
		return 0
	}
    try {
		// Ensure export directory exists
		if (!fs.existsSync('export')) {
			fs.mkdirSync('export', { recursive: true });
		}
	}catch(error){
		throw new Error(`Failure ensuring export directory present: ${error.message}`);
		return false
	}
	//create groups by source and destination to group messages into separate packets
	const packetGroups = new Map();

	for (const message of messageArray){
		var sourceZone = message.SourceZone || 1
		var destinationZone = message.DestinationZone || 1
		var SourceKey = `${sourceZone}:${message.SourceNet}/${message.SourceNode}`
		var DestKey = `${destinationZone}:${message.DestinationNet}/${message.DestinationNode}`
		for (const attrib of message.OptionalAttributes){
			if (attrib.attribute == "INTL"){
				var addresses = attrib.value.split(" ")
				DestKey = addresses[0]
				SourceKey = addresses[1]
			}
		}
		message.Source = SourceKey
		message.Destination = DestKey
		if (!packetGroups.has(SourceKey)){
			packetGroups.set(SourceKey, {})			
		}
		if (!packetGroups.get(SourceKey)[DestKey]){
			packetGroups.get(SourceKey)[DestKey] = []
		}
		packetGroups.get(SourceKey)[DestKey].push(message)
	}

	let count = 0;
	for (const sourceAddress of packetGroups.keys()){
		const source = packetGroups.get(sourceAddress)
		for (const destinationAddress of Object.keys(source)){
			const destination = source[destinationAddress]
			
			//destination is array of messages for destination from source. We can now create a packet.
			const packet = new Packet()
			packet.SourceZone = sourceAddress.split(":")[0]
			packet.DestinationZone = destinationAddress.split(":")[0]
			packet.SourceNet = sourceAddress.split(":")[1].split("/")[0]
			packet.SourceNode = sourceAddress.split(":")[1].split("/")[1]
			packet.DestinationNet = destinationAddress.split(":")[1].split("/")[0]
			packet.DestinationNode = destinationAddress.split(":")[1].split("/")[1]
			packet.Source = sourceAddress
			packet.Destination = destinationAddress

			// Set current time
			const now = new Date();
			packet.Year = now.getFullYear();
			packet.Month = now.getMonth();
			packet.Day = now.getDate();
			packet.Hour = now.getHours();
			packet.Minute = now.getMinutes();
			packet.Second = now.getSeconds();
			packet.DateTime = now;
			packet.Baud = 0;
			packet.PacketType = 2;
			packet.ProdCode = 0xFE;
			packet.Serial = 0x01;
			packet.Password = '';
			var pktpwd = appConfig.get('PacketPwd', '');
			if (pktpwd){
				packet.Password = pktpwd
			}
			packet.Messages = destination;
			packet.MessageCount = destination.length;

			// Build buffer — calculate required size (header + all messages + terminator)
			var bufferSize = 58 + 2; // 58-byte packet header + 2-byte terminator
			for (var bsMsg of destination) {
				bufferSize += 14 + 20;
				bufferSize += Buffer.byteLength((bsMsg.ToUser || '') + '\0');
				bufferSize += Buffer.byteLength((bsMsg.FromUser || '') + '\0');
				bufferSize += Buffer.byteLength((bsMsg.Subject || '') + '\0');
				bufferSize += Buffer.byteLength((bsMsg.BodyText || '') + '\0') + 4096;
			}
			const buffer = Buffer.alloc(bufferSize);
			let offset = 0;

			// Write packet header
			buffer.writeUInt16LE(packet.SourceNode, offset); offset += 2;
			buffer.writeUInt16LE(packet.DestinationNode, offset); offset += 2;
			buffer.writeUInt16LE(packet.Year, offset); offset += 2;
			buffer.writeUInt16LE(packet.Month, offset); offset += 2;
			buffer.writeUInt16LE(packet.Day, offset); offset += 2;
			buffer.writeUInt16LE(packet.Hour, offset); offset += 2;
			buffer.writeUInt16LE(packet.Minute, offset); offset += 2;
			buffer.writeUInt16LE(packet.Second, offset); offset += 2;
			buffer.writeUInt16LE(packet.Baud, offset); offset += 2;
			buffer.writeUInt16LE(packet.PacketType, offset); offset += 2;
			buffer.writeUInt16LE(packet.SourceNet, offset); offset += 2;
			buffer.writeUInt16LE(packet.DestinationNet, offset); offset += 2;
			buffer.writeUInt8(packet.ProdCode, offset); offset += 1;
			buffer.writeUInt8(packet.Serial, offset); offset += 1;

			// Password (8 bytes, null-padded)
			const pwdBuf = Buffer.from(packet.Password.padEnd(8, '\0'));
			pwdBuf.copy(buffer, offset); offset += 8;

			// Zones
			buffer.writeUInt16LE(packet.SourceZone, offset); offset += 2;
			buffer.writeUInt16LE(packet.DestinationZone, offset); offset += 2;

			// Fill bytes (20 zeros)
			for (let i = 0; i < 20; i++) {
			    buffer.writeUInt8(0, offset++);
			}

			// Write messages
			for (const msg of packet.Messages) {
				// Parse and populate required attributes if empty.
				var setattribs = {
					msgid: false,
					reply: false,
					tid: false,
					tz: false,
				}

				for (const attrib of msg.OptionalAttributes){
					switch (attrib.attribute){
						case "MSGID":
							setattribs.msgid = true
							if ((msg.MsgId) && (attrib.value != msg.MsgId)){
								attrib.value = msg.MsgId
							}
							break;
						case "REPLY":
							setattribs.reply = true
							if ((msg.ReplyTo) && (attrib.value != msg.ReplyTo)){
								attrib.value = msg.ReplyTo
							}
							break;
						case "TID":
							setattribs.tid = true
							attrib.value = TosserName
							break;
						case "TZUTC":
							setattribs.tz = true
							attrib.value = SystemTZUTC
							break;
						default:
							//
					}
				}
				if (!setattribs.msgid){
					const newattrib = {
						attribute: "MSGID",
						value: msg.MsgId
					}
					msg.OptionalAttributes.push(newattrib)
				}
				if (!setattribs.reply && msg.ReplyTo){
					msg.OptionalAttributes.push({
						attribute: "REPLY",
						value: msg.ReplyTo
					})
				}
				if (!setattribs.tid){
					const newattrib = {
						attribute: "TID",
						value: TosserName
					}
					msg.OptionalAttributes.push(newattrib)
				}
				if (!setattribs.tz){
					const newattrib = {
						attribute: "TZUTC",
						value: SystemTZUTC
					}
					msg.OptionalAttributes.push(newattrib)
				}

				// Message type 0002
				buffer.writeUInt16LE(0x0002, offset); offset += 2;

				// Message header
				buffer.writeUInt16LE(msg.SourceNode, offset); offset += 2;
				buffer.writeUInt16LE(msg.DestinationNode, offset); offset += 2;
				buffer.writeUInt16LE(msg.SourceNet, offset); offset += 2;
				buffer.writeUInt16LE(msg.DestinationNet, offset); offset += 2;
				buffer.writeUInt16LE(msg.Attribute, offset); offset += 2;
				buffer.writeUInt16LE(msg.Cost, offset); offset += 2;

				// DateTime (20 bytes)
				const dtStr = (msg.DateTime || '').padEnd(20, '\0');
				Buffer.from(dtStr).copy(buffer, offset); offset += 20;

				// Null-terminated strings
				const writeNullStr = (str) => {
					const b = Buffer.from(str + '\0');
					b.copy(buffer, offset);
					offset += b.length;
				};

				writeNullStr(msg.ToUser || '');
				writeNullStr(msg.FromUser || '');
				writeNullStr(msg.Subject || '');

				// Reconstruct RawText
				let rawText = '';
				if (msg.Type === 'Echomail' && msg.AreaTag) {
					rawText += `AREA:${msg.AreaTag}\r`;
				}
				for (const attr of msg.OptionalAttributes || []) {
					rawText += `\x01${attr.attribute}:${attr.value}\r`;
				}
				if (msg.SeenBy) {
					rawText += `\x01SEEN-BY: ${msg.SeenBy}\r`;
				}
				// Body text (join with \r)
				const bodyLines = (msg.BodyText || '').split('\r\n');
				rawText += bodyLines.join('\r');
				var originsplit = "\r\r---"
				if (msg.SignatureString){
					originsplit += "\r" + msg.SignatureString + "\r"
				}
				if (msg.ProductLine){
					originsplit += " " + msg.ProductLine
				}
				rawText += originsplit
				//only apply origin line to echomail?
				if (msg.Type === "Echomail"){
					if (msg.OriginLine){
						rawText += "\r * Origin: " + msg.OriginLine
					}
					if (msg.SeenBy) {
						rawText += `\rSEEN-BY: ${msg.SeenBy}`;
					}
					if (msg.Path) {
						rawText += `\r\x01PATH: ${msg.Path}`;
					}
				}
				rawText += "\r"

				writeNullStr(rawText);
				console.log("Pushing processed", msg.Id)
				returnObj.processedmsgs.push(msg.Id)
			}

			// End of packet
			buffer.writeUInt16LE(0x0000, offset); offset += 2;

			// Trim buffer
			const finalBuffer = buffer.subarray(0, offset);

			// Filename — zone-aware outbound directory
			var outDir = getOutboundDirForZone(packet.DestinationZone);
			const pktFile = generatePktFilename(outDir)
			const netHex = parseInt(packet.DestinationNet).toString(16).padStart(4, '0');
			const nodeHex = parseInt(packet.DestinationNode).toString(16).padStart(4, '0');
			const filename = pktFile.filepath;
			// Write file
			try {
				fs.writeFileSync(filename, finalBuffer);
				//increment pkt count
				count++;
				const desthex = netHex + nodeHex
				UpcertMailerFile(filename, desthex, "Normal", packet.DestinationZone)
			} catch (error) {
				console.error(`Failed to write ${filename}: ${error.message}`);
				return false;
			}
		}
		
	}
	returnObj.pktcount = count
	return returnObj
}

async function UpcertMailerFile(filename, desthex, flavour, zone){
	var extension = ".flo";
	if (flavour) {
		switch (flavour) {
			case "Normal":    extension = ".flo"; break;
			case "Direct":    extension = ".dlo"; break;
			case "Crash":     extension = ".clo"; break;
			case "Immediate": extension = ".ilo"; break;
			case "Hold":      extension = ".hlo"; break;
			default:          extension = ".flo";
		}
	}
	var outDir = getOutboundDirForZone(zone);
	if (!fs.existsSync(outDir)) {
		fs.mkdirSync(outDir, { recursive: true });
	}
	var fline = "^" + filename + "\r\n";
	var mfile = outDir + "/" + desthex + extension;
	try {
		fs.appendFileSync(mfile, fline);
	} catch (error) {
		alogger.writeClog(3, 'UpcertMailerFile: failed to write ' + mfile + ': ' + error.message, 'tosser', 'redbright');
	}
}

async function TossOutboundNetmail(){
	console.log("\r\n-------------------\r\nOutbound Netmail\r\n-------------------")
	var dblist = await privateMessages.getPendingByTransport('FTN')
	if (!dblist || dblist.length === 0){
		console.log("No pending FTN netmail")
		return
	}

	var sendArray = []
	for await (var pmRow of dblist){
		// Convert pm_outbox row to FTN Message object
		var msg = ftnNetmailAdapter.privateMessageToFtn(pmRow)
		console.log("Message from", msg.FromUser, "To", msg.ToUser, "Dest:", msg.Destination)

		// Parse destination zone from the address string
		var destZone = msg.DestinationZone
		if ((!destZone || destZone === 0) && msg.Destination) {
			var zPart = msg.Destination.split(":")[0]
			destZone = parseInt(zPart) || 0
		}

		if (!destZone) {
			console.log("ERROR: No destination zone for message id", pmRow.id, "- marking undeliverable")
			await privateMessages.markOutboxUndeliverable(pmRow.id, "No destination zone could be determined from address: " + (msg.Destination || '(empty)'))
			continue
		}

		// Resolve source address based on which network owns the destination zone
		var sourceResult = await systemAddresses.resolveSourceForDestinationZone(destZone)
		if (!sourceResult.address) {
			console.log("ERROR: Cannot resolve source for zone", destZone, ":", sourceResult.reason, "- marking undeliverable")
			await privateMessages.markOutboxUndeliverable(pmRow.id, "Cannot route to zone " + destZone + ": " + sourceResult.reason)
			continue
		}

		var srcAddr = sourceResult.address

		// Stamp source address
		msg.SourceZone = srcAddr.address_zone || 1
		msg.SourceNet  = srcAddr.address_net  || 0
		msg.SourceNode = srcAddr.address_node || 0
		msg.Source     = srcAddr.address

		// Ensure destination numeric fields are populated
		if (!msg.DestinationNet && msg.Destination) {
			var parsed = msg.Destination.split(":")
			var netsplit = parsed[1] ? parsed[1].split("/") : []
			msg.DestinationZone = parseInt(parsed[0]) || 1
			msg.DestinationNet  = parseInt(netsplit[0]) || 0
			msg.DestinationNode = parseInt(netsplit[1]) || 0
		}

		if (!msg.DestinationNet) {
			console.log("ERROR: Invalid destination address for message id", pmRow.id, "- marking undeliverable")
			await privateMessages.markOutboxUndeliverable(pmRow.id, "Invalid destination address: " + (msg.Destination || '(empty)'))
			continue
		}

		// Setup INTL attribute
		var intlval = msg.Destination + " " + msg.Source
		var hasintl = false
		for await (var oa of msg.OptionalAttributes){
			if (oa.attribute == "INTL"){
				hasintl = true
			}
		}
		if (!hasintl){
			msg.OptionalAttributes.push({attribute: "INTL", value: intlval})
		}
		sendArray.push(msg)

		// Track attachment info for flow file writing after packet creation
		if (pmRow.has_attachments && pmRow.uuid) {
			if (!msg._attachmentInfo) msg._attachmentInfo = {};
			msg._attachmentInfo.pmUuid = pmRow.uuid;
			msg._attachmentInfo.destZone = msg.DestinationZone;
			msg._attachmentInfo.destNet = msg.DestinationNet;
			msg._attachmentInfo.destNode = msg.DestinationNode;
		}
	}

	if (sendArray.length === 0){
		console.log("No routable netmail to send")
		return
	}

	var pktresult = await WritePkts(sendArray)
	if ((pktresult)&&(pktresult.processedmsgs)){
		console.log("Wrote", pktresult.pktcount, "Packets")
		await privateMessages.markSentArray(pktresult.processedmsgs, TosserName)

		// Write flow file entries for file-attach netmail attachments
		try {
			var pmAtt = await import('../models/pmAttachments.js');
			for (var smsg of sendArray) {
				if (!smsg._attachmentInfo) continue;
				var atts = await pmAtt.getAttachments(smsg._attachmentInfo.pmUuid);
				if (atts.length === 0) continue;

				var netHex = parseInt(smsg._attachmentInfo.destNet).toString(16).padStart(4, '0');
				var nodeHex = parseInt(smsg._attachmentInfo.destNode).toString(16).padStart(4, '0');
				var destHex = netHex + nodeHex;

				for (var att of atts) {
					if (fs.existsSync(att.storage_path)) {
						// Use bare path (no prefix) = send and leave.
						// Preserves the local copy for web/IMAP access.
						var attOutDir = getOutboundDirForZone(smsg._attachmentInfo.destZone);
						if (!fs.existsSync(attOutDir)) fs.mkdirSync(attOutDir, { recursive: true });
						var floFile = attOutDir + "/" + destHex + ".flo";
						var floLine = att.storage_path + "\r\n";
						try {
							fs.appendFileSync(floFile, floLine);
							alogger.writeClog(5, 'FTN file-attach: queued ' + att.filename + ' for ' + smsg.Destination, 'tosser', 'cyan');
						} catch (floErr) {
							alogger.writeClog(3, 'FTN file-attach: flow file write error: ' + floErr.message, 'tosser', 'redbright');
						}
					}
				}
			}
		} catch (attErr) {
			console.log("FTN file-attach flow file error:", attErr.message);
		}

		// Signal the mailer to scan the BSO outbound directory.
		// The scanner handles route resolution (peer and nodelist) for all
		// discovered addresses, replacing the previous inline routing logic.
		try {
			var jobsMod = (await import('../../queues/jobs.js'));
			await jobsMod.enqueueMailerBsoScan();
		} catch (scanErr) {
			console.log("BSO scan signal error:", scanErr.message);
		}
	}else{
		console.log("No outbound msgs processed")
	}
}

async function TossOutboundEchomail(){
	console.log("\r\n-------------------\r\nOutbound Echomail\r\n-------------------")
	var connlist = await peerConnections.getActiveConnectionsByNetworkType('FTN')
	if ((!connlist)||(connlist.length < 1)){
		console.log("No active FTN connections!")
		return
	}
	for await (var conn of connlist){
		await echomail.getOutboundForConnection(conn)
	}
	console.log("Completed Echomail check\r\n\r\n")
	return
}

async function TossOutbound(){
	console.log("\r\n-------------------\r\nTossing Oubound\r\n-------------------")
	ensureDirectories();
	await TossOutboundNetmail()
	await TossOutboundEchomail()

	// Signal the mailer to scan the BSO outbound directory for any
	// echomail or netmail packets that were created above.
	try {
		var jobsMod = (await import('../../queues/jobs.js'));
		await jobsMod.enqueueMailerBsoScan();
	} catch (scanErr) {
		console.log("BSO scan signal error:", scanErr.message);
	}
}

export {
	TossInbound,
	TossOutbound,
	ReadPkt,
	WritePkts,
	WritePktsToNode,
	FindAndExtractArchives,
	TossInboundFile,
	processMessageText,
	isMailBundleFilename
}