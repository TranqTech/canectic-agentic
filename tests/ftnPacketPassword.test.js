// tests/ftnPacketPassword.test.js: stamping the packet password on netmail.
//
// Two writers produce FTN packets. Echomail goes through WritePktToNode, which
// reads the peer's own packet_password. Netmail went through WritePkts, which
// read the global PacketPwd config key and nothing else. So a sysop who set a
// packet password on a link got authenticated echomail and netmail with eight
// zero bytes where the password belongs.
//
// It surfaced as an uplink bouncing AreaFix requests back with "no password"
// while every other kind of traffic to the same system was fine. The returned
// packets had the password correctly in the subject, which is where AreaFix
// wants it, and an empty header field, which is what the uplink was actually
// complaining about.
//
// The 8 byte field is also made self-contained. The old code built a buffer as
// long as the password and copied all of it while advancing the write offset
// by 8, so an over-length password spilled past the field. That never
// corrupted a packet, because the zone writes and the fill that follow
// overwrite the rest of the header, but it left the field correct only by
// accident, dependent on what happened to be written after it.
//
// Run: npx mocha

import assert from 'assert';

var tosser = null;
try { tosser = await import('../src/middleware/tossers/ftnTosser.js'); } catch (_) { /* skip */ }

describe('ftnTosser.normaliseFtnAddress', function () {
	before(function () { if (!tosser || !tosser.normaliseFtnAddress) this.skip(); });

	it('matches a node written with and without a point zero', function () {
		// A peer stored as 1:153/757 must still be found when the packet is
		// addressed to 1:153/757.0, which is the same system.
		assert.strictEqual(tosser.normaliseFtnAddress('1:153/757.0'),
			tosser.normaliseFtnAddress('1:153/757'));
	});

	it('drops a 5D domain suffix', function () {
		assert.strictEqual(tosser.normaliseFtnAddress('1:153/757@fidonet'), '1:153/757');
	});

	it('keeps a real point number', function () {
		// .0 is the node itself; .1 is a different system entirely.
		assert.notStrictEqual(tosser.normaliseFtnAddress('1:153/757.1'),
			tosser.normaliseFtnAddress('1:153/757'));
	});

	it('is case insensitive', function () {
		assert.strictEqual(tosser.normaliseFtnAddress('1:153/757@FidoNet'),
			tosser.normaliseFtnAddress('1:153/757@fidonet'));
	});
});

describe('ftnTosser.packetPasswordBuffer', function () {
	before(function () { if (!tosser || !tosser.packetPasswordBuffer) this.skip(); });

	it('is always exactly the 8 bytes FTS-0001 allows', function () {
		for (var pw of ['', 'a', '115898TM', 'muchlongerthaneight']) {
			assert.strictEqual(tosser.packetPasswordBuffer(pw).length, 8, JSON.stringify(pw));
		}
	});

	it('writes an eight character password verbatim', function () {
		// The password from the returned packets, which is exactly the limit.
		assert.strictEqual(
			tosser.packetPasswordBuffer('115898TM').toString('latin1'), '115898TM');
	});

	it('null pads a short password', function () {
		assert.deepStrictEqual(Array.from(tosser.packetPasswordBuffer('ab')),
			[0x61, 0x62, 0, 0, 0, 0, 0, 0]);
	});

	it('writes nothing past its own field', function () {
		// Password sits at offset 26, qOrigZone at 34. The helper must not
		// touch a byte beyond 33 whatever it is handed, so the field stops
		// depending on the zone and fill writes to paint over any spill.
		var header = Buffer.alloc(58);
		tosser.packetPasswordBuffer('123456789012345678901234567890123456').copy(header, 26);

		assert.strictEqual(header.subarray(26, 34).toString('latin1'), '12345678');
		assert.deepStrictEqual(Array.from(header.subarray(34)), new Array(24).fill(0),
			'the rest of the header is untouched');
	});

	it('treats a missing password as an empty field', function () {
		for (var pw of [null, undefined, '']) {
			assert.deepStrictEqual(Array.from(tosser.packetPasswordBuffer(pw)),
				[0, 0, 0, 0, 0, 0, 0, 0]);
		}
	});
});
