// pmAttachments.js -- PM file attachment management.
//
// Attachments stored on disk at {pm_attachment_dir}/{YYYY-MM}/{msgUuid}/{filename}.
// Linked to messages via message_uuid (works across inbox/outbox/undeliverable).

import * as fs from 'fs';
import * as path from 'path';
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

async function ensureTable() {
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS pm_attachments (
			id SERIAL PRIMARY KEY,
			message_uuid VARCHAR(64) NOT NULL,
			message_table VARCHAR(16) NOT NULL DEFAULT 'inbox',
			filename VARCHAR(255) NOT NULL,
			mime_type VARCHAR(128) DEFAULT 'application/octet-stream',
			file_size BIGINT DEFAULT 0,
			storage_path VARCHAR(512) NOT NULL,
			created_at TIMESTAMP DEFAULT NOW()
		)
	`);

	await postgres.write(
		"CREATE INDEX IF NOT EXISTS idx_pma_uuid ON pm_attachments(message_uuid)"
	);
	await postgres.write(
		"CREATE INDEX IF NOT EXISTS idx_pma_uuid_table ON pm_attachments(message_uuid, message_table)"
	);

	// Add has_attachments column to inbox and outbox if missing
	await postgres.write(
		"ALTER TABLE pm_inbox ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN DEFAULT false"
	);
	await postgres.write(
		"ALTER TABLE pm_outbox ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN DEFAULT false"
	);
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function _getStorageDir(msgUuid) {
	var baseDir = appConfig.get('pm_attachment_dir', 'files/pm_attachments');
	var now = new Date();
	var month = String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
	return path.join(baseDir, month, msgUuid);
}

function _sanitizeFilename(filename) {
	// Strip path separators, null bytes, and limit length
	var safe = (filename || 'attachment').replace(/[/\\:\x00]/g, '_').trim();
	if (safe.length > 200) safe = safe.substring(0, 200);
	if (!safe) safe = 'attachment';
	return safe;
}

// ---------------------------------------------------------------------------
// Store attachments for a message
// ---------------------------------------------------------------------------

// Save attachments to disk and create DB records.
// attachments: [{ filename, mimeType, data: Buffer }]
// Returns array of created attachment IDs.
async function storeAttachments(msgUuid, msgTable, attachments) {
	if (!attachments || attachments.length === 0) return [];

	var maxSize = appConfig.getNumber('pm_max_attachment_size', 10485760);
	var maxCount = appConfig.getNumber('pm_max_attachments', 5);
	var toStore = attachments.slice(0, maxCount);

	var storageDir = _getStorageDir(msgUuid);
	fs.mkdirSync(storageDir, { recursive: true });

	var ids = [];

	for (var att of toStore) {
		var filename = _sanitizeFilename(att.filename);
		var mimeType = att.mimeType || 'application/octet-stream';
		var data = att.data;

		if (!Buffer.isBuffer(data)) {
			if (typeof data === 'string') {
				data = Buffer.from(data, 'base64');
			} else {
				continue;
			}
		}

		// Enforce size limit
		if (data.length > maxSize) {
			alogger.writeAlog(3, 'PM attachment too large: ' + filename + ' (' + data.length + ' bytes, max ' + maxSize + ')', 'yellow');
			continue;
		}

		var filePath = path.join(storageDir, filename);

		// Handle filename collision
		var counter = 1;
		while (fs.existsSync(filePath)) {
			var ext = path.extname(filename);
			var base = path.basename(filename, ext);
			filePath = path.join(storageDir, base + '_' + counter + ext);
			counter++;
		}

		fs.writeFileSync(filePath, data);

		var dbObj = {
			message_uuid: msgUuid,
			message_table: msgTable || 'inbox',
			filename: filename,
			mime_type: mimeType,
			file_size: data.length,
			storage_path: filePath,
			created_at: new Date()
		};

		var dbres = await postgres.insertObject(dbObj, 'pm_attachments');
		if (dbres.status && dbres.insertId) {
			ids.push(dbres.insertId);
		}
	}

	if (ids.length > 0) {
		alogger.writeAlog(5, 'Stored ' + ids.length + ' attachment(s) for PM ' + msgUuid, 'cyan');
	}

	return ids;
}

// Store attachments from uploaded files (multer format: { path, originalname, mimetype, size }).
async function storeUploadedFiles(msgUuid, msgTable, files) {
	if (!files || files.length === 0) return [];

	var maxSize = appConfig.getNumber('pm_max_attachment_size', 10485760);
	var maxCount = appConfig.getNumber('pm_max_attachments', 5);
	var toStore = files.slice(0, maxCount);

	var storageDir = _getStorageDir(msgUuid);
	fs.mkdirSync(storageDir, { recursive: true });

	var ids = [];

	for (var file of toStore) {
		if (file.size > maxSize) {
			alogger.writeAlog(3, 'PM upload too large: ' + file.originalname + ' (' + file.size + ')', 'yellow');
			// Clean up multer temp file
			try { fs.unlinkSync(file.path); } catch (_) {}
			continue;
		}

		var filename = _sanitizeFilename(file.originalname);
		var destPath = path.join(storageDir, filename);

		// Handle collision
		var counter = 1;
		while (fs.existsSync(destPath)) {
			var ext = path.extname(filename);
			var base = path.basename(filename, ext);
			destPath = path.join(storageDir, base + '_' + counter + ext);
			counter++;
		}

		// Move from multer temp to storage
		try {
			fs.renameSync(file.path, destPath);
		} catch (_) {
			// Cross-device? Copy + delete
			fs.copyFileSync(file.path, destPath);
			fs.unlinkSync(file.path);
		}

		var dbObj = {
			message_uuid: msgUuid,
			message_table: msgTable || 'outbox',
			filename: filename,
			mime_type: file.mimetype || 'application/octet-stream',
			file_size: file.size,
			storage_path: destPath,
			created_at: new Date()
		};

		var dbres = await postgres.insertObject(dbObj, 'pm_attachments');
		if (dbres.status && dbres.insertId) {
			ids.push(dbres.insertId);
		}
	}

	if (ids.length > 0) {
		alogger.writeAlog(5, 'Stored ' + ids.length + ' uploaded attachment(s) for PM ' + msgUuid, 'cyan');
	}

	return ids;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function getAttachments(msgUuid) {
	var rows = await postgres.query(
		'SELECT * FROM pm_attachments WHERE message_uuid = $1 ORDER BY id ASC',
		[msgUuid]
	);
	return rows || [];
}

async function getAttachmentById(id) {
	return await postgres.queryOne(
		'SELECT * FROM pm_attachments WHERE id = $1',
		[id]
	);
}

// Copy attachment references from an outbox message to an inbox message
// (for LOCAL delivery -- same files on disk, new DB rows pointing to inbox UUID).
async function copyAttachmentsToInbox(outboxUuid, inboxUuid) {
	var outboxAtts = await getAttachments(outboxUuid);
	if (outboxAtts.length === 0) return;

	for (var att of outboxAtts) {
		var dbObj = {
			message_uuid: inboxUuid,
			message_table: 'inbox',
			filename: att.filename,
			mime_type: att.mime_type,
			file_size: att.file_size,
			storage_path: att.storage_path, // Same file on disk
			created_at: new Date()
		};
		await postgres.insertObject(dbObj, 'pm_attachments');
	}
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

// Delete attachments for a message. Removes files from disk only if no other
// references point to the same storage_path (LOCAL delivery shares files).
async function deleteAttachments(msgUuid) {
	var atts = await getAttachments(msgUuid);

	for (var att of atts) {
		// Check if another message references the same file
		var refs = await postgres.queryOne(
			'SELECT COUNT(*) AS cnt FROM pm_attachments WHERE storage_path = $1 AND message_uuid != $2',
			[att.storage_path, msgUuid]
		);
		var refCount = refs ? parseInt(refs.cnt) : 0;

		if (refCount === 0) {
			// Safe to delete from disk
			try { fs.unlinkSync(att.storage_path); } catch (_) {}

			// Try to remove empty parent directories
			try {
				var dir = path.dirname(att.storage_path);
				var contents = fs.readdirSync(dir);
				if (contents.length === 0) fs.rmdirSync(dir);
			} catch (_) {}
		}
	}

	await postgres.write(
		'DELETE FROM pm_attachments WHERE message_uuid = $1',
		[msgUuid]
	);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	ensureTable,
	storeAttachments,
	storeUploadedFiles,
	getAttachments,
	getAttachmentById,
	copyAttachmentsToInbox,
	deleteAttachments,
	_sanitizeFilename,
	_getStorageDir
};
