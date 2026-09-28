// userActivity.js -- a local user's post and upload counts, and the message
// template events they drive.
//
// user_first_message_post, user_nth_post, user_first_file_upload and
// user_nth_upload were seeded as built-in events from the start, but users had
// no post or upload counter and nothing fired them (#82). The counters are
// users.post_count and users.upload_count: incremented here, at the two choke
// points (messages.startNewThread / replyToThread for a post by a local user,
// fileEntries.createEntry for an entry with an uploader), and backfilled once
// by db/migrations/0009-user-activity-counts.js.
//
// As with user_nth_login, the nth event fires on every post or upload with the
// new count; a template chooses its milestones with conditions.nth_count.
//
// Nothing here may fail a post or an upload: a counter or template error is
// logged and swallowed.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';

var _fireOverride = null;

// Tests only: capture the events instead of running templates.
function setFireForTests(fn) {
	_fireOverride = fn || null;
}

async function fire(code, userId, event) {
	if (_fireOverride) return _fireOverride(code, userId, event);
	var tmpl = await import('./messageTemplates.js');
	await tmpl.fireEvent(code, userId, { event: event });
}

/**
 * A local user posted a message.
 * @param {number} userId
 * @param {object} info { area, subject }
 * @returns {Promise<number|null>} the new post count, or null if not counted
 */
async function recordPost(userId, info) {
	var id = parseInt(userId);
	if (!id || id <= 0) return null;
	try {
		var row = await postgres.queryOne(
			'UPDATE users SET post_count = COALESCE(post_count, 0) + 1 WHERE id = $1 RETURNING post_count', [id]);
		if (!row) return null;
		var count = parseInt(row.post_count);
		var i = info || {};
		if (count === 1) {
			await fire('user_first_message_post', id, { area_shortcode: i.area || '', subject: i.subject || '', post_count: 1 });
		}
		await fire('user_nth_post', id, { post_count: count, area_shortcode: i.area || '' });
		return count;
	} catch (err) {
		alogger.writeAlog(3, 'userActivity: could not record a post for user ' + id + ': ' + (err.message || err), 'yellow');
		return null;
	}
}

/**
 * A local user uploaded a file. Uploads are recorded by uploader uuid.
 * @param {string} userUuid
 * @param {object} info { filename, area }
 * @returns {Promise<number|null>} the new upload count, or null if not counted
 */
async function recordUpload(userUuid, info) {
	if (!userUuid) return null;
	try {
		var row = await postgres.queryOne(
			'UPDATE users SET upload_count = COALESCE(upload_count, 0) + 1 WHERE uuid = $1 RETURNING id, upload_count',
			[String(userUuid)]);
		if (!row) return null;
		var count = parseInt(row.upload_count);
		var i = info || {};
		if (count === 1) {
			await fire('user_first_file_upload', row.id, { filename: i.filename || '', area_shortcode: i.area || '', upload_count: 1 });
		}
		await fire('user_nth_upload', row.id, { upload_count: count, filename: i.filename || '', area_shortcode: i.area || '' });
		return count;
	} catch (err) {
		alogger.writeAlog(3, 'userActivity: could not record an upload for ' + userUuid + ': ' + (err.message || err), 'yellow');
		return null;
	}
}

/**
 * What each user's post_count should start at, from tallies of the messages
 * already held. Pure; the migration that backfills does the counting.
 *
 * Posts are attributed by author id where a message has one (every post from
 * #82 on), and otherwise by From name, since before #82 no local post
 * recorded its author: the From is the username, or the full name in an area
 * set to post as real names. Only messages posted on this board are tallied,
 * so a user elsewhere with the same name is not counted. Two local users who
 * share a full name are both credited with its posts; that is the known limit
 * of a best-effort count.
 *
 * users:  [{ id, username, fullname }]
 * byId:   { userId: count }         messages carrying user_id
 * byName: { lowercased name: count } messages without one
 * returns { userId: count }
 */
function backfillPostCounts(users, byId, byName) {
	var out = {};
	for (var u of users || []) {
		var names = new Set();
		if (u.username) names.add(String(u.username).trim().toLowerCase());
		if (u.fullname && String(u.fullname).trim()) names.add(String(u.fullname).trim().toLowerCase());
		var n = (byId && byId[u.id]) || 0;
		for (var name of names) n += (byName && byName[name]) || 0;
		out[u.id] = n;
	}
	return out;
}

export { recordPost, recordUpload, backfillPostCounts, setFireForTests };
