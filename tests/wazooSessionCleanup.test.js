// tests/wazooSessionCleanup.test.js -- what an EMSI/Wazoo session does with
// the files it has sent and received (#81).
//
// binkp cleaned up on M_GOT: packets deleted, flow file lines marked ~ (and the
// file deleted or truncated per its prefix). The Wazoo path did none of it, so
// an EMSI peer was offered the same packets on every session. It also never
// counted received files for the toss, and the manager tosses after a session
// only when that count is non-zero.
//
// Drives SessionController._runWazooTransfer against a WazooTransferEngine on
// the other end of a paired in-memory transport. The receive path writes a
// real inbound_file_log row, removed in after() by its temp-directory path.

import assert from 'assert';
import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionController } from '../src/mailer/session.js';
import { WazooTransferEngine } from '../src/mailer/wazooTransfer.js';
import * as postgres from '../src/middleware/db/postgres.js';

function pairedTransports() {
	var a = new EventEmitter();
	var b = new EventEmitter();
	a.write = function(buf) { setImmediate(function() { b.emit('data', Buffer.from(buf)); }); };
	b.write = function(buf) { setImmediate(function() { a.emit('data', Buffer.from(buf)); }); };
	a.close = function() {};
	b.close = function() {};
	return { ours: a, theirs: b };
}

describe('Wazoo session: sent file cleanup (#81)', function() {
	this.timeout(30000);

	var base, outDir, inDir, peerIn, tmpDir, dataDir;

	beforeEach(function() {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'wazoo-session-'));
		outDir = path.join(base, 'out');
		inDir = path.join(base, 'in');
		peerIn = path.join(base, 'peer-in');
		tmpDir = path.join(base, 'tmp');
		dataDir = path.join(base, 'data');
		for (var d of [outDir, inDir, peerIn, tmpDir, dataDir]) fs.mkdirSync(d);
	});

	afterEach(function() {
		fs.rmSync(base, { recursive: true, force: true });
	});

	after(async function() {
		// logFile is fire-and-forget in the session; let it land first.
		await new Promise(function(r) { setTimeout(r, 200); });
		await postgres.write('DELETE FROM inbound_file_log WHERE filepath LIKE $1',
			[path.join(os.tmpdir(), 'wazoo-session-') + '%']);
	});

	async function runSession(peerSends) {
		var pair = pairedTransports();
		var session = new SessionController(pair.ours, 'answerer', {
			outboundDir: outDir, inboundDir: inDir, tempDir: tmpDir
		});
		// 1:2/3 -> 00020003
		session.peerConnection = { id: null, connection_data: { address: '1:2/3' } };
		var ended = null;
		session._endSession = function(reason) { ended = reason; };
		session._logOutboundFile = function() {};

		var peer = new WazooTransferEngine(pair.theirs, {
			role: 'caller', inboundDir: peerIn, tempDir: tmpDir,
			outboundFiles: peerSends || [], sessionId: 'peer'
		});
		var results = await Promise.all([session._runWazooTransfer(), peer.run()]);
		assert.ok(results[1].success, 'peer side: ' + results[1].error);
		assert.strictEqual(ended, 'complete');
		return session;
	}

	it('deletes a direct packet once the peer has it', async function() {
		var pkt = path.join(outDir, '00020003.out');
		fs.writeFileSync(pkt, 'packet bytes');

		await runSession();

		assert.ok(fs.existsSync(path.join(peerIn, '00020003.out')), 'peer should have received it');
		assert.ok(!fs.existsSync(pkt), 'sent packet should be deleted');
	});

	it('honours flow file prefixes and removes the exhausted flow file', async function() {
		var kill = path.join(dataDir, 'kill.pkt');
		var trunc = path.join(dataDir, 'trunc.tic');
		var keep = path.join(dataDir, 'keep.zip');
		fs.writeFileSync(kill, 'delete me');
		fs.writeFileSync(trunc, 'truncate me');
		fs.writeFileSync(keep, 'leave me');
		var flo = path.join(outDir, '00020003.flo');
		fs.writeFileSync(flo, '^' + kill + '\n#' + trunc + '\n' + keep + '\n');

		await runSession();

		assert.ok(!fs.existsSync(kill), '^ entry should be deleted');
		assert.strictEqual(fs.statSync(trunc).size, 0, '# entry should be truncated');
		assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'leave me', 'bare entry should be left alone');
		assert.ok(!fs.existsSync(flo), 'flow file with every line sent should be removed');
	});

	it('does not offer the same packet on the next session', async function() {
		fs.writeFileSync(path.join(outDir, '00020003.out'), 'once only');

		var first = await runSession();
		assert.strictEqual(first.filesSent, 1);

		fs.rmSync(path.join(peerIn, '00020003.out'));
		var second = await runSession();
		assert.strictEqual(second.filesSent, 0);
		assert.ok(!fs.existsSync(path.join(peerIn, '00020003.out')));
	});

	it('counts received files for the post-session toss', async function() {
		var theirPkt = path.join(dataDir, 'abcd0001.pkt');
		fs.writeFileSync(theirPkt, 'inbound packet');

		var session = await runSession([{ path: theirPkt }]);

		assert.strictEqual(session.filesReceived, 1);
		assert.strictEqual(session.filesToToss, 1);
	});
});
