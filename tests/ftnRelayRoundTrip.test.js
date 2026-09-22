// tests/ftnRelayRoundTrip.test.js: a real relayed message, in and back out.
//
// The fixture is a packet the hub (1:134/100) received from 1:153/757 on
// 2026-09-22, with its packet password blanked. Its first message is Outpost
// BBS's weekly [ANSI] Micronet notice, the one whose rows arrive already split
// by CRs from somewhere upstream (a wrapper counting escape codes as text,
// breaking at 79 bytes). That part is not ours to fix and is not tested here.
//
// What was ours: forwarding it to a downlink sent on a SEEN-BY holding only the
// last of its seven lines (with the colon as an entry), a PATH of "134/100"
// with the real one written at the top as a stale kludge, the author's TZUTC
// replaced with a constant "-0600", "Canectic Tosser v0.1" as the TID, and a
// second tear line after the Origin. Each assertion below is one of those.
//
// Run: npx mocha --no-config --exit tests/ftnRelayRoundTrip.test.js

import assert from 'assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
	ReadPkt, processMessageText, stampKludges, messageTail, formatKludge, tosserName, bodyHasOrigin
} from '../src/middleware/tossers/ftnTosser.js';
import { evaluateOutbound, stampForHop } from '../src/models/echomail.js';
import { parseNetNodes, hasNetNode } from '../src/utils/ftnSeenPath.js';

var FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ftn', 'relayed-ansi-3msgs.pkt');
var PATH_IN = '18/200 229/426 460/58 280/464 153/757';

function received() {
	var pkt = ReadPkt(FIXTURE);
	return pkt.Messages.find(function (m) { return /6696788a/.test(m.MsgId); });
}

// What the hub sends a downlink: the eligibility verdict and the path step
// from echomail.getOutboundForConnection, then the writer's kludges and tail.
function exported(dest) {
	var m = received();
	var verdict = evaluateOutbound(
		{ imported: false, source: '1:153/757', seen_by: m.SeenBy, path: m.Path },
		dest, { netnode: '134/100' });
	assert.strictEqual(verdict.tossable, true, verdict.reason);
	var row = stampForHop({ seen_by: m.SeenBy, path: m.Path }, verdict,
		{ address: '1:134/100', zone: 1, net: 134, node: 100, netnode: '134/100' },
		dest.address, dest.net + '/' + dest.node);
	var out = {
		Type: 'Echomail', MsgId: m.MsgId, ReplyTo: m.ReplyTo,
		OptionalAttributes: m.OptionalAttributes.map(function (a) { return Object.assign({}, a); }),
		BodyText: m.BodyText, TZUTC: m.TZUTC, OriginLine: '',
		SeenBy: row.seen_by, Path: row.path
	};
	stampKludges(out, null);
	var raw = 'AREA:OTHERNETS\r';
	for (var a of out.OptionalAttributes) raw += formatKludge(a.attribute, a.value) + '\r';
	raw += out.BodyText + messageTail(out, out.BodyText);
	return raw;
}

function reread(raw) {
	var m = { RawText: raw, OptionalAttributes: [], Source: '', Destination: '',
		SourceNet: 134, SourceNode: 100, DestinationNet: 134, DestinationNode: 123 };
	processMessageText(m);
	return m;
}

var DEV = { address: '1:134/123', net: '134', node: '123' };

describe('a relayed message as the hub receives it', function () {

	it('keeps every SEEN-BY line, not just the last', function () {
		var m = received();
		var entries = parseNetNodes(m.SeenBy);
		assert.strictEqual(entries.length, 79, m.SeenBy);
		assert.ok(hasNetNode(m.SeenBy, '1/110'), 'from the first line');
		assert.ok(hasNetNode(m.SeenBy, '134/100'), 'from the second line');
		assert.ok(hasNetNode(m.SeenBy, '5075/35'), 'from the last line');
		assert.ok(!/:/.test(m.SeenBy), 'no colon stored as an entry: ' + m.SeenBy);
	});

	it('keeps PATH out of the kludges', function () {
		var m = received();
		assert.strictEqual(m.Path, PATH_IN);
		assert.ok(!m.OptionalAttributes.some(function (a) { return a.attribute === 'PATH'; }));
	});

	it('keeps the author\'s timezone', function () {
		assert.strictEqual(received().TZUTC, '-0400');
	});
});

describe('the same message forwarded to a downlink', function () {
	var raw, back;
	before(function () { raw = exported(DEV); back = reread(raw); });

	it('carries the whole SEEN-BY, plus the hub and the downlink', function () {
		var entries = parseNetNodes(back.SeenBy);
		assert.strictEqual(entries.length, 80, 'the 79 received plus 134/123 (134/100 was already there)');
		assert.ok(hasNetNode(back.SeenBy, '1/110'));
		assert.ok(hasNetNode(back.SeenBy, '134/123'));
	});

	it('writes SEEN-BY as several short lines, not one long one', function () {
		var lines = raw.split('\r').filter(function (l) { return l.startsWith('SEEN-BY'); });
		assert.ok(lines.length > 1, lines.length + ' line(s)');
		for (var l of lines) assert.ok(l.length < 80, l.length + ': ' + l);
		assert.ok(!/SEEN-BY: :/.test(raw));
	});

	it('extends PATH with the hub, once, at the end', function () {
		assert.strictEqual(back.Path, PATH_IN + ' 134/100');
		var pathLines = raw.split('\r').filter(function (l) { return l.startsWith('\x01PATH'); });
		assert.strictEqual(pathLines.length, 1, pathLines.join(' | '));
		assert.ok(raw.lastIndexOf('\x01PATH') > raw.lastIndexOf('SEEN-BY'), 'PATH follows SEEN-BY');
	});

	it('keeps the author\'s TZUTC and names the real tosser', function () {
		assert.ok(raw.includes('\x01TZUTC: -0400\r'), 'author timezone kept');
		assert.ok(!raw.includes('-0600'), 'no constant timezone');
		assert.ok(raw.includes('\x01TID: ' + tosserName() + '\r'));
		assert.ok(!raw.includes('v0.1'));
	});

	it('adds no second tear line after the Origin', function () {
		var afterOrigin = raw.slice(raw.indexOf(' * Origin:'));
		assert.ok(!/\r---/.test(afterOrigin), JSON.stringify(afterOrigin.slice(0, 120)));
		assert.strictEqual(back.BodyText, received().BodyText, 'the body arrives as it left');
	});

	it('is not sent back to a downlink that has it', function () {
		var m = received();
		var v = evaluateOutbound({ imported: false, source: '1:153/757', seen_by: m.SeenBy, path: m.Path },
			{ address: '1:229/426', net: '229', node: '426' }, { netnode: '134/100' });
		assert.strictEqual(v.tossable, false, 'in SEEN-BY on the third line, which used to be dropped');
	});
});

describe('the writer on mail posted here', function () {

	it('still writes the tear line and Origin for a message that has none in its body', function () {
		var out = { Type: 'Echomail', BodyText: 'Hello\r', OriginLine: 'Test Board (1:134/100)',
			ProductLine: 'Canectic BBS v0.9.9a', SeenBy: '134/100 123', Path: '134/100', OptionalAttributes: [] };
		var tail = messageTail(out, out.BodyText);
		assert.ok(tail.includes('\r--- Canectic BBS v0.9.9a\r * Origin: Test Board (1:134/100)\r'), JSON.stringify(tail));
		assert.ok(tail.includes('SEEN-BY: 134/100 123\r'));
		assert.ok(tail.endsWith('\x01PATH: 134/100\r'));
	});

	it('gives netmail posted here this system\'s timezone, and keeps any it has', function () {
		var local = { OptionalAttributes: [], MsgId: '1:134/100 1' };
		stampKludges(local, '-0700');
		assert.ok(local.OptionalAttributes.some(function (a) { return a.attribute === 'TZUTC' && a.value === '-0700'; }));
		var relayed = { OptionalAttributes: [{ attribute: 'TZUTC', value: '0200' }], MsgId: '2:1/1 1' };
		stampKludges(relayed, '-0700');
		assert.deepStrictEqual(relayed.OptionalAttributes.filter(function (a) { return a.attribute === 'TZUTC'; }),
			[{ attribute: 'TZUTC', value: '0200' }]);
	});

	it('drops the PATH that rows stored before this fix still carry as a kludge', function () {
		// Written at the top of the message, old and unextended, it was the
		// PATH a downlink keeping the first line would believe.
		var m = { MsgId: 'x', OptionalAttributes: [
			{ attribute: 'PATH', value: '18/200 153/757' }, { attribute: 'PID', value: 'MBSE' }] };
		stampKludges(m, null);
		assert.deepStrictEqual(m.OptionalAttributes.map(function (a) { return a.attribute; }).filter(function (a) {
			return a === 'PATH' || a === 'PID'; }), ['PID']);
	});

	it('does not declare CHRS twice', function () {
		var m = { OptionalAttributes: [{ attribute: 'CHRS', value: 'UTF-8 4' }], MsgId: 'x' };
		assert.strictEqual(stampKludges(m, null), true);
	});

	it('knows an Origin line when it sees one', function () {
		assert.strictEqual(bodyHasOrigin('text\r--- x\r * Origin: B (1:2/3)\r\r'), true);
		assert.strictEqual(bodyHasOrigin('text\r'), false);
		assert.strictEqual(bodyHasOrigin('quoting * Origin: in the middle\rthen more\r'), false);
	});
});

describe('the parser on the kludges that used to land in PATH', function () {
	it('leaves PATH alone for TOPT and FMPT', function () {
		var m = reread('\x01PATH: 134/100\r\x01FMPT 5\r\x01TOPT: 7\rbody\r');
		assert.strictEqual(m.Path, '134/100');
	});

	it('reads PATH spread over several lines as one list', function () {
		var m = reread('body\r\x01PATH: 18/200 229/426\r\x01PATH: 153/757\r');
		assert.strictEqual(m.Path, '18/200 229/426 153/757');
	});
});
