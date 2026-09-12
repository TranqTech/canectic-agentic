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

describe('ftnTosser.isTossableInboundFile', function () {
	before(function () { if (!tosser || !tosser.isTossableInboundFile) this.skip(); });

	// The periodic inbound scan is the backstop for mail that nobody claimed.
	// In normal operation it never fires, because the mailer enqueues a toss
	// itself the moment a file arrives. It only matters when that enqueue did
	// not happen: the worker was down, the process restarted between receipt
	// and enqueue, or a bundle was put there by hand or recovered from a
	// filebox. The scan tested for a literal .pkt and nothing else, so an
	// arcmail bundle sat in the inbound for ever, and the one case the
	// backstop existed for was the one case it did not cover.

	it('claims a packet', function () {
		assert.strictEqual(tosser.isTossableInboundFile('1a2b3c4d.pkt'), true);
	});

	it('claims a packet whatever the case of the extension', function () {
		assert.strictEqual(tosser.isTossableInboundFile('1A2B3C4D.PKT'), true);
	});

	it('claims an arcmail bundle for every day of the week', function () {
		// FTS-5000 / FSC-0057: day prefix plus one counter character.
		for (var name of ['abcd0001.mo0', 'abcd0001.tu5', 'abcd0001.we9',
		                  'abcd0001.thf', 'abcd0001.fr1', 'abcd0001.sa0',
		                  'abcd0001.suz']) {
			assert.strictEqual(tosser.isTossableInboundFile(name), true, name + ' is mail');
		}
	});

	it('leaves archives that are not mail bundles alone', function () {
		// TIC attachments, nodelist archives and infopacks have their own
		// processors. Claiming them here would have the FTN toss trying to
		// extract packets out of a file area upload.
		for (var name of ['nodelist.z12', 'fsxnet.zip', 'infopack.zip', 'somefile.arj']) {
			assert.strictEqual(tosser.isTossableInboundFile(name), false, name + ' is not mail');
		}
	});

	it('does not claim a TIC descriptor', function () {
		// The TIC path enqueues its own job.
		assert.strictEqual(tosser.isTossableInboundFile('abcd0001.tic'), false);
	});

	it('does not claim a bare directory name', function () {
		assert.strictEqual(tosser.isTossableInboundFile('Old'), false);
	});

	it('survives an empty or missing name', function () {
		assert.strictEqual(tosser.isTossableInboundFile(''), false);
		assert.strictEqual(tosser.isTossableInboundFile(null), false);
		assert.strictEqual(tosser.isTossableInboundFile(undefined), false);
	});
});
