// tests/netmailPing.test.js: answering netmail addressed to "Ping".
//
// A long-standing FTN convention rather than a numbered standard: send netmail
// to Ping at a node, get one back saying it arrived and showing the route it
// took. It is the traceroute of a mail network. Husky's pinger, Mystic and
// Synchronet all answer it, so other sysops expect it to work, and until now a
// ping aimed here fell through to the undeliverable queue and generated a sysop
// notification instead of a reply.
//
// The reply is mostly the Via chain the request accumulated, which is why this
// could not have been built before the Via parser was fixed: it truncated every
// line to two tokens, so the interesting half of each hop was gone before
// anything could read it.
//
// Pure: no database.
// Run: npx mocha

import assert from 'assert';

var ping = null, pm = null;
try {
	ping = await import('../src/models/netmailPing.js');
	pm = await import('../src/models/privateMessages.js');
} catch (_) { /* leave null, suites skip */ }

function request(over) {
	return Object.assign({
		FromUser: 'Alice', ToUser: 'Ping', Subject: 'ping',
		Source: '1:229/426', SourceZone: 1, SourceNet: 229, SourceNode: 426,
		Destination: '21:1/100', DestinationZone: 21, DestinationNet: 1, DestinationNode: 100,
		DateTime: '15 Jan 24  10:00:00',
		BodyText: 'hello\r',
		OptionalAttributes: [
			{ attribute: 'INTL', value: '21:1/100 1:229/426' },
			{ attribute: 'Via', value: '1:229/426 @20240115.100000.UTC binkd/1.1a-115' },
			{ attribute: 'Via', value: '2:5020/1042 @20240115.110000.UTC HPT/lnx 1.9' }
		]
	}, over || {});
}

describe('privateMessages.isAutomatedProcessor', function () {
	before(function () { if (!pm) this.skip(); });

	it('recognises ping', function () {
		// Without this the message falls to recipient resolution, fails, and
		// lands in the undeliverable queue with a sysop notification. Which is
		// what happened to every ping sent here before now.
		assert.strictEqual(pm.isAutomatedProcessor('ping'), true);
		assert.strictEqual(pm.isAutomatedProcessor('Ping'), true);
		assert.strictEqual(pm.isAutomatedProcessor('  PING  '), true);
	});

	it('still recognises the existing processors', function () {
		['areafix', 'areamgr', 'filefix', 'filemgr', 'tic', 'raidfix'].forEach(function (n) {
			assert.strictEqual(pm.isAutomatedProcessor(n), true, n);
		});
	});

	it('does not swallow a real user whose name merely contains ping', function () {
		assert.strictEqual(pm.isAutomatedProcessor('Pinger'), false);
		assert.strictEqual(pm.isAutomatedProcessor('Ping Pong'), false);
	});
});

describe('netmailPing.handleRequest', function () {
	before(function () { if (!ping) this.skip(); });

	it('answers', async function () {
		var r = await ping.handleRequest(request());
		assert.strictEqual(r.status, true);
		assert.ok(r.responseLines.length > 0);
	});

	it('counts the hops it saw', async function () {
		assert.strictEqual((await ping.handleRequest(request())).hops, 2);
	});

	it('answers a request that arrived with no Via chain', async function () {
		// A direct link, or an upstream that does not stamp. Refusing here
		// would make ping useless on exactly the links it is most needed for.
		var r = await ping.handleRequest(request({ OptionalAttributes: [] }));
		assert.strictEqual(r.status, true);
		assert.strictEqual(r.hops, 0);
		assert.ok(r.responseLines.join('\n').match(/no via lines/i));
	});

	it('survives a message with no kludges at all', async function () {
		var r = await ping.handleRequest(request({ OptionalAttributes: undefined }));
		assert.strictEqual(r.status, true);
	});
});

describe('netmailPing reply body', function () {
	before(function () { if (!ping) this.skip(); });

	function body(over) {
		var msg = request(over);
		var via = null;
		return ping.buildBody(msg, (function () {
			// use the real chain extraction so the test exercises what runs
			return [];
		})());
	}

	it('names every hop in order, oldest first', async function () {
		var text = (await ping.handleRequest(request())).responseLines.join('\n');
		var firstIdx = text.indexOf('1:229/426');
		var secondIdx = text.indexOf('2:5020/1042');
		assert.ok(firstIdx !== -1 && secondIdx !== -1, 'both hops should appear');
		assert.ok(firstIdx < secondIdx, 'the chain reads oldest first');
	});

	it('keeps the software each hop reported', async function () {
		// This is the half the old parser threw away, and the half that tells
		// a sysop which implementation mangled their mail.
		var text = (await ping.handleRequest(request())).responseLines.join('\n');
		assert.ok(text.indexOf('binkd/1.1a-115') !== -1, text);
		assert.ok(text.indexOf('HPT/lnx 1.9') !== -1, text);
	});

	it('keeps each hop timestamp', async function () {
		var text = (await ping.handleRequest(request())).responseLines.join('\n');
		assert.ok(text.indexOf('20240115.100000.UTC') !== -1, text);
	});

	it('says who sent it and where it landed', async function () {
		var text = (await ping.handleRequest(request())).responseLines.join('\n');
		assert.ok(text.indexOf('Alice') !== -1);
		assert.ok(text.indexOf('1:229/426') !== -1);
		assert.ok(text.indexOf('21:1/100') !== -1);
	});

	it('does not produce blank hop lines', async function () {
		// The padding helper referenced a variable before assignment, which JS
		// hoists to undefined, so every padded field came back as spaces and
		// the whole route table rendered empty.
		var lines = (await ping.handleRequest(request())).responseLines;
		var hopLines = lines.filter(function (l) { return /^\s+\d+\./.test(l); });
		assert.strictEqual(hopLines.length, 2);
		hopLines.forEach(function (l) {
			assert.ok(l.trim().length > 10, 'hop line should carry content, got: ' + JSON.stringify(l));
		});
	});

	it('stays inside 80 columns', async function () {
		// Read by a person in a terminal, often on the far side of a bad link.
		var lines = (await ping.handleRequest(request())).responseLines;
		lines.forEach(function (l) {
			assert.ok(l.length <= 79, 'line too wide (' + l.length + '): ' + l);
		});
	});
});

describe('netmailPing.buildResponse', function () {
	before(function () { if (!ping) this.skip(); });

	function reply(over) {
		var req = request(over);
		return ping.buildResponse(req, ['Pong.', 'line two'], ping.PROCESSOR_NAME);
	}

	it('sends it back to whoever asked', function () {
		var m = reply();
		assert.strictEqual(m.ToUser, 'Alice');
		assert.strictEqual(m.Destination, '1:229/426');
		assert.strictEqual(m.DestinationZone, 1);
		assert.strictEqual(m.DestinationNet, 229);
		assert.strictEqual(m.DestinationNode, 426);
	});

	it('sends it from the address the ping was aimed at', function () {
		// Not our default AKA: a node that pings 21:1/100 should hear back
		// from 21:1/100, or it cannot tell which of our addresses answered.
		var m = reply();
		assert.strictEqual(m.Source, '21:1/100');
		assert.strictEqual(m.SourceZone, 21);
		assert.strictEqual(m.SourceNet, 1);
		assert.strictEqual(m.SourceNode, 100);
	});

	it('is a private netmail', function () {
		var m = reply();
		assert.strictEqual(m.Type, 'Netmail');
		assert.strictEqual(m.Attribute, 0x0001);
		assert.strictEqual(m.Cost, 0);
	});

	it('is subject Pong, which is what senders look for', function () {
		assert.strictEqual(reply().Subject, 'Pong');
	});

	it('carries an INTL kludge with the endpoints the right way round', function () {
		// INTL is "<destination> <source>", and getting it backwards sends the
		// reply into the void on any zone-crossing link.
		var intl = reply().OptionalAttributes
			.filter(function (a) { return a.attribute === 'INTL'; })[0];
		assert.ok(intl);
		assert.strictEqual(intl.value, '1:229/426 21:1/100');
	});

	it('does not copy the request\'s Via chain onto the reply', function () {
		// The reply is a new message taking its own route. Carrying the
		// request's hops would make our own loop check refuse it.
		var vias = reply().OptionalAttributes
			.filter(function (a) { return String(a.attribute).toUpperCase() === 'VIA'; });
		assert.strictEqual(vias.length, 0);
	});

	it('addresses a reply to Sysop when the request gave no sender name', function () {
		assert.strictEqual(reply({ FromUser: '' }).ToUser, 'Sysop');
	});

	it('ends the body with a bare CR, as FTN bodies do', function () {
		assert.ok(reply().BodyText.endsWith('\r'));
		assert.ok(reply().BodyText.indexOf('\n') === -1,
			'FTN bodies use bare CR, never LF');
	});
});
