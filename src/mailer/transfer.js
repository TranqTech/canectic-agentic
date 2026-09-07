// mailer/transfer.js — File transfer engine for mailer sessions.
//
// Manages concurrent send/receive operations within a single session.
// Reads outbound files and feeds chunks to the protocol module.
// Receives inbound file data to temp files, moves to inbound on completion.
//
// The transfer engine does not speak binkp — it uses the protocol module's
// offerFile/sendFileData/sendGOT/sendEOB methods and reacts to protocol
// events (fileOffered, fileData, fileComplete, fileReceived).

import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as path from 'path';
import * as alogger from '../utils/alogger.js';
import * as fileWildcards from '../models/fileWildcards.js';
import { resolveFileboxPath } from '../utils/fileboxPath.js';

const SEND_CHUNK_SIZE = 4096;

class TransferEngine extends EventEmitter {
	constructor(protocol, options) {
		super();
		this._protocol   = protocol;
		this._inboundDir = options.inboundDir  || 'ftn/in';
		this._tempDir    = options.tempDir      || 'ftn/tmp';
		this._sessionId  = options.sessionId    || 'unknown';

		// Send state
		this._sendQueue  = [];     // Array of { filepath, name, size, mtime }
		this._sendActive = null;   // Currently sending: { filepath, name, size, fd, offset }

		// Receive state
		this._rxStream   = null;   // fs.WriteStream for inbound file
		this._rxInfo     = null;   // { name, size, time, tempPath }

		// Completion tracking
		this._allFilesSent     = false;
		this._allFilesOffered  = false;

		// Ensure directories exist
		this._ensureDir(this._inboundDir);
		this._ensureDir(this._tempDir);

		// Wire protocol events
		this._protocol.on('fileOffered', (info) => this._onFileOffered(info));
		this._protocol.on('fileData',    (data) => this._onFileData(data));
		this._protocol.on('fileComplete', (info) => this._onFileComplete(info));
		this._protocol.on('fileReceived', (info) => this._onFileReceived(info));
		this._protocol.on('fileSkipped',  (info) => this._onFileSkipped(info));
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	// Queue a file for sending. Called by session controller after building
	// the outbound file list.
	// options.floFile   — path to the flow file this entry came from (if any)
	// options.floPrefix — flow file line prefix: '^' = delete, '#' = truncate, '' = leave
	// options.deleteAfterSend — true for direct BSO packet files (.out/.cut/.hut)
	queueFile(filepath, options) {
		var opts = options || {};
		try {
			var stat = fs.statSync(filepath);
			this._sendQueue.push({
				filepath:        filepath,
				name:            path.basename(filepath),
				size:            stat.size,
				mtime:           stat.mtimeMs,
				floFile:         opts.floFile || null,
				floPrefix:       opts.floPrefix || '',
				deleteAfterSend: opts.deleteAfterSend || false
			});
		} catch (err) {
			alogger.writeClog(3, 'TransferEngine: cannot stat ' + filepath + ': ' + err.message, 'mailer', 'redbright');
		}
	}

	// Begin offering and sending queued files. Called after authentication.
	startSending() {
		this._offerNextFile();
	}

	// Called when there are no more files to queue (session controller
	// has finished scanning the outbound directory).
	markAllQueued() {
		this._allFilesOffered = true;
		alogger.writeClog(5, 'TransferEngine: markAllQueued (queue=' + this._sendQueue.length + ', active=' + (this._sendActive ? 'yes' : 'no') + ')', 'mailer', 'cyan');
		if (this._sendQueue.length === 0 && !this._sendActive && !this._allFilesSent) {
			this._allFilesSent = true;
			this.emit('allSent');
		}
	}

	get sendQueue() {
		return this._sendQueue;
	}

	get isReceiving() {
		return this._rxInfo !== null;
	}

	get isSending() {
		return this._sendActive !== null;
	}

	// -----------------------------------------------------------------------
	// Outbound — offer and send files
	// -----------------------------------------------------------------------

	_offerNextFile() {
		if (this._sendActive) return; // Already sending one

		if (this._sendQueue.length === 0) {
			if (this._allFilesOffered && !this._allFilesSent) {
				this._allFilesSent = true;
				this.emit('allSent');
			}
			return;
		}

		var item = this._sendQueue.shift();

		// Verify file still exists (could have been sent by another session)
		if (!fs.existsSync(item.filepath)) {
			alogger.writeClog(4, 'TransferEngine: skipping disappeared file ' + item.filepath, 'mailer', 'yellow');
			// Mark it done rather than just skipping. An unmarked line will
			// never do anything again, but it keeps the flow file alive, and a
			// flow file that outlives its contents is read as pending mail on
			// every BSO scan for ever.
			if (item.floFile) this._markFloLineSent(item.floFile, item.filepath);
			this._offerNextFile();
			return;
		}

		this._sendActive = {
			filepath:        item.filepath,
			name:            item.name,
			size:            item.size,
			mtime:           item.mtime,
			offset:          0,
			fd:              null,
			floFile:         item.floFile || null,
			floPrefix:       item.floPrefix || '',
			deleteAfterSend: item.deleteAfterSend || false
		};

		this._protocol.offerFile(item.name, item.size, item.mtime, 0);
		// Immediately start sending data — binkp is full-duplex, remote will
		// respond with M_GOT, M_SKIP, or M_GET asynchronously.
		this._sendFileChunks();
	}

	_sendFileChunks() {
		if (!this._sendActive) return;

		var item = this._sendActive;
		try {
			if (!item.fd) {
				item.fd = fs.openSync(item.filepath, 'r');
			}

			var buf    = Buffer.alloc(SEND_CHUNK_SIZE);
			var bytesRead = fs.readSync(item.fd, buf, 0, SEND_CHUNK_SIZE, item.offset);

			while (bytesRead > 0) {
				this._protocol.sendFileData(buf.subarray(0, bytesRead));
				item.offset += bytesRead;

				this.emit('sendProgress', {
					name:   item.name,
					sent:   item.offset,
					size:   item.size
				});

				if (item.offset >= item.size) {
					// File send complete — wait for M_GOT from remote
					fs.closeSync(item.fd);
					item.fd = null;
					return;
				}

				bytesRead = fs.readSync(item.fd, buf, 0, SEND_CHUNK_SIZE, item.offset);
			}
		} catch (err) {
			alogger.writeClog(3, 'TransferEngine: send error for ' + item.name + ': ' + err.message, 'mailer', 'redbright');
			if (item.fd) {
				try { fs.closeSync(item.fd); } catch (_) {}
			}
			this._sendActive = null;
			this.emit('transferError', { name: item.name, error: err });
			this._offerNextFile();
		}
	}

	_onFileReceived(info) {
		// Remote acknowledged our file with M_GOT
		if (this._sendActive && this._sendActive.name === info.name) {
			var item = this._sendActive;
			this._sendActive = null;

			// Handle file cleanup based on source
			if (item.deleteAfterSend) {
				// Direct BSO packet file (.out/.cut/.hut) — delete
				this._deleteFile(item.filepath);
			} else if (item.floFile && item.floPrefix === '^') {
				// Flow file entry with ^ prefix — delete after send
				this._deleteFile(item.filepath);
				this._markFloLineSent(item.floFile, item.filepath);
			} else if (item.floFile && item.floPrefix === '#') {
				// Flow file entry with # prefix — truncate after send
				this._truncateFile(item.filepath);
				this._markFloLineSent(item.floFile, item.filepath);
			} else if (item.floFile) {
				// Flow file entry with no prefix — leave file, mark line sent
				this._markFloLineSent(item.floFile, item.filepath);
			}

			this.emit('sendComplete', {
				name:     info.name,
				filepath: item.filepath,
				// Carried so the session can total what it actually pushed.
				// bytesSent was declared and reported for the whole life of the
				// mailer while nothing ever incremented it, so every session
				// reported zero bytes out.
				size:     item.size || 0,
				floFile:  item.floFile
			});

			// Advance to next file
			this._offerNextFile();
		}
	}

	_onFileSkipped(info) {
		// Remote skipped our offered file
		if (this._sendActive && this._sendActive.name === info.name) {
			if (this._sendActive.fd) {
				try { fs.closeSync(this._sendActive.fd); } catch (_) {}
			}
			this._sendActive = null;
			alogger.writeClog(4, 'TransferEngine: remote skipped ' + info.name, 'mailer', 'yellow');
			this._offerNextFile();
		}
	}

	// -----------------------------------------------------------------------
	// Filename sanitization — prevent path traversal attacks
	// -----------------------------------------------------------------------

	_sanitizeFilename(name) {
		if (!name) return null;

		// Strip any directory components — only the base filename matters
		name = path.basename(name);

		// Reject names containing traversal patterns even after basename
		if (name === '.' || name === '..' || name.includes('..')) return null;

		// Strip null bytes and control characters
		name = name.replace(/[\x00-\x1f]/g, '');

		// Reject empty after sanitization
		if (!name || name.length === 0) return null;

		return name;
	}

	// -----------------------------------------------------------------------
	// Inbound — receive files
	// -----------------------------------------------------------------------

	_onFileOffered(info) {
		// Sanitize the offered filename — reject anything suspicious
		var safeName = this._sanitizeFilename(info.name);
		if (!safeName) {
			alogger.writeClog(3, 'TransferEngine: rejected unsafe filename: ' + JSON.stringify(info.name), 'mailer', 'redbright');
			this._protocol.sendSKIP(info.name, info.size, info.time);
			return;
		}
		info.name = safeName;

		// Remote is offering us a file
		alogger.writeClog(5, 'TransferEngine: file offered — ' + info.name + ' (' + info.size + ' bytes, offset ' + info.offset + ')', 'mailer', 'cyan');
		var tempPath = path.join(this._tempDir, this._sessionId + '_' + info.name);

		// Check for resume (partial file from a previous session)
		var resumeOffset = 0;
		if (fs.existsSync(tempPath)) {
			try {
				var stat = fs.statSync(tempPath);
				resumeOffset = stat.size;
			} catch (_) {}
		}

		// NR (Non-Reliable) mode: offset -1 means the sender requires an
		// M_GET response before it will start sending data. We must always
		// respond with M_GET indicating our desired start offset.
		// Also respond with M_GET for normal resume (partial file exists).
		if (info.offset === -1 || (resumeOffset > 0 && resumeOffset < info.size)) {
			alogger.writeClog(5, 'TransferEngine: sending M_GET for ' + info.name + ' at offset ' + resumeOffset, 'mailer', 'cyan');
			this._protocol.sendGET(info.name, info.size, info.time, resumeOffset);
		}

		this._rxInfo = {
			name:     info.name,
			size:     info.size,
			time:     info.time,
			offset:   resumeOffset,
			tempPath: tempPath
		};

		// Open write stream (append for resume)
		this._rxStream = fs.createWriteStream(tempPath, { flags: resumeOffset > 0 ? 'a' : 'w' });
	}

	_onFileData(data) {
		if (this._rxStream) {
			this._rxStream.write(data);

			if (this._rxInfo) {
				this.emit('receiveProgress', {
					name:     this._rxInfo.name,
					received: (this._rxInfo.offset || 0) + this._rxStream.bytesWritten,
					size:     this._rxInfo.size
				});
			}
		}
	}

	_onFileComplete(info) {
		if (!this._rxStream || !this._rxInfo) return;

		var stream = this._rxStream;
		var rxInfo = this._rxInfo;
		this._rxStream = null;
		this._rxInfo   = null;

		var self = this;

		// Wait for the write stream to flush to disk before verifying
		stream.end(function() {
			// Verify size
			try {
				var stat = fs.statSync(rxInfo.tempPath);
				if (stat.size !== rxInfo.size) {
					alogger.writeClog(3,
						'TransferEngine: size mismatch for ' + rxInfo.name +
						' (expected ' + rxInfo.size + ', got ' + stat.size + ')',
						'mailer', 'redbright'
					);
					self.emit('transferError', {
						name: rxInfo.name,
						error: new Error('Size mismatch')
					});
					return;
				}
			} catch (err) {
				alogger.writeClog(3, 'TransferEngine: cannot stat completed file: ' + err.message, 'mailer', 'redbright');
				return;
			}

			// Check inbound wildcard rules for filename routing
			self._routeInboundFile(rxInfo).catch(function(err) {
				alogger.writeClog(3, 'TransferEngine: wildcard routing error: ' + err.message, 'mailer', 'redbright');
			});
		});
	}

	async _routeInboundFile(rxInfo) {
		var destDir = this._inboundDir;
		var wildcardMatch = null;
		var skipToss = false;

		// Test against wildcard rules
		try {
			wildcardMatch = await fileWildcards.matchFilename(rxInfo.name);
		} catch (_) {
			// Wildcard matching failure is non-fatal — fall through to default
		}

		if (wildcardMatch) {
			var targetDir = resolveFileboxPath(wildcardMatch.target_dir);
			if (targetDir) {
				this._ensureDir(targetDir);
				destDir = targetDir;
				skipToss = !wildcardMatch.still_toss;
				alogger.writeClog(5,
					'TransferEngine: wildcard match — ' + rxInfo.name +
					' -> ' + targetDir + ' (pattern: ' + wildcardMatch.pattern +
					', toss: ' + (wildcardMatch.still_toss ? 'yes' : 'no') + ')',
					'mailer', 'cyan'
				);
			}
		}

		// Move to destination directory
		var destPath = path.join(destDir, rxInfo.name);

		// Avoid overwriting — append timestamp if needed
		if (fs.existsSync(destPath)) {
			var ext  = path.extname(rxInfo.name);
			var base = path.basename(rxInfo.name, ext);
			destPath = path.join(destDir, base + '_' + Date.now() + ext);
		}

		try {
			fs.renameSync(rxInfo.tempPath, destPath);
		} catch (err) {
			// Cross-device rename fallback
			try {
				fs.copyFileSync(rxInfo.tempPath, destPath);
				fs.unlinkSync(rxInfo.tempPath);
			} catch (copyErr) {
				alogger.writeClog(3, 'TransferEngine: cannot move file to destination: ' + copyErr.message, 'mailer', 'redbright');
				return;
			}
		}

		// Tell remote we got the file
		this._protocol.sendGOT(rxInfo.name, rxInfo.size, rxInfo.time);

		alogger.writeClog(5, 'TransferEngine: received ' + rxInfo.name + ' (' + rxInfo.size + ' bytes)', 'mailer', 'greenbright');
		this.emit('receiveComplete', {
			name: rxInfo.name,
			size: rxInfo.size,
			path: destPath,
			wildcardMatch: wildcardMatch ? wildcardMatch.pattern : null,
			skipToss: skipToss
		});
	}

	// -----------------------------------------------------------------------
	// Utilities
	// -----------------------------------------------------------------------

	_ensureDir(dir) {
		try {
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
		} catch (err) {
			alogger.writeClog(3, 'TransferEngine: cannot create directory ' + dir + ': ' + err.message, 'mailer', 'redbright');
		}
	}

	cleanup() {
		if (this._rxStream) {
			try { this._rxStream.end(); } catch (_) {}
			this._rxStream = null;
		}
		if (this._sendActive && this._sendActive.fd) {
			try { fs.closeSync(this._sendActive.fd); } catch (_) {}
		}
		this._sendActive = null;
	}

	// -----------------------------------------------------------------------
	// Post-send cleanup
	// -----------------------------------------------------------------------

	_deleteFile(filepath) {
		try {
			if (fs.existsSync(filepath)) {
				fs.unlinkSync(filepath);
				alogger.writeClog(5, 'TransferEngine: deleted sent file ' + filepath, 'mailer', 'green');
			}
		} catch (err) {
			alogger.writeClog(3, 'TransferEngine: cannot delete ' + filepath + ': ' + err.message, 'mailer', 'redbright');
		}
	}

	_truncateFile(filepath) {
		try {
			if (fs.existsSync(filepath)) {
				fs.truncateSync(filepath, 0);
				alogger.writeClog(5, 'TransferEngine: truncated sent file ' + filepath, 'mailer', 'green');
			}
		} catch (err) {
			alogger.writeClog(3, 'TransferEngine: cannot truncate ' + filepath + ': ' + err.message, 'mailer', 'redbright');
		}
	}

	// Mark a flow file line as sent by replacing its prefix with ~
	// If all lines in the flow file are marked sent, delete the flow file.
	_markFloLineSent(floFile, filepath) {
		try {
			if (!fs.existsSync(floFile)) return;

			var content = fs.readFileSync(floFile, 'utf8');
			var lines   = content.split('\n');
			var updated = false;
			var allSent = true;

			for (var i = 0; i < lines.length; i++) {
				var line = lines[i].trim();
				if (!line) continue;

				// Extract the filepath from this line (strip prefix if present)
				var linePrefix = '';
				var lineFile   = line;
				if (line[0] === '^' || line[0] === '#' || line[0] === '~') {
					linePrefix = line[0];
					lineFile   = line.substring(1).trim();
				}
				lineFile = lineFile.replace(/\r/g, '');

				// Match by filepath
				if (lineFile === filepath && linePrefix !== '~') {
					lines[i] = '~' + lineFile;
					updated = true;
				}

				// Check if this line is still pending
				var checkPrefix = lines[i].trim()[0];
				if (checkPrefix !== '~' && lines[i].trim().length > 0) {
					allSent = false;
				}
			}

			// Deletion used to be gated on `updated`, so a flow file whose last
			// line was marked in an earlier session was never removed: nothing
			// changed this time round, so nothing checked whether anything was
			// left. It then read as pending mail on every scan.
			if (allSent) {
				fs.unlinkSync(floFile);
				alogger.writeClog(5, 'TransferEngine: all files sent, deleted flow file ' + floFile, 'mailer', 'green');
			} else if (updated) {
				// Write updated flow file with ~ markers
				fs.writeFileSync(floFile, lines.join('\n'));
				alogger.writeClog(5, 'TransferEngine: marked sent in ' + path.basename(floFile) + ': ' + path.basename(filepath), 'mailer', 'green');
			}
		} catch (err) {
			alogger.writeClog(3, 'TransferEngine: cannot update flow file ' + floFile + ': ' + err.message, 'mailer', 'redbright');
		}
	}
}

export { TransferEngine };
