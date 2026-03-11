// nntpTosser.js
// Minimal NNTP pull client. Connects to NNTP peers, fetches new articles for
// mapped newsgroups, and imports them into the echomail message tables.
//
// Threading: uses Message-ID / References chain (not FTN subject matching).
// High-water marks: stored in connection_data.high_water_marks per areatag.
// source_network_id: written to message rows so step-9 echomail changes can
// suppress re-delivery on the originating network. TODO(step-9): echomail.js
// must read and enforce this field on outbound delivery.

import * as net from 'net';
import * as tls from 'tls';
import { v4 as uuidv4 } from 'uuid';
import * as dotenv from 'dotenv';

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as peerConnections from './peerConnections.js';
import * as networkAreas from './networkAreas.js';
import { cp437ToUtf8 } from '../utils/codepageConversions.js';

dotenv.config();

// ---------------------------------------------------------------------------
// NNTPClient — raw socket NNTP client
// ---------------------------------------------------------------------------

class NNTPClient {
	constructor() {
		this.socket       = null;
		this.lineBuffer   = '';
		this.pendingLine  = null;   // { resolve, reject }
		this.connected    = false;
	}

	// Connect and read the greeting line. Returns greeting response object.
	async connect(host, port, use_tls) {
		return new Promise((resolve, reject) => {
			const onConnect = async () => {
				this.connected = true;
				this.socket.on('data', (chunk) => this._onData(chunk));
				this.socket.on('error', (err) => {
					if (this.pendingLine) {
						this.pendingLine.reject(err);
						this.pendingLine = null;
					}
				});
				this.socket.on('close', () => {
					this.connected = false;
					if (this.pendingLine) {
						this.pendingLine.reject(new Error('Socket closed unexpectedly'));
						this.pendingLine = null;
					}
				});

				try {
					var greeting = await this._readSingleLine();
					resolve(this._parseLine(greeting));
				} catch (err) {
					reject(err);
				}
			};

			if (use_tls) {
				this.socket = tls.connect({ host, port, rejectUnauthorized: false }, onConnect);
			} else {
				this.socket = net.createConnection({ host, port }, onConnect);
			}

			this.socket.once('error', reject);
		});
	}

	_onData(chunk) {
		this.lineBuffer += chunk.toString('binary');
		if (this.pendingLine) {
			var idx = this.lineBuffer.indexOf('\r\n');
			if (idx !== -1) {
				var line = this.lineBuffer.slice(0, idx);
				this.lineBuffer = this.lineBuffer.slice(idx + 2);
				var resolve = this.pendingLine.resolve;
				this.pendingLine = null;
				resolve(line);
			}
		}
	}

	_readSingleLine() {
		return new Promise((resolve, reject) => {
			// Check if a line is already buffered
			var idx = this.lineBuffer.indexOf('\r\n');
			if (idx !== -1) {
				var line = this.lineBuffer.slice(0, idx);
				this.lineBuffer = this.lineBuffer.slice(idx + 2);
				resolve(line);
				return;
			}
			this.pendingLine = { resolve, reject };
		});
	}

	_parseLine(line) {
		var code = parseInt(line.slice(0, 3));
		var text = line.slice(4);
		return { code, text, raw: line };
	}

	// Send a command and read a single-line response
	async _command(cmd) {
		await this._write(cmd + '\r\n');
		var line = await this._readSingleLine();
		return this._parseLine(line);
	}

	// Send a command and read a multi-line response (dot-stuffed body)
	async _commandMulti(cmd) {
		await this._write(cmd + '\r\n');
		var statusLine = await this._readSingleLine();
		var status = this._parseLine(statusLine);
		if (status.code >= 400) {
			return { ...status, lines: [] };
		}

		var lines = [];
		while (true) {
			var line = await this._readSingleLine();
			if (line === '.') break;
			// Dot-unstuffing: leading '..' → '.'
			if (line.startsWith('..')) line = line.slice(1);
			lines.push(line);
		}
		return { ...status, lines };
	}

	_write(data) {
		return new Promise((resolve, reject) => {
			this.socket.write(data, 'binary', (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	// --- NNTP commands ---

	async authenticate(username, password) {
		if (!username) return true;
		var r1 = await this._command('AUTHINFO USER ' + username);
		if (r1.code === 381) {
			var r2 = await this._command('AUTHINFO PASS ' + password);
			return r2.code === 281;
		}
		return r1.code === 281;
	}

	// Returns { count, first, last, name } or null if group not found
	async group(groupName) {
		var r = await this._command('GROUP ' + groupName);
		if (r.code !== 211) return null;
		var parts = r.text.split(' ');
		return {
			count: parseInt(parts[0]),
			first: parseInt(parts[1]),
			last:  parseInt(parts[2]),
			name:  parts[3]
		};
	}

	// Returns array of overview objects for articles first..last
	// XOVER format: num\tsubject\tfrom\tdate\tmessage-id\treferences\tbytes\tlines
	async xover(first, last) {
		var r = await this._commandMulti('XOVER ' + first + '-' + last);
		if (r.code !== 224) return [];
		return r.lines.map(line => {
			var parts = line.split('\t');
			return {
				articleNum:  parseInt(parts[0]),
				subject:     parts[1] || '',
				from:        parts[2] || '',
				date:        parts[3] || '',
				messageId:   parts[4] || '',
				references:  parts[5] || '',
				bytes:       parseInt(parts[6]) || 0,
				lines:       parseInt(parts[7]) || 0
			};
		});
	}

	// Fetches full article by message-id or article number.
	// Returns { code, headers, body } or null on 430/other error.
	async article(msgIdOrNum) {
		var r = await this._commandMulti('ARTICLE ' + msgIdOrNum);
		if (r.code !== 220) return null;

		var headers = {};
		var inHeaders = true;
		var bodyLines = [];
		var lastHeaderKey = null;

		for (var line of r.lines) {
			if (inHeaders) {
				if (line === '') {
					inHeaders = false;
					continue;
				}
				// Header folding: lines beginning with whitespace continue prev header
				if (/^[ \t]/.test(line) && lastHeaderKey) {
					headers[lastHeaderKey] += ' ' + line.trim();
				} else {
					var colonIdx = line.indexOf(':');
					if (colonIdx > 0) {
						lastHeaderKey = line.slice(0, colonIdx).toLowerCase();
						headers[lastHeaderKey] = line.slice(colonIdx + 1).trim();
					}
				}
			} else {
				bodyLines.push(line);
			}
		}

		return {
			code:    r.code,
			headers: headers,
			body:    bodyLines.join('\n')
		};
	}

	// Check whether server accepts posting — MODE READER returns 200 (allowed)
	// or 201 (read-only). Some servers also indicate this in the greeting.
	async checkPostingAllowed() {
		var r = await this._command('MODE READER');
		return r.code === 200;
	}

	// POST an article. articleText must be a complete RFC 2822 formatted article
	// with CRLF line endings and a dot-stuffed body (leading dots doubled).
	// Returns the server response object: code 240 on success, 441 on failure.
	async post(articleText) {
		var r = await this._command('POST');
		if (r.code !== 340) return r;  // 440 = posting not permitted
		await this._write(articleText + '\r\n.\r\n');
		var line = await this._readSingleLine();
		return this._parseLine(line);
	}

	async quit() {
		if (!this.connected) return;
		try { await this._command('QUIT'); } catch (_) {}
		this.socket.destroy();
		this.connected = false;
	}
}

// ---------------------------------------------------------------------------
// Body decoding helpers
// ---------------------------------------------------------------------------

// Parse charset out of a Content-Type header value.
// e.g. "text/plain; charset=utf-8" → "utf-8"
function parseCharset(contentType) {
	if (!contentType) return null;
	var match = contentType.match(/charset\s*=\s*["']?([^"';\s]+)/i);
	return match ? match[1].toLowerCase() : null;
}

// Minimal quoted-printable decoder.
// Handles soft line breaks (=\r\n or =\n) and =XX hex sequences.
function decodeQuotedPrintable(str) {
	return str
		.replace(/=\r?\n/g, '')                         // soft line break
		.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Decode Content-Transfer-Encoding. Returns a string (may be latin-1 encoded).
function decodeTransferEncoding(body, encoding) {
	var enc = (encoding || '7bit').toLowerCase().trim();
	if (enc === 'base64') {
		// Decode base64 → Buffer → latin-1 string (preserve byte values for charset step)
		try {
			return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('latin1');
		} catch (_) {
			return body;
		}
	}
	if (enc === 'quoted-printable') {
		return decodeQuotedPrintable(body);
	}
	// 7bit, 8bit, binary — pass through
	return body;
}

// Normalise NNTP line endings to \r so formatTextForHtml and formatTerminalText
// (both of which are built around FTN \r conventions) work correctly.
// NNTP uses \n; some articles may have \r\n. Strip lone \r first, then \n → \r.
function normaliseLineEndings(str) {
	return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r');
}

// Convert a decoded body string — handles charset normalisation.
// Returns { bodyText, utf8 }.
//
// After QP or base64 decoding, String.fromCharCode() has already mapped each
// byte value directly to the matching Unicode codepoint, so latin-1 text is
// already correct Unicode in the JS string — no Buffer re-encoding needed.
// The utf8 column is only populated here if the charset is CP437 (unusual on
// Usenet but possible in legacy crossposts), using the existing cp437ToUtf8
// utility.  For all other charsets the decoded string is stored as-is.
function normaliseBodyText(decodedBody, charset) {
	var cs = (charset || 'utf-8').toLowerCase().replace(/[^a-z0-9]/g, '');

	// CP437 — the only case where we need a real conversion table
	if (cs === 'cp437' || cs === 'ibm437') {
		try {
			var utf8str = cp437ToUtf8(decodedBody);
			return { bodyText: decodedBody, utf8: utf8str };
		} catch (_) {
			return { bodyText: decodedBody, utf8: null };
		}
	}

	// UTF-8, ASCII, latin-1, ISO-8859-x, windows-125x — all already correct
	// Unicode after the transfer-encoding decode step (String.fromCharCode maps
	// byte values directly to Unicode codepoints for these charsets).
	return { bodyText: decodedBody, utf8: null };
}

// ---------------------------------------------------------------------------
// Article import
// ---------------------------------------------------------------------------

// Parses a From header into a display name.
// "John Doe <john@example.com>" → "John Doe"
// "john@example.com (John Doe)" → "John Doe"
// "john@example.com" → "john@example.com"
function parseFromName(fromHeader) {
	if (!fromHeader) return 'Unknown';
	var angleMatch = fromHeader.match(/^(.*?)\s*<[^>]+>/);
	if (angleMatch && angleMatch[1].trim()) return angleMatch[1].trim().replace(/^"|"$/g, '');
	var parenMatch = fromHeader.match(/\(([^)]+)\)/);
	if (parenMatch) return parenMatch[1].trim();
	return fromHeader.trim();
}

// Parses a date string into a Date object, falls back to now on failure.
function parseArticleDate(dateStr) {
	if (!dateStr) return new Date();
	var d = new Date(dateStr);
	return isNaN(d.getTime()) ? new Date() : d;
}

// Returns the immediate parent Message-ID from a References header, or null.
// References is a space-separated list; the last entry is the direct parent.
function parseImmediateParent(referencesHeader) {
	if (!referencesHeader || !referencesHeader.trim()) return null;
	var refs = referencesHeader.trim().split(/\s+/);
	var last = refs[refs.length - 1];
	return last || null;
}

// Finds an existing thread in the area's thread table by looking up whether
// any of the References Message-IDs are already stored as msg_ids.
// Returns the thread row, or null if not found.
async function findThreadByReferences(references, msgtable, threadtable) {
	if (!references || !references.trim()) return null;
	var refs = references.trim().split(/\s+/).filter(Boolean);
	if (refs.length === 0) return null;

	// Walk from most recent (last) to oldest (first) to find nearest ancestor
	for (var i = refs.length - 1; i >= 0; i--) {
		var ancestorMsg = await postgres.queryOne(
			'SELECT threadid, thread_id FROM ' + msgtable + ' WHERE msg_id = $1',
			[refs[i]]
		);
		if (ancestorMsg && ancestorMsg.thread_id) {
			var thread = await postgres.queryOne(
				'SELECT * FROM ' + threadtable + ' WHERE id = $1',
				[ancestorMsg.thread_id]
			);
			if (thread) return thread;
		}
	}
	return null;
}

// Imports a single NNTP article into the message tables for the given area.
// Returns { status, imported, duplicate, errormessages[] }
async function importNntpArticle(articleData, area, peerConnectionId, networkId) {
	var returnObj = {
		status: false,
		imported: false,
		duplicate: false,
		errormessages: []
	};

	var headers  = articleData.headers;
	var body     = articleData.body;
	var messageId = headers['message-id'] || '';
	var subject   = headers['subject']    || '(no subject)';
	var from      = headers['from']       || '';
	var dateStr   = headers['date']       || '';
	var references = headers['references'] || headers['in-reply-to'] || '';
	var contentType     = headers['content-type']              || '';
	var transferEncoding = headers['content-transfer-encoding'] || '7bit';

	if (!messageId) {
		returnObj.errormessages.push('Article has no Message-ID, skipping');
		return returnObj;
	}

	var shorty      = area.shortcode.toLowerCase().trim();
	var msgtable    = 'mb_' + shorty + '_msgs';
	var threadtable = 'mb_' + shorty + '_threads';

	// Duplicate check — a message is a dupe if we already have its Message-ID
	// stored in either msg_id (inbound NNTP) or nntp_msg_id (outbound post we sent)
	var isUnique = await postgres.checkValueUnique('msg_id', messageId, msgtable);
	if (!isUnique) {
		returnObj.status    = true;
		returnObj.duplicate = true;
		return returnObj;
	}
	var isUniqueNntp = await postgres.checkValueUnique('nntp_msg_id', messageId, msgtable);
	if (!isUniqueNntp) {
		returnObj.status    = true;
		returnObj.duplicate = true;
		return returnObj;
	}

	// Body processing:

	// Decode transfer encoding (base64, quoted-printable, 7bit/8bit passthrough)
	var decodedBody = decodeTransferEncoding(body, transferEncoding);

	// Parse charset and convert to normalised text
	var charset  = parseCharset(contentType);
	var normBody = normaliseBodyText(decodedBody, charset);
	var bodyText = normaliseLineEndings(normBody.bodyText);
	var utf8Text = normBody.utf8 ? normaliseLineEndings(normBody.utf8) : null;
	var rawText  = bodyText;

	var fromUser   = parseFromName(from);
	var systemTime = parseArticleDate(dateStr);
	var currtime   = new Date();
	var uuid       = uuidv4();
	var replyTo    = parseImmediateParent(references) || null;

	// Determine thread membership
	var threadId   = null;
	var threadidStr = null;

	if (references && references.trim()) {
		var existingThread = await findThreadByReferences(references, msgtable, threadtable);
		if (existingThread) {
			threadId    = existingThread.id;
			threadidStr = existingThread.threadid;
		}
	}

	if (!threadId) {
		// No existing thread found — start a new one. The root Message-ID
		// of this thread is the article's own Message-ID.
		var tuuid     = uuidv4();
		var threadObj = {
			uuid:              tuuid,
			threadid:          messageId,
			subject:           subject,
			started_at:        systemTime,
			started_by:        fromUser,
			message_count:     1,
			last_message:      systemTime,
			last_message_from: fromUser
		};
		var tres = await postgres.insertObject(threadObj, threadtable);
		if (!tres.status || !tres.insertId) {
			alogger.writeAlog(3,
				'importNntpArticle: could not create thread for ' + messageId +
				': ' + tres.errormessages.join(', '),
				'redbright'
			);
			returnObj.errormessages.push('Failed to create thread');
			return returnObj;
		}
		threadId    = tres.insertId;
		threadidStr = messageId;
	}

	var dbObj = {
		uuid:             uuid,
		msg_id:           messageId,
		threadid:         threadidStr,
		thread_id:        threadId,
		reply_to:         replyTo,
		from_user:        fromUser,
		to_user:          'All',
		subject:          subject,
		raw_text:         rawText,
		body_text:        bodyText,
		utf8:             utf8Text || null,
		datetime_string:  dateStr,
		system_time:      systemTime,
		created_at:       currtime,
		updated_at:       null,
		user_id:          0,
		source_network_id: networkId
	};

	var mres = await postgres.insertObject(dbObj, msgtable);
	if (!mres.status) {
		// If message insert failed and we just created the thread, clean it up
		if (threadidStr === messageId) {
			await postgres.write(
				'DELETE FROM ' + threadtable + ' WHERE threadid = $1',
				[messageId]
			);
		}
		alogger.writeAlog(3,
			'importNntpArticle: failed to insert message ' + messageId +
			': ' + mres.errormessages.join(', '),
			'redbright'
		);
		returnObj.errormessages = returnObj.errormessages.concat(mres.errormessages);
		return returnObj;
	}

	// Update thread stats if this was a reply into an existing thread
	if (threadidStr !== messageId) {
		await postgres.write(
			'UPDATE ' + threadtable +
			' SET message_count = message_count + 1,' +
			' last_message = GREATEST(last_message, $1),' +
			' last_message_from = $2' +
			' WHERE id = $3',
			[systemTime, fromUser, threadId]
		);
	}

	returnObj.status   = true;
	returnObj.imported = true;
	return returnObj;
}

// ---------------------------------------------------------------------------
// Pull logic
// ---------------------------------------------------------------------------

// Pulls all mapped newsgroups for a single peer connection UUID.
async function pullFromPeer(peerConnectionUUID) {
	var returnObj = {
		status: false,
		totalImported: 0,
		totalDuplicate: 0,
		errormessages: []
	};

	var dbconn = await peerConnections.getConnectionByUUID(peerConnectionUUID);
	if (!dbconn) {
		returnObj.errormessages.push('Connection not found: ' + peerConnectionUUID);
		return returnObj;
	}
	if (!dbconn.active) {
		returnObj.errormessages.push('Connection is not active: ' + peerConnectionUUID);
		return returnObj;
	}

	var cd = dbconn.connection_data || {};
	var host      = cd.host;
	var port      = cd.port      || 119;
	var use_tls   = cd.use_tls   || false;
	var username  = cd.username  || '';
	var password  = cd.password  || '';

	if (!host) {
		returnObj.errormessages.push('No host configured for connection ' + peerConnectionUUID);
		return returnObj;
	}

	// Fetch all network_areas for this connection's network
	var mappedAreas = await networkAreas.getAreasByNetwork(dbconn.network_id);
	if (!mappedAreas || mappedAreas.length === 0) {
		alogger.writeAlog(5,
			'pullFromPeer: no mapped areas for network ' + dbconn.network_id +
			' on connection ' + peerConnectionUUID,
			'cyan'
		);
		returnObj.status = true;
		return returnObj;
	}

	var highWaterMarks = cd.high_water_marks || {};
	var client = new NNTPClient();

	try {
		var greeting = await client.connect(host, port, use_tls);
		if (greeting.code !== 200 && greeting.code !== 201) {
			returnObj.errormessages.push('NNTP greeting error: ' + greeting.raw);
			return returnObj;
		}
		alogger.writeAlog(5,
			'pullFromPeer: connected to ' + host + ':' + port + ' — ' + greeting.text,
			'cyan'
		);

		if (username) {
			var authed = await client.authenticate(username, password);
			if (!authed) {
				returnObj.errormessages.push('NNTP authentication failed for ' + host);
				await client.quit();
				return returnObj;
			}
		}

		for (var networkArea of mappedAreas) {
			if (!networkArea.active) continue;

			var groupName = networkArea.areatag;
			var area      = {
				shortcode: networkArea.shortcode,
				id:        networkArea.area_id
			};

			var groupInfo = await client.group(groupName);
			if (!groupInfo) {
				alogger.writeAlog(4,
					'pullFromPeer: group not found on server: ' + groupName,
					'yellow'
				);
				continue;
			}

			var hwm      = highWaterMarks[groupName] || 0;
			var firstNum = hwm > 0 ? hwm + 1 : groupInfo.first;
			var lastNum  = groupInfo.last;

			if (firstNum > lastNum) {
				alogger.writeAlog(5,
					'pullFromPeer: no new articles in ' + groupName +
					' (hwm=' + hwm + ', server last=' + lastNum + ')',
					'cyan'
				);
				continue;
			}

			alogger.writeAlog(5,
				'pullFromPeer: fetching ' + groupName +
				' articles ' + firstNum + '-' + lastNum,
				'cyan'
			);

			var overview = await client.xover(firstNum, lastNum);
			if (!overview || overview.length === 0) {
				highWaterMarks[groupName] = lastNum;
				continue;
			}

			var groupImported  = 0;
			var groupDuplicate = 0;
			var groupErrors    = 0;
			var newHwm         = hwm;

			for (var ov of overview) {
				var articleData = await client.article(ov.messageId || ov.articleNum);
				if (!articleData) {
					alogger.writeAlog(4,
						'pullFromPeer: could not fetch article ' + ov.messageId +
						' from ' + groupName,
						'yellow'
					);
					newHwm = Math.max(newHwm, ov.articleNum);
					continue;
				}

				var result = await importNntpArticle(
					articleData,
					area,
					dbconn.id,
					dbconn.network_id
				);

				if (result.imported)        groupImported++;
				else if (result.duplicate)  groupDuplicate++;
				else                        groupErrors++;

				if (result.errormessages.length > 0) {
					alogger.writeAlog(3,
						'pullFromPeer: import error for ' + ov.messageId + ': ' +
						result.errormessages.join(', '),
						'redbright'
					);
				}

				newHwm = Math.max(newHwm, ov.articleNum);
			}

			// Persist high-water mark for this group immediately after pulling it
			highWaterMarks[groupName] = newHwm;
			await peerConnections.updateConnectionData(
				peerConnectionUUID,
				{ high_water_marks: highWaterMarks }
			);

			alogger.writeAlog(5,
				'pullFromPeer: ' + groupName + ' — imported=' + groupImported +
				' duplicate=' + groupDuplicate + ' errors=' + groupErrors +
				' hwm=' + newHwm,
				'greenbright'
			);

			returnObj.totalImported  += groupImported;
			returnObj.totalDuplicate += groupDuplicate;
		}

		await client.quit();

	} catch (err) {
		alogger.writeAlog(3,
			'pullFromPeer: unexpected error on connection ' + peerConnectionUUID +
			': ' + err.message,
			'redbright'
		);
		returnObj.errormessages.push(err.message);
		try { await client.quit(); } catch (_) {}
		return returnObj;
	}

	returnObj.status = true;
	return returnObj;
}

// Pulls from all active NNTP peer connections.
async function pullAllNNTP() {
	var connections = await peerConnections.getActiveConnectionsByNetworkType('NNTP');
	if (!connections || connections.length === 0) {
		alogger.writeAlog(5, 'pullAllNNTP: no active NNTP connections found', 'cyan');
		return;
	}

	alogger.writeAlog(5,
		'pullAllNNTP: processing ' + connections.length + ' NNTP connection(s)',
		'cyan'
	);

	for (var conn of connections) {
		alogger.writeAlog(5,
			'pullAllNNTP: pulling from ' + conn.peer_name +
			' (' + conn.uuid + ')',
			'cyan'
		);
		var result = await pullFromPeer(conn.uuid);
		if (!result.status) {
			alogger.writeAlog(3,
				'pullAllNNTP: pull failed for ' + conn.uuid + ': ' +
				result.errormessages.join(', '),
				'redbright'
			);
		} else {
			alogger.writeAlog(5,
				'pullAllNNTP: completed ' + conn.uuid +
				' — total imported=' + result.totalImported +
				' duplicate=' + result.totalDuplicate,
				'greenbright'
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Outbound — format and push local messages to NNTP peers
// ---------------------------------------------------------------------------

// Format a db message row as a complete NNTP article string ready to POST.
// Line endings are CRLF throughout; body lines starting with '.' are doubled.
// domain is the network's domain field, used to build Message-ID and From.
function formatNntpArticle(msg, areatag, domain) {
	var hostPart = domain || 'bbs.local';

	var msgId = '<' + msg.uuid + '@' + hostPart + '>';

	var fromAddr = msg.from_user +
		' <' + msg.from_user.toLowerCase().replace(/\s+/g, '.') + '@' + hostPart + '>';

	var date = msg.system_time
		? new Date(msg.system_time).toUTCString()
		: new Date().toUTCString();

	var headers = [
		'From: '       + fromAddr,
		'Newsgroups: ' + areatag,
		'Subject: '    + (msg.subject || '(no subject)'),
		'Date: '       + date,
		'Message-ID: ' + msgId,
		'Path: '       + hostPart
	];

	if (msg.reply_to) {
		var ref = msg.reply_to.trim();
		if (ref.startsWith('<') && ref.endsWith('>') && !ref.includes(' ')) {
			headers.push('References: ' + ref);
		}
	}

	alogger.writeAlog(5,
		'formatNntpArticle: uuid=' + msg.uuid +
		' newsgroup=' + areatag +
		' domain=' + hostPart +
		' from=' + fromAddr +
		' msgid=' + msgId,
		'cyan'
	);

	// Body: stored with \r line endings — convert to \n, then dot-stuff
	var bodyText  = (msg.body_text || '').replace(/\r/g, '\n');
	var bodyLines = bodyText.split('\n').map(line => line.startsWith('.') ? '.' + line : line);

	return headers.join('\r\n') + '\r\n\r\n' + bodyLines.join('\r\n');
}

// Push locally-authored messages to a single NNTP peer connection.
// Uses peer_area_subscriptions.msg_idx as the outbound high-water mark,
// exactly as the FTN tosser does. Skips messages that originated on this
// same network (source_network_id guard) to avoid echoing imported articles
// back to the server they came from.
async function pushToNntpPeer(peerConnectionUUID) {
	var returnObj = {
		status: false,
		totalPosted: 0,
		totalSkipped: 0,
		errormessages: []
	};

	var dbconn = await peerConnections.getConnectionByUUIDWithNetwork(peerConnectionUUID);
	if (!dbconn || !dbconn.active) {
		returnObj.errormessages.push('Connection not found or inactive: ' + peerConnectionUUID);
		return returnObj;
	}

	var cd       = dbconn.connection_data || {};
	var host     = cd.host;
	var port     = cd.port || 119;
	var use_tls  = cd.use_tls || false;
	var username = cd.username || '';
	var password = cd.password || '';
	var domain   = dbconn.domain || '';

	if (!host) {
		returnObj.errormessages.push('No host in connection_data for ' + peerConnectionUUID);
		return returnObj;
	}

	// Get enabled subscriptions for this connection, joined with areatag
	var enabledSubs = await postgres.query(
		`SELECT pas.id, pas.area_id, pas.msg_idx,
		        ma.shortcode, na.areatag
		 FROM peer_area_subscriptions pas
		 JOIN message_areas ma ON ma.id = pas.area_id
		 JOIN network_areas na ON na.area_id = pas.area_id
		                       AND na.network_id = $1
		 WHERE pas.peer_connection_id = $2
		   AND pas.enabled = true
		   AND na.active = true
		 ORDER BY ma.shortcode ASC`,
		[dbconn.network_id, dbconn.id]
	);

	if (!enabledSubs || enabledSubs.length === 0) {
		alogger.writeAlog(5, 'pushToNntpPeer: no enabled subscriptions for ' + peerConnectionUUID, 'cyan');
		returnObj.status = true;
		return returnObj;
	}

	// Build ordered work list per subscription.
	// Skipped messages (echo suppression) are included as { skip: true } so
	// we can advance past them correctly without blocking on failed posts.
	var workItems = [];  // { pas_id, area_id, msgtable, msgId, skip, article, nntpMsgId }

	for (var sub of enabledSubs) {
		var curIdx   = sub.msg_idx || 0;
		var shorty   = sub.shortcode.toLowerCase().trim();
		var msgtable = 'mb_' + shorty + '_msgs';

		var finalIdxResult = await postgres.query(
			'SELECT id FROM ' + msgtable + ' ORDER BY id DESC LIMIT 1', []
		);
		var finalIdx = (finalIdxResult && finalIdxResult[0]) ? finalIdxResult[0].id : 0;

		if (curIdx > finalIdx) curIdx = finalIdx;  // index got ahead — reset

		if (finalIdx > curIdx) {
			var msglist = await postgres.query(
				'SELECT * FROM ' + msgtable + ' WHERE id > $1 ORDER BY id ASC LIMIT 500',
				[curIdx]
			);

			if (msglist && msglist.length > 0) {
				for (var msg of msglist) {
					// Echo suppression — mark as skip, still include so idx can advance past it
					if (msg.source_network_id && msg.source_network_id === dbconn.network_id) {
						workItems.push({
							pas_id: sub.id, area_id: sub.area_id, msgtable,
							msgId: msg.id, skip: true
						});
						continue;
					}

					var nntpMsgId = '<' + msg.uuid + '@' + (domain || 'bbs.local') + '>';
					workItems.push({
						pas_id: sub.id, area_id: sub.area_id, msgtable,
						msgId: msg.id, skip: false,
						article:   formatNntpArticle(msg, sub.areatag, domain),
						nntpMsgId: nntpMsgId
					});
				}
			}
		}
	}

	if (workItems.filter(i => !i.skip).length === 0) {
		// Only skips — advance past them and return
		alogger.writeAlog(5, 'pushToNntpPeer: nothing to post for ' + peerConnectionUUID, 'cyan');
		await advanceNntpIdxForSkips(workItems);
		returnObj.status = true;
		return returnObj;
	}

	// Connect and post
	var client = new NNTPClient();
	try {
		var greeting = await client.connect(host, port, use_tls);
		if (greeting.code !== 200 && greeting.code !== 201) {
			returnObj.errormessages.push('NNTP greeting error: ' + greeting.raw);
			return returnObj;
		}

		if (greeting.code === 201) {
			returnObj.errormessages.push('NNTP server ' + host + ' does not permit posting (201 greeting)');
			await client.quit();
			return returnObj;
		}

		if (username) {
			var authed = await client.authenticate(username, password);
			if (!authed) {
				returnObj.errormessages.push('NNTP authentication failed for ' + host);
				await client.quit();
				return returnObj;
			}
		}

		for (var item of workItems) {
			if (item.skip) {
				item.success = true;
				returnObj.totalSkipped++;
				continue;
			}

			alogger.writeAlog(5,
				'pushToNntpPeer: POSTing msgId=' + item.msgId +
				' nntpMsgId=' + item.nntpMsgId +
				' to ' + host,
				'cyan'
			);

			var result = await client.post(item.article);

			alogger.writeAlog(5,
				'pushToNntpPeer: POST response code=' + result.code +
				' text=' + result.text,
				result.code === 240 ? 'greenbright' : 'yellow'
			);

			if (result.code === 240) {
				item.success = true;
				returnObj.totalPosted++;
				await postgres.write(
					'UPDATE ' + item.msgtable + ' SET nntp_msg_id = $1 WHERE id = $2',
					[item.nntpMsgId, item.msgId]
				);
			} else {
				item.success = false;
				alogger.writeAlog(4,
					'pushToNntpPeer: POST rejected by ' + host +
					' code=' + result.code + ' text=' + result.text,
					'yellow'
				);
			}
		}

		await client.quit();
	} catch (err) {
		alogger.writeAlog(3, 'pushToNntpPeer: connection error for ' + host + ': ' + err.message, 'redbright');
		returnObj.errormessages.push(err.message);
		try { await client.quit(); } catch (_) {}
		// Fall through to idx advancement — update based on whatever succeeded before the error
	}

	// Advance msg_idx per subscription up through the last consecutive success/skip.
	// Stop at the first failure so unposted messages are retried next toss.
	await advanceNntpIdxAfterPost(workItems, enabledSubs);

	returnObj.status = true;
	alogger.writeAlog(5,
		'pushToNntpPeer: ' + peerConnectionUUID +
		' posted=' + returnObj.totalPosted +
		' skipped=' + returnObj.totalSkipped,
		'greenbright'
	);
	return returnObj;
}

// Advance msg_idx for a list of work items that are all skips (no posts attempted).
async function advanceNntpIdxForSkips(workItems) {
	var byPas = {};
	for (var item of workItems) {
		if (!byPas[item.pas_id] || item.msgId > byPas[item.pas_id]) {
			byPas[item.pas_id] = item.msgId;
		}
	}
	for (var pasId of Object.keys(byPas)) {
		await postgres.write(
			'UPDATE peer_area_subscriptions SET msg_idx = $1 WHERE id = $2',
			[byPas[pasId], parseInt(pasId)]
		);
	}
}

// Advance msg_idx per subscription up through the last consecutive success/skip.
// Stops at the first failure so unposted messages are retried next toss cycle.
// enabledSubs provides the baseline current idx for subs that had no work items.
async function advanceNntpIdxAfterPost(workItems, enabledSubs) {
	// Group items by pas_id preserving insertion order (already ordered by id ASC)
	var byPas = {};
	for (var item of workItems) {
		if (!byPas[item.pas_id]) byPas[item.pas_id] = [];
		byPas[item.pas_id].push(item);
	}

	for (var pasId of Object.keys(byPas)) {
		var items   = byPas[pasId];
		var newIdx  = null;

		for (var item of items) {
			if (item.success) {
				newIdx = item.msgId;
			} else {
				break;  // stop at first failure — retry from here next time
			}
		}

		if (newIdx !== null) {
			await postgres.write(
				'UPDATE peer_area_subscriptions SET msg_idx = $1 WHERE id = $2',
				[newIdx, parseInt(pasId)]
			);
		}
		// If newIdx is null (first item failed), leave msg_idx unchanged — full retry next toss
	}
}

// Reset outbound msg_idx for all subscriptions on a connection, or optionally
// a single area, so the next toss rescans from the beginning.
// Called from the admin route when a manual reset is requested.
async function resetNntpOutboundIdx(peerConnectionUUID, areaId) {
	var dbconn = await peerConnections.getConnectionByUUID(peerConnectionUUID);
	if (!dbconn) return { status: false, errormessages: ['Connection not found'] };

	var sql    = 'UPDATE peer_area_subscriptions SET msg_idx = 0 WHERE peer_connection_id = $1';
	var params = [dbconn.id];

	if (areaId) {
		sql    += ' AND area_id = $2';
		params.push(parseInt(areaId));
	}

	var err = await postgres.write(sql, params);
	if (err) {
		alogger.writeAlog(3, 'resetNntpOutboundIdx: failed for ' + peerConnectionUUID + ': ' + err.message, 'redbright');
		return { status: false, errormessages: [err.message] };
	}

	alogger.writeAlog(5,
		'resetNntpOutboundIdx: reset msg_idx for connection ' + peerConnectionUUID +
		(areaId ? ' area ' + areaId : ' all areas'),
		'greenbright'
	);
	return { status: true, errormessages: [] };
}

// Push outbound messages to all active NNTP connections.
async function pushAllNNTP() {
	var connections = await peerConnections.getActiveConnectionsByNetworkType('NNTP');
	if (!connections || connections.length === 0) {
		alogger.writeAlog(5, 'pushAllNNTP: no active NNTP connections found', 'cyan');
		return;
	}

	alogger.writeAlog(5, 'pushAllNNTP: processing ' + connections.length + ' NNTP connection(s)', 'cyan');

	for (var conn of connections) {
		alogger.writeAlog(5, 'pushAllNNTP: pushing to ' + conn.peer_name + ' (' + conn.uuid + ')', 'cyan');
		var result = await pushToNntpPeer(conn.uuid);
		if (!result.status) {
			alogger.writeAlog(3,
				'pushAllNNTP: push failed for ' + conn.uuid + ': ' + result.errormessages.join(', '),
				'redbright'
			);
		} else {
			alogger.writeAlog(5,
				'pushAllNNTP: completed ' + conn.uuid +
				' — posted=' + result.totalPosted +
				' skipped=' + result.totalSkipped,
				'greenbright'
			);
		}
	}
}

export {
	pullFromPeer,
	pullAllNNTP,
	pushToNntpPeer,
	pushAllNNTP,
	resetNntpOutboundIdx
};
