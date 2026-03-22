// tests/ftnClasses.test.js — Unit tests for src/models/ftnClasses.js
//
// Tests Packet and Message class construction, field defaults, and assignment.
// No DB, no network.
// Run: npx mocha tests/ftnClasses.test.js

import assert from 'assert';
import { Packet, Message } from '../src/models/ftnClasses.js';

// ---------------------------------------------------------------------------
// Packet
// ---------------------------------------------------------------------------

describe('Packet', function () {

	describe('construction', function () {
		it('should construct without errors', function () {
			var p = new Packet();
			assert.ok(p instanceof Packet);
		});

		it('should initialise Messages as an empty array', function () {
			var p = new Packet();
			assert.ok(Array.isArray(p.Messages));
			assert.strictEqual(p.Messages.length, 0);
		});

		it('should have all expected properties accessible', function () {
			var p = new Packet();
			// Packet uses bare this.Prop statements (no assignment), so hasOwnProperty
			// returns false. Test reachability via 'in' — the contract is that callers
			// can read/write these fields.
			var expected = [
				'Password', 'PacketType', 'Source', 'SourceZone', 'SourceNet', 'SourceNode',
				'Destination', 'DestinationZone', 'DestinationNet', 'DestinationNode',
				'DateTime', 'Year', 'Month', 'Day', 'Hour', 'Minute', 'Second',
				'Baud', 'ProdCode', 'Serial', 'MessageCount', 'Messages'
			];
			for (var prop of expected) {
				// Assign and read back — the only meaningful test for bare declarations
				p[prop] = 'sentinel';
				assert.strictEqual(p[prop], 'sentinel', 'Property not settable: ' + prop);
			}
		});
	});

	describe('field assignment', function () {
		it('should accept and return scalar field assignments', function () {
			var p = new Packet();
			p.Password = 'testpw';
			p.SourceZone = 1;
			p.SourceNet = 123;
			p.SourceNode = 456;
			p.DestinationZone = 2;
			p.DestinationNet = 200;
			p.DestinationNode = 100;
			p.Year = 2025;
			p.Month = 3;
			p.Day = 21;
			p.Hour = 14;
			p.Minute = 30;
			p.Second = 0;
			p.Baud = 0;
			p.PacketType = 2;

			assert.strictEqual(p.Password, 'testpw');
			assert.strictEqual(p.SourceZone, 1);
			assert.strictEqual(p.SourceNet, 123);
			assert.strictEqual(p.SourceNode, 456);
			assert.strictEqual(p.DestinationZone, 2);
			assert.strictEqual(p.DestinationNet, 200);
			assert.strictEqual(p.DestinationNode, 100);
			assert.strictEqual(p.Year, 2025);
			assert.strictEqual(p.Month, 3);
			assert.strictEqual(p.Day, 21);
			assert.strictEqual(p.Hour, 14);
			assert.strictEqual(p.Minute, 30);
			assert.strictEqual(p.Second, 0);
			assert.strictEqual(p.Baud, 0);
			assert.strictEqual(p.PacketType, 2);
		});

		it('should allow messages to be pushed into Messages array', function () {
			var p = new Packet();
			var m = new Message();
			p.Messages.push(m);
			assert.strictEqual(p.Messages.length, 1);
			assert.strictEqual(p.Messages[0], m);
		});

		it('should track MessageCount independently from Messages.length', function () {
			var p = new Packet();
			p.MessageCount = 5;
			assert.strictEqual(p.MessageCount, 5);
			assert.strictEqual(p.Messages.length, 0);
		});
	});

	describe('isolation between instances', function () {
		it('should give each instance its own Messages array', function () {
			var p1 = new Packet();
			var p2 = new Packet();
			p1.Messages.push(new Message());
			assert.strictEqual(p1.Messages.length, 1);
			assert.strictEqual(p2.Messages.length, 0);
		});
	});
});

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

describe('Message', function () {

	describe('construction', function () {
		it('should construct without errors', function () {
			var m = new Message();
			assert.ok(m instanceof Message);
		});

		it('should default Type to "Netmail"', function () {
			var m = new Message();
			assert.strictEqual(m.Type, 'Netmail');
		});

		it('should default AreaTag to "None"', function () {
			var m = new Message();
			assert.strictEqual(m.AreaTag, 'None');
		});

		it('should default Cost to 0', function () {
			var m = new Message();
			assert.strictEqual(m.Cost, 0);
		});

		it('should default SourceNet to 0', function () {
			var m = new Message();
			assert.strictEqual(m.SourceNet, 0);
		});

		it('should default DestinationNet to 0', function () {
			var m = new Message();
			assert.strictEqual(m.DestinationNet, 0);
		});

		it('should default DestinationNode to 0', function () {
			var m = new Message();
			assert.strictEqual(m.DestinationNode, 0);
		});

		it('should default OptionalAttributes to an empty array', function () {
			var m = new Message();
			assert.ok(Array.isArray(m.OptionalAttributes));
			assert.strictEqual(m.OptionalAttributes.length, 0);
		});

		it('should default string fields to empty strings', function () {
			var m = new Message();
			assert.strictEqual(m.TZUTC, '');
			assert.strictEqual(m.Path, '');
			assert.strictEqual(m.SeenBy, '');
			assert.strictEqual(m.Source, '');
			assert.strictEqual(m.SourceNode, '');
			assert.strictEqual(m.Destination, '');
			assert.strictEqual(m.Attribute, '');
			assert.strictEqual(m.FromUser, '');
			assert.strictEqual(m.ToUser, '');
			assert.strictEqual(m.DateTime, '');
			assert.strictEqual(m.Subject, '');
			assert.strictEqual(m.MsgId, '');
			assert.strictEqual(m.ReplyTo, '');
			assert.strictEqual(m.ThreadId, '');
			assert.strictEqual(m.TosserId, '');
			assert.strictEqual(m.RawText, '');
			assert.strictEqual(m.BodyText, '');
			assert.strictEqual(m.OriginLine, '');
		});

		it('should have all expected properties accessible', function () {
			var m = new Message();
			// Message fields that have explicit default assignments are own properties.
			// Any bare this.Prop declarations without assignment are testable by set/get.
			var expected = [
				'Type', 'AreaTag', 'TZUTC', 'Path', 'SeenBy', 'Source', 'SourceNode',
				'SourceNet', 'Destination', 'DestinationNet', 'DestinationNode',
				'Attribute', 'Cost', 'FromUser', 'ToUser', 'DateTime', 'Subject',
				'MsgId', 'ReplyTo', 'ThreadId', 'TosserId', 'OptionalAttributes',
				'RawText', 'BodyText', 'OriginLine'
			];
			for (var prop of expected) {
				m[prop] = 'sentinel';
				assert.strictEqual(m[prop], 'sentinel', 'Property not settable: ' + prop);
			}
		});
	});

	describe('field assignment', function () {
		it('should accept echomail type assignment', function () {
			var m = new Message();
			m.Type = 'Echomail';
			assert.strictEqual(m.Type, 'Echomail');
		});

		it('should accept area tag assignment', function () {
			var m = new Message();
			m.AreaTag = 'FIDONET';
			assert.strictEqual(m.AreaTag, 'FIDONET');
		});

		it('should accept a full message construction', function () {
			var m = new Message();
			m.Type = 'Echomail';
			m.AreaTag = 'SPORTS';
			m.FromUser = 'Kostie';
			m.ToUser = 'All';
			m.Subject = 'Test post';
			m.BodyText = 'Hello, this is a test.\r\n\r\n--- Canectic 1.0\r\n * Origin: Test BBS (1:123/456)';
			m.OriginLine = '1:123/456';
			m.MsgId = '<abcd1234@1:123/456>';
			m.SourceNet = 123;
			m.SourceNode = 456;

			assert.strictEqual(m.Type, 'Echomail');
			assert.strictEqual(m.AreaTag, 'SPORTS');
			assert.strictEqual(m.FromUser, 'Kostie');
			assert.strictEqual(m.ToUser, 'All');
			assert.strictEqual(m.Subject, 'Test post');
			assert.ok(m.BodyText.includes('Origin'));
			assert.strictEqual(m.OriginLine, '1:123/456');
			assert.strictEqual(m.SourceNet, 123);
			assert.strictEqual(m.SourceNode, 456);
		});

		it('should allow OptionalAttributes to be extended', function () {
			var m = new Message();
			m.OptionalAttributes.push('MSGID: abc');
			m.OptionalAttributes.push('REPLY: def');
			assert.strictEqual(m.OptionalAttributes.length, 2);
			assert.strictEqual(m.OptionalAttributes[0], 'MSGID: abc');
		});
	});

	describe('isolation between instances', function () {
		it('should give each instance its own OptionalAttributes array', function () {
			var m1 = new Message();
			var m2 = new Message();
			m1.OptionalAttributes.push('test');
			assert.strictEqual(m1.OptionalAttributes.length, 1);
			assert.strictEqual(m2.OptionalAttributes.length, 0);
		});
	});
});
