//imports
import * as fs from 'fs';
import * as  fileType from 'file-type';
import { exec } from 'child_process';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as  util  from 'util';
import AdmZip from 'adm-zip';

const pexec = util.promisify(exec);

//internals
import {Message, Packet} from '../../models/ftnClasses.js'
import * as ftnNetmailAdapter from '../../models/ftnNetmailAdapter.js'
import * as ftnVia from '../../utils/ftnVia.js'
import * as privateMessages from '../../models/privateMessages.js'
import * as systemAddresses from '../../models/systemAddresses.js'
import * as echomail from '../../models/echomail.js'
import * as messages from '../../models/messages.js'
import * as ftnUtils from "../../utils/ftnUtils.js"
import * as charsetPolicy from "../../utils/charsetPolicy.js"
import * as peerConnections from '../../models/peerConnections.js'
import * as codepageConversions from "../../utils/codepageConversions.js"
import appConfig from "../../config/appConfig.js"
import * as alogger from "../../utils/alogger.js"


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
    // Anything that is not a regular file is simply not ours. Sysops keep
    // subdirectories in the inbound (ftn/in/Old is the usual one) and reading
    // a directory throws EISDIR, which the old code logged as an error on
    // every pass. At the inbound scan interval that is a stack trace every few
    // seconds for ever, and it buried the lines that mattered. Symlinks are
    // followed, since stat resolves them, so a linked-in packet still works.
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) return null;

    // Sniff from the file rather than pulling it into memory. Magic numbers
    // live in the first few bytes, but an arcmail bundle or a TIC attachment
    // can be hundreds of megabytes, and the old readFile loaded every one of
    // them in full on every scan of the directory.
    const type = await fileType.fileTypeFromFile(filePath);
    return type ? type.ext : null;
  } catch (error) {
    // ENOENT is a benign race: another processor (ticTosser, wildcard router,
    // parallel FTN toss job) moved the file out of inbound between our
    // readdirSync and our stat. Signal "gone" to the caller quietly.
    if (error && error.code === 'ENOENT') {
      return 'GONE';
    }
    // Anything else is worth seeing, but through the log bus like the rest of
    // the tosser, not console.error, so it lands in the admin log viewer and
    // obeys the configured level.
    alogger.writeClog(2, '[FTN] cannot identify ' + filePath + ': ' + error.message, 'tosser', 'yellow');
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

/**
 * Would an inbound toss do anything with this filename?
 *
 * This is the predicate the periodic inbound scan needs, and it has to be the
 * same one TossInbound uses or the backstop does not back anything up. The
 * scan used to test for a literal .pkt and nothing else, so an arcmail bundle
 * (.mo0, .tu5, .su9) sitting in the inbound never triggered a toss. In normal
 * operation that was hidden, because the mailer enqueues a toss itself the
 * moment a file arrives. It only showed when that enqueue did not happen: a
 * worker that was down, a restart between receipt and enqueue, a bundle
 * dropped in by hand or recovered from a filebox. Exactly the cases the
 * backstop exists for, and exactly the ones it missed.
 *
 * The bundle test is by filename, not by archive format, which is what
 * TossInbound does too: it covers ZIP, ARJ and LHA bundles alike, and leaves
 * TIC attachments, nodelist archives and infopacks to their own processors.
 */
// Strip anything that stops two spellings of the same node comparing equal:
// a 5D "@domain" suffix, and a trailing ".0", which is the node itself and
// which systems write both ways.
function normaliseFtnAddress(addr) {
	return bareFtnAddress(addr).replace(/\.0$/, '').toLowerCase();
}

/**
 * The packet password to stamp on a packet addressed to a given system.
 *
 * Netmail used to take this from the global PacketPwd config key and nothing
 * else, while echomail took it from the peer's own packet_password. So a sysop
 * who set a packet password on a link got authenticated echomail and netmail
 * with an empty password field, and the only symptom was the uplink bouncing
 * AreaFix requests back with "no password" while everything else worked.
 *
 * Keyed on the packet destination rather than the message destination, because
 * the packet envelope is addressed to whoever we hand it to. On transit mail
 * the caller has already set PacketDestination to the routing target, so this
 * picks up that hop's password rather than the final recipient's.
 */
async function buildPacketPasswordIndex() {
	var index = new Map();
	try {
		var conns = await peerConnections.getActiveConnectionsByNetworkType('FTN');
		for (var conn of (conns || [])) {
			var cd = conn.connection_data || {};
			if (!cd.address || !cd.packet_password) continue;
			index.set(normaliseFtnAddress(cd.address), cd.packet_password);
		}
	} catch (err) {
		// A packet with no password beats no packet at all, so fall through to
		// the global key rather than failing the toss.
		alogger.writeClog(2, '[FTN] could not read peer packet passwords: ' + err.message, 'tosser', 'yellow');
	}
	return index;
}

/**
 * The 8 byte password field, per FTS-0001.
 *
 * The old code built a buffer as long as the password and copied all of it
 * while advancing the write offset by 8, so an over-length password spilled
 * past the field. Nothing was ever corrupted by that, because the zone writes
 * and the 20 byte fill that follow overwrite the rest of the header, and only
 * a password over 32 characters could have outrun them. This makes the field
 * self-contained rather than correct by accident, dependent on what happens
 * to be written next.
 */
function packetPasswordBuffer(password) {
	var buf = Buffer.alloc(8);
	Buffer.from(String(password || ''), 'latin1').copy(buf, 0, 0, 8);
	return buf;
}

function isTossableInboundFile(filename) {
	if (!filename) return false;
	if (path.extname(filename).toUpperCase() === '.PKT') return true;
	return isMailBundleFilename(filename);
}

// FTS-0004 kludge line format. Most kludges use "KEYWORD: value" with a
// colon-space separator. A handful of legacy routing/addressing kludges
// (INTL, TOPT, FMPT, Via) use a bare space separator with no colon per
// FTS-0001 / FTS-4001. Returns the full control-A line without trailing CR.
const SPACE_SEPARATED_KLUDGES = new Set(['INTL', 'TOPT', 'FMPT', 'Via', 'VIA']);

// Strip a 5D domain suffix from an FTN address, leaving zone:net/node[.point].
// INTL must carry bare addresses per FTS-0001, but a 5D address
// (zone:net/node@domain) reaches the outbound path whenever a netmail was
// submitted through the SMTP pseudo-TLD in its 5D form, e.g.
// user@21.1.100.fsxnet.ftn parses back to "21:1/100@fsxnet". The domain label
// must not leak into the kludge -- TossOutboundNetmail's INTL value is also
// parsed back out to build the packet grouping keys, so a polluted value would
// split packet groups and overwrite Source/Destination with the 5D string.
function bareFtnAddress(addr) {
	if (!addr) return '';
	var out = String(addr).trim();
	var atIdx = out.indexOf('@');
	if (atIdx >= 0) out = out.substring(0, atIdx);
	return out;
}

function formatKludge(attribute, value) {
	if (attribute && SPACE_SEPARATED_KLUDGES.has(attribute)) {
		return '\x01' + attribute + ' ' + (value == null ? '' : value);
	}
	return '\x01' + attribute + ': ' + (value == null ? '' : value);
}

// Extract an FTN arcmail bundle (zip) into the destination directory.
// Returns { extracted: N, err: null|Error }.
// Using adm-zip in-process (rather than shelling out to unzip) removes the
// shell-injection surface from odd filenames and makes behaviour
// deterministic and testable. All entries in the bundle are written out --
// this function is only ever called once the caller has already decided
// the file is a legitimate arcmail bundle. The bundle file is removed
// after a successful extraction.
function extractMailBundle(filepath, destDir) {
	var result = { extracted: 0, err: null };
	try {
		var zip = new AdmZip(filepath);
		var entries = zip.getEntries();
		for (var entry of entries) {
			if (entry.isDirectory) continue;
			var entryName = path.basename(entry.entryName || '');
			if (!entryName) continue;
			var outPath = path.join(destDir, entryName);
			fs.writeFileSync(outPath, entry.getData());
			result.extracted++;
		}
		if (result.extracted > 0) {
			try { fs.unlinkSync(filepath); } catch (_) {}
		}
	} catch (err) {
		result.err = err;
	}
	return result;
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
		if (ftype === 'GONE') {
			// Another processor handled it between readdir and now — nothing to do.
			continue;
		}
		if (ftype){
			switch(ftype){
				case "zip":
					if (isMailBundleFilename(file)) {
						alogger.writeClog(3, '[FTN] bundle queued: ' + file, 'tosser', 'cyan')
						zipArray.push(filepath)
					} else {
						alogger.writeClog(3, '[FTN] ZIP not a mail bundle, leaving untouched: ' + file, 'tosser', 'yellow')
					}
					break;
				case "arj":
					if (isMailBundleFilename(file)) {
						alogger.writeClog(3, '[FTN] ARJ bundle (handler TBD): ' + file, 'tosser', 'cyan')
					} else {
						alogger.writeClog(3, '[FTN] ARJ not a mail bundle, leaving untouched: ' + file, 'tosser', 'yellow')
					}
					break;
				default:
					pktArray.push(file)
			}
		}
	}
	if (zipArray.length > 0){
		alogger.writeClog(3, '[FTN] FindAndExtractArchives: extracting ' + zipArray.length + ' mail bundle(s)', 'tosser', 'cyan')
		for await (var filepath of zipArray){
			var bundleRes = extractMailBundle(filepath, inDir)
			if (bundleRes.err) {
				alogger.writeClog(3, '[FTN] bundle extract failed for ' + path.basename(filepath) + ': ' + bundleRes.err.message, 'tosser', 'redbright')
			} else {
				alogger.writeClog(3, '[FTN] bundle extracted ' + bundleRes.extracted + ' pkt(s) from ' + path.basename(filepath), 'tosser', 'greenbright')
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
		if (ftype === 'GONE') {
			// Another processor handled it between readdir and now — nothing to do.
			continue;
		}
		if (ftype){
			switch(ftype){
				case "zip":
					// Only extract if the filename matches the FTN BSO arcmail bundle
					// extension pattern (.mo0, .tu5, .su9, etc.). Other ZIPs are
					// TIC attachments, nodelist archives, or infopacks and must be
					// left untouched for their respective processors.
					if (isMailBundleFilename(file)) {
						alogger.writeClog(3, '[FTN] bundle queued: ' + file, 'tosser', 'cyan')
						zipArray.push(filepath)
					} else {
						alogger.writeClog(3, '[FTN] ZIP not a mail bundle, leaving for TIC/other processors: ' + file, 'tosser', 'yellow')
					}
					break;
				case "arj":
					if (isMailBundleFilename(file)) {
						alogger.writeClog(3, '[FTN] ARJ bundle queued: ' + file, 'tosser', 'cyan')
						arjArray.push(filepath)
					} else {
						alogger.writeClog(3, '[FTN] ARJ not a mail bundle, leaving for TIC/other processors: ' + file, 'tosser', 'yellow')
					}
					break;
				default:
					//TODO:
					//do another call to a second switch function based on extension
					//then we can call this both here and under the other else
					//and prep arrays for other files like .tic etc.
					if (path.extname(file).toUpperCase() === ".PKT"){
						var fileobj = {filepath: filepath, movepath: appConfig.get('ftntossed', 'ftn/tossed') + "/" + file}
						pktArray.push(fileobj)
					} else {
						alogger.writeClog(5, '[FTN] non-pkt, non-bundle file left in inbound: ' + file + ' (detected as ' + ftype + ')', 'tosser', 'cyan')
					}
			}
		}else{
			if (path.extname(file).toUpperCase() === ".PKT"){
				var fileobj = {filepath: filepath, movepath: appConfig.get('ftntossed', 'ftn/tossed') + "/" + file}
				pktArray.push(fileobj)
			} else {
				alogger.writeClog(5, '[FTN] unknown file type, left in inbound: ' + file, 'tosser', 'cyan')
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
		alogger.writeClog(3, '[FTN] TossInbound: extracting ' + zipArray.length + ' mail bundle(s)', 'tosser', 'cyan')
		for await (var filepath of zipArray){
			var bundleRes = extractMailBundle(filepath, inDir)
			if (bundleRes.err) {
				alogger.writeClog(3, '[FTN] bundle extract failed for ' + path.basename(filepath) + ': ' + bundleRes.err.message, 'tosser', 'redbright')
			} else {
				alogger.writeClog(3, '[FTN] bundle extracted ' + bundleRes.extracted + ' pkt(s) from ' + path.basename(filepath), 'tosser', 'greenbright')
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
				alogger.writeClog(3, '[FTN] could not process ' + file, 'tosser', 'yellow')
			}
		}else{
			// Every non-pkt entry in the inbound lands here on every pass,
			// subdirectories included. On the log bus at trace level rather
			// than unconditional console output.
			alogger.writeClog(5, '[FTN] not a pkt, leaving in inbound: ' + file, 'tosser', 'cyan')
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
		// ENOENT means the pkt was moved/processed by another job between when
		// the caller scanned the inbound directory and now. Log at info and
		// return null so the caller skips this file without aborting the toss.
		if (error && error.code === 'ENOENT') {
			alogger.writeClog(4, '[FTN] pkt vanished before read (concurrent processor): ' + path.basename(filepath), 'tosser', 'yellow');
			return null;
		}
		throw new Error(`Failed to open pkt file: ${error.message}`);
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

			// Decode by what the message DECLARES, not by assumption. FTN's
			// default is CP437 and almost nothing declares otherwise, but a
			// message that says UTF-8 and is decoded through the CP437 table
			// turns every multi-byte character into mojibake, permanently,
			// because body_html is rendered from it at toss time.
			message.Charset = ftnUtils.charsetFromKludge(TextBuffer);
			if (message.Charset === 'utf8') {
				message.RawText = TextBuffer.toString('utf8');
			} else if (message.Charset === 'latin1') {
				message.RawText = TextBuffer.toString('latin1');
			} else {
				message.RawText = codepageConversions.cp437ToUtf8(TextBuffer);
			}

			// Advance by the BYTE length, not the decoded string length. They
			// are equal for CP437 and latin1, where one byte is one character,
			// and they are not for UTF-8: using the string length there walks
			// the packet short and desynchronises every message after it.
			offset += TextBuffer.length + 1;
			
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
		if (line.startsWith('AREA:')){
			// FTS-0004: AREA:AREATAG (colon, no space). Some legacy tossers
			// emit "AREA: TAG" with a space, so trim to be safe.
			message.Type = "Echomail"
			message.AreaTag = line.substring(5).trim()
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
					// No 'INTL' case: the colon form ("\x01INTL: <dest> <orig>")
					// falls through to the startsWith("INTL") handler in
					// default, which parses both forms correctly because
					// "INTL" and "INTL:" both occupy split[0]. A dedicated
					// case here previously reassigned the attribute/value
					// consts and threw on every colon-form INTL kludge.
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
							// Shared with ftnVia so there is one definition of
							// what a Via line is. The copy that lived here kept
							// two tokens and dropped the rest, losing the
							// timestamp or the software from every line it read
							// depending on whether the writer used the optional
							// '@' before the stamp. A truncated chain still
							// relays and still looks like a path, so nothing
							// complained, and the tested implementation was
							// somewhere else entirely.
							const split = line.substring(1).split(" ")
							message.OptionalAttributes.push({
								attribute: split[0],
								value: ftnVia.viaValueFromKludge(line.substring(1))
							});
							break;
						}
						message.OptionalAttributes.push({ attribute, value });
				}
			}
		}else if (line.startsWith('SEEN-BY')){
			// FTS-0004: SEEN-BY is space-separated (SEEN-BY 1/1 2/2 ...) with
			// no colon. Prior code did line.split(':')[1].trim() which crashed
			// on the common no-colon case and mis-sliced zone:net addresses
			// when a colon happened to be present.
			message.SeenBy = line.substring(7).trim()
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
	// Who handed us this packet, as distinct from who wrote the messages in
	// it. On transit mail those differ, and the relay log needs both to tell
	// an uplink feeding us traffic from a node writing it directly.
	var _pktOrigin = {
		packetSource: pkt.Source || null,
		peerAddress:  _senderInfo.address || null,
		connectionId: _senderInfo.connectionId || null
	}
	//pkt.Messages.forEach(message =>{
	for await (var message of pkt.Messages){			
		if (message.Type === "Netmail"){
			var result = await ftnNetmailAdapter.importFtnNetmail(message, _pktOrigin)
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
						var respPkt = await WritePkts([result.responseMessage])
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
		var _pktOrigin2 = {
			packetSource: pkt.Source || null,
			peerAddress:  _senderInfo2.address || null,
			connectionId: _senderInfo2.connectionId || null
		}
		//pkt.Messages.forEach(message =>{
		for await (var message of pkt.Messages){			
			if (message.Type === "Netmail"){
				var result = await ftnNetmailAdapter.importFtnNetmail(message, _pktOrigin2)
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
	packetPasswordBuffer(packet.Password).copy(buffer, offset); offset += 8;

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

		// Declare the wire encoding. The area's policy decides it; `auto`
		// means CP437 whenever the body fits, which is nearly always. Writing
		// undeclared UTF-8 is what mangled inbound art on every receiver that
		// followed the FTN default, and that default is what the ecosystem
		// runs on: of 113,079 messages held here, 163 carry a CHRS at all.
		const wireCharset = charsetPolicy.charsetForMessage(
			msg.Charset, (msg.BodyText || '') + (msg.Subject || ''), codepageConversions);
		if (!setattribs.chrs) {
			msg.OptionalAttributes.push({
				attribute: "CHRS",
				value: ftnUtils.chrsValueFor(wireCharset)
			})
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

		// Null-terminated strings, in the charset this message declares.
		// Buffer.from() defaults to UTF-8, so every packet this tosser has
		// ever written carried UTF-8 bytes under an implicit CP437 contract.
		const encodeWire = (str) => {
			if (wireCharset === 'utf8') return Buffer.from(str, 'utf8');
			if (wireCharset === 'latin1') return Buffer.from(str, 'latin1');
			return Buffer.from(codepageConversions.utf8ToCp437(str, true));
		};
		const writeNullStr = (str) => {
			const b = Buffer.concat([encodeWire(str), Buffer.from([0])]);
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
			rawText += formatKludge(attr.attribute, attr.value) + '\r';
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

async function WritePkts(messageArray){
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
	// Peer packet passwords, read once for the whole batch rather than per
	// packet, since a netmail run can produce a packet per destination.
	const pwIndex = await buildPacketPasswordIndex();

	//create groups by source and destination to group messages into separate packets
	const packetGroups = new Map();

	for (const message of messageArray){
		var sourceZone = message.SourceZone || 1
		var destinationZone = message.DestinationZone || 1

		// The packet envelope. PacketSource is set by the caller when it
		// differs from the message header, which is the transit case.
		//
		// This used to be read out of the INTL kludge. INTL describes the
		// message's own endpoints, so on relayed mail it named the original
		// author and the packet went out claiming to be from a system that had
		// merely written the message, not sent the packet. For mail we
		// originated INTL and the message header agree, which is why it looked
		// correct for years.
		var SourceKey = message.PacketSource ||
			`${sourceZone}:${message.SourceNet}/${message.SourceNode}`
		var DestKey = message.PacketDestination ||
			`${destinationZone}:${message.DestinationNet}/${message.DestinationNode}`
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
			// The peer's own password first, the global key only as a
			// fallback for links that have none of their own.
			packet.Password = pwIndex.get(normaliseFtnAddress(destinationAddress)) ||
				appConfig.get('PacketPwd', '') || '';
			if (!packet.Password) {
				alogger.writeClog(3, '[FTN] no packet password for ' + destinationAddress +
					', sending unauthenticated', 'tosser', 'yellow');
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
			packetPasswordBuffer(packet.Password).copy(buffer, offset); offset += 8;

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

				// Netmail decides its encoding per message, and declares it.
				const nmWire = charsetPolicy.charsetForMessage(
					'auto', (msg.BodyText || '') + (msg.Subject || ''), codepageConversions);
				if (!setattribs.chrs) {
					msg.OptionalAttributes.push({
						attribute: "CHRS",
						value: ftnUtils.chrsValueFor(nmWire)
					})
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

				// Same wire-encoding rule as the echomail writer. Netmail has
				// no area to carry a policy, so it decides per message: CP437
				// when the body fits it, UTF-8 when it does not.
				const nmEncode = (str) => {
					if (nmWire === 'utf8') return Buffer.from(str, 'utf8');
					if (nmWire === 'latin1') return Buffer.from(str, 'latin1');
					return Buffer.from(codepageConversions.utf8ToCp437(str, true));
				};
				const writeNullStr = (str) => {
					const b = Buffer.concat([nmEncode(str), Buffer.from([0])]);
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
					rawText += formatKludge(attr.attribute, attr.value) + '\r';
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

		// Stamp the message header and the packet envelope separately. They
		// are the same address for mail we wrote, and different for transit
		// mail: the message keeps its author, the packet is from us.
		var stamp = ftnNetmailAdapter.resolveOutboundSource(msg, srcAddr, pmRow.transport_data)
		msg.SourceZone = stamp.message.zone
		msg.SourceNet  = stamp.message.net
		msg.SourceNode = stamp.message.node
		msg.Source     = stamp.message.address
		msg.PacketSource = stamp.packet.zone + ":" + stamp.packet.net + "/" + stamp.packet.node

		if (stamp.relayed) {
			console.log("Relaying netmail from", msg.Source, "to", msg.Destination, "as", msg.PacketSource)
		}

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

		// Setup INTL attribute. Both halves must be bare 4D-style addresses,
		// so drop any 5D "@domain" suffix carried in from a pseudo-TLD address.
		// INTL describes the message's own endpoints, not the packet's, so it
		// is built from the message source even when relaying.
		var intlval = bareFtnAddress(msg.Destination) + " " + bareFtnAddress(msg.Source)
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
	isMailBundleFilename,
	isTossableInboundFile,
	normaliseFtnAddress,
	packetPasswordBuffer,
	getFileType,
	formatKludge,
	bareFtnAddress,
	extractMailBundle
}