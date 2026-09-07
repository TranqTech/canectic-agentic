// tests/floFile.test.js: flow files that outlive their contents.
//
// The reported symptom was a peer configured to poll every 240 minutes being
// called every minute. The poll schedule was correct and had nothing to do with
// it. The BSO scanner decides a node has mail from the *filename* alone, so a
// flow file with nothing left to send still read as pending work: it triggered a
// session, the session skipped every line and sent nothing, nothing removed the
// flow file, and it happened again on the next scan. With the scan interval at
// its default of 60 seconds, that is one connection a minute indefinitely.
//
// Two ways a flow file gets into that state, and both are covered here:
//
//   1. Every line already marked ~. TransferEngine only deleted the flow file
//      when a line changed to ~ during that session, so one whose last line was
//      marked in an earlier session was never removed.
//   2. Lines pointing at files that no longer exist. Both readers skipped a
//      missing file silently, so its line was never marked and the file never
//      drained.
//
// Real files in a temp directory, because the whole bug is about what is on
// disk versus what a filename implies.
//
// Run: npx mocha

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

var floFile = null;
try { floFile = await import('../src/utils/floFile.js'); } catch (_) { floFile = null; }

describe('floFile', function () {
	var dir = null;

	beforeEach(function () {
		if (!floFile) this.skip();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-flo-'));
	});

	afterEach(function () {
		if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
	});

	function realFile(name) {
		var p = path.join(dir, name);
		fs.writeFileSync(p, 'x');
		return p;
	}

	function flo(lines) {
		var p = path.join(dir, '00860065.flo');
		fs.writeFileSync(p, lines.join('\n') + '\n');
		return p;
	}

	// -----------------------------------------------------------------------
	// parsing
	// -----------------------------------------------------------------------

	describe('parseFlowLine', function () {
		it('reads the four line forms', function () {
			assert.deepStrictEqual(floFile.parseFlowLine('/a/b.pkt'),
				{ raw: '/a/b.pkt', prefix: '', filepath: '/a/b.pkt', sent: false });
			assert.strictEqual(floFile.parseFlowLine('^/a/b.pkt').prefix, '^');
			assert.strictEqual(floFile.parseFlowLine('#/a/b.pkt').prefix, '#');
			assert.strictEqual(floFile.parseFlowLine('~/a/b.pkt').sent, true);
		});

		it('strips the CR that survives a split on newline', function () {
			// Flow files written on DOS systems are still in circulation, and a
			// trailing CR makes every existsSync miss.
			assert.strictEqual(floFile.parseFlowLine('/a/b.pkt\r').filepath, '/a/b.pkt');
		});

		it('returns null for a blank line', function () {
			assert.strictEqual(floFile.parseFlowLine(''), null);
			assert.strictEqual(floFile.parseFlowLine('   '), null);
			assert.strictEqual(floFile.parseFlowLine(null), null);
		});
	});

	// -----------------------------------------------------------------------
	// pendingCount: the honest answer to "is there mail waiting"
	// -----------------------------------------------------------------------

	describe('pendingCount', function () {
		it('counts only lines whose file exists and is unsent', function () {
			var a = realFile('a.pkt');
			var b = realFile('b.pkt');
			var p = flo([a, '~' + b, path.join(dir, 'gone.pkt')]);
			assert.strictEqual(floFile.pendingCount(p), 1);
		});

		it('reports zero for a flow file where everything is already sent', function () {
			// The exact state that kept triggering a session every minute.
			var p = flo(['~' + realFile('a.pkt'), '~' + realFile('b.pkt')]);
			assert.strictEqual(floFile.pendingCount(p), 0);
		});

		it('reports zero when every referenced file has vanished', function () {
			var p = flo([path.join(dir, 'gone1.pkt'), path.join(dir, 'gone2.pkt')]);
			assert.strictEqual(floFile.pendingCount(p), 0);
		});

		it('reports zero for a file that does not exist', function () {
			assert.strictEqual(floFile.pendingCount(path.join(dir, 'nope.flo')), 0);
		});
	});

	// -----------------------------------------------------------------------
	// pruneFlowFile: the fix
	// -----------------------------------------------------------------------

	describe('pruneFlowFile', function () {
		it('deletes a flow file whose lines are all already sent', function () {
			var p = flo(['~' + realFile('a.pkt'), '~' + realFile('b.pkt')]);
			var r = floFile.pruneFlowFile(p);
			assert.strictEqual(r.deleted, true);
			assert.strictEqual(fs.existsSync(p), false,
				'an exhausted flow file has to go, or it reads as pending mail for ever');
		});

		it('deletes a flow file whose files have all vanished', function () {
			var p = flo([path.join(dir, 'gone1.pkt'), path.join(dir, 'gone2.pkt')]);
			var r = floFile.pruneFlowFile(p);
			assert.strictEqual(r.vanished, 2);
			assert.strictEqual(r.deleted, true);
			assert.strictEqual(fs.existsSync(p), false);
		});

		it('deletes an empty flow file', function () {
			var p = path.join(dir, '00860065.flo');
			fs.writeFileSync(p, '\n\n');
			assert.strictEqual(floFile.pruneFlowFile(p).deleted, true);
		});

		it('keeps a flow file that still has something to send', function () {
			var a = realFile('a.pkt');
			var p = flo([a]);
			var r = floFile.pruneFlowFile(p);
			assert.strictEqual(r.pending, 1);
			assert.strictEqual(r.deleted, false);
			assert.strictEqual(fs.existsSync(p), true,
				'pruning must never throw away mail that has not been sent');
		});

		it('marks vanished lines but keeps the file when others are pending', function () {
			var a = realFile('a.pkt');
			var p = flo([path.join(dir, 'gone.pkt'), a]);
			var r = floFile.pruneFlowFile(p);

			assert.strictEqual(r.vanished, 1);
			assert.strictEqual(r.pending, 1);
			assert.strictEqual(r.deleted, false);

			var after = fs.readFileSync(p, 'utf8');
			assert.ok(after.indexOf('~' + path.join(dir, 'gone.pkt')) !== -1,
				'the vanished line should be marked so the file can drain later');
			assert.ok(after.indexOf(a) !== -1, 'the pending line must survive');
		});

		it('preserves the action prefix on lines it keeps', function () {
			// ^ means delete after sending and # means truncate. Losing either
			// would leave sent mail on disk to be sent again.
			var a = realFile('a.pkt');
			var b = realFile('b.pkt');
			var p = flo(['^' + a, '#' + b, path.join(dir, 'gone.pkt')]);
			floFile.pruneFlowFile(p);

			var lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
			assert.ok(lines.some(function (l) { return l === '^' + a; }), 'lost ^ prefix');
			assert.ok(lines.some(function (l) { return l === '#' + b; }), 'lost # prefix');
		});

		it('is idempotent', function () {
			var a = realFile('a.pkt');
			var p = flo([path.join(dir, 'gone.pkt'), a]);
			floFile.pruneFlowFile(p);
			var first = fs.readFileSync(p, 'utf8');
			floFile.pruneFlowFile(p);
			assert.strictEqual(fs.readFileSync(p, 'utf8'), first,
				'the scanner runs this every cycle; it must settle');
		});

		it('does nothing to a flow file that does not exist', function () {
			var r = floFile.pruneFlowFile(path.join(dir, 'nope.flo'));
			assert.strictEqual(r.existed, false);
			assert.strictEqual(r.deleted, false);
		});

		it('reports without writing under dryRun', function () {
			var p = flo([path.join(dir, 'gone.pkt')]);
			var r = floFile.pruneFlowFile(p, { dryRun: true });
			assert.strictEqual(r.vanished, 1);
			assert.strictEqual(r.deleted, false);
			assert.strictEqual(fs.existsSync(p), true, 'dryRun must not delete');
		});

		it('leaves the loop unable to restart once it has run', function () {
			// The whole point, end to end: a flow file in the state that caused
			// the every-minute connections is gone afterwards, so the next scan
			// finds nothing and triggers nothing.
			var p = flo(['~' + realFile('sent.pkt'), path.join(dir, 'gone.pkt')]);
			assert.strictEqual(floFile.pendingCount(p), 0, 'nothing was actually sendable');
			floFile.pruneFlowFile(p);
			assert.strictEqual(fs.existsSync(p), false);
		});
	});
});

describe('TransferEngine flow file housekeeping', function () {
	var TransferEngine = null, EventEmitter = null;
	var dir = null;

	before(async function () {
		try {
			TransferEngine = (await import('../src/mailer/transfer.js')).TransferEngine;
			EventEmitter = (await import('node:events')).EventEmitter;
		} catch (_) { this.skip(); }
	});

	beforeEach(function () {
		if (!TransferEngine) this.skip();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-flo-tx-'));
	});

	afterEach(function () {
		if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
	});

	function engine() {
		var protocol = new EventEmitter();
		protocol.offerFile = function () {};
		protocol.sendFileData = function () {};
		return new TransferEngine(protocol, {
			inboundDir: dir, tempDir: dir, sessionId: 'zz-test'
		});
	}

	it('deletes the flow file when the last line was marked in an earlier session', function () {
		// Deletion used to be gated on whether this call changed a line. A flow
		// file whose last line was marked previously therefore survived: nothing
		// changed this time, so nothing checked whether anything was left. It
		// then read as pending mail on every BSO scan, for ever.
		var a = path.join(dir, 'a.pkt');
		fs.writeFileSync(a, 'x');
		var flo = path.join(dir, '00860065.flo');
		fs.writeFileSync(flo, '~' + a + '\n');

		engine()._markFloLineSent(flo, a);

		assert.strictEqual(fs.existsSync(flo), false,
			'an exhausted flow file has to go even when this call marked nothing');
	});

	it('still deletes the flow file when this call marks the last line', function () {
		var a = path.join(dir, 'a.pkt');
		fs.writeFileSync(a, 'x');
		var flo = path.join(dir, '00860065.flo');
		fs.writeFileSync(flo, a + '\n');

		engine()._markFloLineSent(flo, a);
		assert.strictEqual(fs.existsSync(flo), false);
	});

	it('keeps the flow file while another line is still pending', function () {
		var a = path.join(dir, 'a.pkt');
		var b = path.join(dir, 'b.pkt');
		fs.writeFileSync(a, 'x');
		fs.writeFileSync(b, 'x');
		var flo = path.join(dir, '00860065.flo');
		fs.writeFileSync(flo, a + '\n' + b + '\n');

		engine()._markFloLineSent(flo, a);

		assert.strictEqual(fs.existsSync(flo), true, 'b has not been sent yet');
		var after = fs.readFileSync(flo, 'utf8');
		assert.ok(after.indexOf('~' + a) !== -1, 'a should be marked');
		assert.ok(/^[^~]/m.test(after.split('\n').filter(function (l) {
			return l.indexOf('b.pkt') !== -1;
		})[0] || ''), 'b should still be unmarked');
	});

	it('marks a line whose file vanishes between queueing and sending', function () {
		// _offerNextFile skipped a file that disappeared under it without
		// marking its line. The line could never do anything again but it kept
		// the flow file alive, and a flow file that outlives its contents is
		// read as pending mail on every BSO scan.
		//
		// Note this is the race, not the already-missing case: queueFile stats
		// the file and refuses to queue one that is gone, so a file missing
		// before the session starts never reaches here. That case is handled by
		// pruneFlowFile in the outbound list builders and the scanner.
		var doomed = path.join(dir, 'doomed.pkt');
		fs.writeFileSync(doomed, 'x');
		var flo = path.join(dir, '00860065.flo');
		fs.writeFileSync(flo, doomed + '\n');

		var e = engine();
		e.queueFile(doomed, { floFile: flo, floPrefix: '' });

		// Another session sends and deletes it before this one gets to it.
		fs.unlinkSync(doomed);

		e.startSending();

		assert.strictEqual(fs.existsSync(flo), false,
			'the only line pointed at a file that is now gone, so the flow file should be gone too');
	});

	it('does not queue a file that is already missing', function () {
		// Documents why the prune in the outbound list builders is needed as
		// well: this path never sees an already-missing file at all.
		var gone = path.join(dir, 'gone.pkt');
		var e = engine();
		e.queueFile(gone, { floFile: path.join(dir, 'x.flo'), floPrefix: '' });
		assert.strictEqual(e._sendQueue.length, 0);
	});
});
