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
import { resolveRecipient, queueMessage } from '../models/privateMessages.js';
import appConfig from '../config/appConfig.js';

// ---------------------------------------------------------------------------
// SmtpSession — one per client connection
// ---------------------------------------------------------------------------

class SmtpSession {
	constructor(socket, mailDomain) {
		this.socket = socket;
		this.mailDomain = mailDomain;
		this.state = 'greeting'; // greeting, ready, auth_login_user, auth_login_pass, data
		this.authenticated = false;
		this.userId = null;
		this.username = null;
		this.userRecord = null;
		this.mailFrom = null;
		this.rcptTo = [];
		this.dataBuffer = '';
		this._buffer = '';
		this._closed = false;

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
			// Collecting message body
			this.dataBuffer += data.toString('utf8');
			// Check for end-of-data marker
			if (this.dataBuffer.includes('\r\n.\r\n')) {
				var body = this.dataBuffer.split('\r\n.\r\n')[0];
				this.dataBuffer = '';
				this.state = 'ready';
				this._processData(body);
			}
			return;
		}

		this._buffer += data.toString('utf8');
		var lines = this._buffer.split('\r\n');
		this._buffer = lines.pop();

		for (var line of lines) {
			if (line.length > 0) {
				this._processCommand(line);
			}
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

	_cmdEhlo(clientName) {
		this._send('250-' + this.mailDomain);
		this._send('250-AUTH PLAIN LOGIN');
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
			this._send('501 Syntax error in MAIL FROM');
			return;
		}

		this.mailFrom = match[1];
		this.rcptTo = [];
		this._send('250 OK');
	}

	// --- RCPT TO ---

	async _cmdRcptTo(line) {
		if (!this.authenticated) {
			this._send('530 Authentication required');
			return;
		}
		if (!this.mailFrom) {
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
		if (!resolved) {
			this._send('550 Recipient not found or relay denied: ' + address);
			return;
		}

		this.rcptTo.push(resolved);
		this._send('250 OK');
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
		// Parse RFC 2822 message
		var parsed = this._parseMessage(rawMessage);

		for (var rcpt of this.rcptTo) {
			var messageObj = {
				user_id: this.userId,
				from_user: this.username,
				to_user: rcpt.username || rcpt.toUser || '',
				from_address: rcpt.transportType === 'FTN' ? '' : '',
				to_address: rcpt.ftnAddress || '',
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
				alogger.writeAlog(4, 'SMTP delivered to ' + rcpt.address +
					' from ' + this.username, 'green');
			}
		}

		this._send('250 OK message queued');
		this.mailFrom = null;
		this.rcptTo = [];
	}

	// --- Address resolution ---

	async _resolveAddress(address) {
		var atIdx = address.indexOf('@');
		if (atIdx === -1) return null;

		var localPart = address.substring(0, atIdx);
		var domain = address.substring(atIdx + 1);

		// Must be our domain
		if (domain.toLowerCase() !== this.mailDomain.toLowerCase()) {
			return null; // No relay
		}

		// Check for FTN encoding: user%zone.net.node
		var pctIdx = localPart.indexOf('%');
		if (pctIdx >= 0) {
			var ftnUser = localPart.substring(0, pctIdx);
			var ftnAddr = localPart.substring(pctIdx + 1).replace(/\./g, ':').replace(/:([^:]+)$/, '/$1');
			// Convert a.b.c → a:b/c (zone:net/node)
			var addrParts = localPart.substring(pctIdx + 1).split('.');
			if (addrParts.length >= 3) {
				ftnAddr = addrParts[0] + ':' + addrParts[1] + '/' + addrParts[2];
				if (addrParts.length >= 4) ftnAddr += '.' + addrParts[3]; // point
			}

			return {
				address: address,
				transportType: 'FTN',
				toUser: ftnUser || 'Sysop',
				username: ftnUser || 'Sysop',
				ftnAddress: ftnAddr,
				transportData: {
					ftn_to_address: ftnAddr,
					ftn_to_name: ftnUser || 'Sysop'
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
		var result = { subject: '', bodyPlain: '', bodyHtml: '', headers: {} };

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
			var boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
			if (boundaryMatch) {
				var boundary = boundaryMatch[1];
				var parts = bodySection.split('--' + boundary);
				for (var part of parts) {
					if (part.startsWith('--')) continue; // End marker
					var partBlank = part.indexOf('\r\n\r\n');
					if (partBlank === -1) partBlank = part.indexOf('\n\n');
					if (partBlank >= 0) {
						var partHeaders = part.substring(0, partBlank).toLowerCase();
						var partBody = part.substring(partBlank).replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
						if (partHeaders.includes('text/plain')) {
							result.bodyPlain = partBody;
						} else if (partHeaders.includes('text/html')) {
							result.bodyHtml = partBody;
						}
					}
				}
			}
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
}

// ---------------------------------------------------------------------------
// SmtpServer
// ---------------------------------------------------------------------------

class SmtpServer {
	constructor(port, mailDomain) {
		this.port = port;
		this.mailDomain = mailDomain;
		this.server = null;
		this.sessions = new Set();
	}

	start() {
		this.server = net.createServer((socket) => {
			var session = new SmtpSession(socket, this.mailDomain);
			this.sessions.add(session);
			socket.on('close', () => this.sessions.delete(session));
		});

		this.server.on('error', (err) => {
			alogger.writeAlog(0, 'SMTP server error: ' + err.message, 'redbright');
		});

		this.server.listen(this.port, () => {
			alogger.writeAlog(1, 'SMTP submission server listening on port ' + this.port +
				' (domain: ' + this.mailDomain + ')', 'magentabright', true);
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

export { SmtpServer, SmtpSession };
