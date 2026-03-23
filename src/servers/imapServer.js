// imapServer.js — IMAP4rev1 server for private message access.
//
// Maps BBS private messages to IMAP mailboxes so users can read PMs
// from standard mail clients (Thunderbird, Outlook, etc.).
//
// MVP commands: CAPABILITY, LOGIN, LOGOUT, LIST, LSUB, SELECT, EXAMINE,
// FETCH, STORE, EXPUNGE, NOOP, CLOSE, STATUS
//
// Mailboxes: INBOX (pm_inbox), Sent (pm_outbox), Trash (soft-deleted)

import * as net from 'net';
import * as alogger from '../utils/alogger.js';
import { checkUserPass } from '../models/useraccounts.js';
import {
	renderRfc2822, renderEnvelope, getMailboxMessages,
	getFullMessage, getMailboxStatus, trashUid, trashUidToSource
} from '../models/imapAdapter.js';
import appConfig from '../config/appConfig.js';

var GREETING = 'Canectic BBS IMAP4rev1 ready';
var CAPABILITIES = 'IMAP4rev1';

// Valid mailbox names
var MAILBOXES = ['INBOX', 'Sent', 'Trash'];

// ---------------------------------------------------------------------------
// ImapSession — one per client connection
// ---------------------------------------------------------------------------

class ImapSession {
	constructor(socket, mailDomain) {
		this.socket = socket;
		this.mailDomain = mailDomain;
		this.state = 'not_authenticated'; // not_authenticated, authenticated, selected, logout
		this.userId = null;
		this.username = null;
		this.userRecord = null;
		this.selectedMailbox = null;
		this.uidList = [];      // Ordered array of UIDs for selected mailbox
		this.messageMap = {};   // UID → row data (lightweight)
		this._buffer = '';
		this._closed = false;

		socket.on('data', (data) => this._onData(data));
		socket.on('close', () => { this._closed = true; });
		socket.on('error', () => { this._closed = true; });

		// Send greeting
		this._send('* OK ' + GREETING);
	}

	close() {
		if (!this._closed && !this.socket.destroyed) {
			this.socket.end();
		}
		this._closed = true;
	}

	// --- Data handling ---

	_onData(data) {
		this._buffer += data.toString('utf8');

		// Process complete lines
		var lines = this._buffer.split('\r\n');
		this._buffer = lines.pop(); // Keep incomplete line in buffer

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
		// IMAP format: tag SP command [SP arguments]
		var spaceIdx = line.indexOf(' ');
		if (spaceIdx === -1) {
			this._send('* BAD Invalid command');
			return;
		}

		var tag = line.substring(0, spaceIdx);
		var rest = line.substring(spaceIdx + 1);

		var cmdSpaceIdx = rest.indexOf(' ');
		var cmd, args;
		if (cmdSpaceIdx === -1) {
			cmd = rest.toUpperCase();
			args = '';
		} else {
			cmd = rest.substring(0, cmdSpaceIdx).toUpperCase();
			args = rest.substring(cmdSpaceIdx + 1);
		}

		try {
			switch (cmd) {
				case 'CAPABILITY':
					this._send('* CAPABILITY ' + CAPABILITIES);
					this._send(tag + ' OK CAPABILITY completed');
					break;

				case 'NOOP':
					this._send(tag + ' OK NOOP completed');
					break;

				case 'LOGOUT':
					this._send('* BYE Logging out');
					this._send(tag + ' OK LOGOUT completed');
					this.close();
					break;

				case 'LOGIN':
					await this._cmdLogin(tag, args);
					break;

				case 'LIST':
					this._cmdList(tag, args);
					break;

				case 'LSUB':
					this._cmdList(tag, args); // Same as LIST for our purposes
					break;

				case 'SELECT':
					await this._cmdSelect(tag, args, false);
					break;

				case 'EXAMINE':
					await this._cmdSelect(tag, args, true);
					break;

				case 'STATUS':
					await this._cmdStatus(tag, args);
					break;

				case 'FETCH':
					await this._cmdFetch(tag, args);
					break;

				case 'STORE':
					await this._cmdStore(tag, args);
					break;

				case 'EXPUNGE':
					await this._cmdExpunge(tag);
					break;

				case 'CLOSE':
					// CLOSE = EXPUNGE + deselect
					if (this.state === 'selected') {
						await this._doExpunge();
						this.selectedMailbox = null;
						this.uidList = [];
						this.messageMap = {};
						this.state = 'authenticated';
					}
					this._send(tag + ' OK CLOSE completed');
					break;

				case 'UID':
					await this._cmdUid(tag, args);
					break;

				default:
					this._send(tag + ' BAD Unknown command: ' + cmd);
			}
		} catch (err) {
			alogger.writeAlog(3, 'IMAP command error: ' + err.message, 'redbright');
			this._send(tag + ' BAD Internal error');
		}
	}

	// --- LOGIN ---

	async _cmdLogin(tag, args) {
		if (this.state !== 'not_authenticated') {
			this._send(tag + ' BAD Already authenticated');
			return;
		}

		// Parse: LOGIN username password (may be quoted)
		var parsed = this._parseArgs(args, 2);
		if (!parsed || parsed.length < 2) {
			this._send(tag + ' BAD LOGIN requires username and password');
			return;
		}

		var username = parsed[0];
		var password = parsed[1];

		var result = await checkUserPass(username, password);
		if (result.isvalid) {
			this.userId = result.useraccount.id;
			this.username = result.useraccount.username;
			this.userRecord = result.useraccount;
			this.state = 'authenticated';
			alogger.writeAlog(4, 'IMAP LOGIN: ' + this.username, 'cyan');
			this._send(tag + ' OK LOGIN completed');
		} else {
			this._send(tag + ' NO LOGIN failed');
		}
	}

	// --- LIST ---

	_cmdList(tag, args) {
		if (this.state === 'not_authenticated') {
			this._send(tag + ' NO Not authenticated');
			return;
		}

		// List fixed mailboxes
		this._send('* LIST (\\HasNoChildren) "/" "INBOX"');
		this._send('* LIST (\\HasNoChildren \\Sent) "/" "Sent"');
		this._send('* LIST (\\HasNoChildren \\Trash) "/" "Trash"');
		this._send(tag + ' OK LIST completed');
	}

	// --- SELECT / EXAMINE ---

	async _cmdSelect(tag, args, readOnly) {
		if (this.state === 'not_authenticated') {
			this._send(tag + ' NO Not authenticated');
			return;
		}

		var mailbox = this._unquote(args.trim());
		if (!MAILBOXES.includes(mailbox)) {
			this._send(tag + ' NO Mailbox not found: ' + mailbox);
			return;
		}

		// Load messages for this mailbox
		var rows = await getMailboxMessages(this.userId, mailbox);
		this.selectedMailbox = mailbox;
		this.uidList = [];
		this.messageMap = {};

		for (var row of rows) {
			var uid;
			if (mailbox === 'Trash') {
				uid = trashUid(row.id, row._source || 'inbox');
			} else {
				uid = row.id;
			}
			this.uidList.push(uid);
			this.messageMap[uid] = row;
		}

		this.state = 'selected';
		var status = await getMailboxStatus(this.userId, mailbox);

		this._send('* ' + this.uidList.length + ' EXISTS');
		this._send('* 0 RECENT');
		this._send('* OK [UIDVALIDITY 1]');
		this._send('* OK [UIDNEXT ' + (this.uidList.length > 0 ? this.uidList[this.uidList.length - 1] + 1 : 1) + ']');
		this._send('* FLAGS (\\Seen \\Deleted \\Answered)');
		this._send('* OK [PERMANENTFLAGS (\\Seen \\Deleted)]');
		this._send('* OK [UNSEEN ' + status.unseen + ']');
		this._send(tag + ' OK [' + (readOnly ? 'READ-ONLY' : 'READ-WRITE') + '] SELECT completed');
	}

	// --- STATUS ---

	async _cmdStatus(tag, args) {
		if (this.state === 'not_authenticated') {
			this._send(tag + ' NO Not authenticated');
			return;
		}

		// STATUS "mailbox" (MESSAGES UNSEEN)
		var parsed = this._parseArgs(args, 2);
		if (!parsed || parsed.length < 2) {
			this._send(tag + ' BAD STATUS requires mailbox and item list');
			return;
		}

		var mailbox = parsed[0];
		if (!MAILBOXES.includes(mailbox)) {
			this._send(tag + ' NO Mailbox not found');
			return;
		}

		var status = await getMailboxStatus(this.userId, mailbox);
		var items = parsed[1].replace(/[()]/g, '').toUpperCase();
		var response = [];
		if (items.includes('MESSAGES')) response.push('MESSAGES ' + status.messages);
		if (items.includes('UNSEEN')) response.push('UNSEEN ' + status.unseen);
		if (items.includes('UIDVALIDITY')) response.push('UIDVALIDITY 1');
		if (items.includes('UIDNEXT')) response.push('UIDNEXT ' + (status.messages + 1));
		if (items.includes('RECENT')) response.push('RECENT 0');

		this._send('* STATUS "' + mailbox + '" (' + response.join(' ') + ')');
		this._send(tag + ' OK STATUS completed');
	}

	// --- FETCH ---

	async _cmdFetch(tag, args) {
		if (this.state !== 'selected') {
			this._send(tag + ' NO Not selected');
			return;
		}

		await this._doFetch(tag, args, false);
	}

	async _doFetch(tag, args, useUid) {
		// Parse: sequence_set (items)
		var spaceIdx = args.indexOf(' ');
		if (spaceIdx === -1) {
			this._send(tag + ' BAD FETCH requires sequence set and items');
			return;
		}

		var seqSet = args.substring(0, spaceIdx);
		var itemsStr = args.substring(spaceIdx + 1).trim();

		// Resolve sequence set to UIDs
		var uids = this._resolveSequenceSet(seqSet, useUid);

		// Parse fetch items
		var items = itemsStr.replace(/[()]/g, '').toUpperCase();
		var wantFlags = items.includes('FLAGS');
		var wantUid = items.includes('UID') || useUid;
		var wantSize = items.includes('RFC822.SIZE');
		var wantEnvelope = items.includes('ENVELOPE');
		var wantBody = items.includes('BODY[]') || items.includes('RFC822') || items.includes('BODY.PEEK[]');
		var wantBodyStructure = items.includes('BODYSTRUCTURE');
		var peek = items.includes('PEEK');

		for (var uid of uids) {
			var row = this.messageMap[uid];
			if (!row) continue;

			var seqNum = this.uidList.indexOf(uid) + 1;
			var parts = [];

			if (wantFlags) {
				var flags = [];
				if (row.read) flags.push('\\Seen');
				if (row.deleted) flags.push('\\Deleted');
				parts.push('FLAGS (' + flags.join(' ') + ')');
			}

			if (wantUid) {
				parts.push('UID ' + uid);
			}

			if (wantEnvelope) {
				parts.push('ENVELOPE ' + renderEnvelope(row, this.mailDomain));
			}

			if (wantSize || wantBody) {
				// Need full message — fetch from DB
				var table = (this.selectedMailbox === 'Sent') ? 'sent' :
					(row._source === 'sent') ? 'sent' : 'inbox';
				var fullRow = await getFullMessage(this.userId, table, row.id);
				if (fullRow) {
					fullRow._source = table;
					var rfc2822 = renderRfc2822(fullRow, this.mailDomain);

					if (wantSize) {
						parts.push('RFC822.SIZE ' + Buffer.byteLength(rfc2822, 'utf8'));
					}

					if (wantBody) {
						var bodyKey = peek ? 'BODY[]' : 'BODY[]';
						parts.push(bodyKey + ' {' + Buffer.byteLength(rfc2822, 'utf8') + '}\r\n' + rfc2822);

						// Mark as read unless PEEK
						if (!peek && !row.read && this.selectedMailbox === 'INBOX') {
							await this._markRead(row.id);
							row.read = true;
						}
					}
				}
			}

			if (wantBodyStructure) {
				parts.push('BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "8BIT" 0 0)');
			}

			this._send('* ' + seqNum + ' FETCH (' + parts.join(' ') + ')');
		}

		this._send(tag + ' OK FETCH completed');
	}

	// --- STORE ---

	async _cmdStore(tag, args) {
		if (this.state !== 'selected') {
			this._send(tag + ' NO Not selected');
			return;
		}

		await this._doStore(tag, args, false);
	}

	async _doStore(tag, args, useUid) {
		// Parse: sequence_set +/-FLAGS (flag_list)
		var parts = args.match(/^(\S+)\s+([-+]?FLAGS(?:\.SILENT)?)\s+\(([^)]*)\)/i);
		if (!parts) {
			this._send(tag + ' BAD Invalid STORE syntax');
			return;
		}

		var seqSet = parts[1];
		var action = parts[2].toUpperCase();
		var flagStr = parts[3].toUpperCase();
		var silent = action.includes('SILENT');
		var add = action.startsWith('+');
		var remove = action.startsWith('-');

		var uids = this._resolveSequenceSet(seqSet, useUid);
		var wantSeen = flagStr.includes('\\SEEN');
		var wantDeleted = flagStr.includes('\\DELETED');

		for (var uid of uids) {
			var row = this.messageMap[uid];
			if (!row) continue;

			if (wantSeen) {
				if (add) {
					await this._markRead(row.id);
					row.read = true;
				} else if (remove) {
					await this._markUnread(row.id);
					row.read = false;
				}
			}

			if (wantDeleted) {
				if (add) {
					await this._markDeleted(row, uid);
					row.deleted = true;
				}
			}

			if (!silent) {
				var seqNum = this.uidList.indexOf(uid) + 1;
				var flags = [];
				if (row.read) flags.push('\\Seen');
				if (row.deleted) flags.push('\\Deleted');
				this._send('* ' + seqNum + ' FETCH (FLAGS (' + flags.join(' ') + ')' +
					(useUid ? ' UID ' + uid : '') + ')');
			}
		}

		this._send(tag + ' OK STORE completed');
	}

	// --- EXPUNGE ---

	async _cmdExpunge(tag) {
		if (this.state !== 'selected') {
			this._send(tag + ' NO Not selected');
			return;
		}

		await this._doExpunge();
		this._send(tag + ' OK EXPUNGE completed');
	}

	async _doExpunge() {
		// Remove messages flagged as \Deleted
		var removed = [];
		for (var i = this.uidList.length - 1; i >= 0; i--) {
			var uid = this.uidList[i];
			var row = this.messageMap[uid];
			if (row && row.deleted) {
				var seqNum = i + 1;
				this._send('* ' + seqNum + ' EXPUNGE');
				this.uidList.splice(i, 1);
				delete this.messageMap[uid];
				removed.push(uid);
			}
		}
	}

	// --- UID prefix command ---

	async _cmdUid(tag, args) {
		var spaceIdx = args.indexOf(' ');
		if (spaceIdx === -1) {
			this._send(tag + ' BAD UID requires subcommand');
			return;
		}

		var subcmd = args.substring(0, spaceIdx).toUpperCase();
		var subargs = args.substring(spaceIdx + 1);

		switch (subcmd) {
			case 'FETCH':
				await this._doFetch(tag, subargs, true);
				break;
			case 'STORE':
				await this._doStore(tag, subargs, true);
				break;
			default:
				this._send(tag + ' BAD Unknown UID subcommand');
		}
	}

	// --- DB operations ---

	async _markRead(id) {
		if (this.selectedMailbox === 'INBOX' || this.selectedMailbox === 'Trash') {
			await postgres.write(
				"UPDATE pm_inbox SET read = true, read_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2",
				[id, this.userId]
			);
		}
	}

	async _markUnread(id) {
		if (this.selectedMailbox === 'INBOX' || this.selectedMailbox === 'Trash') {
			await postgres.write(
				"UPDATE pm_inbox SET read = false, read_at = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2",
				[id, this.userId]
			);
		}
	}

	async _markDeleted(row, uid) {
		var table;
		if (this.selectedMailbox === 'Trash') {
			var resolved = trashUidToSource(uid);
			table = resolved.table === 'sent' ? 'pm_outbox' : 'pm_inbox';
		} else if (this.selectedMailbox === 'Sent') {
			table = 'pm_outbox';
		} else {
			table = 'pm_inbox';
		}

		await postgres.write(
			"UPDATE " + table + " SET deleted = true, deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2",
			[row.id, this.userId]
		);
	}

	// --- Helpers ---

	_resolveSequenceSet(seqSet, useUid) {
		// Resolve a sequence set like "1:*", "3", "1,3,5" to UIDs
		var result = [];
		var parts = seqSet.split(',');

		for (var part of parts) {
			if (part.includes(':')) {
				var range = part.split(':');
				var start, end;

				if (useUid) {
					start = range[0] === '*' ? this.uidList[this.uidList.length - 1] : parseInt(range[0]);
					end = range[1] === '*' ? this.uidList[this.uidList.length - 1] : parseInt(range[1]);
					for (var uid of this.uidList) {
						if (uid >= start && uid <= end) result.push(uid);
					}
				} else {
					start = range[0] === '*' ? this.uidList.length : parseInt(range[0]);
					end = range[1] === '*' ? this.uidList.length : parseInt(range[1]);
					for (var i = start - 1; i < end && i < this.uidList.length; i++) {
						result.push(this.uidList[i]);
					}
				}
			} else {
				if (part === '*') {
					if (this.uidList.length > 0) result.push(this.uidList[this.uidList.length - 1]);
				} else {
					var num = parseInt(part);
					if (useUid) {
						if (this.uidList.includes(num)) result.push(num);
					} else {
						if (num >= 1 && num <= this.uidList.length) result.push(this.uidList[num - 1]);
					}
				}
			}
		}

		return result;
	}

	_parseArgs(str, maxArgs) {
		// Parse IMAP arguments, handling quoted strings
		var args = [];
		var i = 0;
		while (i < str.length && args.length < maxArgs) {
			// Skip whitespace
			while (i < str.length && str[i] === ' ') i++;
			if (i >= str.length) break;

			if (str[i] === '"') {
				// Quoted string
				i++;
				var val = '';
				while (i < str.length && str[i] !== '"') {
					if (str[i] === '\\' && i + 1 < str.length) {
						val += str[i + 1];
						i += 2;
					} else {
						val += str[i];
						i++;
					}
				}
				i++; // Skip closing quote
				args.push(val);
			} else {
				// Unquoted — take until space or end
				var start = i;
				while (i < str.length && str[i] !== ' ') i++;
				args.push(str.substring(start, i));
			}
		}
		return args;
	}

	_unquote(str) {
		if (str.startsWith('"') && str.endsWith('"')) {
			return str.substring(1, str.length - 1);
		}
		return str;
	}
}

// ---------------------------------------------------------------------------
// ImapServer
// ---------------------------------------------------------------------------

class ImapServer {
	constructor(port, mailDomain) {
		this.port = port;
		this.mailDomain = mailDomain;
		this.server = null;
		this.sessions = new Set();
	}

	start() {
		this.server = net.createServer((socket) => {
			var session = new ImapSession(socket, this.mailDomain);
			this.sessions.add(session);
			socket.on('close', () => this.sessions.delete(session));
		});

		this.server.on('error', (err) => {
			alogger.writeAlog(0, 'IMAP server error: ' + err.message, 'redbright');
		});

		this.server.listen(this.port, () => {
			alogger.writeAlog(1, 'IMAP server listening on port ' + this.port +
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

export { ImapServer, ImapSession };
