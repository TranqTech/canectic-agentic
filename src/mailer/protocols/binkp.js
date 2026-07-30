// mailer/protocols/binkp.js — binkp/1.1 protocol implementation.
//
// Handles frame encoding/decoding, session handshake (both caller and
// answerer roles), and file transfer negotiation.
//
// The protocol module sits between the transport (raw bytes) and the
// session controller (high-level events). It consumes 'data' events from
// the transport, parses binkp frames, and emits semantic events that the
// session controller acts on.
//
// Emits:
//   'authenticated'  { addresses, options }
//   'authFailed'     { reason }
//   'fileOffered'    { name, size, time, offset }
//   'fileData'       Buffer
//   'fileComplete'   { name, size }
//   'fileReceived'   { name } (remote acknowledged our file)
//   'fileSkipped'    { name } (remote skipped our file)
//   'sessionEnd'     (remote sent EOB, both sides done)
//   'error'          Error

import { EventEmitter } from 'node:events';
import * as crypto from 'crypto';
import * as alogger from '../../utils/alogger.js';

// --- binkp command IDs ---
const M_NUL  = 0;   // Informational / capabilities
const M_ADR  = 1;   // FTN address presentation
const M_PWD  = 2;   // Session password (caller → answerer)
const M_FILE = 3;   // File offer
const M_OK   = 4;   // Password accepted (answerer → caller)
const M_EOB  = 5;   // End of batch
const M_GOT  = 6;   // File received OK
const M_ERR  = 7;   // Fatal error
const M_BSY  = 8;   // System busy
const M_GET  = 9;   // Request file / resume
const M_SKIP = 10;  // Skip file

const CMD_NAMES = ['M_NUL','M_ADR','M_PWD','M_FILE','M_OK','M_EOB','M_GOT','M_ERR','M_BSY','M_GET','M_SKIP'];

const BINKP_MAX_FRAME = 32767;
const PRODUCT_NAME    = 'Canectic BBS Mailer';
const PRODUCT_VERSION = '0.1';

class BinkpProtocol extends EventEmitter {
	constructor(transport, options) {
		super();
		this._transport = transport;
		this._options   = options || {};

		// State
		this._role          = null;       // 'caller' or 'answerer'
		this._state         = 'init';     // init, handshake, transfer, done, error
		this._buffer        = Buffer.alloc(0); // Accumulator for partial frames

		// Handshake data
		this._localAddresses  = options.localAddresses  || [];
		this._sessionPassword = options.sessionPassword  || '';
		this._forcePlainPassword = !!options.forcePlainPassword;
		this._peerAddresses   = [];
		this._peerPassword    = '';
		this._peerOptions     = {};

		// Transfer state
		this._localEOB   = false;  // We've sent EOB
		this._remoteEOB  = false;  // Remote sent EOB

		// Current inbound file
		this._rxFile     = null;   // { name, size, time, offset, received }

		// Pending acknowledgments — incremented on fileComplete, decremented
		// on sendGOT. Session cannot end while GOTs are outstanding (the
		// transfer engine flushes writes async before sending GOT).
		this._pendingGOTs = 0;

		// Logging — set quiet: true in tests to suppress async log output
		this._quiet = !!options.quiet;

		// CRAM-MD5
		this._cramChallenge = null;

		// Wire transport data to frame parser
		this._transport.on('data', (data) => {
			this._onData(data);
		});
		this._transport.on('error', (err) => {
			this._state = 'error';
			this.emit('error', err);
		});
		this._transport.on('close', () => {
			if (this._state !== 'done' && this._state !== 'error') {
				this.emit('error', new Error('Connection closed unexpectedly'));
			}
		});
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	startSession(role) {
		this._role  = role;
		this._state = 'handshake';

		if (!this._quiet) alogger.writeClog(5, 'binkp: starting session as ' + role + ', addresses: ' + this._localAddresses.join(' '), 'mailer', 'cyan');

		// Send M_NUL capabilities
		this._sendCmd(M_NUL, 'SYS ' + (this._options.systemName || 'Canectic BBS'));
		this._sendCmd(M_NUL, 'ZYZ ' + (this._options.sysopName  || 'Sysop'));
		this._sendCmd(M_NUL, 'VER ' + PRODUCT_NAME + '/' + PRODUCT_VERSION + ' binkp/1.1');
		this._sendCmd(M_NUL, 'TIME ' + new Date().toUTCString());

		// OPT flags
		var opts = ['NR'];
		if (role === 'answerer') {
			// Generate CRAM-MD5 challenge
			this._cramChallenge = crypto.randomBytes(16).toString('hex');
			opts.push('MD5');
			this._sendCmd(M_NUL, 'OPT ' + opts.join(' ') + ' CRAM-MD5-' + this._cramChallenge);
		} else {
			this._sendCmd(M_NUL, 'OPT ' + opts.join(' '));
		}

		// Send M_ADR with our addresses
		if (!this._quiet) alogger.writeClog(5, 'binkp tx: M_ADR ' + this._localAddresses.join(' '), 'mailer', 'cyan');
		this._sendCmd(M_ADR, this._localAddresses.join(' '));
	}

	// Offer a file for transfer. Called by the session controller.
	offerFile(name, size, time, offset) {
		var ts = Math.floor(time / 1000); // Unix timestamp
		var args = name + ' ' + size + ' ' + ts + ' ' + (offset || 0);
		this._sendCmd(M_FILE, args);
	}

	// Send a chunk of file data. Called by the transfer engine.
	sendFileData(buffer) {
		// Data frames: command flag = 0
		if (buffer.length > BINKP_MAX_FRAME) {
			// Split into multiple frames
			var offset = 0;
			while (offset < buffer.length) {
				var chunk = buffer.subarray(offset, offset + BINKP_MAX_FRAME);
				this._sendDataFrame(chunk);
				offset += BINKP_MAX_FRAME;
			}
		} else {
			this._sendDataFrame(buffer);
		}
	}

	// Signal that we've finished sending all files.
	sendEOB() {
		if (this._localEOB) return; // Already sent
		if (!this._quiet) alogger.writeClog(5, 'binkp tx: M_EOB (local EOB)', 'mailer', 'cyan');
		this._localEOB = true;
		this._sendCmd(M_EOB, '');
		this._checkSessionEnd();
	}

	// Acknowledge receipt of a file.
	sendGOT(name, size, time) {
		var ts = Math.floor(time / 1000);
		var _t0 = Date.now();
		alogger.writeClog(2, '[binkp DIAG] sendGOT.enter t=' + _t0 + ' name=' + name + ' size=' + size + ' pendingGOTs=' + this._pendingGOTs + ' localEOB=' + this._localEOB + ' remoteEOB=' + this._remoteEOB, 'mailer', 'magentabright');
		this._sendCmd(M_GOT, name + ' ' + size + ' ' + ts);
		alogger.writeClog(2, '[binkp DIAG] sendGOT.wrote t=' + Date.now() + ' dt=' + (Date.now() - _t0) + 'ms name=' + name, 'mailer', 'magentabright');
		if (this._pendingGOTs > 0) this._pendingGOTs--;
		this._checkSessionEnd();
		alogger.writeClog(2, '[binkp DIAG] sendGOT.exit t=' + Date.now() + ' pendingGOTs=' + this._pendingGOTs + ' state=' + this._state, 'mailer', 'magentabright');
	}

	// Skip a file offered by the remote.
	sendSKIP(name, size, time) {
		var ts = Math.floor(time / 1000);
		// Clear the receive state for this file — we won't send GOT for it,
		// so prevent _handleFILE from triggering an implicit fileComplete
		// (which would increment pendingGOTs and block session end).
		if (this._rxFile && this._rxFile.name === name) {
			this._rxFile = null;
		}
		this._sendCmd(M_SKIP, name + ' ' + size + ' ' + ts);
	}

	// Request a file from remote (for resume).
	sendGET(name, size, time, offset) {
		var ts = Math.floor(time / 1000);
		this._sendCmd(M_GET, name + ' ' + size + ' ' + ts + ' ' + offset);
	}

	// Send fatal error and end session.
	sendERR(reason) {
		this._sendCmd(M_ERR, reason || 'Unknown error');
		this._state = 'error';
	}

	// Send busy.
	sendBSY(reason) {
		this._sendCmd(M_BSY, reason || 'System busy');
		this._state = 'error';
	}

	// Called by answerer after validating the password.
	sendOK() {
		this._sendCmd(M_OK, '');
	}

	get remoteAddresses() {
		return this._peerAddresses;
	}

	get remoteEOB() {
		return this._remoteEOB;
	}

	get localEOB() {
		return this._localEOB;
	}

	get pendingGOTs() {
		return this._pendingGOTs;
	}

	get isAuthenticated() {
		return this._state === 'transfer' || this._state === 'done';
	}

	get state() {
		return this._state;
	}

	// -----------------------------------------------------------------------
	// Frame parsing — accumulates data and extracts complete frames
	// -----------------------------------------------------------------------

	_onData(data) {
		this._buffer = Buffer.concat([this._buffer, data]);

		while (this._buffer.length >= 2) {
			// Read 2-byte header
			var header = this._buffer.readUInt16BE(0);
			var isCommand  = (header & 0x8000) !== 0;
			var payloadLen = header & 0x7FFF;

			// Do we have the full frame?
			if (this._buffer.length < 2 + payloadLen) {
				break; // Wait for more data
			}

			// Extract payload
			var payload = this._buffer.subarray(2, 2 + payloadLen);
			this._buffer = this._buffer.subarray(2 + payloadLen);

			if (isCommand) {
				this._handleCommand(payload);
			} else {
				this._handleDataFrame(payload);
			}
		}
	}

	_handleCommand(payload) {
		if (payload.length === 0) return;

		var cmdId   = payload[0];
		var cmdData = payload.length > 1 ? payload.subarray(1).toString('utf8') : '';
		// Per binkp (FTS-1026) command bodies MAY be NUL-terminated. Some
		// mailers (Argus observed) do include the trailing NUL; others
		// don't. Strip trailing NULs so string comparisons (M_PWD, M_ADR
		// matching, etc.) don't silently fail on an invisible byte.
		// .trim() doesn't strip NUL, only whitespace.
		cmdData = cmdData.replace(/\0+$/, '');
		var cmdName = CMD_NAMES[cmdId] || ('CMD_' + cmdId);

		// Debug: log all received command frames (skip M_NUL after handshake to reduce noise)
		if (cmdId !== M_NUL || this._state === 'init' || this._state === 'handshake') {
			if (!this._quiet) alogger.writeClog(5, 'binkp rx [' + this._state + ']: ' + cmdName + ' ' + cmdData, 'mailer', 'gray');
		}

		switch (cmdId) {
			case M_NUL:
				this._handleNUL(cmdData);
				break;
			case M_ADR:
				this._handleADR(cmdData);
				break;
			case M_PWD:
				this._handlePWD(cmdData);
				break;
			case M_OK:
				this._handleOK(cmdData);
				break;
			case M_ERR:
				this._state = 'error';
				this.emit('error', new Error('Remote error: ' + cmdData));
				break;
			case M_BSY:
				this._state = 'error';
				this.emit('error', new Error('Remote busy: ' + cmdData));
				break;
			case M_FILE:
				this._handleFILE(cmdData);
				break;
			case M_GOT:
				this._handleGOT(cmdData);
				break;
			case M_SKIP:
				this._handleSKIP(cmdData);
				break;
			case M_GET:
				this._handleGET(cmdData);
				break;
			case M_EOB:
				this._handleEOB();
				break;
			default:
				// Unknown command — ignore
				break;
		}
	}

	_handleDataFrame(payload) {
		if (this._rxFile) {
			this._rxFile.received += payload.length;
			this.emit('fileData', payload);

			// Check if file is complete
			if (this._rxFile.received >= this._rxFile.size) {
				var completed = this._rxFile;
				this._rxFile = null;
				this._pendingGOTs++;
				this.emit('fileComplete', { name: completed.name, size: completed.size });
				// File done — check if session can end (both EOBs + no more files + no pending GOTs)
				this._checkSessionEnd();
			}
		}
		// Data without an active file receive — discard (shouldn't happen in normal flow)
	}

	// -----------------------------------------------------------------------
	// Command handlers
	// -----------------------------------------------------------------------

	_handleNUL(data) {
		// Parse key-value options from M_NUL
		if (data.startsWith('OPT ')) {
			var opts = data.substring(4).trim().split(/\s+/);
			for (var opt of opts) {
				if (opt.startsWith('CRAM-MD5-')) {
					this._cramChallenge = opt.substring(9);
					this._peerOptions.cramMD5 = true;
				} else if (opt === 'NR') {
					this._peerOptions.nonReliable = true;
				} else if (opt === 'MB') {
					this._peerOptions.multiBatch = true;
				} else if (opt === 'MD5') {
					this._peerOptions.md5 = true;
				}
			}
		} else if (data.startsWith('SYS ')) {
			this._peerOptions.systemName = data.substring(4).trim();
		} else if (data.startsWith('ZYZ ')) {
			this._peerOptions.sysopName = data.substring(4).trim();
		} else if (data.startsWith('VER ')) {
			this._peerOptions.version = data.substring(4).trim();
		} else if (data.startsWith('TIME ')) {
			this._peerOptions.time = data.substring(5).trim();
		} else if (data.startsWith('LOC ')) {
			this._peerOptions.location = data.substring(4).trim();
		}
		// Other M_NUL lines are informational — ignored
	}

	_handleADR(data) {
		this._peerAddresses = data.trim().split(/\s+/).filter(Boolean);
		if (!this._quiet) alogger.writeClog(5, 'binkp: remote addresses: ' + this._peerAddresses.join(', '), 'mailer', 'cyan');

		// If we're the caller, we now have their addresses. Send our password.
		if (this._role === 'caller') {
			if (!this._quiet) alogger.writeClog(5, 'binkp: sending password (cramChallenge=' + (this._cramChallenge ? 'yes' : 'no') + ', hasPassword=' + (this._sessionPassword ? 'yes' : 'no') + ')', 'mailer', 'cyan');
			this._sendPassword();
		}
		// If we're the answerer, we wait for M_PWD before validating.
	}

	_handlePWD(data) {
		if (this._role !== 'answerer') return; // Only answerers process M_PWD

		this._peerPassword = data.trim();

		// Emit event — the session controller validates against peer_connections
		// and calls sendOK() or sendERR()
		this.emit('passwordReceived', {
			addresses: this._peerAddresses,
			password:  this._peerPassword,
			isCramMD5: this._peerPassword.startsWith('CRAM-MD5-'),
			challenge: this._cramChallenge
		});
	}

	_handleOK(data) {
		if (this._role !== 'caller') return;

		this._state = 'transfer';
		this.emit('authenticated', {
			addresses: this._peerAddresses,
			options:   this._peerOptions
		});
	}

	// Called by session controller after password validation succeeds
	confirmAuth() {
		this.sendOK();
		this._state = 'transfer';
		this.emit('authenticated', {
			addresses: this._peerAddresses,
			options:   this._peerOptions
		});
	}

	_handleFILE(data) {
		// Format: "name size time offset"
		var parts = data.trim().split(/\s+/);
		if (parts.length < 3) return;

		var fileInfo = {
			name:   parts[0],
			size:   parseInt(parts[1]),
			time:   parseInt(parts[2]) * 1000, // Convert to JS timestamp
			offset: parts.length > 3 ? parseInt(parts[3]) : 0
		};

		// In binkp, a new M_FILE for a DIFFERENT filename means the previous
		// file's data has been fully transmitted. Finalize it.
		if (this._rxFile && this._rxFile.name !== fileInfo.name) {
			var completed = this._rxFile;
			this._rxFile = null;
			this._pendingGOTs++;
			this.emit('fileComplete', { name: completed.name, size: completed.size });
		}

		// NR re-offer: same filename with offset >= 0 after we sent M_GET.
		// Update the offset (data will follow) but don't re-emit fileOffered
		// if we already have this file set up.
		if (this._rxFile && this._rxFile.name === fileInfo.name) {
			this._rxFile.offset   = Math.max(0, fileInfo.offset);
			this._rxFile.received = Math.max(0, fileInfo.offset);
			return;
		}

		// New file offer
		this._rxFile = {
			name:     fileInfo.name,
			size:     fileInfo.size,
			time:     fileInfo.time,
			offset:   fileInfo.offset,
			received: Math.max(0, fileInfo.offset)
		};

		this.emit('fileOffered', fileInfo);
	}

	_handleGOT(data) {
		var parts = data.trim().split(/\s+/);
		if (parts.length < 1) return;
		this.emit('fileReceived', { name: parts[0] });
	}

	_handleSKIP(data) {
		var parts = data.trim().split(/\s+/);
		if (parts.length < 1) return;
		this.emit('fileSkipped', { name: parts[0] });
	}

	_handleGET(data) {
		// Remote requesting a file (possibly with resume offset)
		var parts = data.trim().split(/\s+/);
		if (parts.length < 4) return;
		this.emit('fileRequested', {
			name:   parts[0],
			size:   parseInt(parts[1]),
			time:   parseInt(parts[2]) * 1000,
			offset: parseInt(parts[3])
		});
	}

	_handleEOB() {
		// If we have an active receive, EOB means its data is complete
		if (this._rxFile) {
			if (!this._quiet) alogger.writeClog(5, 'binkp: EOB with active receive — finalizing ' + this._rxFile.name, 'mailer', 'cyan');
			var completed = this._rxFile;
			this._rxFile = null;
			this._pendingGOTs++;
			this.emit('fileComplete', { name: completed.name, size: completed.size });
		}
		if (!this._quiet) alogger.writeClog(5, 'binkp: remote sent EOB (localEOB=' + this._localEOB + ', pendingGOTs=' + this._pendingGOTs + ')', 'mailer', 'cyan');
		this._remoteEOB = true;
		this.emit('remoteEOB');
		this._checkSessionEnd();
	}

	_checkSessionEnd() {
		// Session ends only when both sides sent EOB AND no file receive
		// is in progress AND no GOTs are pending (async write flush).
		// Guard against firing sessionEnd twice — the underlying conditions
		// can be re-checked from several paths (data arrival, EOB, sendGOT)
		// and the state transition should be one-shot.
		if (this._state === 'done') return;
		if (this._localEOB && this._remoteEOB && !this._rxFile && this._pendingGOTs === 0) {
			alogger.writeClog(2, '[binkp DIAG] _checkSessionEnd: emitting sessionEnd t=' + Date.now(), 'mailer', 'magentabright');
			this._state = 'done';
			this.emit('sessionEnd');
		}
	}

	// -----------------------------------------------------------------------
	// Password handling
	// -----------------------------------------------------------------------

	_sendPassword() {
		// forcePlainPassword (per-peer config toggle) skips the CRAM-MD5 branch
		// even when the answerer offered a challenge. Useful as an escape
		// hatch for peers whose verifier rejects valid CRAM-MD5 digests
		// (seen with some Argus configurations).
		if (this._cramChallenge && this._sessionPassword && !this._forcePlainPassword) {
			// CRAM-MD5: HMAC-MD5(password_as_key, challenge_as_bytes)
			// The challenge is transmitted as hex — decode to raw bytes for the HMAC
			var challengeBytes = Buffer.from(this._cramChallenge, 'hex');
			var hmac = crypto.createHmac('md5', this._sessionPassword);
			hmac.update(challengeBytes);
			var digest = hmac.digest('hex');
			if (!this._quiet) alogger.writeClog(5,
				'binkp tx: M_PWD CRAM-MD5 challenge=' + this._cramChallenge +
				' pwlen=' + this._sessionPassword.length +
				' digest=' + digest,
				'mailer', 'cyan');
			this._sendCmd(M_PWD, 'CRAM-MD5-' + digest);
		} else if (this._sessionPassword) {
			// Plaintext password
			if (!this._quiet) alogger.writeClog(5, 'binkp tx: M_PWD plaintext (length: ' + this._sessionPassword.length + ')', 'mailer', 'cyan');
			this._sendCmd(M_PWD, this._sessionPassword);
		} else {
			// No password
			if (!this._quiet) alogger.writeClog(5, 'binkp tx: M_PWD - (no password)', 'mailer', 'cyan');
			this._sendCmd(M_PWD, '-');
		}
	}

	// -----------------------------------------------------------------------
	// Frame encoding
	// -----------------------------------------------------------------------

	_sendCmd(cmdId, data) {
		var payload = Buffer.isBuffer(data) ? data : Buffer.from(data || '', 'utf8');
		var frame   = Buffer.alloc(2 + 1 + payload.length);

		// Header: command flag (bit 15 set) + length
		var len = 1 + payload.length;
		frame.writeUInt16BE(0x8000 | len, 0);
		frame[2] = cmdId;
		payload.copy(frame, 3);

		this._transport.write(frame);
	}

	_sendDataFrame(data) {
		var frame = Buffer.alloc(2 + data.length);

		// Header: command flag clear (bit 15 = 0) + length
		frame.writeUInt16BE(data.length, 0);
		data.copy(frame, 2);

		this._transport.write(frame);
	}
}

// --- Static helpers for CRAM-MD5 validation (used by session controller) ---

function verifyCramMD5(password, challenge, response) {
	if (!response.startsWith('CRAM-MD5-')) return false;
	var digest = response.substring(9);
	var challengeBytes = Buffer.from(challenge, 'hex');
	var hmac   = crypto.createHmac('md5', password);
	hmac.update(challengeBytes);
	return hmac.digest('hex') === digest;
}

export { BinkpProtocol, verifyCramMD5, M_NUL, M_ADR, M_PWD, M_FILE, M_OK, M_EOB, M_GOT, M_ERR, M_BSY, M_GET, M_SKIP };
