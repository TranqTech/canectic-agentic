// tests/wsTransport.test.js — Mocha tests for WebSocket mailer transport
//
// Tests WsTransport class (unit) and full binkp session over WebSocket (integration).
// Run: npx mocha tests/wsTransport.test.js

import assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocketServer } from 'ws';
import { WsTransport } from '../src/mailer/transports/ws.js';
import { BinkpProtocol, verifyCramMD5 } from '../src/mailer/protocols/binkp.js';
import { TransferEngine } from '../src/mailer/transfer.js';

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Unit tests — WsTransport class
// ---------------------------------------------------------------------------

describe('WsTransport', function() {
	var httpServer;
	var wss;
	var port;

	before(function(done) {
		port = 34567 + Math.floor(Math.random() * 10000);
		httpServer = http.createServer(function(req, res) {
			res.writeHead(426);
			res.end();
		});
		wss = new WebSocketServer({ noServer: true });
		httpServer.on('upgrade', function(request, socket, head) {
			wss.handleUpgrade(request, socket, head, function(ws) {
				wss.emit('connection', ws, request);
			});
		});
		httpServer.listen(port, '127.0.0.1', done);
	});

	after(function(done) {
		wss.close();
		httpServer.close(done);
	});

	it('should connect via WsTransport.connect()', function(done) {
		wss.once('connection', function(ws) {
			ws.close();
		});

		var transport = WsTransport.connect('ws://127.0.0.1:' + port + '/', 3000);
		transport.once('connect', function() {
			assert.ok(transport.isConnected, 'transport should be connected');
			transport.close();
			done();
		});
		transport.once('error', done);
	});

	it('should wrap inbound via WsTransport.fromWebSocket()', function(done) {
		wss.once('connection', function(ws, request) {
			var transport = WsTransport.fromWebSocket(ws, request);
			assert.ok(transport.isConnected, 'inbound transport should be connected');
			assert.ok(transport.remoteAddress !== 'unknown', 'should have remote address');
			transport.close();
			done();
		});

		var client = WsTransport.connect('ws://127.0.0.1:' + port + '/', 3000);
		client.once('error', done);
	});

	it('should exchange binary data bidirectionally', function(done) {
		var serverGot = null;
		var clientGot = null;
		var testData = Buffer.from([0x00, 0x80, 0xFF, 0x42, 0x69, 0x6E]);

		wss.once('connection', function(ws, request) {
			var sTransport = WsTransport.fromWebSocket(ws, request);
			sTransport.on('data', function(buf) {
				serverGot = buf;
				sTransport.write(Buffer.from([0xDE, 0xAD]));
			});
		});

		var client = WsTransport.connect('ws://127.0.0.1:' + port + '/', 3000);
		client.once('connect', function() {
			client.on('data', function(buf) {
				clientGot = buf;
				client.close();
				assert.ok(Buffer.isBuffer(serverGot), 'server should receive Buffer');
				assert.deepStrictEqual(serverGot, testData, 'server should receive exact data');
				assert.ok(Buffer.isBuffer(clientGot), 'client should receive Buffer');
				assert.deepStrictEqual(clientGot, Buffer.from([0xDE, 0xAD]), 'client should receive exact reply');
				done();
			});
			client.write(testData);
		});
		client.once('error', done);
	});

	it('should buffer data while paused and replay on resume', function(done) {
		wss.once('connection', function(ws, request) {
			var sTransport = WsTransport.fromWebSocket(ws, request);
			sTransport.pause();

			var received = [];
			sTransport.on('data', function(buf) {
				received.push(buf);
				if (received.length === 2) {
					assert.deepStrictEqual(received[0], Buffer.from('first'));
					assert.deepStrictEqual(received[1], Buffer.from('second'));
					sTransport.close();
					done();
				}
			});

			// Send data while paused, then resume after a delay
			setTimeout(function() {
				sTransport.resume();
			}, 100);
		});

		var client = WsTransport.connect('ws://127.0.0.1:' + port + '/', 3000);
		client.once('connect', function() {
			client.write(Buffer.from('first'));
			client.write(Buffer.from('second'));
		});
		client.once('error', done);
	});

	it('should emit close event on disconnect', function(done) {
		wss.once('connection', function(ws, request) {
			var sTransport = WsTransport.fromWebSocket(ws, request);
			sTransport.on('close', function() {
				assert.ok(!sTransport.isConnected, 'should not be connected after close');
				done();
			});
		});

		var client = WsTransport.connect('ws://127.0.0.1:' + port + '/', 3000);
		client.once('connect', function() {
			client.close();
		});
		client.once('error', done);
	});

	it('should timeout on connect to unreachable host', function(done) {
		// Use a non-routable address to trigger timeout
		var transport = WsTransport.connect('ws://192.0.2.1:1/', 500);
		transport.once('error', function(err) {
			assert.ok(err.message.includes('timeout') || err.message.includes('connect'), 'should get timeout or connect error');
			done();
		});
	});
});

// ---------------------------------------------------------------------------
// Integration test — full binkp session over WebSocket
// ---------------------------------------------------------------------------

describe('binkp over WebSocket', function() {
	this.timeout(10000);

	it('should complete handshake + file transfer over WS transport', async function() {
		var TEST_PORT = 34567 + Math.floor(Math.random() * 10000);
		var PASSWORD = 'wsmocha';

		// Temp directories
		var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'binkp-ws-mocha-'));
		var inDir  = path.join(tmpBase, 'inbound');
		var tmpDir = path.join(tmpBase, 'tmp');
		var outDir = path.join(tmpBase, 'outbound');
		fs.mkdirSync(inDir);
		fs.mkdirSync(tmpDir);
		fs.mkdirSync(outDir);

		// Create test file
		var testContent = 'Mocha WS binkp test - ' + Date.now() + '\r\n';
		testContent = testContent.repeat(50);
		var testFile = path.join(outDir, 'mocha-ws.pkt');
		fs.writeFileSync(testFile, testContent);
		var testSize = fs.statSync(testFile).size;

		// Results
		var handshakeOK = false;
		var receivedFile = null;
		var sentFile = false;
		var sessionDone = false;

		// WS server
		var httpSrv = http.createServer(function(req, res) { res.writeHead(426); res.end(); });
		var wssSrv = new WebSocketServer({ noServer: true });
		httpSrv.on('upgrade', function(request, socket, head) {
			wssSrv.handleUpgrade(request, socket, head, function(ws) {
				wssSrv.emit('connection', ws, request);
			});
		});

		wssSrv.on('connection', function(ws, request) {
			var transport = WsTransport.fromWebSocket(ws, request);
			var proto = new BinkpProtocol(transport, {
				quiet: true,
				localAddresses: ['1:200/200'],
				systemName: 'WS Mocha Answerer'
			});
			var transfer = new TransferEngine(proto, {
				inboundDir: inDir, tempDir: tmpDir, sessionId: 'ws-mocha-answerer'
			});

			transfer.on('receiveComplete', function(info) { receivedFile = info; });

			proto.on('passwordReceived', function(info) {
				var ok = info.isCramMD5 && info.challenge
					? verifyCramMD5(PASSWORD, info.challenge, info.password)
					: (info.password === PASSWORD);
				if (ok) { proto.confirmAuth(); handshakeOK = true; }
				else { proto.sendERR('Bad password'); }
			});

			proto.on('authenticated', function() { proto.sendEOB(); });
			proto.on('sessionEnd', function() { transfer.cleanup(); transport.close(); });
			proto.startSession('answerer');
			transport.resume();
		});

		await new Promise(function(resolve) { httpSrv.listen(TEST_PORT, '127.0.0.1', resolve); });

		// WS client
		var callerTransport = WsTransport.connect('ws://127.0.0.1:' + TEST_PORT + '/', 5000);

		callerTransport.once('connect', function() {
			var proto = new BinkpProtocol(callerTransport, {
				quiet: true,
				localAddresses: ['1:100/100'],
				sessionPassword: PASSWORD,
				systemName: 'WS Mocha Caller'
			});
			var transfer = new TransferEngine(proto, {
				inboundDir: inDir, tempDir: tmpDir, sessionId: 'ws-mocha-caller'
			});

			transfer.on('sendComplete', function() { sentFile = true; });
			transfer.on('allSent', function() { proto.sendEOB(); });

			proto.on('authenticated', function() {
				transfer.queueFile(testFile);
				transfer.markAllQueued();
				transfer.startSending();
			});

			proto.on('sessionEnd', function() {
				sessionDone = true;
				transfer.cleanup();
				callerTransport.close();
			});

			proto.startSession('caller');
		});

		// Wait for session to complete
		var waited = 0;
		while (!sessionDone && waited < 5000) {
			await sleep(50);
			waited += 50;
		}
		await sleep(500); // flush

		// Cleanup server
		wssSrv.close();
		httpSrv.close();

		// Assertions
		assert.ok(handshakeOK, 'Handshake should complete');
		assert.ok(sentFile, 'Caller should send file');
		assert.ok(receivedFile, 'Answerer should receive file');
		assert.strictEqual(receivedFile.name, 'mocha-ws.pkt');
		assert.strictEqual(receivedFile.size, testSize);

		if (receivedFile.path && fs.existsSync(receivedFile.path)) {
			var content = fs.readFileSync(receivedFile.path, 'utf8');
			assert.strictEqual(content, testContent, 'File content should match');
		} else {
			assert.fail('Received file not found on disk');
		}

		assert.ok(sessionDone, 'Session should complete within timeout');

		// Cleanup temp
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});
});
