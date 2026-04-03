// newsFiles.js -- News/score file management.
//
// Admin-configurable list of ANSI/ASCII art files (e.g. door game scores,
// BBS news) displayed in the call flow and terminal login sequence.
// Files are read from disk at display time -- the DB tracks metadata only.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

async function ensureTable() {
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS news_files (
			id SERIAL PRIMARY KEY,
			title VARCHAR(128) NOT NULL,
			file_path VARCHAR(512) NOT NULL,
			description VARCHAR(256) DEFAULT '',
			center BOOLEAN DEFAULT false,
			source_width INTEGER DEFAULT 80,
			active BOOLEAN DEFAULT true,
			sort_order INTEGER DEFAULT 0,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP
		)
	`);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getActiveNewsFiles() {
	var rows = await postgres.query(
		'SELECT * FROM news_files WHERE active = true ORDER BY sort_order ASC, title ASC',
		[]
	);
	return rows || [];
}

async function getAllNewsFiles() {
	var rows = await postgres.query(
		'SELECT * FROM news_files ORDER BY sort_order ASC, title ASC',
		[]
	);
	return rows || [];
}

async function getNewsFileById(id) {
	return await postgres.queryOne(
		'SELECT * FROM news_files WHERE id = $1',
		[id]
	);
}

async function createNewsFile(data) {
	var result = { status: false, errormessages: [] };

	var title = (data.title || '').trim();
	var filePath = (data.file_path || '').trim();

	if (!title) result.errormessages.push('Title is required');
	if (!filePath) result.errormessages.push('File path is required');
	if (result.errormessages.length > 0) return result;

	var dbObj = {
		title: title,
		file_path: filePath,
		description: (data.description || '').trim(),
		center: data.center === 'true' || data.center === true || data.center === 'on',
		source_width: parseInt(data.source_width) || 80,
		active: data.active !== 'false' && data.active !== false,
		sort_order: parseInt(data.sort_order) || 0,
		created_at: new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'news_files');
	if (dbres.status) {
		result.status = true;
		result.insertId = dbres.insertId;
		alogger.writeAlog(5, 'News file created: ' + title, 'greenbright');
	} else {
		result.errormessages = result.errormessages.concat(dbres.errormessages);
	}

	return result;
}

async function updateNewsFile(id, data) {
	var result = { status: false, errormessages: [] };

	var updates = {};
	if (data.title !== undefined) updates.title = (data.title || '').trim();
	if (data.file_path !== undefined) updates.file_path = (data.file_path || '').trim();
	if (data.description !== undefined) updates.description = (data.description || '').trim();
	if (data.center !== undefined) updates.center = data.center === 'true' || data.center === true || data.center === 'on';
	if (data.source_width !== undefined) updates.source_width = parseInt(data.source_width) || 80;
	if (data.active !== undefined) updates.active = data.active === 'true' || data.active === true || data.active === 'on';
	if (data.sort_order !== undefined) updates.sort_order = parseInt(data.sort_order) || 0;

	if (Object.keys(updates).length === 0) {
		result.errormessages.push('No changes');
		return result;
	}

	updates.updated_at = new Date();
	var count = await postgres.updateById(id, updates, 'news_files');
	if (count > 0) {
		result.status = true;
		alogger.writeAlog(5, 'News file updated: id=' + id, 'greenbright');
	} else {
		result.errormessages.push('No rows updated');
	}

	return result;
}

async function deleteNewsFile(id) {
	return await postgres.write('DELETE FROM news_files WHERE id = $1', [id]);
}

async function updateSortOrder(ids) {
	for (var i = 0; i < ids.length; i++) {
		await postgres.write(
			'UPDATE news_files SET sort_order = $1 WHERE id = $2',
			[i, parseInt(ids[i])]
		);
	}
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	ensureTable,
	getActiveNewsFiles,
	getAllNewsFiles,
	getNewsFileById,
	createNewsFile,
	updateNewsFile,
	deleteNewsFile,
	updateSortOrder
};
