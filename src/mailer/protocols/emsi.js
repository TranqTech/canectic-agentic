// mailer/protocols/emsi.js — EMSI session handshake protocol.
//
// Implements the Electronic Mail Standard Identification (EMSI) protocol
// used by legacy FTN mailers (FrontDoor, BinkleyTerm, T-Mail, Argus).
// After handshake, the Wazoo batch protocol takes over for file transfer.
//
// Emits the same events as BinkpProtocol so SessionController works unchanged:
//   'authenticated'     { addresses, options }
//   'passwordReceived'  { addresses, password }
//   'sessionEnd'
//   'error'             Error

import { EventEmitter } from 'node:events';
import { crc16 } from '../../transfers/crc.js';
import * as alogger from '../../utils/alogger.js';

// --- EMSI packet constants ---
// Fixed EMSI packets — CRC is computed over the body WITHOUT the ** prefix
var EMSI_INQ = '**EMSI_INQC816\r';      // Inquiry (caller → answerer)
var EMSI_REQ = '**EMSI_REQA77E\r';      // Request (answerer → caller)
var EMSI_ACK = '**EMSI_ACKA490\r';      // Acknowledge
var EMSI_NAK = '**EMSI_NAKEEC3\r';      // Negative acknowledge

var EMSI_DAT_PREFIX = '{EMSI_DAT}';

var PRODUCT_NAME = 'Canectic BBS Mailer';
var PRODUCT_VERSION = '0.1';

var MAX_RETRIES = 6;
var RETRY_TIMEOUT = 5000;  // 5s between retries
var ACK_TIMEOUT = 10000;   // 10s waiting for ACK

// --- CRC helpers ---

function emsiCrc16(str) {
	// EMSI CRC is computed over the ASCII string bytes
	return crc16(Buffer.from(str, 'ascii'));
}

function hexCrc(crc) {
	return crc.toString(16).toUpperCase().padStart(4, '0');
}

// --- EMSI_DAT encoding/decoding ---

function escapeField(str) {
	// Escape braces and backslashes in field values
	return str.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function unescapeField(str) {
	return str.replace(/\\([\\{}])/g, '$1');
}

function encodeEmsiDat(fields) {
	// Build {EMSI_DAT}<len_hex>{f1}{f2}...{fN}<crc_hex>\r
	var body = '';
	for (var f of fields) {
		body += '{' + escapeField(f) + '}';
	}
	var lenHex = body.length.toString(16).toUpperCase().padStart(4, '0');
	var dataPortion = EMSI_DAT_PREFIX + lenHex + body;
	var crc = emsiCrc16(dataPortion);
	return dataPortion + hexCrc(crc) + '\r';
}

function parseEmsiDat(str) {
	// Parse {EMSI_DAT}<len>{fields}<crc>
	// Returns array of field strings or null on error
	if (!str.startsWith(EMSI_DAT_PREFIX)) return null;

	var after = str.substring(EMSI_DAT_PREFIX.length);
	if (after.length < 4) return null;

	var lenHex = after.substring(0, 4);
	var bodyLen = parseInt(lenHex, 16);
	if (isNaN(bodyLen)) return null;

	var body = after.substring(4, 4 + bodyLen);
	if (body.length < bodyLen) return null;

	// Validate CRC — computed over "{EMSI_DAT}<len><body>"
	var crcPortion = str.substring(0, EMSI_DAT_PREFIX.length + 4 + bodyLen);
	var crcHex = after.substring(4 + bodyLen, 4 + bodyLen + 4);
	if (crcHex.length < 4) return null;

	var expectedCrc = parseInt(crcHex, 16);
	var calcCrc = emsiCrc16(crcPortion);
	if (expectedCrc !== calcCrc) {
		return null; // CRC mismatch
	}

	// Extract brace-delimited fields
	var fields = [];
	var i = 0;
	while (i < body.length) {
		if (body[i] !== '{') { i++; continue; }
		i++; // Skip opening brace
		var val = '';
		while (i < body.length && body[i] !== '}') {
			if (body[i] === '\\' && i + 1 < body.length) {
				val += body[i + 1];
				i += 2;
			} else {
				val += body[i];
				i++;
			}
		}
		i++; // Skip closing brace
		fields.push(val);
	}

	return fields;
}

// --- EmsiProtocol ---

class EmsiProtocol extends EventEmitter {
	constructor(transport, options) {
		super();
		this._transport = transport;
		this._options = options || {};

		this._role = null;
		this._state = 'init';
		this._buffer = '';   // Accumulate ASCII data
		this._timer = null;
		this._retries = 0;

		// Local info
		this._localAddresses = options.localAddresses || [];
		this._sessionPassword = options.sessionPassword || '';
		this._systemName = options.systemName || 'Canectic BBS';
		this._sysopName = options.sysopName || 'Sysop';
		this._quiet = options.quiet || false;

		// Remote info (populated during handshake)
		this._remoteAddresses = [];
		this._remoteDat = null;
		this._remotePassword = '';
		this._remoteSystemName = '';
		this._remoteSysopName = '';
		this._remoteCompatCodes = '';

		this._authenticated = false;
		this._receivedRemoteDat = false;
		this._receivedAck = false;

		// Wire transport data events
		this._onDataBound = (data) => this._onData(data);
		this._transport.on('data', this._onDataBound);
	}

	// ======================================================================
	// PUBLIC API
	// ======================================================================

	startSession(role) {
		this._role = role;
		this._state = 'handshake';

		if (!this._quiet) {
			alogger.writeClog(5, 'EMSI: starting session as ' + role +
				', addresses: ' + this._localAddresses.join(' '), 'mailer', 'cyan');
		}

		if (role === 'caller') {
			this._state = 'await_req';
			this._sendEmsiInq();
		}
		// Answerer waits for EMSI_INQ from caller (handled in _onData)
	}

	// Feed peeked bytes from auto-detection
	pushInitialData(buf) {
		this._onData(buf);
	}

	// Answerer: password OK, proceed with handshake
	confirmAuth() {
		if (this._state !== 'await_auth_decision') return;

		// Send our EMSI_DAT + EMSI_ACK
		this._sendOurDat();
		this._sendRaw(EMSI_ACK);

		this._state = 'await_caller_ack';
		this._startTimer(ACK_TIMEOUT, 'ack_timeout');
	}

	sendERR(reason) {
		if (!this._quiet) {
			alogger.writeClog(3, 'EMSI: sendERR — ' + reason, 'mailer', 'redbright');
		}
		// EMSI has no error packet — just disconnect
		this._cleanup();
		this._transport.close();
	}

	sendBSY(reason) {
		this.sendERR(reason);
	}

	get remoteAddresses() { return this._remoteAddresses; }
	get isAuthenticated() { return this._authenticated; }
	get state() { return this._state; }

	// ======================================================================
	// HANDSHAKE — CALLER
	// ======================================================================

	_sendEmsiInq() {
		this._retries++;
		if (this._retries > MAX_RETRIES) {
			this.emit('error', new Error('EMSI_INQ: no response after ' + MAX_RETRIES + ' retries'));
			this._endSession();
			return;
		}
		this._sendRaw(EMSI_INQ);
		this._startTimer(RETRY_TIMEOUT, 'inq_retry');
	}

	_onCallerReceivedReq() {
		this._clearTimer();
		this._state = 'await_ack';

		// Send our EMSI_DAT
		this._sendOurDat();
		this._retries = 0;
		this._startTimer(ACK_TIMEOUT, 'dat_ack_timeout');
	}

	_onCallerReceivedDat(fields) {
		this._parseRemoteDat(fields);
		this._receivedRemoteDat = true;
		this._checkCallerAuthenticated();
	}

	_onCallerReceivedAck() {
		this._receivedAck = true;
		this._checkCallerAuthenticated();
	}

	_checkCallerAuthenticated() {
		if (!this._receivedRemoteDat || !this._receivedAck) return;
		if (this._authenticated) return;

		this._clearTimer();
		this._authenticated = true;
		this._state = 'authenticated';

		// Send our ACK to confirm
		this._sendRaw(EMSI_ACK);

		if (!this._quiet) {
			alogger.writeClog(5, 'EMSI: caller authenticated with ' +
				this._remoteAddresses.join(', '), 'mailer', 'greenbright');
		}

		this.emit('authenticated', {
			addresses: this._remoteAddresses,
			options: {
				systemName: this._remoteSystemName,
				sysopName: this._remoteSysopName,
				compatCodes: this._remoteCompatCodes
			}
		});
	}

	// ======================================================================
	// HANDSHAKE — ANSWERER
	// ======================================================================

	_onAnswererReceivedInq() {
		this._state = 'await_dat';
		this._sendRaw(EMSI_REQ);
		this._startTimer(ACK_TIMEOUT, 'dat_timeout');
	}

	_onAnswererReceivedDat(fields) {
		this._clearTimer();
		this._parseRemoteDat(fields);

		this._state = 'await_auth_decision';

		// Emit passwordReceived — session controller validates and calls confirmAuth()
		this.emit('passwordReceived', {
			addresses: this._remoteAddresses,
			password: this._remotePassword,
			isCramMD5: false,
			challenge: null
		});
	}

	_onAnswererReceivedCallerAck() {
		if (this._state !== 'await_caller_ack') return;
		this._clearTimer();
		this._authenticated = true;
		this._state = 'authenticated';

		if (!this._quiet) {
			alogger.writeClog(5, 'EMSI: answerer authenticated with ' +
				this._remoteAddresses.join(', '), 'mailer', 'greenbright');
		}

		this.emit('authenticated', {
			addresses: this._remoteAddresses,
			options: {
				systemName: this._remoteSystemName,
				sysopName: this._remoteSysopName,
				compatCodes: this._remoteCompatCodes
			}
		});
	}

	// ======================================================================
	// DATA ENCODING
	// ======================================================================

	_sendOurDat() {
		// EMSI_DAT fields in order:
		// {system_name} {city} {sysop} {phone} {baud} {flags}
		// {link_codes} {compat_codes} {mailer_code} {addresses} {password}
		var fields = [
			this._systemName,                          // system name
			'Internet',                                // city
			this._sysopName,                           // sysop
			'-Unpublished-',                           // phone
			'300',                                     // baud (required but meaningless for IP)
			'XA,CM,IBN,IFC',                           // flags
			'8N1',                                     // link codes
			'ZMO,ZAP',                                 // compat codes (ZMODEM + ZedZap)
			PRODUCT_NAME + ' ' + PRODUCT_VERSION,      // mailer code
			this._localAddresses.join(' '),            // addresses
			this._sessionPassword                      // password
		];

		var packet = encodeEmsiDat(fields);
		this._sendRaw(packet);
	}

	_parseRemoteDat(fields) {
		// Fields: system_name, city, sysop, phone, baud, flags,
		//         link_codes, compat_codes, mailer_code, addresses, password
		if (fields.length >= 1) this._remoteSystemName = fields[0] || '';
		if (fields.length >= 3) this._remoteSysopName = fields[2] || '';
		if (fields.length >= 8) this._remoteCompatCodes = fields[7] || '';
		if (fields.length >= 10) {
			var addrStr = fields[9] || '';
			this._remoteAddresses = addrStr.split(/\s+/).filter(Boolean);
		}
		if (fields.length >= 11) this._remotePassword = fields[10] || '';

		if (!this._quiet) {
			alogger.writeClog(5, 'EMSI: remote DAT — ' + this._remoteSystemName +
				' (' + this._remoteAddresses.join(', ') + ') compat=' +
				this._remoteCompatCodes, 'mailer', 'cyan');
		}
	}

	// ======================================================================
	// INPUT PROCESSING
	// ======================================================================

	_onData(data) {
		// Accumulate ASCII data
		var str = Buffer.isBuffer(data) ? data.toString('binary') : data;
		this._buffer += str;

		this._processBuffer();
	}

	_processBuffer() {
		// Scan for known EMSI sequences
		while (this._buffer.length > 0) {
			// Look for EMSI_DAT packet
			var datIdx = this._buffer.indexOf(EMSI_DAT_PREFIX);
			if (datIdx >= 0) {
				// Need at least prefix + 4 hex len
				if (this._buffer.length < datIdx + EMSI_DAT_PREFIX.length + 4) break;

				var afterPrefix = this._buffer.substring(datIdx + EMSI_DAT_PREFIX.length);
				var lenHex = afterPrefix.substring(0, 4);
				var bodyLen = parseInt(lenHex, 16);
				if (isNaN(bodyLen)) {
					// Bad length — discard up to after the prefix
					this._buffer = this._buffer.substring(datIdx + EMSI_DAT_PREFIX.length);
					continue;
				}

				// Need full packet: prefix + 4 len + body + 4 crc + \r
				var totalLen = EMSI_DAT_PREFIX.length + 4 + bodyLen + 4;
				if (this._buffer.length < datIdx + totalLen) break; // Need more data

				var fullPacket = this._buffer.substring(datIdx, datIdx + totalLen);
				var fields = parseEmsiDat(fullPacket);

				// Consume up to after the packet (+ optional \r)
				var endIdx = datIdx + totalLen;
				if (endIdx < this._buffer.length && this._buffer[endIdx] === '\r') endIdx++;
				this._buffer = this._buffer.substring(endIdx);

				if (fields) {
					this._handleDat(fields);
				} else {
					if (!this._quiet) {
						alogger.writeClog(3, 'EMSI: EMSI_DAT CRC error or parse failure', 'mailer', 'yellow');
					}
				}
				continue;
			}

			// Look for fixed EMSI sequences
			var emsiIdx = this._buffer.indexOf('**EMSI_');
			if (emsiIdx >= 0) {
				// Need at least 20 chars for fixed sequences: **EMSI_XXX<4crc>\r
				if (this._buffer.length < emsiIdx + 15) break; // Need more

				var seq = this._buffer.substring(emsiIdx, emsiIdx + 15);

				// Match known sequences (includes CRC)
				if (seq.startsWith('**EMSI_INQ')) {
					this._buffer = this._buffer.substring(emsiIdx + 15);
					if (this._buffer[0] === '\r') this._buffer = this._buffer.substring(1);
					this._handleInq();
					continue;
				}
				if (seq.startsWith('**EMSI_REQ')) {
					this._buffer = this._buffer.substring(emsiIdx + 15);
					if (this._buffer[0] === '\r') this._buffer = this._buffer.substring(1);
					this._handleReq();
					continue;
				}
				if (seq.startsWith('**EMSI_ACK')) {
					this._buffer = this._buffer.substring(emsiIdx + 15);
					if (this._buffer[0] === '\r') this._buffer = this._buffer.substring(1);
					this._handleAck();
					continue;
				}
				if (seq.startsWith('**EMSI_NAK')) {
					this._buffer = this._buffer.substring(emsiIdx + 15);
					if (this._buffer[0] === '\r') this._buffer = this._buffer.substring(1);
					this._handleNak();
					continue;
				}

				// Unknown **EMSI_ sequence — skip past **EMSI_
				this._buffer = this._buffer.substring(emsiIdx + 7);
				continue;
			}

			// No EMSI sequence found — discard everything except last few bytes
			// that could be a partial match
			if (this._buffer.length > 20) {
				this._buffer = this._buffer.substring(this._buffer.length - 20);
			}
			break;
		}
	}

	// ======================================================================
	// PACKET HANDLERS
	// ======================================================================

	_handleInq() {
		if (!this._quiet) alogger.writeClog(5, 'EMSI rx: EMSI_INQ', 'mailer', 'cyan');

		if (this._role === 'answerer' &&
			(this._state === 'handshake' || this._state === 'init')) {
			this._onAnswererReceivedInq();
		}
	}

	_handleReq() {
		if (!this._quiet) alogger.writeClog(5, 'EMSI rx: EMSI_REQ', 'mailer', 'cyan');

		if (this._role === 'caller' && this._state === 'await_req') {
			this._onCallerReceivedReq();
		}
		// Answerer receiving REQ from caller as re-request — respond again
		if (this._role === 'answerer' &&
			(this._state === 'handshake' || this._state === 'init')) {
			this._onAnswererReceivedInq(); // Same behavior
		}
	}

	_handleAck() {
		if (!this._quiet) alogger.writeClog(5, 'EMSI rx: EMSI_ACK', 'mailer', 'cyan');

		if (this._role === 'caller' && this._state === 'await_ack') {
			this._onCallerReceivedAck();
		}
		if (this._role === 'answerer' && this._state === 'await_caller_ack') {
			this._onAnswererReceivedCallerAck();
		}
	}

	_handleNak() {
		if (!this._quiet) alogger.writeClog(5, 'EMSI rx: EMSI_NAK', 'mailer', 'yellow');
		// Resend last packet on NAK
		if (this._role === 'caller' && this._state === 'await_ack') {
			this._sendOurDat();
		}
	}

	_handleDat(fields) {
		if (!this._quiet) alogger.writeClog(5, 'EMSI rx: EMSI_DAT (' + fields.length + ' fields)', 'mailer', 'cyan');

		if (this._role === 'caller' && this._state === 'await_ack') {
			this._onCallerReceivedDat(fields);
		}
		if (this._role === 'answerer' && this._state === 'await_dat') {
			this._onAnswererReceivedDat(fields);
		}
	}

	// ======================================================================
	// TRANSPORT
	// ======================================================================

	_sendRaw(str) {
		this._transport.write(Buffer.from(str, 'binary'));
	}

	// ======================================================================
	// TIMER
	// ======================================================================

	_startTimer(ms, reason) {
		this._clearTimer();
		var self = this;
		this._timer = setTimeout(function() {
			self._timer = null;
			if (reason === 'inq_retry') {
				self._sendEmsiInq();
			} else if (reason === 'dat_ack_timeout') {
				// Caller: resend EMSI_DAT
				self._retries++;
				if (self._retries > MAX_RETRIES) {
					self.emit('error', new Error('EMSI: no ACK after ' + MAX_RETRIES + ' retries'));
					self._endSession();
				} else {
					self._sendOurDat();
					self._startTimer(ACK_TIMEOUT, 'dat_ack_timeout');
				}
			} else if (reason === 'dat_timeout') {
				// Answerer: no EMSI_DAT received
				self.emit('error', new Error('EMSI: no EMSI_DAT received'));
				self._endSession();
			} else if (reason === 'ack_timeout') {
				// Answerer: no caller ACK after our DAT+ACK
				// Assume caller is happy (some implementations skip the final ACK)
				self._onAnswererReceivedCallerAck();
			}
		}, ms);
	}

	_clearTimer() {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
	}

	// ======================================================================
	// CLEANUP
	// ======================================================================

	_endSession() {
		this._cleanup();
		this.emit('sessionEnd');
	}

	_cleanup() {
		this._clearTimer();
		this._state = 'done';
		if (this._onDataBound) {
			this._transport.removeListener('data', this._onDataBound);
			this._onDataBound = null;
		}
	}

	// Called by session controller when transfer phase is starting —
	// disconnects the EMSI parser from the transport so ZMODEM can take over
	detachTransport() {
		if (this._onDataBound) {
			this._transport.removeListener('data', this._onDataBound);
			this._onDataBound = null;
		}
	}
}

export {
	EmsiProtocol,
	encodeEmsiDat,
	parseEmsiDat,
	emsiCrc16,
	escapeField,
	unescapeField
};
