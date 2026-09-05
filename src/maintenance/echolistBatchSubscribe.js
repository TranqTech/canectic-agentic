/**
 * Batch subscribe: create local message areas for many echolist areatags at once.
 *
 * Runs on the worker, off the maintenance queue, because each area is expensive:
 * a uniqueness check, a QWK conference number allocation, an INSERT, two backing
 * tables (mb_<shortcode>_msgs and mb_<shortcode>_threads), a scan pointer row per
 * active user, the network mapping, and a peer subscription sync. A BACKBONE-sized
 * list is a couple of hundred areas, which is several hundred CREATE TABLEs. That
 * is far past what an HTTP request should hold open.
 *
 * Create-only by design. Mapping an existing local area onto an areatag is a
 * per-area pairing decision and does not generalise to a batch.
 *
 * Areas are processed one at a time and failures are isolated: a bad areatag
 * records an error and the run continues. The caller gets a per-area result list
 * plus a sysop notification summarising the run.
 */

import * as postgres from '../middleware/db/postgres.js';
import * as msgAreas from '../models/msgAreas.js';
import * as networkEcholist from '../models/networkEcholist.js';
import * as peerAreaSubscriptions from '../models/peerAreaSubscriptions.js';
import * as notifications from '../models/notifications.js';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Shortcode derivation
// ---------------------------------------------------------------------------

/**
 * Derive a shortcode from an areatag, matching the single-area subscribe flow
 * in the admin route so batch and single runs produce identical names.
 */
function baseShortcode(areatag) {
	return String(areatag || '').toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 64);
}

/**
 * Resolve a unique shortcode for an areatag.
 *
 * Sanitising is lossy: `FSX.GEN` and `FSX-GEN` both become `FSX_GEN`, and
 * anything past 64 characters is truncated, so distinct areatags can collide
 * with each other or with an existing area. On collision we append `_2`, `_3`
 * and so on, trimming the base so the result still fits in 64 characters.
 *
 * `taken` carries shortcodes claimed earlier in this same run, which are not in
 * the database yet at the time we check.
 *
 * Returns null if no free shortcode is found, which the caller reports as a
 * skip rather than guessing.
 */
async function resolveShortcode(areatag, taken) {
	var base = baseShortcode(areatag);
	if (!base) return null;

	if (!taken.has(base)) {
		var free = await postgres.checkValueUnique('shortcode', base, 'message_areas');
		if (free) return base;
	}

	for (var n = 2; n <= 99; n++) {
		var suffix = '_' + n;
		var candidate = base.substring(0, 64 - suffix.length) + suffix;
		if (taken.has(candidate)) continue;
		var isFree = await postgres.checkValueUnique('shortcode', candidate, 'message_areas');
		if (isFree) return candidate;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/**
 * Work out what a batch would do, without writing anything.
 *
 * Used by the admin page to show conflicts before the sysop commits, and by
 * the job itself so the two never disagree about which shortcode an areatag
 * gets. Returns { plan: [...], skipped: [...] }.
 */
async function planBatch(networkId, areatags) {
	var rows = await networkEcholist.getAreasAcrossNetwork(networkId);
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

		// Areatags are unique per network, so a repeat in the submitted list is
		// a duplicated checkbox, not a second area. Without this guard the
		// collision suffixing below would happily create FOO and FOO_2 both
		// mapped to the same areatag.
		var tagKey = tag.toUpperCase();
		if (seen.has(tagKey)) continue;
		seen.add(tagKey);

		var known = byTag[tagKey];
		if (!known) {
			skipped.push({ areatag: tag, reason: 'not on any echolist for this network' });
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
 * `opts` carries the shared area settings chosen once for the whole batch:
 * groupshortcode, readsecurity, postsecurity, post_as, newscan_default, the
 * four flag lists, and the allowPeers / enablePeers toggles.
 */
async function runBatch(networkId, areatags, opts) {
	opts = opts || {};
	networkId = parseInt(networkId);

	var planned = await planBatch(networkId, areatags);
	var created = [];
	var failed = [];

	alogger.writeAlog(2, '[batchSubscribe] network ' + networkId + ': ' +
		planned.plan.length + ' to create, ' + planned.skipped.length + ' skipped', 'cyan');

	for (var item of planned.plan) {
		try {
			var formObj = {
				groupshortcode:  opts.groupshortcode,
				name:            item.areatag,
				description:     item.description,
				shortcode:       item.shortcode,
				readsecurity:    opts.readsecurity,
				postsecurity:    opts.postsecurity,
				post_as:         opts.post_as || 'realname',
				newscan_default: opts.newscan_default,
				read_perm_flags: opts.read_perm_flags,
				read_rest_flags: opts.read_rest_flags,
				post_perm_flags: opts.post_perm_flags,
				post_rest_flags: opts.post_rest_flags,
				network_id:      networkId,
				areatag:         item.areatag,
				createdByUUID:   opts.createdByUUID || '',
				createdByName:   opts.createdByName || ''
			};

			var result = await msgAreas.newArea(formObj);
			if (!result.status) {
				failed.push({
					areatag: item.areatag,
					shortcode: item.shortcode,
					reason: (result.errormessages || []).join(', ') || 'unknown error'
				});
				continue;
			}

			// newArea applies allowAll itself when mapping to a network, but
			// enabling needs an explicit pass, the same as the single-area flow.
			if (opts.enablePeers) {
				var area = await msgAreas.getAreaByShortcode(result.shortcode);
				if (area) {
					await peerAreaSubscriptions.syncNetworkAreaToConnections(
						networkId, area.id, { enableAll: true }
					);
				}
			}

			created.push({ areatag: item.areatag, shortcode: result.shortcode, renamed: item.renamed });
		} catch (err) {
			failed.push({
				areatag: item.areatag,
				shortcode: item.shortcode,
				reason: err.message || String(err)
			});
			alogger.writeAlog(2, '[batchSubscribe] ' + item.areatag + ' failed: ' +
				(err.message || err), 'redbright');
		}
	}

	var summary = {
		networkId: networkId,
		created: created,
		failed: failed,
		skipped: planned.skipped
	};

	await notifySysop(summary, opts);

	alogger.writeAlog(1, '[batchSubscribe] done: ' + created.length + ' created, ' +
		failed.length + ' failed, ' + planned.skipped.length + ' skipped',
		failed.length ? 'yellowbright' : 'greenbright', true);

	return summary;
}

/**
 * Tell the sysop how the run went. A batch can take minutes, so whoever
 * started it has almost certainly navigated away by the time it lands.
 */
async function notifySysop(summary, opts) {
	try {
		var parts = [summary.created.length + ' area(s) created'];
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
			'echolist_batch_subscribe',
			'Batch subscribe finished: ' + summary.created.length + ' area(s) created',
			body,
			{
				icon: summary.failed.length ? 'exclamation-triangle' : 'check-circle',
				severity: summary.failed.length ? 'warning' : 'info',
				link: '/admin/echolist/' + summary.networkId + '/combined'
			}
		);
	} catch (err) {
		alogger.writeAlog(3, '[batchSubscribe] notification failed: ' + (err.message || err), 'yellow');
	}
}

export { planBatch, runBatch, baseShortcode };
