// src/models/announcements.js
// PostgreSQL-backed announcements/bulletin management.

import * as postgres from '../middleware/db/postgres.js';
import { v4 as uuidv4 } from 'uuid';

// --- ANSI 16-color palette (standard + bright) ---
// Each entry: [R, G, B, ansiColorNumber]
var ANSI_PALETTE = [
	[0, 0, 0, 0],           // black
	[170, 0, 0, 1],         // red
	[0, 170, 0, 2],         // green
	[170, 85, 0, 3],        // yellow (dark)
	[0, 0, 170, 4],         // blue
	[170, 0, 170, 5],       // magenta
	[0, 170, 170, 6],       // cyan
	[170, 170, 170, 7],     // white (grey)
	[85, 85, 85, 8],        // bright black (dark grey)
	[255, 85, 85, 9],       // bright red
	[85, 255, 85, 10],      // bright green
	[255, 255, 85, 11],     // bright yellow
	[85, 85, 255, 12],      // bright blue
	[255, 85, 255, 13],     // bright magenta
	[85, 255, 255, 14],     // bright cyan
	[255, 255, 255, 15],    // bright white
];

function parseColor(colorStr) {
	if (!colorStr) return null;
	colorStr = colorStr.trim();
	// rgb(R, G, B)
	var rgbMatch = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
	if (rgbMatch) return [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])];
	// #RRGGBB
	var hexMatch = colorStr.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
	if (hexMatch) return [parseInt(hexMatch[1], 16), parseInt(hexMatch[2], 16), parseInt(hexMatch[3], 16)];
	// #RGB
	var hex3Match = colorStr.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
	if (hex3Match) return [parseInt(hex3Match[1] + hex3Match[1], 16), parseInt(hex3Match[2] + hex3Match[2], 16), parseInt(hex3Match[3] + hex3Match[3], 16)];
	return null;
}

function closestAnsiColor(rgb) {
	var best = 7;
	var bestDist = Infinity;
	for (var i = 0; i < ANSI_PALETTE.length; i++) {
		var p = ANSI_PALETTE[i];
		var dr = rgb[0] - p[0];
		var dg = rgb[1] - p[1];
		var db = rgb[2] - p[2];
		var dist = dr * dr + dg * dg + db * db;
		if (dist < bestDist) {
			bestDist = dist;
			best = p[3];
		}
	}
	return best;
}

function ansiColorCode(num) {
	if (num > 7) {
		return '\x1b[1;' + (num + 30 - 8) + 'm';
	}
	return '\x1b[0;' + (num + 30) + 'm';
}

var ANSI_RESET = '\x1b[0m';

// --- HTML to terminal text with ANSI color codes ---
// Converts TinyMCE HTML to plain text with ANSI escape sequences for colors.
function htmlToTerminalText(html) {
	if (!html || typeof html !== 'string') return '';

	var result = '';
	var i = 0;

	while (i < html.length) {
		if (html[i] === '<') {
			var tagEnd = html.indexOf('>', i);
			if (tagEnd === -1) break;
			var tagContent = html.substring(i + 1, tagEnd);
			var tagLower = tagContent.toLowerCase().trim();

			// Closing tags
			if (tagLower.startsWith('/')) {
				var closingTag = tagLower.substring(1).trim().split(/\s/)[0];
				if (closingTag === 'span') {
					result += ANSI_RESET;
				} else if (closingTag === 'p' || closingTag === 'div') {
					result += '\r\n';
				} else if (closingTag === 'li') {
					result += '\r\n';
				} else if (closingTag === 'strong' || closingTag === 'b') {
					// bold off — no simple ANSI for this without resetting color
				} else if (closingTag === 'em' || closingTag === 'i') {
					// italic off
				} else if (closingTag === 'u') {
					result += '\x1b[24m'; // underline off
				}
				i = tagEnd + 1;
				continue;
			}

			// Opening tags
			var tagName = tagLower.split(/[\s\/]/)[0];

			if (tagName === 'br') {
				result += '\r\n';
			} else if (tagName === 'p' || tagName === 'div') {
				// Opening p/div — add newline if we have content already
				if (result.length > 0 && !result.endsWith('\r\n') && !result.endsWith('\n')) {
					result += '\r\n';
				}
			} else if (tagName === 'li') {
				result += '  * ';
			} else if (tagName === 'strong' || tagName === 'b') {
				result += '\x1b[1m'; // bold
			} else if (tagName === 'u') {
				result += '\x1b[4m'; // underline
			} else if (tagName === 'span') {
				// Extract color from style attribute
				var styleMatch = tagContent.match(/style\s*=\s*"([^"]*)"/i);
				if (styleMatch) {
					var colorMatch = styleMatch[1].match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
					if (colorMatch) {
						var rgb = parseColor(colorMatch[1]);
						if (rgb) {
							var ansi = closestAnsiColor(rgb);
							result += ansiColorCode(ansi);
						}
					}
					var bgMatch = styleMatch[1].match(/(?:^|;)\s*background-color\s*:\s*([^;]+)/i);
					if (bgMatch) {
						var bgRgb = parseColor(bgMatch[1]);
						if (bgRgb) {
							var bgAnsi = closestAnsiColor(bgRgb);
							if (bgAnsi > 7) {
								result += '\x1b[1;' + (bgAnsi + 40 - 8) + 'm';
							} else {
								result += '\x1b[' + (bgAnsi + 40) + 'm';
							}
						}
					}
				}
			}

			i = tagEnd + 1;
			continue;
		}

		// Decode entities
		if (html[i] === '&') {
			var semiIdx = html.indexOf(';', i);
			if (semiIdx > i && semiIdx - i < 10) {
				var entity = html.substring(i, semiIdx + 1);
				if (entity === '&amp;') { result += '&'; i = semiIdx + 1; continue; }
				if (entity === '&lt;') { result += '<'; i = semiIdx + 1; continue; }
				if (entity === '&gt;') { result += '>'; i = semiIdx + 1; continue; }
				if (entity === '&quot;') { result += '"'; i = semiIdx + 1; continue; }
				if (entity === '&#39;') { result += "'"; i = semiIdx + 1; continue; }
				if (entity === '&nbsp;') { result += ' '; i = semiIdx + 1; continue; }
			}
		}

		result += html[i];
		i++;
	}

	// Clean up trailing whitespace, collapse excessive blank lines
	result = result.replace(/\r\n{3,}/g, '\r\n\r\n').trim();
	// Ensure reset at end
	if (result.includes('\x1b[')) result += ANSI_RESET;
	return result;
}

// --- Plain text (no ANSI) for storage/fallback ---
function htmlToPlainText(html) {
	if (!html || typeof html !== 'string') return '';
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<\/div>/gi, '\n')
		.replace(/<\/li>/gi, '\n')
		.replace(/<li[^>]*>/gi, '  * ')
		.replace(/<[^>]*>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// --- Announcement CRUD ---

async function getActiveAnnouncements(limit) {
	var lim = limit || 10;
	var rows = await postgres.query(
		'SELECT * FROM announcements WHERE active = true AND (publish_at IS NULL OR publish_at <= NOW()) AND (expire_at IS NULL OR expire_at > NOW()) ORDER BY pinned DESC, sort_order ASC, created_at DESC LIMIT $1',
		[lim]
	);
	return rows || [];
}

async function getAllAnnouncements() {
	var rows = await postgres.query(
		'SELECT * FROM announcements ORDER BY sort_order ASC, created_at DESC'
	);
	return rows || [];
}

async function updateSortOrder(orderedIds) {
	if (!orderedIds || orderedIds.length === 0) return;
	for (var i = 0; i < orderedIds.length; i++) {
		await postgres.write(
			'UPDATE announcements SET sort_order = $1, updated_at = NOW() WHERE id = $2',
			[i, parseInt(orderedIds[i])]
		);
	}
}

async function getAnnouncementById(id) {
	return await postgres.queryOne('SELECT * FROM announcements WHERE id = $1', [id]);
}

async function createAnnouncement(data) {
	var result = { status: false, errormessages: [], announcementId: null };

	var title = (data.title || '').trim();
	if (!title) {
		result.errormessages.push('Title is required');
		return result;
	}

	var bodyHtml = (data.body_html || '').trim();
	var bodyText = htmlToTerminalText(bodyHtml);

	var obj = {
		uuid: uuidv4(),
		title: title,
		body_text: bodyText || null,
		body_html: bodyHtml || null,
		author_id: data.author_id ? parseInt(data.author_id) : null,
		author_name: (data.author_name || '').trim() || null,
		pinned: data.pinned === 'true' || data.pinned === true || data.pinned === 'on',
		active: data.active === 'true' || data.active === true || data.active === 'on',
		publish_at: data.publish_at || null,
		expire_at: data.expire_at || null,
		sort_order: parseInt(data.sort_order) || 0,
		created_at: new Date(),
		updated_at: new Date()
	};

	var insertResult = await postgres.insertObject(obj, 'announcements');
	if (insertResult.status) {
		result.status = true;
		result.announcementId = insertResult.insertId;
	} else {
		result.errormessages.push('Database insert failed');
	}
	return result;
}

async function updateAnnouncement(id, data) {
	var result = { status: false, errormessages: [] };

	var title = (data.title || '').trim();
	if (!title) {
		result.errormessages.push('Title is required');
		return result;
	}

	var bodyHtml = (data.body_html || '').trim();
	var bodyText = htmlToTerminalText(bodyHtml);

	var obj = {
		title: title,
		body_text: bodyText || null,
		body_html: bodyHtml || null,
		pinned: data.pinned === 'true' || data.pinned === true || data.pinned === 'on',
		active: data.active === 'true' || data.active === true || data.active === 'on',
		publish_at: data.publish_at || null,
		expire_at: data.expire_at || null,
		sort_order: parseInt(data.sort_order) || 0,
		updated_at: new Date()
	};

	await postgres.updateById(id, obj, 'announcements');
	result.status = true;
	return result;
}

async function deleteAnnouncement(id) {
	await postgres.write('DELETE FROM announcements WHERE id = $1', [id]);
	return { status: true };
}

export {
	getActiveAnnouncements,
	getAllAnnouncements,
	updateSortOrder,
	getAnnouncementById,
	createAnnouncement,
	updateAnnouncement,
	deleteAnnouncement,
	htmlToTerminalText,
	htmlToPlainText
};
