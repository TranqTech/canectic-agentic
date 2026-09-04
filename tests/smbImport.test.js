// tests/smbImport.test.js — Unit tests for the SMB import adapter.
//
// Covers smbToDbObj, which is pure, so no DB is involved. importSMB itself
// needs a database and is not covered here.
// Run: npx mocha tests/smbImport.test.js

import assert from 'assert';
import { smbToDbObj } from '../src/maintenance/smbImport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A parsed-SMB header with sensible defaults, as smbParser would produce it.
function header(overrides) {
	var base = {
		number: 1,
		attr: 0,
		whenWritten: { time: 1700000000, zone: 0 },
		sender: 'Alice',
		recipient: 'Bob',
		senderAddr: '1:2/3',
		recipientAddr: '1:2/4',
		subject: 'Test subject',
		msgId: '',
		replyId: '',
		fidoPid: '',
		fidoSeenBy: '',
		fidoPath: '',
		fidoCtrl: [],
		hfields: [],
		dfields: [],
	};
	return Object.assign(base, overrides || {});
}

function message(hdrOverrides, bodyText, tailText) {
	return {
		header: header(hdrOverrides),
		bodyText: bodyText !== undefined ? bodyText : 'Message body.',
		tailText: tailText !== undefined ? tailText : '',
	};
}

// ---------------------------------------------------------------------------
// smbToDbObj
// ---------------------------------------------------------------------------

describe('smbToDbObj', function () {

	it('should map the basic header fields', function () {
		var row = smbToDbObj(message({}), null);
		assert.strictEqual(row.from_user, 'Alice');
		assert.strictEqual(row.to_user, 'Bob');
		assert.strictEqual(row.subject, 'Test subject');
		assert.strictEqual(row.source, '1:2/3');
		assert.strictEqual(row.destination, '1:2/4');
		assert.strictEqual(row.user_id, 0);
	});

	it('should convert whenWritten to a Date', function () {
		var row = smbToDbObj(message({ whenWritten: { time: 1700000000, zone: 0 } }), null);
		assert.ok(row.system_time instanceof Date);
		assert.strictEqual(row.system_time.getTime(), 1700000000 * 1000);
	});

	it('should fall back to now when whenWritten is zero', function () {
		var before = Date.now();
		var row = smbToDbObj(message({ whenWritten: { time: 0, zone: 0 } }), null);
		assert.ok(row.system_time.getTime() >= before);
	});

	describe('MSGID tuple storage', function () {

		// The platform stores MSGID split across two columns: the serial in
		// msg_id, the origin address in msg_orig_addr. Matching ftnToDb here is
		// what lets dupe detection catch the same message arriving over FTN.

		it('should split MSGID into the tuple columns', function () {
			var row = smbToDbObj(message({ msgId: '1:229/426 5f2a1b3c' }), null);
			assert.strictEqual(row.msg_id, '5f2a1b3c');
			assert.strictEqual(row.msg_orig_addr, '1:229/426');
		});

		it('should split REPLY into the tuple columns', function () {
			var row = smbToDbObj(message({ replyId: '1:2/4 aabbccdd' }), null);
			assert.strictEqual(row.reply_to, 'aabbccdd');
			assert.strictEqual(row.reply_orig_addr, '1:2/4');
		});

		it('should never store the full MSGID string in msg_id', function () {
			var row = smbToDbObj(message({ msgId: '1:229/426 5f2a1b3c' }), null);
			assert.strictEqual(row.msg_id.indexOf(' '), -1);
			assert.strictEqual(row.msg_id.indexOf(':'), -1);
		});

		it('should treat a bare serial with no address as serial only', function () {
			var row = smbToDbObj(message({ msgId: 'deadbeef' }), null);
			assert.strictEqual(row.msg_id, 'deadbeef');
			assert.strictEqual(row.msg_orig_addr, '');
		});

		it('should synthesise a msg_id when the base carries no MSGID', function () {
			var row = smbToDbObj(message({ number: 42, msgId: '' }), null);
			assert.strictEqual(row.msg_id, 'smb-42');
			assert.strictEqual(row.msg_orig_addr, '');
		});

		it('should use an empty string, not null, for a missing reply', function () {
			var row = smbToDbObj(message({ replyId: '' }), null);
			assert.strictEqual(row.reply_to, '');
			assert.strictEqual(row.reply_orig_addr, '');
		});
	});

	describe('source_network_id', function () {

		it('should stamp source_network_id from the resolved target', function () {
			assert.strictEqual(smbToDbObj(message({}), { networkId: 7 }).source_network_id, 7);
		});

		it('should leave source_network_id null without a target', function () {
			assert.strictEqual(smbToDbObj(message({}), null).source_network_id, null);
		});

		it('should leave source_network_id null when the target has no network', function () {
			assert.strictEqual(smbToDbObj(message({}), { networkId: null }).source_network_id, null);
		});
	});

	describe('addresses', function () {

		it('should break the sender address into zone, net and node', function () {
			var row = smbToDbObj(message({ senderAddr: '2:250/1', recipientAddr: '3:770/1' }), null);
			assert.strictEqual(row.source_zone, 2);
			assert.strictEqual(row.source_net, 250);
			assert.strictEqual(row.source_node, 1);
			assert.strictEqual(row.destination_zone, 3);
			assert.strictEqual(row.destination_net, 770);
			assert.strictEqual(row.destination_node, 1);
		});

		it('should leave address parts null when there is no address', function () {
			var row = smbToDbObj(message({ senderAddr: '', recipientAddr: '' }), null);
			assert.strictEqual(row.source_zone, null);
			assert.strictEqual(row.source_net, null);
			assert.strictEqual(row.destination_node, null);
		});
	});

	describe('body and tail', function () {

		it('should join body and tail with CRLF', function () {
			var row = smbToDbObj(message({}, 'Body text', '--- tearline'), null);
			assert.strictEqual(row.body_text, 'Body text\r\n--- tearline');
		});

		it('should leave the body alone when there is no tail', function () {
			assert.strictEqual(smbToDbObj(message({}, 'Body only', ''), null).body_text, 'Body only');
		});

		it('should mirror body_text into the utf8 column', function () {
			var row = smbToDbObj(message({}, 'Body', 'Tail'), null);
			assert.strictEqual(row.utf8, row.body_text);
		});

		it('should extract the origin line from the tail', function () {
			var row = smbToDbObj(message({}, 'Text', '--- Sync\r\n * Origin: Some BBS (1:2/3)'), null);
			assert.strictEqual(row.origin_line, 'Some BBS (1:2/3)');
		});

		it('should leave origin_line empty when there is no origin', function () {
			assert.strictEqual(smbToDbObj(message({}, 'Just text', ''), null).origin_line, '');
		});

		it('should strip null bytes from body and tail', function () {
			var row = smbToDbObj(message({}, 'Bo\x00dy', 'Ta\x00il'), null);
			assert.strictEqual(row.body_text.indexOf('\x00'), -1);
		});
	});

	describe('defaults', function () {

		it('should default missing names and subject', function () {
			var row = smbToDbObj(message({ sender: '', recipient: '', subject: '' }), null);
			assert.strictEqual(row.from_user, 'Unknown');
			assert.strictEqual(row.to_user, 'All');
			assert.strictEqual(row.subject, '(no subject)');
		});

		it('should default tosser_id when the base has no PID', function () {
			assert.strictEqual(smbToDbObj(message({ fidoPid: '' }), null).tosser_id, 'SMB Import');
		});

		it('should use the PID as tosser_id when present', function () {
			assert.strictEqual(smbToDbObj(message({ fidoPid: 'SBBSecho 3.0' }), null).tosser_id, 'SBBSecho 3.0');
		});

		it('should carry SEEN-BY and PATH through', function () {
			var row = smbToDbObj(message({ fidoSeenBy: '1/1 2', fidoPath: '2/3' }), null);
			assert.strictEqual(row.seen_by, '1/1 2');
			assert.strictEqual(row.path, '2/3');
		});

		it('should give every row a distinct uuid', function () {
			var a = smbToDbObj(message({}), null);
			var b = smbToDbObj(message({}), null);
			assert.notStrictEqual(a.uuid, b.uuid);
			assert.ok(a.uuid.length > 0);
		});
	});
});
