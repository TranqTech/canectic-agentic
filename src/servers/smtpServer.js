// smtpServer.js — SMTP submission server for sending private messages.
//
// Accepts messages from authenticated mail clients and routes them:
// - Local users (username@domain) → delivered as LOCAL PM
// - FTN addresses (user%zone.net.node@domain) → queued as FTN netmail
// - Unknown/external → rejected (no relay)
//
// This is a submission-only server (MSA, RFC 6409). It does not accept
// unauthenticated mail from the internet.

import * as net from 'net';
import * as alogger from '../utils/alogger.js';
import { checkUserPass, getUserRecord } from '../models/useraccounts.js';
import { resolveRecipient, queueMessage, deliverMessage } from '../models/privateMessages.js';
import { storeAttachments } from '../models/pmAttachments.js';
import appConfig from '../config/appConfig.js';

// ---------------------------------------------------------------------------
// SmtpSession — one per client connection
// ---------------------------------------------------------------------------

class SmtpSession {
	constructor(socket, mailDomain, options) {
		this.socket = socket;
		this.mailDomain = mailDomain;
		this.trustedMode = !!(options && options.trusted);
		this.state = 'greeting'; // greeting, ready, auth_login_user, auth_login_pass, data
		this.authenticated = this.trustedMode; // trusted sessions skip auth
		this.userId = null;
		this.username = null;
		this.userRecord = null;
		this.mailFrom = null;
		this.rcptTo = [];
		this.dataBuffer = '';
		this._buffer = '';
		this._closed = false;

		// Serialized command queue. Clients using RFC 2920 PIPELINING send
		// MAIL/RCPT/DATA in a single TCP write; if we dispatched each line
		// without awaiting the previous command's async handlers (e.g. the
		// DB-backed recipient resolve in _cmdRcptTo), DATA could run before
		// rcptTo was populated and send "503 Need RCPT TO first". The queue
		// guarantees commands execute strictly in order.
		this._cmdQueue = [];
		this._cmdRunning = false;

		socket.on('data', (data) => this._onData(data));
		socket.on('close', () => { this._closed = true; });
		socket.on('error', () => { this._closed = true; });

		// Send greeting
		this._send('220 ' + mailDomain + ' Canectic BBS ESMTP');
		this.state = 'ready';
	}

	close() {
		if (!this._closed && !this.socket.destroyed) {
			this.socket.end();
		}
		this._closed = true;
	}

	_onData(data) {
		if (this.state === 'data') {
			// Collecting message body. We use latin1 for byte fidelity: SMTP
			// with 8BITMIME can carry any 0-255 byte value in the body, and
			// latin1 is the only Node string encoding that maps 1:1 onto raw
			// bytes. utf8 would mangle high-bit bytes into U+FFFD and wreck
			// base64 slicing for attachment parts and charset conversion for
			// text parts later in _parseMessage.
			this.dataBuffer += data.toString('latin1');
			// Check for end-of-data marker
			if (this.dataBuffer.includes('\r\n.\r\n')) {
				var body = this.dataBuffer.split('\r\n.\r\n')[0];
				this.dataBuffer = '';
				this.state = 'ready';
				// RFC 5321 section 4.5.2 -- transparency: the client prefixes
				// any body line starting with "." with an extra "." so the
				// dot doesn't look like the end-of-data marker. The receiver
				// MUST strip that extra dot before processing the message.
				body = body.replace(/\r\n\.\./g, '\r\n.');
				if (body.startsWith('..')) body = body.substring(1);
				this._processData(body);
			}
			return;
		}

		this._buffer += data.toString('latin1');
		var lines = this._buffer.split('\r\n');
		this._buffer = lines.pop();

		for (var line of lines) {
			if (line.length > 0) {
				this._cmdQueue.push(line);
			}
		}
		this._runCmdQueue();
	}

	async _runCmdQueue() {
		if (this._cmdRunning) return;
		this._cmdRunning = true;
		try {
			while (this._cmdQueue.length > 0 && !this._closed) {
				var line = this._cmdQueue.shift();
				// Once DATA has been accepted the state flips to 'data' and
				// the remainder of the pipelined bytes (if any) are the body,
				// which _onData routes to dataBuffer directly. Any queued
				// lines beyond that point are stale and must be dropped.
				if (this.state === 'data') {
					this._cmdQueue.length = 0;
					break;
				}
				try {
					await this._processCommand(line);
				} catch (err) {
					alogger.writeAlog(1,
						'SMTP command dispatch error: ' + err.message +
						(err.stack ? '\n' + err.stack : ''),
						'redbright');
					if (!this._closed) {
						this._send('451 4.3.0 Temporary server error');
					}
				}
			}
		} finally {
			this._cmdRunning = false;
		}
	}

	_send(str) {
		if (this._closed || this.socket.destroyed) return;
		this.socket.write(str + '\r\n');
	}

	// --- Command dispatch ---

	async _processCommand(line) {
		var cmd = line.substring(0, 4).toUpperCase();
		var args = line.substring(4).trim();

		// Handle auth continuation
		if (this.state === 'auth_login_user') {
			await this._authLoginUser(line.trim());
			return;
		}
		if (this.state === 'auth_login_pass') {
			await this._authLoginPass(line.trim());
			return;
		}

		switch (cmd) {
			case 'EHLO':
			case 'HELO':
				this._cmdEhlo(args);
				break;
			case 'AUTH':
				await this._cmdAuth(args);
				break;
			case 'MAIL':
				this._cmdMailFrom(line);
				break;
			case 'RCPT':
				await this._cmdRcptTo(line);
				break;
			case 'DATA':
				this._cmdData();
				break;
			case 'VRFY':
				await this._cmdVrfy(line);
				break;
			case 'QUIT':
				this._send('221 Bye');
				this.close();
				break;
			case 'NOOP':
				this._send('250 OK');
				break;
			case 'RSET':
				this.mailFrom = null;
				this.rcptTo = [];
				this._send('250 OK');
				break;
			default:
				this._send('502 Command not implemented');
		}
	}

	// --- EHLO ---

	// Capability advertisement differs between modes:
	//
	// Submission mode  (authenticated, port 10587):
	//   - AUTH PLAIN LOGIN  (users must auth before sending)
	//   - 8BITMIME, SIZE, PIPELINING
	//
	// Trusted mode  (IP-allowlisted, port 1026):
	//   - NO AUTH (allowlist is the auth)
	//   - VRFY (relays doing recipient verification need this)
	//   - 8BITMIME, SIZE, PIPELINING
	_cmdEhlo(clientName) {
		this._send('250-' + this.mailDomain);
		if (this.trustedMode) {
			this._send('250-VRFY');
		} else {
			this._send('250-AUTH PLAIN LOGIN');
		}
		this._send('250-PIPELINING');
		this._send('250-8BITMIME');
		this._send('250 SIZE 10485760');
	}

	// --- AUTH ---

	async _cmdAuth(args) {
		var parts = args.split(' ');
		var mechanism = parts[0].toUpperCase();

		if (mechanism === 'PLAIN') {
			if (parts.length > 1) {
				await this._authPlain(parts[1]);
			} else {
				// Client will send credentials on next line
				this._send('334 ');
				this.state = 'auth_plain_cont';
			}
		} else if (mechanism === 'LOGIN') {
			this._send('334 VXNlcm5hbWU6'); // Base64("Username:")
			this.state = 'auth_login_user';
			this._authLoginUsername = null;
		} else {
			this._send('504 Unrecognized authentication mechanism');
		}
	}

	async _authPlain(base64Str) {
		try {
			var decoded = Buffer.from(base64Str, 'base64').toString('utf8');
			// Format: \0username\0password
			var parts = decoded.split('\0');
			var username = parts[1] || '';
			var password = parts[2] || '';

			// Allow username@domain login style
			var atIdx = username.indexOf('@');
			if (atIdx >= 0) username = username.substring(0, atIdx);

			var result = await checkUserPass(username, password);
			if (result.isvalid) {
				this.authenticated = true;
				this.userId = result.useraccount.id;
				this.username = result.useraccount.username;
				this.userRecord = result.useraccount;
				alogger.writeAlog(4, 'SMTP AUTH: ' + this.username, 'cyan');
				this._send('235 Authentication successful');
			} else {
				this._send('535 Authentication failed');
			}
		} catch (err) {
			this._send('535 Authentication failed');
		}
		this.state = 'ready';
	}

	async _authLoginUser(base64Str) {
		this._authLoginUsername = Buffer.from(base64Str, 'base64').toString('utf8');
		this._send('334 UGFzc3dvcmQ6'); // Base64("Password:")
		this.state = 'auth_login_pass';
	}

	async _authLoginPass(base64Str) {
		var password = Buffer.from(base64Str, 'base64').toString('utf8');
		var username = this._authLoginUsername || '';

		// Allow username@domain login style
		var atIdx = username.indexOf('@');
		if (atIdx >= 0) username = username.substring(0, atIdx);

		var result = await checkUserPass(username, password);
		if (result.isvalid) {
			this.authenticated = true;
			this.userId = result.useraccount.id;
			this.username = result.useraccount.username;
			this.userRecord = result.useraccount;
			alogger.writeAlog(4, 'SMTP AUTH LOGIN: ' + this.username, 'cyan');
			this._send('235 Authentication successful');
		} else {
			this._send('535 Authentication failed');
		}
		this.state = 'ready';
	}

	// --- MAIL FROM ---

	_cmdMailFrom(line) {
		if (!this.authenticated) {
			this._send('530 Authentication required');
			return;
		}

		var match = line.match(/MAIL\s+FROM:\s*<([^>]*)>/i);
		if (!match) {
			this._send('501 5.5.2 Syntax error in MAIL FROM');
			return;
		}

		this.mailFrom = match[1];
		this.rcptTo = [];

		// Empty sender from a trusted relay is almost certainly the start
		// of a recipient verification probe (MAIL FROM: <> / RCPT TO / RSET).
		// Log at level 4 so it's visible with mild verbosity but doesn't
		// drown out regular delivery.
		if (this.trustedMode && this.mailFrom === '') {
			alogger.writeAlog(4,
				'SMTP inbound: verify probe started (MAIL FROM: <>) from ' +
				(this.socket.remoteAddress || 'unknown'),
				'cyan');
		}

		this._send('250 2.1.0 OK');
	}

	// --- RCPT TO ---

	async _cmdRcptTo(line) {
		if (!this.authenticated) {
			this._send('530 Authentication required');
			return;
		}
		// Must be === null specifically. An empty-string mailFrom is a
		// legitimate bounce / verification probe sender ("MAIL FROM: <>")
		// and should be allowed to proceed.
		if (this.mailFrom === null) {
			this._send('503 Need MAIL FROM first');
			return;
		}

		var match = line.match(/RCPT\s+TO:\s*<([^>]*)>/i);
		if (!match) {
			this._send('501 Syntax error in RCPT TO');
			return;
		}

		var address = match[1];
		var resolved = await this._resolveAddress(address);

		// In trusted mode, log every RCPT TO so sysops can see verification
		// probes in the log stream. MG-style recipient verification is
		// "MAIL FROM: <> / RCPT TO: <addr> / RSET" so the empty-sender case
		// is explicitly flagged as a probe.
		if (this.trustedMode) {
			var isProbe = (this.mailFrom === '');
			var verdict = resolved ? 'accepted' : 'unknown';
			alogger.writeAlog(3,
				'SMTP inbound: ' + (isProbe ? 'verify probe' : 'RCPT') +
				' <' + address + '> ' + verdict +
				(isProbe ? ' (empty sender)' : ' from <' + this.mailFrom + '>'),
				resolved ? 'cyan' : 'yellow');
		}

		if (!resolved) {
			// Enhanced status code 5.1.1 (bad destination mailbox address)
			// so downstream log lines show "user unknown" rather than the
			// generic 550 text. Postfix-style verify probes use this to
			// cache permanent negative results correctly.
			this._send('550 5.1.1 <' + address + '> Recipient address unknown');
			return;
		}

		this.rcptTo.push(resolved);
		this._send('250 2.1.5 OK');
	}

	// --- VRFY ---
	//
	// RFC 5321 section 3.5.1. Used by some relays (Postfix with
	// reject_unverified_recipient, Exchange, GroupWise) as an alternative
	// to the MAIL FROM / RCPT TO probe. Only enabled in trusted mode --
	// enabling VRFY on a public submission server is an address-harvesting
	// vector. In trusted mode the IP allowlist already gates access so
	// there's no harvesting risk from random spammers.
	//
	// Accepted argument forms:
	//   VRFY username           -- matches users.username
	//   VRFY first.last         -- matches users.fullname via dot-to-space fallback
	//   VRFY username@domain
	//   VRFY first.last@domain
	//   VRFY <username@domain>
	//
	// Lookup cascade lives in privateMessages.resolveRecipient:
	// exact username > exact fullname > dotted-local fallback > sysop alias.
	async _cmdVrfy(line) {
		if (!this.trustedMode) {
			// RFC 5321 allows 252 ("cannot VRFY, but will accept and attempt
			// delivery") as a permitted response when VRFY is disabled.
			this._send('252 2.5.2 Cannot VRFY user, but will accept message');
			return;
		}

		var match = line.match(/VRFY\s+(.+?)\s*$/i);
		if (!match) {
			this._send('501 5.5.2 Syntax error in VRFY');
			return;
		}

		var arg = match[1].trim();
		// Strip optional angle brackets: VRFY <user@domain>
		if (arg.length >= 2 && arg[0] === '<' && arg[arg.length - 1] === '>') {
			arg = arg.substring(1, arg.length - 1);
		}
		if (!arg) {
			this._send('501 5.5.2 Empty VRFY argument');
			return;
		}

		// If no @ in arg, assume local mail domain so _resolveAddress has
		// the shape it expects. Bare-username VRFY is normal for gateways
		// that verify by local-part only.
		var probeAddress = arg.indexOf('@') >= 0 ? arg : (arg + '@' + this.mailDomain);

		var resolved = await this._resolveAddress(probeAddress);

		alogger.writeAlog(3,
			'SMTP inbound: VRFY <' + arg + '> ' + (resolved ? 'accepted' : 'unknown'),
			resolved ? 'cyan' : 'yellow');

		if (!resolved) {
			this._send('550 5.1.1 <' + arg + '> User unknown');
			return;
		}

		// RFC 5321: 250 response to VRFY should include the full mailbox
		// (optionally with a display name). Return <local@domain> with a
		// lowercase local part so it canonicalises regardless of how the
		// client asked.
		var local = (resolved.username || resolved.toUser || arg)
			.toLowerCase()
			.replace(/\s+/g, '.');
		this._send('250 <' + local + '@' + this.mailDomain + '>');
	}

	// --- DATA ---

	_cmdData() {
		if (!this.authenticated) {
			this._send('530 Authentication required');
			return;
		}
		if (this.rcptTo.length === 0) {
			this._send('503 Need RCPT TO first');
			return;
		}

		this._send('354 Start mail input; end with <CR><LF>.<CR><LF>');
		this.state = 'data';
		this.dataBuffer = '';
	}

	async _processData(rawMessage) {
		// Wrap the whole pipeline in a try/catch so any downstream error
		// (DB schema mismatch, model exception, anything) logs a clean
		// line and sends a 451 to the client instead of crashing the
		// mail process via an unhandled promise rejection -- _onData
		// calls us fire-and-forget so unhandled rejections would kill
		// the process, which pm2 would then restart in a loop.
		try {
			// Parse RFC 2822 message
			var parsed = this._parseMessage(rawMessage);

			if (this.trustedMode) {
				// Trusted inbound: deliver directly as EMAIL transport PM
				await this._processInboundData(parsed);
			} else {
				// Authenticated submission: queue outbound via queueMessage
				await this._processSubmissionData(parsed);
			}

			this._send('250 OK message queued');
		} catch (err) {
			alogger.writeAlog(1,
				'SMTP ' + (this.trustedMode ? 'inbound' : 'submission') +
				' data processing FAILED: ' + err.message +
				(err.stack ? '\n' + err.stack : ''),
				'redbright');
			this._send('451 4.3.0 Temporary server error processing message, please retry later');
		}
		this.mailFrom = null;
		this.rcptTo = [];
	}

	async _processSubmissionData(parsed) {
		for (var rcpt of this.rcptTo) {
			var messageObj = {
				user_id: this.userId,
				from_user: this.username,
				to_user: rcpt.username || rcpt.toUser || '',
				from_address: '',
				to_address: rcpt.ftnAddress || rcpt.qwkPeerId || '',
				subject: parsed.subject || '(no subject)',
				body_text: parsed.bodyPlain || parsed.bodyHtml || '',
				utf8: parsed.bodyPlain || '',
				transport_type: rcpt.transportType,
				transport_data: rcpt.transportData || {},
				system_time: new Date()
			};

			// Build minimal session for access control
			var session = {
				id: this.userId,
				username: this.username,
				security: this.userRecord.security,
				permissionflags: this.userRecord.permissionflags,
				restrictionflags: this.userRecord.restrictionflags
			};

			var result = await queueMessage(messageObj, session);
			if (!result.status) {
				alogger.writeAlog(3, 'SMTP delivery failed to ' + rcpt.address +
					': ' + result.errormessages.join(', '), 'yellow');
			} else {
				// Store attachments on outbox message
				if (parsed.attachments && parsed.attachments.length > 0 && result.outboxUuid) {
					var attIds = await storeAttachments(result.outboxUuid, 'outbox', parsed.attachments);
					if (attIds.length > 0) {
						try {
							var pg = await import('../middleware/db/postgres.js');
							await pg.write('UPDATE pm_outbox SET has_attachments = true WHERE uuid = $1', [result.outboxUuid]);
							// For LOCAL delivery, copy attachments to inbox
							if (result.deliveryResult && result.deliveryResult.uuid) {
								var pmAtt = await import('../models/pmAttachments.js');
								await pmAtt.copyAttachmentsToInbox(result.outboxUuid, result.deliveryResult.uuid);
								await pg.write('UPDATE pm_inbox SET has_attachments = true WHERE uuid = $1', [result.deliveryResult.uuid]);
							}
						} catch (_) {}
					}
				}
				alogger.writeAlog(4, 'SMTP delivered to ' + rcpt.address +
					' from ' + this.username, 'green');
			}
		}
	}

	async _processInboundData(parsed) {
		// Trusted inbound: deliver each recipient as a LOCAL inbox message
		// from an external email sender.
		var senderAddress = this.mailFrom || '';
		var senderName = parsed.headers['from'] || senderAddress;
		// Strip angle brackets if present: "Name <addr>" → use as-is for display
		var displayFrom = senderName.replace(/<[^>]*>/g, '').trim() || senderAddress;

		alogger.writeAlog(3,
			'SMTP inbound: DATA received, processing ' + this.rcptTo.length +
			' recipient(s) from ' + senderAddress +
			' (subject: ' + (parsed.subject || '(none)') +
			', body-bytes: ' + ((parsed.bodyPlain || '').length + (parsed.bodyHtml || '').length) +
			', attachments: ' + (parsed.attachments ? parsed.attachments.length : 0) + ')',
			'cyan');

		// Extract the RFC 5322 Message-ID header if present. It's not an
		// FTN MSGID but stuffing it into msg_id lets the dupe check match
		// repeated deliveries of the same message from the upstream MTA,
		// and makes threading work if we later read this via IMAP.
		var rfcMessageId = parsed.headers['message-id'] || '';
		rfcMessageId = rfcMessageId.trim();

		for (var rcpt of this.rcptTo) {
			if (!rcpt.transportData || !rcpt.transportData.recipient_user_id) {
				alogger.writeAlog(3,
					'SMTP inbound: skipping recipient ' + (rcpt.address || '?') +
					' (no recipient_user_id in transport data)',
					'yellow');
				continue;
			}

			var messageObj = {
				user_id: rcpt.transportData.recipient_user_id,
				from_user: displayFrom,
				to_user: rcpt.username || rcpt.toUser || '',
				from_address: senderAddress,
				to_address: '',
				msg_id: rfcMessageId,
				subject: parsed.subject || '(no subject)',
				body_text: parsed.bodyPlain || parsed.bodyHtml || '',
				utf8: parsed.bodyPlain || '',
				transport_type: 'EMAIL',
				transport_data: {
					email_address: senderAddress,
					inbound: true
				},
				system_time: new Date()
			};

			var result = await deliverMessage(messageObj);
			if (!result.status) {
				alogger.writeAlog(3, 'SMTP inbound delivery failed to ' + rcpt.address +
					': ' + (result.errormessages || []).join(', '), 'yellow');
			} else {
				// Store attachments if present
				if (parsed.attachments && parsed.attachments.length > 0 && result.uuid) {
					var attIds = await storeAttachments(result.uuid, 'inbox', parsed.attachments);
					if (attIds.length > 0) {
						// Mark message as having attachments
						try {
							var pg = await import('../middleware/db/postgres.js');
							await pg.write('UPDATE pm_inbox SET has_attachments = true WHERE uuid = $1', [result.uuid]);
						} catch (_) {}
					}
				}
				alogger.writeAlog(3, 'SMTP inbound delivered to ' + rcpt.address +
					' from ' + senderAddress +
					(parsed.attachments.length > 0 ? ' (' + parsed.attachments.length + ' attachment(s))' : ''),
					'green');
			}
		}
	}

	// --- Address resolution ---

	async _resolveAddress(address) {
		var atIdx = address.indexOf('@');
		if (atIdx === -1) return null;

		var localPart = address.substring(0, atIdx);
		var domainLower = address.substring(atIdx + 1).toLowerCase();

		// Trusted inbound mode: only accept local users on our domain — no network relay
		if (this.trustedMode) {
			if (domainLower !== this.mailDomain.toLowerCase()) return null;
			var resolved = await resolveRecipient(localPart);
			if (resolved.resolved) {
				return {
					address: address,
					transportType: 'LOCAL',
					username: resolved.username,
					toUser: resolved.username,
					transportData: {
						recipient_user_id: resolved.userId
					}
				};
			}
			return null;
		}

		// --- FTN pseudo-TLD: user@zone.net.node[.point][.ftndomain].ftn ---
		// Leading numeric dot-parts are the address, trailing non-numeric part
		// (if any) is the 5D FTN domain. Point numbers are always numeric,
		// FTN domain names are always alphabetic — no ambiguity.
		if (domainLower.endsWith('.ftn')) {
			var ftnBody = domainLower.slice(0, -4); // strip .ftn
			var parts = ftnBody.split('.');

			// Split into leading numeric parts (address) and trailing non-numeric (domain)
			var numericParts = [];
			var ftnDomain = '';
			for (var i = 0; i < parts.length; i++) {
				if (/^\d+$/.test(parts[i])) {
					numericParts.push(parts[i]);
				} else {
					// First non-numeric part is the 5D domain (rest shouldn't exist, but join if so)
					ftnDomain = parts.slice(i).join('.');
					break;
				}
			}

			if (numericParts.length >= 3) {
				var ftnAddr = numericParts[0] + ':' + numericParts[1] + '/' + numericParts[2];
				if (numericParts.length >= 4) ftnAddr += '.' + numericParts[3];
				if (ftnDomain) ftnAddr += '@' + ftnDomain;

				return {
					address: address,
					transportType: 'FTN',
					toUser: localPart || 'Sysop',
					username: localPart || 'Sysop',
					ftnAddress: ftnAddr,
					transportData: {
						ftn_to_address: ftnAddr,
						ftn_to_name: localPart || 'Sysop'
					}
				};
			}
			return null; // Malformed .ftn address
		}

		// --- QWK pseudo-TLD: user@peerid.qwk ---
		if (domainLower.endsWith('.qwk')) {
			var qwkPeerId = domainLower.slice(0, -4).toUpperCase();
			if (!qwkPeerId) return null;

			return {
				address: address,
				transportType: 'QWK',
				toUser: localPart || 'Sysop',
				username: localPart || 'Sysop',
				qwkPeerId: qwkPeerId,
				transportData: {
					destination: qwkPeerId
				}
			};
		}

		// --- Our mail domain: local delivery or legacy % encoding ---
		if (domainLower !== this.mailDomain.toLowerCase()) {
			// In trusted inbound mode, only accept local recipients — no relay out
			if (this.trustedMode) return null;
			// Authenticated submission: treat as outbound internet email
			return {
				address: address,
				transportType: 'EMAIL',
				toUser: localPart,
				username: localPart,
				transportData: {
					email_address: address
				}
			};
		}

		// Legacy % encoding (backwards compat): user%zone.net.node or user%peerid
		var pctIdx = localPart.indexOf('%');
		if (pctIdx >= 0) {
			var netUser = localPart.substring(0, pctIdx);
			var netAddr = localPart.substring(pctIdx + 1);

			var ftnDomain2 = '';
			var addrStr = netAddr;
			var bangIdx = addrStr.indexOf('!');
			if (bangIdx >= 0) {
				ftnDomain2 = addrStr.substring(bangIdx + 1);
				addrStr = addrStr.substring(0, bangIdx);
			}
			var addrParts = addrStr.split('.');
			if (addrParts.length >= 3 && addrParts.every(function(p) { return /^\d+$/.test(p); })) {
				var ftnAddr2 = addrParts[0] + ':' + addrParts[1] + '/' + addrParts[2];
				if (addrParts.length >= 4) ftnAddr2 += '.' + addrParts[3];
				if (ftnDomain2) ftnAddr2 += '@' + ftnDomain2;

				return {
					address: address,
					transportType: 'FTN',
					toUser: netUser || 'Sysop',
					username: netUser || 'Sysop',
					ftnAddress: ftnAddr2,
					transportData: {
						ftn_to_address: ftnAddr2,
						ftn_to_name: netUser || 'Sysop'
					}
				};
			}

			// % but not FTN → QWK
			return {
				address: address,
				transportType: 'QWK',
				toUser: netUser || 'Sysop',
				username: netUser || 'Sysop',
				qwkPeerId: netAddr.toUpperCase(),
				transportData: {
					destination: netAddr.toUpperCase()
				}
			};
		}

		// Local user resolution
		var resolved = await resolveRecipient(localPart);
		if (resolved.resolved) {
			return {
				address: address,
				transportType: 'LOCAL',
				username: resolved.username,
				toUser: resolved.username,
				transportData: {
					recipient_user_id: resolved.userId
				}
			};
		}

		return null;
	}

	// --- Minimal RFC 2822 parser ---

	_parseMessage(raw) {
		var result = { subject: '', bodyPlain: '', bodyHtml: '', headers: {}, attachments: [] };

		// Split headers from body at first blank line
		var blankIdx = raw.indexOf('\r\n\r\n');
		if (blankIdx === -1) blankIdx = raw.indexOf('\n\n');

		var headerSection, bodySection;
		if (blankIdx >= 0) {
			headerSection = raw.substring(0, blankIdx);
			bodySection = raw.substring(blankIdx).replace(/^[\r\n]+/, '');
		} else {
			headerSection = raw;
			bodySection = '';
		}

		// Parse headers (unfold continuation lines)
		var headers = headerSection.replace(/\r\n\s+/g, ' ').replace(/\n\s+/g, ' ');
		var headerLines = headers.split(/\r?\n/);
		for (var hl of headerLines) {
			var colonIdx = hl.indexOf(':');
			if (colonIdx > 0) {
				var key = hl.substring(0, colonIdx).trim().toLowerCase();
				var val = hl.substring(colonIdx + 1).trim();
				result.headers[key] = val;
			}
		}

		result.subject = result.headers['subject'] || '';

		// Extract body — check for MIME multipart
		var contentType = result.headers['content-type'] || '';
		if (contentType.includes('multipart/')) {
			this._parseMultipart(bodySection, contentType, result);
		} else {
			// Simple body
			if (contentType.includes('text/html')) {
				result.bodyHtml = bodySection;
			} else {
				result.bodyPlain = bodySection;
			}
		}

		// Strip HTML tags for plain text if only HTML available
		if (!result.bodyPlain && result.bodyHtml) {
			result.bodyPlain = result.bodyHtml.replace(/<[^>]*>/g, '');
		}

		return result;
	}

	_parseMultipart(body, contentType, result) {
		var boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
		if (!boundaryMatch) return;

		var boundary = boundaryMatch[1];
		var parts = body.split('--' + boundary);

		for (var part of parts) {
			if (part.startsWith('--') || !part.trim()) continue;

			var partBlank = part.indexOf('\r\n\r\n');
			if (partBlank === -1) partBlank = part.indexOf('\n\n');
			if (partBlank < 0) continue;

			var partHeaderStr = part.substring(0, partBlank);
			var partBody = part.substring(partBlank).replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');

			// Parse part headers (unfold continuations)
			var partHeaders = {};
			var unfolded = partHeaderStr.replace(/\r\n\s+/g, ' ').replace(/\n\s+/g, ' ');
			var phLines = unfolded.split(/\r?\n/);
			for (var phl of phLines) {
				var ci = phl.indexOf(':');
				if (ci > 0) {
					partHeaders[phl.substring(0, ci).trim().toLowerCase()] = phl.substring(ci + 1).trim();
				}
			}

			var partCt = (partHeaders['content-type'] || '').toLowerCase();
			var partDisp = (partHeaders['content-disposition'] || '').toLowerCase();
			var partEncoding = (partHeaders['content-transfer-encoding'] || '').toLowerCase().trim();

			// Recurse into nested multipart (e.g. multipart/alternative inside multipart/mixed)
			if (partCt.includes('multipart/')) {
				this._parseMultipart(partBody, partHeaders['content-type'] || partCt, result);
				continue;
			}

			// Text parts
			if (partCt.includes('text/plain') && !partDisp.includes('attachment')) {
				result.bodyPlain = this._decodePart(partBody, partEncoding);
				continue;
			}
			if (partCt.includes('text/html') && !partDisp.includes('attachment')) {
				result.bodyHtml = this._decodePart(partBody, partEncoding);
				continue;
			}

			// Attachment part (anything else, or anything with Content-Disposition: attachment)
			var filename = this._extractFilename(partHeaders['content-disposition'] || '', partHeaders['content-type'] || '');
			if (!filename) filename = 'attachment';

			var mimeType = partCt.split(';')[0].trim() || 'application/octet-stream';

			// partBody is a latin1 string (byte-faithful). For base64 we
			// feed the ASCII-only text to Buffer's base64 decoder. For
			// quoted-printable we decode =XX escapes (each producing a
			// single char code) and reinterpret the result as raw bytes
			// -- NOT utf8, which would corrupt any byte > 0x7F. For
			// unencoded 8bit/binary parts latin1 already is the raw bytes.
			var data;
			if (partEncoding === 'base64') {
				data = Buffer.from(partBody.replace(/\s/g, ''), 'base64');
			} else if (partEncoding === 'quoted-printable') {
				data = Buffer.from(this._decodeQP(partBody), 'latin1');
			} else {
				data = Buffer.from(partBody, 'latin1');
			}

			result.attachments.push({
				filename: filename,
				mimeType: mimeType,
				data: data
			});
		}
	}

	// Decode a text/* part body into a JavaScript UTF-8 string.
	//
	// The raw body is held as a latin1 string at this point (see _onData)
	// so every character code is the literal byte value. We reinterpret
	// those bytes as UTF-8 because modern mail is overwhelmingly UTF-8;
	// messages in another charset will Mojibake but attachment integrity
	// (the priority here) is preserved.
	_decodePart(body, encoding) {
		if (encoding === 'base64') {
			return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
		}
		if (encoding === 'quoted-printable') {
			var qpBytes = this._decodeQP(body);
			return Buffer.from(qpBytes, 'latin1').toString('utf8');
		}
		// 7bit, 8bit, binary -- body is already the raw bytes held in latin1
		return Buffer.from(body, 'latin1').toString('utf8');
	}

	_decodeQP(str) {
		return str
			.replace(/=\r?\n/g, '') // soft line breaks
			.replace(/=([0-9A-Fa-f]{2})/g, function(_, hex) {
				return String.fromCharCode(parseInt(hex, 16));
			});
	}

	_extractFilename(disposition, contentType) {
		// Try Content-Disposition: attachment; filename="file.pdf"
		var match = disposition.match(/filename\*?="?([^";\r\n]+)"?/i);
		if (match) return match[1].trim();

		// Try Content-Type: application/pdf; name="file.pdf"
		match = contentType.match(/name="?([^";\r\n]+)"?/i);
		if (match) return match[1].trim();

		return null;
	}
}

// ---------------------------------------------------------------------------
// Trusted-host allowlist parsing
// ---------------------------------------------------------------------------
//
// email_trusted_hosts accepts a comma-separated mix of:
//   - bare IPv4 addresses       (e.g. 127.0.0.1)
//   - IPv4 CIDR blocks          (e.g. 10.0.0.0/8, 192.168.1.0/24)
//
// CIDR entries with non-zero host bits (e.g. 10.0.0.1/8) are accepted and
// normalised by masking the base against the prefix length. IPv6 is not yet
// supported -- operators wanting IPv6 should list exact addresses for now.

function _ipv4ToInt(ip) {
	if (!ip) return null;
	var parts = ip.split('.');
	if (parts.length !== 4) return null;
	var result = 0;
	for (var i = 0; i < 4; i++) {
		var n = parseInt(parts[i], 10);
		if (isNaN(n) || n < 0 || n > 255 || String(n) !== parts[i].replace(/^0+(?=\d)/, '')) {
			// Reject non-numeric, out of range, or weird padded forms like "01"
			// (the replace lets "0" itself through)
			if (String(n) !== parts[i]) return null;
		}
		if (isNaN(n) || n < 0 || n > 255) return null;
		result = ((result * 256) + n) >>> 0;
	}
	return result;
}

function _parseTrustedHostList(hostStr) {
	var exact = new Set();
	var cidrs = [];
	var parts = (hostStr || '').split(',').map(function(h) { return h.trim(); }).filter(Boolean);

	for (var p of parts) {
		var slashIdx = p.indexOf('/');
		if (slashIdx >= 0) {
			var baseStr = p.substring(0, slashIdx);
			var prefixLen = parseInt(p.substring(slashIdx + 1), 10);
			var baseInt = _ipv4ToInt(baseStr);
			if (baseInt === null || isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) {
				alogger.writeAlog(2,
					'SMTP inbound: invalid CIDR in email_trusted_hosts: "' + p +
					'" -- expected IPv4 with prefix 0-32',
					'yellow');
				continue;
			}
			var mask = prefixLen === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
			cidrs.push({
				base: (baseInt & mask) >>> 0,
				mask: mask,
				text: p
			});
		} else {
			exact.add(p);
		}
	}

	return { exact: exact, cidrs: cidrs };
}

function _matchesTrustedHost(normalizedAddr, parsed) {
	if (!parsed) return false;
	if (parsed.exact && parsed.exact.has(normalizedAddr)) return true;
	if (!parsed.cidrs || parsed.cidrs.length === 0) return false;
	var addrInt = _ipv4ToInt(normalizedAddr);
	if (addrInt === null) return false;
	for (var cidr of parsed.cidrs) {
		if (((addrInt & cidr.mask) >>> 0) === cidr.base) return true;
	}
	return false;
}

function _trustedHostListToString(parsed) {
	if (!parsed) return '(none)';
	var out = [];
	if (parsed.exact) {
		for (var e of parsed.exact) out.push(e);
	}
	if (parsed.cidrs) {
		for (var c of parsed.cidrs) out.push(c.text);
	}
	return out.length > 0 ? out.join(', ') : '(none)';
}

// ---------------------------------------------------------------------------
// SmtpServer
// ---------------------------------------------------------------------------

class SmtpServer {
	constructor(port, mailDomain, options) {
		this.port = port;
		this.mailDomain = mailDomain;
		this.options = options || {};
		this.server = null;
		this.sessions = new Set();

		// Trusted mode: parse allowed hosts into exact-match Set + CIDR list
		if (this.options.trusted) {
			var hostStr = this.options.trustedHosts || '127.0.0.1';
			this._trustedHosts = _parseTrustedHostList(hostStr);
		}
	}

	start() {
		var self = this;
		this.server = net.createServer((socket) => {
			// In trusted mode, verify connecting IP
			if (self.options.trusted) {
				var remoteAddr = socket.remoteAddress || '';
				// Normalize IPv6-mapped IPv4 (::ffff:127.0.0.1 → 127.0.0.1)
				var normalizedAddr = remoteAddr.replace(/^::ffff:/, '');
				if (!_matchesTrustedHost(normalizedAddr, self._trustedHosts)) {
					// Level 2 so sysops see this in default logs -- a blocked
					// gateway usually looks like a mystery "undeliverable" on
					// the sending side and nothing obvious on the receiving
					// side if this line is hidden behind verbose logging.
					alogger.writeAlog(2,
						'SMTP inbound: rejected untrusted host ' + normalizedAddr +
						' (allowlist has ' + _trustedHostListToString(self._trustedHosts) +
						'). Add this IP or a containing CIDR block to ' +
						'email_trusted_hosts in /admin/config if the sender is legitimate.',
						'yellow');
					// More informative 5.7.1 reply so the remote postfix log
					// shows "access denied" rather than just "connection refused".
					socket.write('554 5.7.1 Access denied: ' + normalizedAddr +
						' is not in this host\'s SMTP allowlist\r\n');
					socket.end();
					return;
				}
			}
			var session = new SmtpSession(socket, self.mailDomain, self.options);
			self.sessions.add(session);
			socket.on('close', () => self.sessions.delete(session));
		});

		this.server.on('error', (err) => {
			alogger.writeAlog(0, 'SMTP server error: ' + err.message, 'redbright');
		});

		var label = this.options.trusted ? 'SMTP inbound (trusted)' : 'SMTP submission';
		this.server.listen(this.port, () => {
			alogger.writeAlog(1, label + ' server listening on port ' + self.port +
				' (domain: ' + self.mailDomain + ')', 'magentabright', true);
		});
	}

	stop() {
		for (var session of this.sessions) session.close();
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}

export {
	SmtpServer,
	SmtpSession,
	_parseTrustedHostList,
	_matchesTrustedHost,
	_ipv4ToInt
};
