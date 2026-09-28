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
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { checkUserPass } from '../models/useraccounts.js';
import {
	renderRfc2822, renderEnvelope, renderBodyStructure, formatDate2822, getMailboxMessages,
	getFullMessage, getMailboxStatus, trashUid, trashUidToSource
} from '../models/imapAdapter.js';
import { getAttachments } from '../models/pmAttachments.js';
import { clearPmNotifications } from '../models/privateMessages.js';
import appConfig from '../config/appConfig.js';
import { createEventPublisher, createEventSubscriber, EVENTS } from '../queues/events.js';

var GREETING = 'Canectic BBS IMAP4rev1 ready';
var CAPABILITIES = 'IMAP4rev1 IDLE UIDPLUS MOVE';

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
		if (this._idleTimer) {
			clearInterval(this._idleTimer);
			this._idleTimer = null;
		}
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
		alogger.writeAlog(5, 'IMAP rx: ' + line.substring(0, 200), 'cyan');

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
					await this._cmdNoop(tag);
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

				case 'COPY':
					await this._cmdCopy(tag, args, false);
					break;

				case 'MOVE':
					await this._cmdMove(tag, args, false);
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

				case 'SEARCH':
					await this._cmdSearch(tag, args, false);
					break;

				case 'APPEND':
					this._cmdAppend(tag, args);
					break;

				case 'UID':
					await this._cmdUid(tag, args);
					break;

				case 'IDLE':
					this._cmdIdle(tag);
					break;

				case 'DONE':
					// DONE is handled inside IDLE state, shouldn't reach here
					this._send(tag + ' BAD Not in IDLE state');
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

		// Allow username@domain login style — strip the domain part
		var atIdx = username.indexOf('@');
		if (atIdx >= 0) username = username.substring(0, atIdx);

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
				uid = trashUid(parseInt(row.id), row._source || 'inbox');
			} else {
				uid = parseInt(row.id);
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

		// Parse fetch items — keep original case/brackets for BODY[] keys
		var itemsUpper = itemsStr.toUpperCase();
		var wantFlags = itemsUpper.includes('FLAGS');
		var wantUid = itemsUpper.includes('UID') || useUid;
		var wantSize = itemsUpper.includes('RFC822.SIZE');
		var wantEnvelope = itemsUpper.includes('ENVELOPE');
		var wantBodyFull = itemsUpper.includes('BODY[]') || itemsUpper.includes('BODY.PEEK[]') ||
			itemsUpper.includes('RFC822 ') || itemsUpper === 'RFC822' || itemsUpper.includes('RFC822)');
		var wantBodyStructure = itemsUpper.includes('BODYSTRUCTURE');
		var wantHeaderFields = itemsUpper.includes('HEADER.FIELDS');
		var wantHeader = (itemsUpper.includes('BODY.PEEK[HEADER]') || itemsUpper.includes('BODY[HEADER]'))
			&& !wantHeaderFields;
		var wantBodyText = itemsUpper.includes('BODY[TEXT]') || itemsUpper.includes('BODY.PEEK[TEXT]');
		var wantInternalDate = itemsUpper.includes('INTERNALDATE');
		var peek = itemsUpper.includes('PEEK');

		// Extract requested header field names if HEADER.FIELDS
		var headerFieldNames = [];
		if (wantHeaderFields) {
			var hfMatch = itemsStr.match(/HEADER\.FIELDS\s*\(([^)]+)\)/i);
			if (hfMatch) {
				headerFieldNames = hfMatch[1].trim().split(/\s+/).map(function(h) { return h.toUpperCase(); });
			}
		}

		for (var uid of uids) {
			var row = this.messageMap[uid];
			if (!row) continue;

			var seqNum = this.uidList.indexOf(uid) + 1;
			var parts = [];

			if (wantFlags) {
				var flags = this._buildFlags(row, uid);
				parts.push('FLAGS (' + flags.join(' ') + ')');
			}

			if (wantUid) {
				parts.push('UID ' + uid);
			}

			if (wantInternalDate) {
				var dt = row.system_time || row.created_at || new Date();
				if (!(dt instanceof Date)) dt = new Date(dt);
				parts.push('INTERNALDATE "' + formatDate2822(dt) + '"');
			}

			if (wantEnvelope) {
				parts.push('ENVELOPE ' + renderEnvelope(row, this.mailDomain));
			}

			// Anything that needs the full rendered message
			if (wantSize || wantBodyFull || wantHeader || wantHeaderFields || wantBodyText) {
				var table = (this.selectedMailbox === 'Sent') ? 'sent' :
					(row._source === 'sent') ? 'sent' : 'inbox';
				var fullRow = await getFullMessage(this.userId, table, row.id);
				if (fullRow) {
					fullRow._source = table;
					var msgAttachments = fullRow.has_attachments ? await getAttachments(fullRow.uuid) : [];
					var rfc2822 = renderRfc2822(fullRow, this.mailDomain, msgAttachments);
					var headerEnd = rfc2822.indexOf('\r\n\r\n');
					var headerSection = headerEnd >= 0 ? rfc2822.substring(0, headerEnd + 2) : rfc2822;
					var bodySection = headerEnd >= 0 ? rfc2822.substring(headerEnd + 4) : '';

					if (wantSize) {
						parts.push('RFC822.SIZE ' + Buffer.byteLength(rfc2822, 'utf8'));
					}

					if (wantBodyFull) {
						var bodyKey = peek ? 'BODY[]' : 'BODY[]';
						parts.push(bodyKey + ' {' + Buffer.byteLength(rfc2822, 'utf8') + '}\r\n' + rfc2822);
						if (!peek && !row.read && (this.selectedMailbox === 'INBOX' || this.selectedMailbox === 'Trash')) {
							await this._markRead(row, uid);
							row.read = true;
						}
					}

					if (wantHeader) {
						var hdrBytes = Buffer.byteLength(headerSection, 'utf8');
						parts.push('BODY[HEADER] {' + hdrBytes + '}\r\n' + headerSection);
					}

					if (wantHeaderFields) {
						// Extract only requested headers
						var filteredHeaders = '';
						var allHeaders = headerSection.split('\r\n');
						for (var h of allHeaders) {
							var colonIdx = h.indexOf(':');
							if (colonIdx > 0) {
								var headerName = h.substring(0, colonIdx).trim().toUpperCase();
								if (headerFieldNames.includes(headerName)) {
									filteredHeaders += h + '\r\n';
								}
							}
						}
						filteredHeaders += '\r\n'; // Blank line terminates headers
						var fhBytes = Buffer.byteLength(filteredHeaders, 'utf8');
						parts.push('BODY[HEADER.FIELDS (' + headerFieldNames.join(' ') + ')] {' + fhBytes + '}\r\n' + filteredHeaders);
					}

					if (wantBodyText) {
						var btBytes = Buffer.byteLength(bodySection, 'utf8');
						parts.push('BODY[TEXT] {' + btBytes + '}\r\n' + bodySection);
					}
				}
			}

			if (wantBodyStructure) {
				// Load full message + attachments for dynamic BODYSTRUCTURE
				if (!fullRow) {
					var bsTable = (this.selectedMailbox === 'Sent') ? 'sent' :
						(row._source === 'sent') ? 'sent' : 'inbox';
					fullRow = await getFullMessage(this.userId, bsTable, row.id);
				}
				if (fullRow) {
					var bsAtts = fullRow.has_attachments ? await getAttachments(fullRow.uuid) : [];
					parts.push('BODYSTRUCTURE ' + renderBodyStructure(fullRow, bsAtts));
				} else {
					parts.push('BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "8BIT" 0 0)');
				}
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

		alogger.writeAlog(5, 'IMAP STORE: uids=' + JSON.stringify(uids) +
			' action=' + action + ' wantSeen=' + wantSeen + ' wantDeleted=' + wantDeleted +
			' mailbox=' + this.selectedMailbox, 'cyan');

		for (var uid of uids) {
			var row = this.messageMap[uid];
			if (!row) {
				alogger.writeAlog(5, 'IMAP STORE: UID ' + uid + ' not found in messageMap', 'yellow');
				continue;
			}

			if (wantSeen) {
				if (add) {
					await this._markRead(row, uid);
					row.read = true;
				} else if (remove) {
					await this._markUnread(row, uid);
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
				var flags = this._buildFlags(row, uid);
				this._send('* ' + seqNum + ' FETCH (FLAGS (' + flags.join(' ') + ')' +
					(useUid ? ' UID ' + uid : '') + ')');
			}
		}

		await this._fireOnDemandPurgeCleanup();
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

	async _doExpunge(uidSet) {
		// Remove messages flagged as \Deleted
		// If uidSet provided, only expunge those UIDs (UID EXPUNGE)
		for (var i = this.uidList.length - 1; i >= 0; i--) {
			var uid = this.uidList[i];
			var row = this.messageMap[uid];
			if (row && row.deleted) {
				if (uidSet && !uidSet.includes(uid)) continue;
				var seqNum = i + 1;
				this._send('* ' + seqNum + ' EXPUNGE');
				this.uidList.splice(i, 1);
				delete this.messageMap[uid];
			}
		}
	}

	async _cmdUidExpunge(tag, args) {
		if (this.state !== 'selected') {
			this._send(tag + ' NO Not selected');
			return;
		}
		var uids = this._resolveSequenceSet(args.trim(), true);
		await this._doExpunge(uids);
		this._send(tag + ' OK UID EXPUNGE completed');
	}

	// --- COPY ---
	// Thunderbird deletes by: COPY to Trash, STORE \Deleted, EXPUNGE
	// We map COPY to Trash as soft-delete, COPY from Trash to INBOX as restore.

	async _cmdCopy(tag, args, useUid) {
		if (this.state !== 'selected') {
			this._send(tag + ' NO Not selected');
			return;
		}

		var parts = args.match(/^(\S+)\s+(.+)$/);
		if (!parts) {
			this._send(tag + ' BAD Invalid COPY syntax');
			return;
		}

		var seqSet = parts[1];
		var targetMailbox = this._unquote(parts[2].trim());
		var uids = this._resolveSequenceSet(seqSet, useUid);

		alogger.writeAlog(5, 'IMAP COPY: uids=' + JSON.stringify(uids) +
			' from=' + this.selectedMailbox + ' to=' + targetMailbox, 'cyan');

		for (var uid of uids) {
			var row = this.messageMap[uid];
			if (!row) continue;

			if (targetMailbox.toUpperCase() === 'TRASH') {
				// Copy to Trash = soft-delete
				await this._markDeleted(row, uid);
				row.deleted = true;
			} else if (targetMailbox.toUpperCase() === 'INBOX' && this.selectedMailbox === 'Trash') {
				// Restore from Trash
				await this._restoreFromTrash(row, uid);
			}
			// Other copies silently accepted (no actual cross-folder copy needed)
		}

		this._send(tag + ' OK COPY completed');
	}

	// --- MOVE (RFC 6851) ---
	// MOVE = COPY + STORE \Deleted + EXPUNGE in one step

	async _cmdMove(tag, args, useUid) {
		if (this.state !== 'selected') {
			this._send(tag + ' NO Not selected');
			return;
		}

		var parts = args.match(/^(\S+)\s+(.+)$/);
		if (!parts) {
			this._send(tag + ' BAD Invalid MOVE syntax');
			return;
		}

		var seqSet = parts[1];
		var targetMailbox = this._unquote(parts[2].trim());
		var uids = this._resolveSequenceSet(seqSet, useUid);

		for (var uid of uids) {
			var row = this.messageMap[uid];
			if (!row) continue;

			if (targetMailbox.toUpperCase() === 'TRASH') {
				await this._markDeleted(row, uid);
				row.deleted = true;
			} else if (targetMailbox.toUpperCase() === 'INBOX' && this.selectedMailbox === 'Trash') {
				await this._restoreFromTrash(row, uid);
				row.deleted = true; // Mark for expunge from current view
			}
		}

		// Expunge the moved messages from the current mailbox view
		await this._doExpunge(uids);
		await this._fireOnDemandPurgeCleanup();
		this._send(tag + ' OK MOVE completed');
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
			case 'COPY':
				await this._cmdCopy(tag, subargs, true);
				break;
			case 'MOVE':
				await this._cmdMove(tag, subargs, true);
				break;
			case 'SEARCH':
				await this._cmdSearch(tag, subargs, true);
				break;
			case 'EXPUNGE':
				// UID EXPUNGE (UIDPLUS extension) — expunge only specified UIDs
				await this._cmdUidExpunge(tag, subargs);
				break;
			default:
				this._send(tag + ' BAD Unknown UID subcommand');
		}
	}

	// --- APPEND (accept and discard — SMTP already saved the message) ---

	_cmdAppend(tag, args) {
		if (this.state === 'not_authenticated') {
			this._send(tag + ' NO Not authenticated');
			return;
		}

		// Parse the literal size from {N} or {N+} (non-synchronizing)
		var literalMatch = args.match(/\{(\d+)\+?\}\s*$/);
		if (literalMatch) {
			var size = parseInt(literalMatch[1]);
			// Tell client to send the literal data
			this._send('+ Ready');

			// Temporarily hijack data handler to consume the literal
			var self = this;
			var collected = Buffer.alloc(0);
			var origOnData = ImapSession.prototype._onData;
			this._onData = function(data) {
				var buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
				collected = Buffer.concat([collected, buf]);
				if (collected.length >= size) {
					// Restore normal data handler
					self._onData = origOnData;
					self._send(tag + ' OK APPEND completed');
					// Any bytes beyond the literal + trailing CRLF need normal processing
					var excess = collected.length - size;
					if (excess > 2) {
						// Skip the trailing CRLF after the literal, process the rest
						var leftover = collected.slice(size + 2);
						if (leftover.length > 0) {
							self._onData(leftover);
						}
					}
				}
			};
		} else {
			this._send(tag + ' OK APPEND completed');
		}
	}

	// --- NOOP (with mailbox refresh) ---

	async _cmdNoop(tag) {
		if (this.state === 'selected' && this.selectedMailbox) {
			// Refresh the mailbox — check for new messages
			var rows = await getMailboxMessages(this.userId, this.selectedMailbox);
			var newUidList = [];
			var newMap = {};

			for (var row of rows) {
				var uid;
				if (this.selectedMailbox === 'Trash') {
					uid = trashUid(parseInt(row.id), row._source || 'inbox');
				} else {
					uid = parseInt(row.id);
				}
				newUidList.push(uid);
				newMap[uid] = row;
			}

			// Report new messages if count changed
			if (newUidList.length !== this.uidList.length) {
				this._send('* ' + newUidList.length + ' EXISTS');
			}

			// Push flag changes for existing messages
			for (var i = 0; i < newUidList.length; i++) {
				var nuid = newUidList[i];
				var oldRow = this.messageMap[nuid];
				var newRow = newMap[nuid];
				if (oldRow && newRow && oldRow.read !== newRow.read) {
					var flags = this._buildFlags(newRow, nuid);
					this._send('* ' + (i + 1) + ' FETCH (FLAGS (' + flags.join(' ') + '))');
				}
			}

			this.uidList = newUidList;
			this.messageMap = newMap;
		}
		this._send(tag + ' OK NOOP completed');
	}

	// --- SEARCH ---

	async _cmdSearch(tag, args, useUid) {
		if (this.state !== 'selected') {
			this._send(tag + ' NO Not selected');
			return;
		}

		var criteria = args.toUpperCase().trim();
		var results = [];

		for (var i = 0; i < this.uidList.length; i++) {
			var uid = this.uidList[i];
			var row = this.messageMap[uid];
			if (!row) continue;

			var match = true;
			var isSentItem = this.selectedMailbox === 'Sent' ||
				(this.selectedMailbox === 'Trash' && row._source === 'sent');
			var isSeen = row.read || isSentItem;

			if (criteria.includes('UNSEEN') || criteria.includes('NOT SEEN')) {
				if (isSeen) match = false;
			}
			if (criteria.includes('SEEN') && !criteria.includes('UNSEEN') && !criteria.includes('NOT SEEN')) {
				if (!isSeen) match = false;
			}
			if (criteria.includes('DELETED')) {
				if (!row.deleted) match = false;
			}
			if (criteria.includes('UNDELETED')) {
				if (row.deleted) match = false;
			}
			// ALL matches everything (default)

			if (match) {
				results.push(useUid ? uid : (i + 1));
			}
		}

		this._send('* SEARCH ' + results.join(' '));
		this._send(tag + ' OK SEARCH completed');
	}

	// --- IDLE ---

	_cmdIdle(tag) {
		if (this.state !== 'selected') {
			this._send(tag + ' NO Not selected');
			return;
		}

		this._send('+ idling');
		this._idleTag = tag;
		this._idleActive = true;

		// Poll for new messages every 30 seconds during IDLE
		var self = this;
		this._idleTimer = setInterval(async function() {
			if (!self._idleActive) return;
			try {
				var rows = await getMailboxMessages(self.userId, self.selectedMailbox);
				var newCount = rows.length;
				var newUidList = [];
				var newMap = {};
				for (var row of rows) {
					var uid = self.selectedMailbox === 'Trash'
						? trashUid(parseInt(row.id), row._source || 'inbox')
						: parseInt(row.id);
					newUidList.push(uid);
					newMap[uid] = row;
				}

				// Report new messages
				if (newCount > self.uidList.length) {
					self._send('* ' + newCount + ' EXISTS');
				}

				// Push flag changes
				for (var i = 0; i < newUidList.length; i++) {
					var nuid = newUidList[i];
					var oldRow = self.messageMap[nuid];
					var newRow = newMap[nuid];
					if (oldRow && newRow && oldRow.read !== newRow.read) {
						var flags = self._buildFlags(newRow, nuid);
						self._send('* ' + (i + 1) + ' FETCH (FLAGS (' + flags.join(' ') + '))');
					}
				}

				self.uidList = newUidList;
				self.messageMap = newMap;
			} catch (_) {}
		}, 30000);

		// Watch for DONE — must handle line-by-line since DONE and the
		// next command may arrive in the same TCP chunk
		this._idleBuf = '';
		this._idlePrevOnData = ImapSession.prototype._onData;
		this._onData = function(data) {
			self._idleBuf += data.toString('utf8');
			var lines = self._idleBuf.split('\r\n');
			self._idleBuf = lines.pop(); // Keep incomplete line

			for (var line of lines) {
				if (line.trim().toUpperCase() === 'DONE') {
					self._idleActive = false;
					clearInterval(self._idleTimer);
					self._idleTimer = null;
					self._onData = self._idlePrevOnData;
					self._send(self._idleTag + ' OK IDLE terminated');

					// Process any remaining lines as regular commands
					var remaining = lines.slice(lines.indexOf(line) + 1);
					for (var rem of remaining) {
						if (rem.length > 0) self._processCommand(rem);
					}
					// Also process any leftover in buffer
					if (self._idleBuf.length > 0) {
						var leftover = self._idleBuf;
						self._idleBuf = '';
						self._buffer += leftover;
						var moreLines = self._buffer.split('\r\n');
						self._buffer = moreLines.pop();
						for (var ml of moreLines) {
							if (ml.length > 0) self._processCommand(ml);
						}
					}
					return;
				}
			}
		};
	}

	// Notify IDLE session of new messages (called externally)
	notifyNewMessage() {
		if (this._idleActive && this.selectedMailbox === 'INBOX') {
			// Refresh mailbox and send EXISTS
			getMailboxMessages(this.userId, 'INBOX').then((rows) => {
				if (rows.length > this.uidList.length) {
					this._send('* ' + rows.length + ' EXISTS');
				}
			}).catch(() => {});
		}
	}

	// --- DB operations ---

	// Resolve a UID to its source table name and real row ID.
	// For Trash, UIDs are interleaved (even=inbox, odd=outbox).
	_resolveTable(uid) {
		if (this.selectedMailbox === 'Trash') {
			var resolved = trashUidToSource(uid);
			return { table: resolved.table === 'sent' ? 'pm_outbox' : 'pm_inbox', source: resolved.table };
		}
		if (this.selectedMailbox === 'Sent') return { table: 'pm_outbox', source: 'sent' };
		return { table: 'pm_inbox', source: 'inbox' };
	}

	async _markRead(row, uid) {
		var info = this._resolveTable(uid);
		// pm_outbox has no read column — skip silently
		if (info.source === 'sent') return;

		await postgres.write(
			"UPDATE pm_inbox SET read = true, read_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2",
			[row.id, this.userId]
		);
		if (this._eventPublisher) {
			this._eventPublisher.publish(EVENTS.PM_READ_CHANGED, {
				userId: this.userId, pmId: row.id, read: true, source: 'imap'
			});
		}
		await clearPmNotifications(this.userId, [row.id]);
	}

	async _markUnread(row, uid) {
		var info = this._resolveTable(uid);
		if (info.source === 'sent') return;

		await postgres.write(
			"UPDATE pm_inbox SET read = false, read_at = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2",
			[row.id, this.userId]
		);
		if (this._eventPublisher) {
			this._eventPublisher.publish(EVENTS.PM_READ_CHANGED, {
				userId: this.userId, pmId: row.id, read: false, source: 'imap'
			});
		}
	}

	async _markDeleted(row, uid) {
		var info = this._resolveTable(uid);

		if (this.selectedMailbox === 'Trash') {
			// Already in Trash -- tag for background hard delete via the
			// shared two-stage cleanup pipeline. This is non-blocking
			// (a single UPDATE) so even Thunderbird's "Empty Trash"
			// against hundreds of rows responds instantly. The actual
			// disk + DB cleanup happens in pm-purged-cleanup, which we
			// also enqueue on-demand below for sub-minute reclaim.
			//
			// Direct UPDATE rather than calling privateMessages.purgeMessage
			// avoids a uuid lookup -- row.uuid is already in messageMap
			// from getMailboxMessages. Same effect as purgeMessage().
			await postgres.write(
				"UPDATE " + info.table + " SET purged = true, purged_at = NOW(), updated_at = NOW() " +
				"WHERE id = $1 AND user_id = $2 AND deleted = true AND purged IS NOT TRUE",
				[row.id, this.userId]
			);
			// Track that we tagged at least one row in this expunge cycle
			// so the on-demand cleanup enqueue at the end of the cycle
			// fires once per cycle, not once per row.
			this._purgedDuringSession = true;
		} else {
			// Soft-delete (move to Trash)
			await postgres.write(
				"UPDATE " + info.table + " SET deleted = true, deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2",
				[row.id, this.userId]
			);
			// Its "New PM" notice goes with it, as for a web or terminal delete
			if (info.table === 'pm_inbox') await clearPmNotifications(this.userId, [row.id]);
		}
	}

	// Fire a single on-demand pm-purged-cleanup job if any rows were
	// tagged during this command. Coalesces a multi-row STORE+EXPUNGE
	// (Thunderbird "Empty Trash" hits hundreds of rows in one command)
	// into one enqueue. Failure is non-fatal -- the hourly schedule
	// will sweep tagged rows even if the on-demand job is dropped.
	async _fireOnDemandPurgeCleanup() {
		if (!this._purgedDuringSession) return;
		this._purgedDuringSession = false;
		try {
			var jobsMod = await import('../queues/jobs.js');
			await jobsMod.enqueuePmPurgedCleanup();
		} catch (err) {
			alogger.writeAlog(3,
				'IMAP: failed to enqueue pm-purged-cleanup (hourly schedule will catch it): ' + err.message,
				'yellow');
		}
	}

	async _restoreFromTrash(row, uid) {
		var info = this._resolveTable(uid);

		await postgres.write(
			"UPDATE " + info.table + " SET deleted = false, deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND user_id = $2",
			[row.id, this.userId]
		);
	}

	// --- Helpers ---

	// Build the flags array for a message row.
	// Sent messages (and outbox items in Trash) are always \Seen.
	_buildFlags(row, uid) {
		var flags = [];
		var isSentItem = this.selectedMailbox === 'Sent' ||
			(this.selectedMailbox === 'Trash' && row._source === 'sent');
		if (row.read || isSentItem) flags.push('\\Seen');
		if (row.deleted) flags.push('\\Deleted');
		return flags;
	}

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
		this._eventPublisher = null;
		this._eventSubscriber = null;
		this._maintenance = false;
	}

	// Maintenance mode. New connections are greeted with BYE, which RFC 3501
	// allows in place of OK and which clients read as "server unavailable";
	// sessions already open, IDLE included, stay until the grace runs out.
	setMaintenance(active) {
		this._maintenance = !!active;
	}

	closeSessionsForMaintenance() {
		for (var session of this.sessions) {
			if (!session._closed) session._send('* BYE Server closing for maintenance');
			session.close();
		}
	}

	start() {
		// Event publisher — shared across all sessions for PM read notifications
		this._eventPublisher = createEventPublisher();

		// Event subscriber — push notifications to IDLE sessions
		this._eventSubscriber = createEventSubscriber((event) => {
			switch (event.type) {
				case EVENTS.PM_DELIVERED:
					this._notifySessions(event.data.userId);
					break;
				case EVENTS.PM_READ_CHANGED:
					// Skip events we published ourselves
					if (event.data.source === 'imap') break;
					this._refreshSessions(event.data.userId);
					break;
				case EVENTS.CONFIG_CHANGED:
					appConfig.reload();
					break;
			}
		});

		this.server = net.createServer((socket) => this._onConnection(socket));

		this.server.on('error', (err) => {
			alogger.writeAlog(0, 'IMAP server error: ' + err.message, 'redbright');
		});

		this.server.listen(this.port, () => {
			alogger.writeAlog(1, 'IMAP server listening on port ' + this.port +
				' (domain: ' + this.mailDomain + ')', 'magentabright', true);
		});
	}

	// Split out of start() so the accept path is testable without a listener
	// and the Redis connections start() opens.
	_onConnection(socket) {
		if (this._maintenance) {
			socket.write('* BYE Closed for maintenance, try again later\r\n');
			socket.end();
			return null;
		}
		var session = new ImapSession(socket, this.mailDomain);
		session._eventPublisher = this._eventPublisher;
		this.sessions.add(session);
		socket.on('close', () => this.sessions.delete(session));
		return session;
	}

	stop() {
		for (var session of this.sessions) session.close();
		if (this._eventSubscriber) {
			this._eventSubscriber.shutdown();
			this._eventSubscriber = null;
		}
		if (this._eventPublisher) {
			this._eventPublisher.shutdown();
			this._eventPublisher = null;
		}
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}

	// Push new-message notification to IDLE sessions for a specific user
	_notifySessions(userId) {
		for (var session of this.sessions) {
			if (session.userId === userId) {
				session.notifyNewMessage();
			}
		}
	}

	// Trigger a mailbox refresh for IDLE sessions when read status changed externally
	_refreshSessions(userId) {
		for (var session of this.sessions) {
			if (session.userId === userId && session._idleActive) {
				// Force an immediate poll cycle by calling the IDLE timer logic
				session.notifyNewMessage();
			}
		}
	}
}

export { ImapServer, ImapSession };
