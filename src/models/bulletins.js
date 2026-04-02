// src/models/bulletins.js
// PostgreSQL-backed bulletin management.
// Bulletins are sysop-created info pages (rules, help, info, etc.)
// displayed via a selection menu on the terminal and as a list on the web.

import * as postgres from '../middleware/db/postgres.js';
import { htmlToTerminalText, htmlToPlainText } from './announcements.js';

async function getActiveBulletins() {
	var rows = await postgres.query(
		'SELECT * FROM bulletins WHERE active = true ORDER BY sort_order ASC, title ASC'
	);
	return rows || [];
}

async function getAllBulletins() {
	var rows = await postgres.query(
		'SELECT * FROM bulletins ORDER BY sort_order ASC, title ASC'
	);
	return rows || [];
}

async function getBulletinById(id) {
	return await postgres.queryOne('SELECT * FROM bulletins WHERE id = $1', [id]);
}

async function getBulletinByUuid(uuid) {
	return await postgres.queryOne('SELECT * FROM bulletins WHERE uuid = $1', [uuid]);
}

async function createBulletin(data) {
	var result = { status: false, errormessages: [], bulletinId: null };

	var title = (data.title || '').trim();
	if (!title) {
		result.errormessages.push('Title is required');
		return result;
	}

	var bodyHtml = (data.body_html || '').trim() || null;
	var bodyText = bodyHtml ? htmlToTerminalText(bodyHtml) : null;
	var artFile = (data.art_file || '').trim() || null;

	var obj = {
		title: title,
		art_file: artFile,
		body_html: bodyHtml,
		body_text: bodyText,
		active: data.active !== undefined ? (data.active === 'true' || data.active === true) : true,
		sort_order: parseInt(data.sort_order) || 0,
	};

	var insertResult = await postgres.insertObject(obj, 'bulletins');
	if (insertResult) {
		result.status = true;
		result.bulletinId = insertResult.insertId;
	} else {
		result.errormessages.push('Database insert failed');
	}
	return result;
}

async function updateBulletin(id, data) {
	var result = { status: false, errormessages: [] };

	var updates = {};
	if (data.title !== undefined) updates.title = (data.title || '').trim();
	if (data.art_file !== undefined) updates.art_file = (data.art_file || '').trim() || null;
	if (data.body_html !== undefined) {
		updates.body_html = (data.body_html || '').trim() || null;
		updates.body_text = updates.body_html ? htmlToTerminalText(updates.body_html) : null;
	}
	if (data.active !== undefined) updates.active = (data.active === 'true' || data.active === true);
	if (data.sort_order !== undefined) updates.sort_order = parseInt(data.sort_order) || 0;
	updates.updated_at = new Date();

	if (Object.keys(updates).length === 0) {
		result.errormessages.push('No changes');
		return result;
	}

	await postgres.updateById(updates, 'bulletins', id);
	result.status = true;
	return result;
}

async function deleteBulletin(id) {
	return await postgres.write('DELETE FROM bulletins WHERE id = $1', [id]);
}

async function updateSortOrder(ids) {
	for (var i = 0; i < ids.length; i++) {
		await postgres.write('UPDATE bulletins SET sort_order = $1 WHERE id = $2', [i, ids[i]]);
	}
}

export {
	getActiveBulletins,
	getAllBulletins,
	getBulletinById,
	getBulletinByUuid,
	createBulletin,
	updateBulletin,
	deleteBulletin,
	updateSortOrder
};
