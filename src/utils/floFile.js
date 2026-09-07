// floFile.js -- BSO flow file reading and housekeeping.
//
// A flow file (.flo, .clo, .dlo, .hlo, .ilo) lists the files to send to one
// node, one per line, with an optional leading action character:
//
//   ^/path/to/file    send then delete the file
//   #/path/to/file    send then truncate the file
//   ~/path/to/file    already sent, skip
//    /path/to/file    send and leave the file alone
//
// Nothing owned "is there anything left in here", and that turned out to
// matter. The BSO scanner decides a node has mail from the *filename* alone, so
// a flow file with nothing left to do still reads as pending work. It triggers
// a session, the session skips every line, nothing is sent, and nothing deletes
// the flow file, so it happens again on the next scan. With the scan interval
// at its default of 60 seconds that is a connection a minute, for ever, on a
// peer whose poll interval says four hours.
//
// Two ways a flow file ends up with nothing to do:
//
//   1. Every line is already marked ~. The delete in TransferEngine only runs
//      when a line changes to ~ during that session, so a file whose last line
//      was marked in an earlier session is never removed.
//   2. Lines point at files that no longer exist. Both the outbound list
//      builder and the send loop skip a missing file silently, so its line is
//      never marked and the file never drains.
//
// pruneFlowFile handles both: it marks vanished files as done, and removes the
// flow file once nothing actionable remains.

import * as fs from 'fs';
import * as alogger from './alogger.js';

const ACTION_CHARS = ['^', '#', '~'];

/**
 * Parse one flow file line.
 *
 * @returns {object|null} { raw, prefix, filepath, sent } or null for a blank
 */
function parseFlowLine(line) {
	var raw = String(line === null || line === undefined ? '' : line).trim();
	if (!raw) return null;

	var prefix = '';
	var filepath = raw;
	if (ACTION_CHARS.indexOf(raw[0]) !== -1) {
		prefix = raw[0];
		filepath = raw.substring(1).trim();
	}
	// Flow files written on DOS carry CR endings that survive a split on \n.
	filepath = filepath.replace(/\r/g, '');

	return { raw: raw, prefix: prefix, filepath: filepath, sent: prefix === '~' };
}

/**
 * Every line of a flow file, blanks dropped.
 */
function readFlowLines(floPath) {
	var out = [];
	try {
		if (!fs.existsSync(floPath)) return out;
		var content = fs.readFileSync(floPath, 'utf8');
		for (var line of content.split('\n')) {
			var parsed = parseFlowLine(line);
			if (parsed) out.push(parsed);
		}
	} catch (err) {
		alogger.writeAlog(3, 'floFile: cannot read ' + floPath + ': ' + (err?.message || err), 'redbright');
	}
	return out;
}

/**
 * How many lines still name a file that exists and has not been sent.
 *
 * This is the honest answer to "does this node have mail waiting", as opposed
 * to "does a flow file exist", which is what the scanner used to ask.
 */
function pendingCount(floPath) {
	var n = 0;
	for (var line of readFlowLines(floPath)) {
		if (line.sent) continue;
		if (!line.filepath) continue;
		try {
			if (fs.existsSync(line.filepath)) n++;
		} catch (_) {}
	}
	return n;
}

/**
 * Bring a flow file into line with what is actually on disk.
 *
 * Marks lines whose file has vanished, and deletes the flow file when nothing
 * actionable is left. Safe to call repeatedly and safe to call on a file that
 * does not exist.
 *
 * @param {string} floPath
 * @param {object} opts  { dryRun } to report without writing
 * @returns {object} { existed, pending, vanished, deleted, rewritten }
 */
function pruneFlowFile(floPath, opts) {
	var options = opts || {};
	var result = { existed: false, pending: 0, vanished: 0, deleted: false, rewritten: false };

	var lines;
	try {
		if (!fs.existsSync(floPath)) return result;
		result.existed = true;
		lines = readFlowLines(floPath);
	} catch (err) {
		alogger.writeAlog(3, 'floFile: cannot read ' + floPath + ': ' + (err?.message || err), 'redbright');
		return result;
	}

	var rebuilt = [];
	for (var line of lines) {
		if (line.sent) { rebuilt.push(line.raw); continue; }

		var exists = false;
		try { exists = !!line.filepath && fs.existsSync(line.filepath); } catch (_) {}

		if (exists) {
			result.pending++;
			rebuilt.push(line.raw);
		} else {
			// The file went somewhere: sent by another session, cleaned up, or
			// removed by hand. Either way this line will never do anything
			// again, and leaving it unmarked is what keeps the flow file alive.
			result.vanished++;
			rebuilt.push('~' + line.filepath);
		}
	}

	if (options.dryRun) return result;

	try {
		if (result.pending === 0) {
			fs.unlinkSync(floPath);
			result.deleted = true;
			alogger.writeAlog(4, 'floFile: removed exhausted flow file ' + floPath +
				(result.vanished ? ' (' + result.vanished + ' vanished file(s))' : ' (all sent)'), 'cyan');
		} else if (result.vanished > 0) {
			fs.writeFileSync(floPath, rebuilt.join('\n') + '\n');
			result.rewritten = true;
			alogger.writeAlog(4, 'floFile: marked ' + result.vanished +
				' vanished file(s) in ' + floPath + ', ' + result.pending + ' still pending', 'cyan');
		}
	} catch (err) {
		alogger.writeAlog(3, 'floFile: cannot update ' + floPath + ': ' + (err?.message || err), 'redbright');
	}

	return result;
}

export { parseFlowLine, readFlowLines, pendingCount, pruneFlowFile, ACTION_CHARS };
