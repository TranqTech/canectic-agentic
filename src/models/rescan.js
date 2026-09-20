/**
 * Rescan: rewinding a peer's outbound pointer so held mail is sent again.
 *
 * AreaFix and FileFix share the command grammar, and nothing else. The
 * mechanisms are genuinely different and a single executor would only hide
 * that:
 *
 *   message areas  peer_area_subscriptions.msg_idx is a high water mark, so a
 *                  rescan rewinds a pointer
 *   file areas     file_peer_subscriptions has no pointer at all. Distribution
 *                  is per file, per peer, in file_distribution, so a rescan
 *                  re-queues rows to 'pending'
 *
 * So the parser is shared and the two executors are not.
 *
 * Both executors return { lines, ... counts }. `lines` is the netmail response
 * body the fixers send back; the counts exist because the admin UI needs a
 * one-line summary and flash messages render as plain text, so it cannot just
 * paste the netmail body in.
 *
 * Grammar, accepted by both:
 *
 *   %RESCAN                     every subscribed area, default window
 *   %RESCAN ALL                 same. `*` is accepted too
 *   %RESCAN AREATAG             one area, default window
 *   %RESCAN AREATAG 30          one area, last 30 days
 *   %RESCAN ALL /FULL           everything still held, all areas
 *   %RESCAN AREATAG -FULL       same, dash form accepted
 *
 * Bare %RESCAN meaning "all" is the form SBBSecho, Mystic and Squish all
 * implement, so a sysop who sends it should not get an unknown-command reply.
 *
 * /FULL is the documented flag spelling. -FULL is accepted because it is a
 * natural thing to type, but note a leading dash already means unsubscribe in
 * the AreaFix grammar, so -FULL is only safe on the same line as %RESCAN. The
 * slash form has no such ambiguity.
 *
 * Defaulting to a window rather than everything is deliberate. A full rescan of
 * a busy area pushes thousands of messages down a link that did not ask for
 * them one at a time, which is antisocial on a shared network.
 */

import * as postgres from '../middleware/db/postgres.js';
import appConfig from '../config/appConfig.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Parse the argument tail of a %RESCAN line.
 *
 * Takes the raw line so flags and counts survive; _parseCommands only keeps
 * the command word itself.
 *
 * Returns { areatag, full, days, error }. `areatag` is null for "all areas".
 */
function parseRescanRequest(rawLine, defaultDays) {
	var out = { areatag: null, full: false, days: defaultDays, error: null };

	var tail = String(rawLine || '').trim();
	if (tail.startsWith('%')) tail = tail.substring(1);
	// drop the command word itself
	tail = tail.replace(/^\S+\s*/, '').trim();

	if (!tail) return out;   // bare %RESCAN: all areas, default window

	var parts = tail.split(/\s+/);
	for (var part of parts) {
		var token = part.trim();
		if (!token) continue;

		var upper = token.toUpperCase();

		if (upper === '/FULL' || upper === '-FULL' || upper === 'FULL') {
			out.full = true;
			continue;
		}

		if (/^\d+$/.test(token)) {
			var n = parseInt(token, 10);
			if (n <= 0) {
				out.error = 'day count must be greater than zero';
				return out;
			}
			out.days = n;
			continue;
		}

		if (upper === 'ALL' || upper === '*') {
			out.areatag = null;
			continue;
		}

		if (out.areatag === null && /^[A-Z0-9._-]+$/.test(upper)) {
			out.areatag = upper;
			continue;
		}

		out.error = 'unrecognised argument "' + token + '"';
		return out;
	}

	return out;
}

// ---------------------------------------------------------------------------
// Pointer computation
// ---------------------------------------------------------------------------

/**
 * Work out the pointer that replays everything newer than `days` days.
 *
 * The subtlety worth spelling out: msg_idx is a message **id**, the window is a
 * **date**, and the two do not move together. An imported message can carry a
 * high id and a very old date, so taking MAX(id) of everything older than the
 * cutoff can land above messages that are inside the window but have lower ids,
 * silently skipping exactly the mail the rescan was asked for.
 *
 * So anchor on the low end instead: the oldest id inside the window, minus one.
 * That guarantees the whole window is replayed, at the cost of possibly
 * re-sending a few older messages. For a rescan, sending slightly more than
 * asked is the right direction to err.
 *
 * Returns one below the oldest in-window id, so the whole window replays. That
 * is 0 only when the oldest in-window row happens to be id 1; ids are serial
 * and do not restart, so do not expect 0 to mean "everything".
 *
 * When nothing falls inside the window it returns the current head, making the
 * rescan a no-op rather than an accidental full replay.
 */
async function pointerForWindow(msgTable, days, dateColumn) {
	var col = dateColumn || 'COALESCE(system_time, created_at)';
	var row = await postgres.queryOne(
		'SELECT COALESCE(MIN(id), 0) AS first_in_window FROM ' + msgTable +
		' WHERE ' + col + ' >= NOW() - ($1::text || \' days\')::interval',
		[String(days)]
	);
	var firstIn = row ? parseInt(row.first_in_window) : 0;
	if (!firstIn) {
		// Nothing inside the window. Leave the pointer at the head so the
		// rescan is a no-op rather than replaying everything by accident.
		var headRow = await postgres.queryOne(
			'SELECT COALESCE(MAX(id), 0) AS head FROM ' + msgTable);
		return headRow ? parseInt(headRow.head) : 0;
	}
	return firstIn - 1;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Message-area rescan: rewind msg_idx so held mail is sent again.
 */
async function rescanMessageAreas(opts) {
	var lines = [];

	if (!appConfig.getBoolean('areafix_rescan_enabled', true)) {
		return { lines: ['  Rescan is disabled on this system. Contact the sysop.'],
		         disabled: true, rewound: 0, areas: 0, days: 0, full: false };
	}

	var windowed = resolveWindow(opts);
	var days = windowed.days;

	var sql =
		'SELECT pas.id, pas.area_id, pas.msg_idx, na.areatag, ma.shortcode ' +
		'FROM peer_area_subscriptions pas ' +
		'JOIN network_areas na ON na.area_id = pas.area_id AND na.network_id = $1 ' +
		'JOIN message_areas ma ON ma.id = pas.area_id ' +
		'WHERE pas.peer_connection_id = $2 AND pas.enabled = true AND na.active = true';
	var params = [opts.networkId, opts.connectionId];
	if (opts.areatag) { sql += ' AND UPPER(na.areatag) = $3'; params.push(opts.areatag); }
	sql += ' ORDER BY na.areatag ASC';

	var subs = await postgres.query(sql, params);
	if (!subs || subs.length === 0) {
		return {
			lines: [opts.areatag
				? '  ' + opts.areatag + ': not subscribed, nothing to rescan'
				: '  No subscribed areas to rescan'],
			rewound: 0, areas: 0, days: days, full: !!opts.full
		};
	}

	var rewound = 0;
	for (var sub of subs) {
		try {
			var msgTable = 'mb_' + String(sub.shortcode).toLowerCase() + '_msgs';
			var newIdx = opts.full ? 0 : await pointerForWindow(msgTable, days);

			// A rescan only ever moves a pointer backwards. Asking for 60 days
			// while already further behind than that must not skip mail.
			var current = parseInt(sub.msg_idx) || 0;
			if (newIdx >= current) {
				lines.push('  ' + sub.areatag + ': already at or behind that point, unchanged');
				continue;
			}

			await postgres.write(
				'UPDATE peer_area_subscriptions SET msg_idx = $1, updated_at = NOW() WHERE id = $2',
				[newIdx, sub.id]
			);
			rewound++;
			lines.push('  ' + sub.areatag + ': pointer ' + current + ' -> ' + newIdx);
		} catch (err) {
			lines.push('  ' + sub.areatag + ': failed (' + (err.message || err) + ')');
			alogger.writeAlog(2, 'AreaFix rescan failed for ' + sub.areatag + ': ' +
				(err.message || err), 'redbright');
		}
	}

	lines.unshift(headerFor(opts.full, days, rewound, 'area'));
	appendCaveats(lines, windowed.capped, windowed.maxDays, true);

	alogger.writeAlog(2, 'AreaFix: rescan rewound ' + rewound + ' area(s) for connection ' +
		opts.connectionId + (opts.full ? ' (full)' : ' (' + days + ' days)'), 'cyan');
	return { lines: lines, rewound: rewound, areas: subs.length, days: days, full: !!opts.full,
	         capped: windowed.capped, maxDays: windowed.maxDays };
}

/**
 * File-area rescan: re-queue distribution rows.
 *
 * There is no pointer to rewind here. file_distribution holds one row per file
 * per peer, so a rescan resets the rows for files inside the window back to
 * 'pending' and creates them where a file was never queued for this peer at
 * all. The outbound TIC pass picks them up from there.
 */
async function rescanFileAreas(opts) {
	var lines = [];

	if (!appConfig.getBoolean('areafix_rescan_enabled', true)) {
		return { lines: ['  Rescan is disabled on this system. Contact the sysop.'],
		         disabled: true, queued: 0, areas: 0, days: 0, full: false };
	}

	var windowed = resolveWindow(opts);
	var days = windowed.days;

	var sql =
		'SELECT fps.id, fps.file_area_id, fna.areatag, fa.shortcode ' +
		'FROM file_peer_subscriptions fps ' +
		'JOIN file_network_areas fna ON fna.area_id = fps.file_area_id AND fna.network_id = $1 ' +
		'JOIN file_areas fa ON fa.id = fps.file_area_id ' +
		'WHERE fps.peer_connection_id = $2 AND fps.enabled = true AND fna.active = true';
	var params = [opts.networkId, opts.connectionId];
	if (opts.areatag) { sql += ' AND UPPER(fna.areatag) = $3'; params.push(opts.areatag); }
	sql += ' ORDER BY fna.areatag ASC';

	var subs = await postgres.query(sql, params);
	if (!subs || subs.length === 0) {
		return {
			lines: [opts.areatag
				? '  ' + opts.areatag + ': not subscribed, nothing to rescan'
				: '  No subscribed file areas to rescan'],
			queued: 0, areas: 0, days: days, full: !!opts.full
		};
	}

	var queuedTotal = 0;
	var areasTouched = 0;
	for (var sub of subs) {
		try {
			var where = 'fe.area_id = $1 AND fe.active = true';
			var qp = [sub.file_area_id];
			if (!opts.full) {
				where += ' AND fe.upload_date >= NOW() - ($2::text || \' days\')::interval';
				qp.push(String(days));
			}

			var files = await postgres.query(
				'SELECT fe.id FROM file_entries fe WHERE ' + where, qp);
			if (!files || files.length === 0) {
				lines.push('  ' + sub.areatag + ': no files in that window');
				continue;
			}

			var ids = files.map(function (f) { return parseInt(f.id); });

			// Reset anything already queued or sent back to pending.
			await postgres.write(
				'UPDATE file_distribution SET status = $1, attempts = 0, error_message = NULL ' +
				'WHERE peer_connection_id = $2 AND file_entry_id = ANY($3::int[])',
				['pending', opts.connectionId, ids]
			);

			// Create rows for files this peer was never queued for.
			var existing = await postgres.query(
				'SELECT file_entry_id FROM file_distribution ' +
				'WHERE peer_connection_id = $1 AND file_entry_id = ANY($2::int[])',
				[opts.connectionId, ids]
			);
			var have = new Set((existing || []).map(function (e) { return parseInt(e.file_entry_id); }));
			for (var fid of ids) {
				if (have.has(fid)) continue;
				await postgres.insertObject({
					file_entry_id: fid, peer_connection_id: opts.connectionId,
					status: 'pending', attempts: 0, created_at: new Date()
				}, 'file_distribution');
			}

			queuedTotal += ids.length;
			areasTouched++;
			lines.push('  ' + sub.areatag + ': ' + ids.length + ' file(s) queued');
		} catch (err) {
			lines.push('  ' + sub.areatag + ': failed (' + (err.message || err) + ')');
			alogger.writeAlog(2, 'FileFix rescan failed for ' + sub.areatag + ': ' +
				(err.message || err), 'redbright');
		}
	}

	lines.unshift(headerFor(opts.full, days, areasTouched, 'file area') +
		' (' + queuedTotal + ' file(s))');
	appendCaveats(lines, windowed.capped, windowed.maxDays, false);

	alogger.writeAlog(2, 'FileFix: rescan queued ' + queuedTotal + ' file(s) across ' +
		areasTouched + ' area(s) for connection ' + opts.connectionId, 'cyan');

	// A file rescan only writes pending rows; something has to stage them.
	// Unlike a message rescan, which rewinds a pointer the next export scan
	// reads, these rows are inert until tic:outbound runs, so a downlink's
	// %RESCAN used to get a cheerful reply and no files.
	if (queuedTotal > 0) {
		try {
			var jobsMod = await import('../queues/jobs.js');
			await jobsMod.enqueueTicOutbound();
		} catch (qErr) {
			alogger.writeAlog(3, 'FileFix: rescan could not signal tic:outbound: ' +
				(qErr.message || qErr), 'yellow');
		}
	}

	return { lines: lines, queued: queuedTotal, areas: areasTouched, days: days,
	         full: !!opts.full, capped: windowed.capped, maxDays: windowed.maxDays };
}

// ---------------------------------------------------------------------------
// shared response shaping
// ---------------------------------------------------------------------------

function resolveWindow(opts) {
	var days = opts.days;
	var maxDays = appConfig.getNumber('areafix_rescan_max_days', 0);
	var capped = false;
	if (!opts.full && maxDays > 0 && days > maxDays) {
		days = maxDays;
		capped = true;
	}
	return { days: days, capped: capped, maxDays: maxDays };
}

function headerFor(full, days, count, noun) {
	return full
		? 'Rescan (full) queued for ' + count + ' ' + noun + '(s):'
		: 'Rescan (last ' + days + ' days) queued for ' + count + ' ' + noun + '(s):';
}

// Both of these surprise people, so say them rather than let a downlink wonder
// why the numbers do not match what was asked for.
function appendCaveats(lines, capped, maxDays, isMessages) {
	if (capped) {
		lines.push('');
		lines.push('  Window reduced to the system maximum of ' + maxDays + ' days.');
	}
	lines.push('');
	lines.push('  Only content still held is replayed. Areas with a retention');
	lines.push('  limit hold less than the window you asked for.');
	if (isMessages) {
		lines.push('  Imported message base history is never replayed.');
	}
	lines.push('  Delivery happens on the next toss cycle.');
}

export { parseRescanRequest, pointerForWindow, rescanMessageAreas, rescanFileAreas };
