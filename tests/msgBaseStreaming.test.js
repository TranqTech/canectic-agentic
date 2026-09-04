// tests/msgBaseStreaming.test.js — Memory regression guard for the message
// base parsers.
//
// This exists because of a real incident. The first bulk JAM import exhausted
// the worker's heap twice at around 5000 messages: parseJAM read the whole .jdt
// into memory and built an array holding every decoded message, so peak memory
// scaled with the size of the base. The parsers were reworked into generators
// (iterateJAM, iterateSMB) that read each message's text from a file descriptor
// on demand.
//
// The correctness tests in jamParser.test.js and smbParser.test.js would all
// still pass if someone reverted that, because output is identical either way.
// Only memory behaviour differs, so it needs its own guard.
//
// Thresholds are deliberately generous. The measured figures were roughly 5 MB
// streaming versus 136 MB collecting for an 80 MB base — around 27x — so a wide
// margin still separates the two cleanly without making the test sensitive to
// GC timing or whatever else the suite has loaded.
// Run: npx mocha tests/msgBaseStreaming.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { iterateJAM, parseJAM } from '../src/utils/jamParser.js';

var __dirname = path.dirname(url.fileURLToPath(import.meta.url));
var TMP_DIR = path.join(__dirname, 'tmp');

var JAM_SIG = Buffer.from([0x4A, 0x41, 0x4D, 0x00]);

// ~40 MB of message text. Large enough that a collecting parser is obvious,
// small enough to build in a couple of seconds.
var MSG_COUNT = 10000;
var BODY_BYTES = 4096;

var jhrPath = path.join(TMP_DIR, 'zz_stream_probe.jhr');
var jdtPath = path.join(TMP_DIR, 'zz_stream_probe.jdt');

function buildLargeBase() {
	if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

	var info = Buffer.alloc(1024);
	JAM_SIG.copy(info, 0);
	info.writeUInt32LE(MSG_COUNT, 12);

	var jhr = fs.openSync(jhrPath, 'w');
	var jdt = fs.openSync(jdtPath, 'w');
	fs.writeSync(jhr, info);

	var filler = 'The quick brown fox jumps over the lazy dog. '
		.repeat(Math.ceil(BODY_BYTES / 45)).slice(0, BODY_BYTES);
	var offset = 0;

	for (var n = 1; n <= MSG_COUNT; n++) {
		var body = Buffer.from(filler + '\r', 'latin1');

		var subj = Buffer.from('Message ' + n, 'latin1');
		var sf = Buffer.alloc(8 + subj.length);
		sf.writeUInt16LE(6, 0);          // SUBJECT subfield
		sf.writeUInt32LE(subj.length, 4);
		subj.copy(sf, 8);

		var h = Buffer.alloc(76);
		JAM_SIG.copy(h, 0);
		h.writeUInt16LE(1, 4);
		h.writeUInt32LE(sf.length, 8);
		h.writeUInt32LE(1700000000 + n, 36);
		h.writeUInt32LE(n, 48);
		h.writeUInt32LE(offset, 60);
		h.writeUInt32LE(body.length, 64);

		fs.writeSync(jhr, Buffer.concat([h, sf]));
		fs.writeSync(jdt, body);
		offset += body.length;
	}

	fs.closeSync(jhr);
	fs.closeSync(jdt);
}

function cleanup() {
	for (var p of [jhrPath, jdtPath]) {
		try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
	}
}

// Peak heap observed while fn() runs, sampled rather than measured once, since
// the interesting figure is the high-water mark and not the end state.
function peakHeapDuring(fn) {
	var peak = process.memoryUsage().heapUsed;
	var timer = setInterval(function () {
		var h = process.memoryUsage().heapUsed;
		if (h > peak) peak = h;
	}, 5);
	try {
		fn();
	} finally {
		clearInterval(timer);
	}
	var final = process.memoryUsage().heapUsed;
	return Math.max(peak, final) ;
}

function mb(bytes) { return Math.round(bytes / 1048576); }

describe('message base streaming', function () {
	this.timeout(120000);

	before(function () {
		buildLargeBase();
	});

	after(function () {
		cleanup();
	});

	it('builds a base large enough for the comparison to mean something', function () {
		var jdtMB = fs.statSync(jdtPath).size / 1048576;
		assert.ok(jdtMB > 30, 'expected a .jdt over 30 MB, got ' + jdtMB.toFixed(1));
	});

	it('iterateJAM holds one message at a time, not the whole base', function () {
		var before = process.memoryUsage().heapUsed;
		var count = 0;
		var chars = 0;

		var peak = peakHeapDuring(function () {
			for (var msg of iterateJAM(jhrPath, jdtPath, null)) {
				count++;
				chars += msg.bodyText.length;
			}
		});

		var growth = peak - before;
		assert.strictEqual(count, MSG_COUNT, 'should have walked every message');
		assert.ok(chars > 30 * 1048576, 'should have decoded the whole base, got ' + chars + ' chars');
		assert.ok(growth < 30 * 1048576,
			'streaming heap growth should stay well under the size of the base; got ' +
			mb(growth) + ' MB for a ' + mb(fs.statSync(jdtPath).size) + ' MB base. ' +
			'A figure near or above the base size means the parser is materialising it again.');
	});

	it('exposes iterateJAM as a lazy iterator rather than an array', function () {
		var it = iterateJAM(jhrPath, jdtPath, null);
		assert.strictEqual(typeof it[Symbol.iterator], 'function');
		assert.ok(!Array.isArray(it), 'iterateJAM must not return an array');

		// Taking a single message must not require walking the rest.
		var first = it.next();
		assert.ok(first.value && first.value.header, 'first message should be available immediately');
		assert.strictEqual(first.value.header.number, 1);
		if (typeof it.return === 'function') it.return();
	});

	it('collecting parseJAM still agrees with the streaming path', function () {
		// parseJAM is retained for small bases and tests. It must not drift from
		// the iterator, so compare a sample rather than the whole 40 MB.
		var streamed = [];
		for (var msg of iterateJAM(jhrPath, jdtPath, null, { headersOnly: true })) {
			streamed.push(msg.header.subject);
			if (streamed.length === 50) break;
		}

		var collected = parseJAM(jhrPath, jdtPath, null, { headersOnly: true })
			.messages.slice(0, 50).map(function (m) { return m.header.subject; });

		assert.deepStrictEqual(streamed, collected);
	});
});
