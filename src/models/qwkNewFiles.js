// src/models/qwkNewFiles.js: NEWFILES.DAT for a user's personal QWK packet
// (#75), in the form Synchronet writes it (tmp_xfer.cpp create_filelist,
// listfile.cpp listfiles/listfiletofile), so offline readers show it as they
// would from a Synchronet board:
//
//   New files since: <date>
//
//   (1) <Group> (2) <Area>
//   ---------------------
//   FILENAME.ZIP   12.3K Description
//
//   3 Files Listed.
//
// CRLF lines, CP437 bytes. It lists the areas the user scans for new files
// (their file subscriptions), as Synchronet lists every directory not
// excluded from new-scan, and only when the user has the list switched on
// (users.qwk_files, on by default as in Synchronet's QWK_DEFAULT).

import * as postgres from '../middleware/db/postgres.js';
import * as userFileSubs from './userFileSubs.js';
import { getActiveGroups } from './fileGroups.js';
import { getAreasInGroup } from './fileAreas.js';
import { canBrowseFileArea } from '../utils/fileAreaAccess.js';
import { utf8ToCp437 } from '../utils/codepageConversions.js';

var MAX_FILES = 2000;

/** Synchronet's byte_estimate_to_str, near enough: 512, 12.3K, 1.2M, 3.4G. Pure. */
function sizeText(bytes) {
	var n = Number(bytes) || 0;
	if (n < 1024) return String(n);
	var units = ['K', 'M', 'G', 'T'];
	var v = n, u = -1;
	while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
	return (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))) + units[u];
}

function dateText(d) {
	var x = new Date(d);
	if (isNaN(x.getTime())) return '';
	var pad = function (n) { return String(n).padStart(2, '0'); };
	return pad(x.getMonth() + 1) + '/' + pad(x.getDate()) + '/' + pad(x.getFullYear() % 100) + ' ' +
		pad(x.getHours()) + ':' + pad(x.getMinutes());
}

/**
 * The list as text (CRLF lines). Pure. `sections` are
 * [{ groupNum, groupName, areaNum, areaName, files: [{filename, file_size, short_desc}] }].
 * Returns '' when there is nothing to list.
 */
function renderNewFilesList(since, sections) {
	var count = 0;
	var out = 'New files since: ' + dateText(since) + '\r\n';
	for (var s of sections || []) {
		if (!s.files || s.files.length === 0) continue;
		var head = '(' + s.groupNum + ') ' + s.groupName + ' (' + s.areaNum + ') ' + s.areaName;
		out += '\r\n' + head + '\r\n' + '-'.repeat(Math.min(head.length, 64)) + '\r\n';
		for (var f of s.files) {
			var desc = String(f.short_desc || f.filename || '').replace(/[\r\n]+/g, ' ').trim();
			out += String(f.filename).padEnd(12) + ' ' + sizeText(f.file_size).padStart(7) + ' ' + desc + '\r\n';
			count++;
		}
	}
	if (count === 0) return '';
	if (count > 1) out += '\r\n' + count + ' Files Listed.\r\n';
	return out;
}

/**
 * NEWFILES.DAT bytes for a user: files uploaded after `since` in the areas
 * they can see and scan for new files. `null` when there is nothing new.
 * @returns {Promise<{bytes: Buffer, count: number}|null>}
 */
async function buildNewFilesDat(user, since) {
	var sections = [];
	var total = 0;
	var groups = (await getActiveGroups()) || [];
	for (var gi = 0; gi < groups.length && total < MAX_FILES; gi++) {
		var g = groups[gi];
		if (!canBrowseFileArea(user, g)) continue;
		var areas = (await getAreasInGroup(g.shortcode)) || [];
		var visible = areas.filter(function (a) { return a.active && canBrowseFileArea(user, a); });
		var subscribed = new Set(await userFileSubs.getSubscribedAreas(user.id,
			visible.map(function (a) { return { shortcode: a.shortcode, newscan_default: a.newscan_default }; })));
		for (var ai = 0; ai < visible.length && total < MAX_FILES; ai++) {
			var a = visible[ai];
			if (!subscribed.has(a.shortcode)) continue;
			var files = (await postgres.query(
				'SELECT filename, file_size, short_desc FROM file_entries WHERE area_id = $1 AND active = true AND upload_date > $2 ' +
				'ORDER BY upload_date ASC, id ASC LIMIT $3', [a.id, since, MAX_FILES - total])) || [];
			if (files.length === 0) continue;
			total += files.length;
			sections.push({ groupNum: gi + 1, groupName: g.name, areaNum: ai + 1, areaName: a.name, files: files });
		}
	}
	var text = renderNewFilesList(since, sections);
	if (!text) return null;
	return { bytes: Buffer.from(utf8ToCp437(text)), count: total };
}

export { sizeText, renderNewFilesList, buildNewFilesDat };
