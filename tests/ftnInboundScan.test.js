// tests/ftnInboundScan.test.js: what the inbound scanner does with things that
// are not files.
//
// Sysops keep subdirectories in the inbound. ftn/in/Old is the usual one. The
// type sniffer read every directory entry with readFile, so each pass over the
// inbound threw EISDIR on the directory and dumped a stack trace through
// console.error, outside the log bus and outside the configured level. At the
// inbound scan interval that is a trace every few minutes for ever, and on a
// live hub it buried the lines that mattered.
//
// It also read whole files into memory purely to look at their first few bytes,
// which on an inbound holding arcmail bundles or TIC attachments is a lot of
// memory for a magic number.
//
// Run: npx mocha

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

var tosser = null;
try { tosser = await import('../src/middleware/tossers/ftnTosser.js'); } catch (_) { /* skip */ }

describe('ftnTosser.getFileType', function () {
	this.timeout(10000);

	var dir = null;

	before(function () {
		if (!tosser || !tosser.getFileType) this.skip();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-inbound-'));
	});

	after(function () {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('treats a subdirectory as "not ours" instead of erroring', async function () {
		var sub = path.join(dir, 'Old');
		fs.mkdirSync(sub, { recursive: true });

		// null is the same answer an unrecognised file gives, which is what the
		// callers already handle: they fall through to the extension check and
		// leave the entry alone. `false` is the error signal, and returning it
		// here is what produced the log spam.
		assert.strictEqual(await tosser.getFileType(sub), null);
	});

	it('logs nothing to console.error for a subdirectory', async function () {
		var sub = path.join(dir, 'Old2');
		fs.mkdirSync(sub, { recursive: true });

		var original = console.error;
		var calls = [];
		console.error = function () { calls.push(Array.from(arguments)); };
		try {
			await tosser.getFileType(sub);
		} finally {
			console.error = original;
		}

		assert.deepStrictEqual(calls, [],
			'a directory in the inbound is ordinary, not an error worth a stack trace');
	});

	it('still identifies a real archive', async function () {
		// Minimal ZIP: an end-of-central-directory record is enough for the
		// sniffer, and proves the switch away from readFile still detects the
		// types the bundle handling depends on.
		var zip = path.join(dir, 'test.zip');
		var eocd = Buffer.alloc(22);
		eocd.write('PK\x05\x06', 0, 'binary');
		fs.writeFileSync(zip, eocd);

		assert.strictEqual(await tosser.getFileType(zip), 'zip');
	});

	it('returns null for a packet, which has no magic number', async function () {
		var pkt = path.join(dir, 'test.pkt');
		fs.writeFileSync(pkt, Buffer.alloc(64));

		// Callers rely on this: a null or false answer sends the entry to the
		// extension check, which is how .pkt files get tossed at all.
		assert.strictEqual(await tosser.getFileType(pkt), null);
	});

	it('reports a vanished file as GONE rather than an error', async function () {
		// Another processor moving a file out between readdir and stat is a
		// benign race, not a fault.
		assert.strictEqual(await tosser.getFileType(path.join(dir, 'nope.pkt')), 'GONE');
	});
});
