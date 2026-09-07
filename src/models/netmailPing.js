// netmailPing.js -- replies to netmail addressed to "Ping".
//
// A long-standing FTN convention rather than a numbered standard: send netmail
// to Ping at a node, get one back saying it arrived and showing the route it
// took. It is the traceroute of a mail network, and the only practical way to
// find out where mail is actually going when a link misbehaves. Husky's pinger,
// Mystic and Synchronet all answer it, so other sysops expect it to work.
//
// The reply is mostly the Via chain the request accumulated on the way in,
// which is why this could not be built before Via lines were parsed properly:
// the parser truncated every line to two tokens, so the interesting half of
// each hop was already gone by the time anything could read it.
//
// Shaped like areafix.js and filefix.js (handleRequest + buildResponse) so the
// Step 2 dispatch in ftnNetmailAdapter needs no special case.

import { Message } from './ftnClasses.js';
import * as ftnVia from '../utils/ftnVia.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

const PROCESSOR_NAME = 'Ping';

/**
 * Handle an inbound ping request.
 *
 * @param {object} ftnMessage
 * @returns {object} { status, responseLines, hops }
 */
async function handleRequest(ftnMessage) {
	var out = { status: false, responseLines: [], hops: 0 };

	if (!appConfig.getBoolean('netmail_ping_enabled', true)) {
		alogger.writeAlog(4, 'Netmail ping received but ping is disabled', 'yellow');
		return out;
	}

	var chain = ftnVia.viaChain(ftnMessage && ftnMessage.OptionalAttributes);
	out.hops = chain.length;
	out.status = true;
	out.responseLines = buildBody(ftnMessage, chain);

	alogger.writeAlog(2,
		'Netmail ping answered for ' + (ftnMessage.FromUser || '?') + ' @ ' +
		(ftnMessage.Source || '?') + ' (' + chain.length + ' hop' +
		(chain.length === 1 ? '' : 's') + ')', 'cyan');

	return out;
}

/**
 * The reply body.
 *
 * Deliberately plain text with no kludges of its own: this is read by a person
 * trying to work out where their mail went, and half of them will read it in a
 * 80 column terminal.
 */
function buildBody(ftnMessage, chain) {
	var lines = [];
	var boardName = appConfig.get('boardname', 'Canectic BBS');

	lines.push('Pong.');
	lines.push('');
	lines.push('Your message reached ' + boardName + ' at ' +
		(ftnMessage.Destination || 'this system') + '.');
	lines.push('');
	lines.push('  Sent by:   ' + (ftnMessage.FromUser || '(unknown)') +
		' @ ' + (ftnMessage.Source || '(unknown)'));
	if (ftnMessage.DateTime) {
		lines.push('  Written:   ' + ftnMessage.DateTime);
	}
	lines.push('  Received:  ' + formatUtc(new Date()));
	if (ftnMessage.Subject) {
		lines.push('  Subject:   ' + ftnMessage.Subject);
	}
	lines.push('');

	if (chain && chain.length > 0) {
		lines.push('Route taken (' + chain.length + ' hop' +
			(chain.length === 1 ? '' : 's') + ', oldest first):');
		lines.push('');
		for (var i = 0; i < chain.length; i++) {
			var hop = chain[i];
			lines.push('  ' + pad(String(i + 1) + '.', 4) + pad(hop.address, 22) +
				pad(hop.stamp || '', 20) + (hop.software || ''));
		}
	} else {
		// Either a direct link, or somewhere upstream is not stamping. Both are
		// worth telling the sender apart from "we lost the path".
		lines.push('No Via lines were present, so either this arrived directly');
		lines.push('or a system on the way did not stamp its hop.');
	}

	lines.push('');
	lines.push('-- ');
	lines.push(boardName + ' netmail ping');

	return lines;
}

/**
 * Build the reply netmail. Same shape as areafix/filefix buildResponse.
 */
function buildResponse(ftnMessage, responseLines, processorName) {
	var msg = new Message();
	msg.Type = 'Netmail';
	msg.FromUser = processorName || PROCESSOR_NAME;
	msg.ToUser = ftnMessage.FromUser || 'Sysop';
	msg.Subject = 'Pong';
	msg.Attribute = 0x0001; // Private
	msg.Cost = 0;

	// Swap source and destination: the reply goes back where it came from.
	msg.SourceZone = ftnMessage.DestinationZone;
	msg.SourceNet = ftnMessage.DestinationNet;
	msg.SourceNode = ftnMessage.DestinationNode;
	msg.Source = ftnMessage.Destination;
	msg.DestinationZone = ftnMessage.SourceZone;
	msg.DestinationNet = ftnMessage.SourceNet;
	msg.DestinationNode = ftnMessage.SourceNode;
	msg.Destination = ftnMessage.Source;

	msg.BodyText = responseLines.join('\r') + '\r';
	msg.OptionalAttributes = [];

	if (msg.Destination && msg.Source) {
		msg.OptionalAttributes.push({ attribute: 'INTL', value: msg.Destination + ' ' + msg.Source });
	}

	return msg;
}

function formatUtc(d) {
	return d.getUTCFullYear() + '-' +
		p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' +
		p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + ' UTC';
}

function p2(n) { return n < 10 ? '0' + n : String(n); }

function pad(str, len) {
	var s = (str === null || str === undefined) ? '' : String(str);
	return s.length >= len ? s + ' ' : s + ' '.repeat(len - s.length);
}

export { handleRequest, buildResponse, buildBody, PROCESSOR_NAME };
