/**
 * Batch subscribe: create local file areas for many filebone areatags at once.
 *
 * The filebone counterpart to echolistBatchSubscribe.js, and follows the same
 * convention as the models it sits on: fileEcholist.js mirrors
 * networkEcholist.js with different tables rather than sharing an abstraction.
 * The two batch paths differ enough to keep separate:
 *
 *   - file areas have no per-area backing tables (one shared file_entries),
 *     so an area is far cheaper here than on the message side
 *   - creating and mapping are two calls, not one: fileAreas.newArea() does not
 *     take a network, so fileNetworkAreas.addMapping() follows it
 *   - peer sync takes allowAll and enableAll in a single pass
 *   - there is no QWK conference number to allocate
 *   - there are extra settings: browse security, browse flags, and the
 *     max_age_days / max_files retention limits
 *
 * It still runs on the worker. A filebone can carry a few hundred areatags, and
 * each area creates a directory on disk and a scan pointer row per active user.
 *
 * Create-only, for the same reason as the message side: mapping an existing
 * local area onto an areatag is a per-area pairing decision.
 */

import * as postgres from '../middleware/db/postgres.js';
import * as fileAreas from '../models/fileAreas.js';
import * as fileEcholist from '../models/fileEcholist.js';
import * as fileNetworkAreas from '../models/fileNetworkAreas.js';
import * as filePeerSubscriptions from '../models/filePeerSubscriptions.js';
import * as notifications from '../models/notifications.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Shortcode derivation
// ---------------------------------------------------------------------------

/**
 * Derive a shortcode from an areatag, matching the single-area filebone
 * subscribe flow in the admin route so batch and single runs agree.
 */
function baseShortcode(areatag) {
	return String(areatag || '').toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 64);
}

/**
 * Resolve a unique shortcode, checking `file_areas` rather than
 * `message_areas`. Sanitising is lossy, so distinct areatags can collide with
 * each other or with an existing area; on collision append `_2`, `_3` and so
 * on, trimming the base so the result still fits in 64 characters.
 *
 * `taken` carries shortcodes claimed earlier in this run, not yet in the DB.
 * Returns null if nothing is free, which the caller reports as a skip.
 */
async function resolveShortcode(areatag, taken) {
	var base = baseShortcode(areatag);
	if (!base) return null;

	if (!taken.has(base)) {
		var free = await postgres.checkValueUnique('shortcode', base, 'file_areas');
		if (free) return base;
	}

	for (var n = 2; n <= 99; n++) {
		var suffix = '_' + n;
		var candidate = base.substring(0, 64 - suffix.length) + suffix;
		if (taken.has(candidate)) continue;
		var isFree = await postgres.checkValueUnique('shortcode', candidate, 'file_areas');
		if (isFree) return candidate;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/**
 * Work out what a batch would do, writing nothing.
 *
 * Exported so a dry run and the job itself can never disagree about which
 * shortcode an areatag gets. Returns { plan: [...], skipped: [...] }.
 */
async function planBatch(networkId, areatags) {
	var rows = await fileEcholist.getAreasAcrossNetwork(networkId);
	var byTag = {};
	for (var row of (rows || [])) {
		byTag[String(row.areatag).toUpperCase()] = row;
	}

	var plan = [];
	var skipped = [];
	var taken = new Set();
	var seen = new Set();

	for (var rawTag of (areatags || [])) {
		var tag = String(rawTag || '').trim();
		if (!tag) continue;

		// An areatag is unique per network, so a repeat in the submitted list is
		// a duplicated checkbox, not a second area. Without this the collision
		// suffixing below would create FOO and FOO_2 for the same areatag.
		var tagKey = tag.toUpperCase();
		if (seen.has(tagKey)) continue;
		seen.add(tagKey);

		var known = byTag[tagKey];
		if (!known) {
			skipped.push({ areatag: tag, reason: 'not on any filebone for this network' });
			continue;
		}
		if (known.local_area_id) {
			skipped.push({ areatag: tag, reason: 'already carried' });
			continue;
		}

		var shortcode = await resolveShortcode(tag, taken);
		if (!shortcode) {
			skipped.push({ areatag: tag, reason: 'no free shortcode after 99 attempts' });
			continue;
		}

		taken.add(shortcode);
		plan.push({
			areatag: known.areatag,
			shortcode: shortcode,
			description: known.description || known.areatag,
			renamed: shortcode !== baseShortcode(tag)
		});
	}

	return { plan: plan, skipped: skipped };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Execute a batch subscribe.
 *
 * `opts` carries the settings chosen once for the whole batch: groupshortcode,
 * browsesecurity, readsecurity, postsecurity, newscan_default, the six flag
 * lists, max_age_days / max_files, and the allowPeers / enablePeers toggles.
 *
 * `sub_dir` is deliberately not settable per batch: fileAreas.newArea() defaults
 * it to the lowercased shortcode, which gives every area its own directory. A
 * single shared value would put every area in one directory.
 */
async function runBatch(networkId, areatags, opts) {
	opts = opts || {};
	networkId = parseInt(networkId);

	var planned = await planBatch(networkId, areatags);
	var created = [];
	var failed = [];

	var syncOpts = {};
	if (opts.allowPeers)  syncOpts.allowAll = true;
	if (opts.enablePeers) syncOpts.enableAll = true;

	alogger.writeAlog(2, '[fileboneBatch] network ' + networkId + ': ' +
		planned.plan.length + ' to create, ' + planned.skipped.length + ' skipped', 'cyan');

	for (var item of planned.plan) {
		try {
			var formObj = {
				groupshortcode:    opts.groupshortcode,
				name:              item.areatag,
				description:       item.description,
				shortcode:         item.shortcode,
				sub_dir:           '',   // defaults to the shortcode, one directory per area
				browsesecurity:    opts.browsesecurity,
				readsecurity:      opts.readsecurity,
				postsecurity:      opts.postsecurity,
				newscan_default:   opts.newscan_default,
				max_age_days:      opts.max_age_days || null,
				max_files:         opts.max_files || null,
				browse_perm_flags: opts.browse_perm_flags,
				browse_rest_flags: opts.browse_rest_flags,
				read_perm_flags:   opts.read_perm_flags,
				read_rest_flags:   opts.read_rest_flags,
				post_perm_flags:   opts.post_perm_flags,
				post_rest_flags:   opts.post_rest_flags,
				createdByUUID:     opts.createdByUUID || '',
				createdByName:     opts.createdByName || ''
			};

			var result = await fileAreas.newArea(formObj);
			if (!result.status) {
				failed.push({
					areatag: item.areatag,
					shortcode: item.shortcode,
					reason: (result.errormessages || []).join(', ') || 'unknown error'
				});
				continue;
			}

			// Unlike the message side, creating does not map. If this fails the
			// area exists but is not on the network, so say so precisely rather
			// than reporting a clean success.
			var mapResult = await fileNetworkAreas.addMapping(networkId, result.insertId, item.areatag, {
				createdByUUID: opts.createdByUUID || '',
				createdByName: opts.createdByName || ''
			});
			if (!mapResult.status) {
				failed.push({
					areatag: item.areatag,
					shortcode: item.shortcode,
					reason: 'area created but network mapping failed: ' +
						((mapResult.errormessages || []).join(', ') || 'unknown error')
				});
				continue;
			}

			if (opts.allowPeers || opts.enablePeers) {
				await filePeerSubscriptions.syncFileAreaToConnections(networkId, result.insertId, syncOpts);
			}

			created.push({ areatag: item.areatag, shortcode: result.shortcode, renamed: item.renamed });
		} catch (err) {
			failed.push({
				areatag: item.areatag,
				shortcode: item.shortcode,
				reason: err.message || String(err)
			});
			alogger.writeAlog(2, '[fileboneBatch] ' + item.areatag + ' failed: ' +
				(err.message || err), 'redbright');
		}
	}

	var summary = {
		networkId: networkId,
		created: created,
		failed: failed,
		skipped: planned.skipped
	};

	await notifySysop(summary);

	alogger.writeAlog(1, '[fileboneBatch] done: ' + created.length + ' created, ' +
		failed.length + ' failed, ' + planned.skipped.length + ' skipped',
		failed.length ? 'yellowbright' : 'greenbright', true);

	return summary;
}

/**
 * Report the run. A batch can take a while, so whoever started it has almost
 * certainly navigated away by the time it finishes.
 */
async function notifySysop(summary) {
	try {
		var parts = [summary.created.length + ' file area(s) created'];
		if (summary.failed.length) parts.push(summary.failed.length + ' failed');
		if (summary.skipped.length) parts.push(summary.skipped.length + ' skipped');

		var body = parts.join(', ') + '.';

		var renamed = summary.created.filter(function (c) { return c.renamed; });
		if (renamed.length) {
			body += '\n\n' + renamed.length + ' shortcode(s) were suffixed to avoid a collision: ' +
				renamed.slice(0, 10).map(function (c) { return c.areatag + ' -> ' + c.shortcode; }).join(', ') +
				(renamed.length > 10 ? ', ...' : '');
		}
		if (summary.failed.length) {
			body += '\n\nFailed: ' + summary.failed.slice(0, 10).map(function (f) {
				return f.areatag + ' (' + f.reason + ')';
			}).join('; ') + (summary.failed.length > 10 ? ', ...' : '');
		}
		if (summary.skipped.length) {
			body += '\n\nSkipped: ' + summary.skipped.slice(0, 10).map(function (s) {
				return s.areatag + ' (' + s.reason + ')';
			}).join('; ') + (summary.skipped.length > 10 ? ', ...' : '');
		}

		await notifications.createSysop(
			'filebone_batch_subscribe',
			'Filebone batch subscribe finished: ' + summary.created.length + ' area(s) created',
			body,
			{
				icon: summary.failed.length ? 'exclamation-triangle' : 'check-circle',
				severity: summary.failed.length ? 'warning' : 'info',
				link: '/admin/filebone/' + summary.networkId + '/combined'
			}
		);
	} catch (err) {
		alogger.writeAlog(3, '[fileboneBatch] notification failed: ' + (err.message || err), 'yellow');
	}
}

export { planBatch, runBatch, baseShortcode };
