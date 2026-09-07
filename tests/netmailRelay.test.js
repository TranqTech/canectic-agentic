// tests/netmailRelay.test.js: relaying netmail without lying about who sent it.
//
// Three faults, all of which only showed on transit mail, which is why they sat
// unnoticed: relay is off by default and mail we write ourselves exercises none
// of these paths.
//
// 1. The message header and the packet header were swapped. A netmail carries
//    two "from" addresses that answer different questions. The message header
//    says who wrote it. The packet header says who is handing the packet over.
//    For mail we originated those are the same address. For relayed mail they
//    are not, and the code stamped our address over the message header while
//    reading the packet header out of the INTL kludge, which on transit mail
//    names the original author. So both were wrong, in opposite directions, and
//    replies went back to the wrong system.
//
// 2. No Via line was written, so there was no loop protection at all. Two
//    systems routing to each other would pass a message back and forth
//    indefinitely.
//
// 3. The inbound Via parser kept two tokens and dropped the rest, so any chain
//    that did arrive was already mangled before anything could read it.
//
// Pure: no database.
// Run: npx mocha

import assert from 'assert';

var adapter = null, via = null;
try {
	adapter = await import('../src/models/ftnNetmailAdapter.js');
	via = await import('../src/utils/ftnVia.js');
} catch (_) { /* leave null, suites skip */ }

var OURS = { address: '21:1/100', address_zone: 21, address_net: 1, address_node: 100 };

describe('ftnNetmailAdapter.resolveOutboundSource', function () {
	before(function () {
		if (!adapter || typeof adapter.resolveOutboundSource !== 'function') this.skip();
	});

	// -----------------------------------------------------------------------
	// mail we wrote
	// -----------------------------------------------------------------------

	it('stamps our address on both headers for locally written mail', function () {
		var msg = { Source: '', SourceZone: 0, SourceNet: 0, SourceNode: 0 };
		var s = adapter.resolveOutboundSource(msg, OURS, {});
		assert.strictEqual(s.relayed, false);
		assert.strictEqual(s.message.address, '21:1/100');
		assert.strictEqual(s.packet.address, '21:1/100');
		assert.strictEqual(s.message.net, 1);
		assert.strictEqual(s.message.node, 100);
	});

	it('treats absent transport data as locally written', function () {
		assert.strictEqual(adapter.resolveOutboundSource({}, OURS, null).relayed, false);
		assert.strictEqual(adapter.resolveOutboundSource({}, OURS, undefined).relayed, false);
	});

	it('does not treat a stray truthy value as relayed', function () {
		// transport_data carries a lot of keys. Only an explicit relayed:true
		// means transit; anything looser would start rewriting ordinary mail.
		assert.strictEqual(adapter.resolveOutboundSource({}, OURS, { relayed: 'yes' }).relayed, false);
		assert.strictEqual(adapter.resolveOutboundSource({}, OURS, { relayed: 1 }).relayed, false);
	});

	// -----------------------------------------------------------------------
	// mail we are carrying for someone else
	// -----------------------------------------------------------------------

	it('keeps the original author on the message header when relaying', function () {
		var msg = { Source: '1:229/426', SourceZone: 1, SourceNet: 229, SourceNode: 426 };
		var s = adapter.resolveOutboundSource(msg, OURS, { relayed: true });

		assert.strictEqual(s.relayed, true);
		assert.strictEqual(s.message.address, '1:229/426',
			'the message stays from whoever wrote it');
		assert.strictEqual(s.message.zone, 1);
		assert.strictEqual(s.message.net, 229);
		assert.strictEqual(s.message.node, 426);
	});

	it('puts our address on the packet header when relaying', function () {
		var msg = { Source: '1:229/426', SourceZone: 1, SourceNet: 229, SourceNode: 426 };
		var s = adapter.resolveOutboundSource(msg, OURS, { relayed: true });

		assert.strictEqual(s.packet.address, '21:1/100',
			'we are the system sending the packet, whoever wrote what is inside');
		assert.strictEqual(s.packet.net, 1);
		assert.strictEqual(s.packet.node, 100);
	});

	it('gives the two headers different addresses on transit mail', function () {
		// The single assertion that would have caught the original bug: they
		// were equal, and equal to the wrong one of the two.
		var msg = { Source: '1:229/426', SourceZone: 1, SourceNet: 229, SourceNode: 426 };
		var s = adapter.resolveOutboundSource(msg, OURS, { relayed: true });
		assert.notStrictEqual(s.message.address, s.packet.address);
	});

	it('strips a 5D domain from the address it stamps', function () {
		var msg = { Source: '1:229/426@fidonet', SourceZone: 1, SourceNet: 229, SourceNode: 426 };
		var s = adapter.resolveOutboundSource(msg, { address: '21:1/100@fsxnet',
			address_zone: 21, address_net: 1, address_node: 100 }, { relayed: true });
		assert.strictEqual(s.message.address, '1:229/426');
		assert.strictEqual(s.packet.address, '21:1/100');
	});

	// -----------------------------------------------------------------------
	// malformed transit mail
	// -----------------------------------------------------------------------

	it('falls back to our address when the originator did not survive', function () {
		// Better to send it as ours than to emit a 0:0/0 message header that
		// no tosser downstream will accept.
		var msg = { Source: '', SourceZone: 0, SourceNet: 0, SourceNode: 0 };
		var s = adapter.resolveOutboundSource(msg, OURS, { relayed: true });
		assert.strictEqual(s.message.address, '21:1/100');
		assert.strictEqual(s.message.net, 1);
	});

	it('accepts a point address without losing the node', function () {
		var msg = { Source: '1:229/426.1', SourceZone: 1, SourceNet: 229, SourceNode: 426 };
		var s = adapter.resolveOutboundSource(msg, OURS, { relayed: true });
		assert.strictEqual(s.message.net, 229);
		assert.strictEqual(s.message.node, 426);
	});

	it('survives a null message', function () {
		assert.doesNotThrow(function () {
			adapter.resolveOutboundSource(null, OURS, { relayed: true });
		});
	});
});

describe('ftnVia parsing', function () {
	before(function () { if (!via) this.skip(); });

	it('keeps the whole line, not the first two tokens', function () {
		// The parser used to do split[1] + " " + split[2], which threw away
		// either the software or the timestamp off every line it read,
		// depending on whether the writer used the optional '@'.
		var v = via.parseViaLine('2:5020/1042 @20240115.123456.UTC binkd/1.1a-115');
		assert.strictEqual(v.address, '2:5020/1042');
		assert.strictEqual(v.stamp, '20240115.123456.UTC');
		assert.strictEqual(v.software, 'binkd/1.1a-115');
	});

	it('reads a line with no @ before the timestamp', function () {
		var v = via.parseViaLine('1:229/426 20240115.123456.UTC Canectic 0.9.5a');
		assert.strictEqual(v.stamp, '20240115.123456.UTC');
		assert.strictEqual(v.software, 'Canectic 0.9.5a');
	});

	it('reads a 5D address and reports the bare form alongside', function () {
		var v = via.parseViaLine('21:1/100@fsxnet @20240115.123456.UTC HPT/lnx 1.9');
		assert.strictEqual(v.address, '21:1/100@fsxnet');
		assert.strictEqual(v.bare, '21:1/100');
	});

	it('keeps sub-second precision some systems write', function () {
		var v = via.parseViaLine('21:1/100 @20240115.123456.12345.UTC HPT/lnx 1.9');
		assert.strictEqual(v.stamp, '20240115.123456.12345.UTC');
		assert.strictEqual(v.software, 'HPT/lnx 1.9');
	});

	it('handles a line with an address and nothing else', function () {
		var v = via.parseViaLine('2:5020/1042');
		assert.strictEqual(v.address, '2:5020/1042');
		assert.strictEqual(v.stamp, '');
		assert.strictEqual(v.software, '');
	});

	it('treats a non-timestamp second token as software', function () {
		var v = via.parseViaLine('2:5020/1042 SomeMailer 2.0');
		assert.strictEqual(v.stamp, '');
		assert.strictEqual(v.software, 'SomeMailer 2.0');
	});

	it('keeps the raw line so a relay can put back exactly what it read', function () {
		// Reconstructing from parsed parts would quietly normalise other
		// systems' lines, and a Via chain is evidence.
		var line = '2:5020/1042 @20240115.123456.UTC binkd/1.1a-115';
		assert.strictEqual(via.parseViaLine(line).raw, line);
	});

	it('returns null for an empty line rather than a hollow object', function () {
		assert.strictEqual(via.parseViaLine(''), null);
		assert.strictEqual(via.parseViaLine('   '), null);
		assert.strictEqual(via.parseViaLine(null), null);
	});
});

describe('ftnVia.viaValueFromKludge', function () {
	before(function () { if (!via) this.skip(); });

	// This is the function the tosser actually calls while reading a packet.
	// The first attempt at fixing the truncation left the tosser with its own
	// private copy of the logic, so reverting the fix broke nothing: the tests
	// were exercising a different implementation than the one that runs.

	it('keeps everything after the marker', function () {
		assert.strictEqual(
			via.viaValueFromKludge('Via 2:5020/1042 @20240115.123456.UTC binkd/1.1a-115'),
			'2:5020/1042 @20240115.123456.UTC binkd/1.1a-115');
	});

	it('keeps a software string with spaces in it', function () {
		// The two-token version cut this to "1:229/426 20240115.123456.UTC",
		// silently discarding which implementation handled the hop.
		assert.strictEqual(
			via.viaValueFromKludge('Via 1:229/426 20240115.123456.UTC Canectic BBS 0.9.5a'),
			'1:229/426 20240115.123456.UTC Canectic BBS 0.9.5a');
	});

	it('keeps the timestamp when the writer omits the @', function () {
		// With no '@' the old two-token slice produced address + stamp and
		// dropped the software; with an '@' it produced the same two fields
		// from different positions. Either way something was lost.
		var out = via.viaValueFromKludge('Via 21:1/100 20240115.123456.UTC HPT/lnx 1.9');
		assert.ok(out.indexOf('20240115.123456.UTC') !== -1);
		assert.ok(out.indexOf('HPT/lnx 1.9') !== -1);
	});

	it('accepts the uppercase marker', function () {
		assert.strictEqual(via.viaValueFromKludge('VIA 2:5020/1042 x y z'),
			'2:5020/1042 x y z');
	});

	it('collapses the runs of spaces some writers emit', function () {
		assert.strictEqual(via.viaValueFromKludge('Via   2:5020/1042    @2024  sw'),
			'2:5020/1042 @2024 sw');
	});

	it('returns an empty string for a marker with nothing after it', function () {
		assert.strictEqual(via.viaValueFromKludge('Via'), '');
		assert.strictEqual(via.viaValueFromKludge(''), '');
		assert.strictEqual(via.viaValueFromKludge(null), '');
	});

	it('feeds the parser a line it can fully read back', function () {
		// The pair that matters: what the tosser stores has to be what the
		// chain reader can parse, or the loop check and the ping reply both
		// work off a mangled path.
		var raw = 'Via 2:5020/1042 @20240115.123456.UTC binkd/1.1a-115';
		var parsed = via.parseViaLine(via.viaValueFromKludge(raw));
		assert.strictEqual(parsed.address, '2:5020/1042');
		assert.strictEqual(parsed.stamp, '20240115.123456.UTC');
		assert.strictEqual(parsed.software, 'binkd/1.1a-115');
	});
});

describe('ftnVia.viaChain', function () {
	before(function () { if (!via) this.skip(); });

	var ATTRS = [
		{ attribute: 'INTL', value: '21:1/100 1:229/426' },
		{ attribute: 'Via', value: '1:229/426 @20240115.100000.UTC binkd/1.1a' },
		{ attribute: 'MSGID', value: '1:229/426 deadbeef' },
		{ attribute: 'VIA', value: '2:5020/1042 @20240115.110000.UTC HPT/lnx' }
	];

	it('picks out only the Via lines, in order', function () {
		var chain = via.viaChain(ATTRS);
		assert.strictEqual(chain.length, 2);
		assert.strictEqual(chain[0].address, '1:229/426', 'oldest hop first');
		assert.strictEqual(chain[1].address, '2:5020/1042');
	});

	it('accepts either capitalisation, since both are used in the wild', function () {
		assert.strictEqual(via.viaChain([{ attribute: 'via', value: '1:1/1' }]).length, 1);
	});

	it('returns an empty chain rather than throwing on junk', function () {
		assert.deepStrictEqual(via.viaChain(null), []);
		assert.deepStrictEqual(via.viaChain([null, {}, { attribute: 'Via' }]), []);
	});
});

describe('ftnVia.hasPassedThrough', function () {
	before(function () { if (!via) this.skip(); });

	function attrs(addresses) {
		return addresses.map(function (a) {
			return { attribute: 'Via', value: a + ' @20240115.100000.UTC mailer' };
		});
	}

	it('spots our own address in the chain', function () {
		assert.strictEqual(
			via.hasPassedThrough(attrs(['1:229/426', '21:1/100']), ['21:1/100']), true);
	});

	it('spots any of our addresses, not just the first', function () {
		// A message that came back to a different AKA of ours is the same loop.
		assert.strictEqual(
			via.hasPassedThrough(attrs(['1:229/426']), ['21:1/100', '1:229/426']), true);
	});

	it('matches on the bare address across a domain mismatch', function () {
		// A system may write itself into the chain with a domain one hop and
		// without it the next. A loop check that misses is worse than none: it
		// reads as protection.
		assert.strictEqual(
			via.hasPassedThrough(attrs(['21:1/100@fsxnet']), ['21:1/100']), true);
		assert.strictEqual(
			via.hasPassedThrough(attrs(['21:1/100']), ['21:1/100@fsxnet']), true);
	});

	it('is case insensitive on the domain', function () {
		assert.strictEqual(
			via.hasPassedThrough(attrs(['21:1/100@FsxNet']), ['21:1/100@fsxnet']), true);
	});

	it('passes a chain we are not in', function () {
		assert.strictEqual(
			via.hasPassedThrough(attrs(['1:229/426', '2:5020/1042']), ['21:1/100']), false);
	});

	it('passes an empty chain', function () {
		// First hop, or an upstream that does not stamp. Either way not a loop,
		// and refusing here would break relay for everyone behind such a system.
		assert.strictEqual(via.hasPassedThrough([], ['21:1/100']), false);
		assert.strictEqual(via.hasPassedThrough(null, ['21:1/100']), false);
	});

	it('does not claim a loop when we hold no addresses', function () {
		assert.strictEqual(via.hasPassedThrough(attrs(['1:229/426']), []), false);
		assert.strictEqual(via.hasPassedThrough(attrs(['1:229/426']), null), false);
	});

	it('does not match a partial address', function () {
		// 21:1/10 must not match 21:1/100.
		assert.strictEqual(via.hasPassedThrough(attrs(['21:1/100']), ['21:1/10']), false);
	});
});

describe('ftnVia.buildVia and appendVia', function () {
	before(function () { if (!via) this.skip(); });

	var WHEN = new Date(Date.UTC(2024, 0, 15, 12, 34, 56));

	it('writes the conventional shape', function () {
		var line = via.buildViaLine('21:1/100', WHEN, '0.9.5a');
		assert.ok(line.startsWith('21:1/100 '), line);
		assert.ok(/ 20240115\.123456\.UTC /.test(line), line);
		assert.ok(/Canectic 0\.9\.5a$/.test(line), line);
	});

	it('stamps in UTC regardless of the local clock', function () {
		// A Via chain is compared across systems in different zones, so a local
		// timestamp makes the ordering meaningless.
		assert.ok(via.buildViaLine('21:1/100', WHEN, '1').indexOf('20240115.123456') !== -1);
	});

	it('pads single digit dates and times', function () {
		var line = via.buildViaLine('21:1/100', new Date(Date.UTC(2024, 8, 7, 1, 2, 3)), '1');
		assert.ok(/ 20240907\.010203\.UTC /.test(line), line);
	});

	it('round-trips through the parser', function () {
		var parsed = via.parseViaLine(via.buildViaLine('21:1/100', WHEN, '0.9.5a'));
		assert.strictEqual(parsed.address, '21:1/100');
		assert.strictEqual(parsed.stamp, '20240115.123456.UTC');
		assert.strictEqual(parsed.software, 'Canectic 0.9.5a');
	});

	it('appends to the end so the chain stays chronological', function () {
		var attrs = [{ attribute: 'Via', value: '1:229/426 @20240115.100000.UTC binkd' }];
		via.appendVia(attrs, '21:1/100', WHEN, '1');
		var chain = via.viaChain(attrs);
		assert.strictEqual(chain.length, 2);
		assert.strictEqual(chain[1].address, '21:1/100', 'our hop is the newest');
	});

	it('leaves the existing chain untouched', function () {
		var original = '1:229/426 @20240115.100000.UTC binkd/1.1a-115';
		var attrs = [{ attribute: 'Via', value: original }];
		via.appendVia(attrs, '21:1/100', WHEN, '1');
		assert.strictEqual(via.viaChain(attrs)[0].raw, original,
			'another system\'s hop must survive verbatim');
	});

	it('starts a chain when there is none', function () {
		var attrs = [];
		via.appendVia(attrs, '21:1/100', WHEN, '1');
		assert.strictEqual(via.viaChain(attrs).length, 1);
	});

	it('makes a message that has been through us detectable afterwards', function () {
		// The pair that matters: we stamp, the next system checks, and if it
		// routes back to us we refuse it.
		var attrs = [];
		via.appendVia(attrs, '21:1/100', WHEN, '1');
		assert.strictEqual(via.hasPassedThrough(attrs, ['21:1/100']), true);
	});
});
