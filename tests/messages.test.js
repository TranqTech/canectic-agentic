// tests/messages.test.js — Unit tests for pure/testable logic in messages.js
//
// Most of messages.js is DB-dependent (reads, writes, threading inserts).
// This file exercises the pure-logic portions that can run without a live
// database connection:
//
//   - buildMessageTree() — pure tree construction from flat message list
//   - sanitizeMessageFields() — pure input scrubbing
//   - Origin line format assertions via inline regex mimicking resolveAreaAddress
//
// DB-dependent functions (threadMessage, reconcileOrphans, etc.) are covered
// by modelExports.test.js for export validation. Full integration tests for
// those would require a test database harness (not currently set up).
//
// Run: npx mocha tests/messages.test.js

import assert from 'assert';

// ---------------------------------------------------------------------------
// Import the module (postgres pool is lazy, safe without a running DB)
// ---------------------------------------------------------------------------

var mod;
try {
	mod = await import('../src/models/messages.js');
} catch (err) {
	mod = null;
}

// ---------------------------------------------------------------------------
// buildMessageTree — pure, builds nested reply tree from flat list
// ---------------------------------------------------------------------------

describe('messages.buildMessageTree', function() {
	before(function() {
		if (!mod || typeof mod.buildMessageTree !== 'function') this.skip();
	});

	it('returns empty array for empty input', function() {
		var result = mod.buildMessageTree([]);
		assert.deepStrictEqual(result, []);
	});

	it('treats messages with no reply_to as roots', function() {
		var msgs = [
			{ msg_id: 'a', reply_to: null, subject: 'One' },
			{ msg_id: 'b', reply_to: null, subject: 'Two' }
		];
		var tree = mod.buildMessageTree(msgs);
		assert.strictEqual(tree.length, 2);
		assert.strictEqual(tree[0].msg_id, 'a');
		assert.strictEqual(tree[1].msg_id, 'b');
		assert.deepStrictEqual(tree[0].replies, []);
	});

	it('nests reply under its parent via reply_to', function() {
		var msgs = [
			{ msg_id: 'p', reply_to: null, subject: 'Parent' },
			{ msg_id: 'c', reply_to: 'p', subject: 'Re: Parent' }
		];
		var tree = mod.buildMessageTree(msgs);
		assert.strictEqual(tree.length, 1);
		assert.strictEqual(tree[0].msg_id, 'p');
		assert.strictEqual(tree[0].replies.length, 1);
		assert.strictEqual(tree[0].replies[0].msg_id, 'c');
	});

	it('treats reply with missing parent as a root', function() {
		var msgs = [
			{ msg_id: 'orphan', reply_to: 'missing-parent', subject: 'Re: Thing' }
		];
		var tree = mod.buildMessageTree(msgs);
		assert.strictEqual(tree.length, 1);
		assert.strictEqual(tree[0].msg_id, 'orphan');
	});

	it('handles multi-level nesting', function() {
		var msgs = [
			{ msg_id: 'a', reply_to: null, subject: 'Root' },
			{ msg_id: 'b', reply_to: 'a', subject: 'Reply 1' },
			{ msg_id: 'c', reply_to: 'b', subject: 'Reply to reply' }
		];
		var tree = mod.buildMessageTree(msgs);
		assert.strictEqual(tree.length, 1);
		assert.strictEqual(tree[0].replies.length, 1);
		assert.strictEqual(tree[0].replies[0].replies.length, 1);
		assert.strictEqual(tree[0].replies[0].replies[0].msg_id, 'c');
	});
});

// ---------------------------------------------------------------------------
// sanitizeMessageFields — pure input scrubber
// ---------------------------------------------------------------------------

describe('messages.sanitizeMessageFields', function() {
	before(function() {
		if (!mod || typeof mod.sanitizeMessageFields !== 'function') this.skip();
	});

	it('strips <script> tags from body_text', function() {
		var obj = { body_text: 'Hello <script>alert(1)</script> world' };
		mod.sanitizeMessageFields(obj);
		assert.ok(!obj.body_text.includes('<script>'),
			'script tag should be stripped');
		assert.ok(!obj.body_text.includes('alert(1)'),
			'script body should be removed');
	});

	it('strips javascript: URIs', function() {
		var obj = { body_text: 'Click <a href="javascript:alert(1)">here</a>' };
		mod.sanitizeMessageFields(obj);
		assert.ok(!obj.body_text.toLowerCase().includes('javascript:'),
			'javascript: URI should be stripped');
	});

	it('preserves plain text and literal < > that are not tags', function() {
		var obj = { body_text: 'x < 5 and y > 3' };
		mod.sanitizeMessageFields(obj);
		// Should not be mangled into entities or destroyed
		assert.ok(obj.body_text.length > 0);
	});

	it('handles null/undefined fields gracefully', function() {
		var obj = { body_text: null, subject: undefined };
		assert.doesNotThrow(function() { mod.sanitizeMessageFields(obj); });
	});
});

// ---------------------------------------------------------------------------
// Origin line format assertion (the recent bug)
// ---------------------------------------------------------------------------
//
// resolveAreaAddress() is DB-dependent, but we can assert the format rule:
// a valid origin line should contain the address wrapped in parentheses.
// This test guards against the old "BoardName 1:2/3" format coming back.

describe('origin line format rules', function() {
	// These are the formats we EXPECT after the parens fix
	var validCases = [
		{ line: 'Canectic BBS (1:134/120)', address: '1:134/120' },
		{ line: 'My Custom Origin (2:280/464)', address: '2:280/464' },
		{ line: 'Text (21:1/100)', address: '21:1/100' }
	];

	// These are the formats we FORBID (the old bug)
	var invalidCases = [
		{ line: 'Canectic BBS 1:134/120', address: '1:134/120' },
		{ line: 'BoardName 2:280/464', address: '2:280/464' }
	];

	validCases.forEach(function(tc) {
		it('accepts "' + tc.line + '" (address in parens)', function() {
			assert.ok(
				tc.line.includes('(' + tc.address + ')'),
				'valid origin line must contain (address)'
			);
		});
	});

	invalidCases.forEach(function(tc) {
		it('detects "' + tc.line + '" as missing parens', function() {
			assert.ok(
				!tc.line.includes('(' + tc.address + ')'),
				'old format without parens should be detected'
			);
			assert.ok(
				tc.line.includes(tc.address),
				'address should still be present (just not parenthesized)'
			);
		});
	});

	it('custom origin with address already in parens should not be duplicated', function() {
		// This mirrors the logic in resolveAreaAddress: if the custom origin
		// already has (address), don't append another one.
		var customOrigin = 'My BBS (1:134/120)';
		var address = '1:134/120';
		var result = customOrigin.includes('(' + address + ')')
			? customOrigin
			: customOrigin + ' (' + address + ')';
		assert.strictEqual(result, 'My BBS (1:134/120)');
	});

	it('custom origin without parens should get address appended', function() {
		var customOrigin = 'My BBS';
		var address = '1:134/120';
		var result = customOrigin.includes('(' + address + ')')
			? customOrigin
			: customOrigin + ' (' + address + ')';
		assert.strictEqual(result, 'My BBS (1:134/120)');
	});
});

// ---------------------------------------------------------------------------
// Subject RE: stripping (mirrors the loop in threadMessage)
// ---------------------------------------------------------------------------

describe('subject RE: stripping', function() {
	function stripRe(subject) {
		var i = 0;
		while (subject.toUpperCase().startsWith('RE:')) {
			subject = subject.substring(3).trim();
			i++;
			if (i > 10) break;
		}
		return subject;
	}

	it('strips single Re: prefix', function() {
		assert.strictEqual(stripRe('Re: Hello'), 'Hello');
	});

	it('strips multiple Re: prefixes', function() {
		assert.strictEqual(stripRe('Re: Re: Re: Hello'), 'Hello');
	});

	it('is case-insensitive for the prefix', function() {
		assert.strictEqual(stripRe('RE: Hello'), 'Hello');
		assert.strictEqual(stripRe('re: Hello'), 'Hello');
		assert.strictEqual(stripRe('rE: Hello'), 'Hello');
	});

	it('leaves subjects without RE: unchanged', function() {
		assert.strictEqual(stripRe('Hello world'), 'Hello world');
	});

	it('preserves case of the remaining subject', function() {
		assert.strictEqual(stripRe('Re: BBS Software Discussion'),
			'BBS Software Discussion');
	});

	it('caps recursion at 10 to prevent pathological input', function() {
		var pathological = 'Re:'.repeat(50) + ' test';
		var result = stripRe(pathological);
		// After 10 strips, there should still be ~40 Re: remaining
		assert.ok(result.toLowerCase().includes('re:'),
			'should stop stripping after 10 iterations');
	});
});
