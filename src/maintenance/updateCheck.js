// updateCheck.js -- the daily "is there a newer Canectic" job.
//
// Opt-in and off by default. An outbound request from a sysop's box should be
// something they turned on, not something they have to discover and turn off.
// It resolves an index, compares, records the result and raises a notification.
// It never downloads an artifact and never applies anything: that is phase 6.
//
// No telemetry. The request is a plain GET for a static JSON document, carrying
// no query string, no identifier and no version. A server logging it learns an
// IP address asked for a file, which is what any static host learns about any
// fetch, and nothing about who or what asked.
//
// Over FTN there is no outbound request at all. The TIC tosser has already
// filed the artifact in a file area, so the check is a database query and a
// read of CANECTIC.ID out of an archive that is already on this disk.
//
// The impure half. Every rule that can be got backwards lives in
// src/release/updateVerdict.js, which is pure and tested; this fetches, writes
// and notifies.

import appConfig from '../config/appConfig.js';
import * as alogger from '../utils/alogger.js';
import * as systeminfo from '../utils/systeminfo.js';
import * as updateChecks from '../models/updateChecks.js';
import * as notifications from '../models/notifications.js';
import { appliedIds } from './migrationLedger.js';
import { parseIndex, indexName } from '../release/releaseIndex.js';
import {
	evaluate, shouldNotify, notificationFor, channelsToCheck, VERDICT_UNKNOWN
} from '../release/updateVerdict.js';
import { buildChannelIndex } from './ftnReleaseSource.js';

var FETCH_TIMEOUT_MS = 20000;
var MAX_INDEX_BYTES = 4 * 1024 * 1024;

var NOTIFICATION_TYPE = 'update_available';

/** Join a configured base URL with an index filename, tolerating a missing slash. */
function indexUrl(base, channel) {
	var b = String(base || '').trim();
	if (!b) return null;
	if (b.charAt(b.length - 1) !== '/') b += '/';
	return b + indexName(channel);
}

/**
 * Fetch and parse one channel index.
 *
 * A 404 is not an error worth shouting about: a channel with nothing published
 * has no index, and treating that as a failure would make a stable-only project
 * look broken to everyone on development. It comes back as null, which reads as
 * "unknown" in the verdict.
 */
async function fetchIndex(url) {
	var controller = new AbortController();
	var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
	try {
		var res = await fetch(url, {
			signal: controller.signal,
			redirect: 'follow',
			headers: { 'Accept': 'application/json' }
		});
		if (res.status === 404) return { index: null, missing: true };
		if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);

		var text = await res.text();
		if (text.length > MAX_INDEX_BYTES) {
			throw new Error('index at ' + url + ' is larger than ' + MAX_INDEX_BYTES + ' bytes');
		}
		return { index: parseIndex(text), missing: false };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Combine what two transports found for one channel.
 *
 * HTTP entries win a tie on version, because only they carry the PUBLISHED
 * checksum: the FTN copy of a release can be verified as unchanged since it
 * arrived but not as the file the maintainer built. When a version is only on
 * the file echo, its entry is used as it stands and the staging step is told it
 * has no published checksum to check against.
 */
function mergeIndexes(channel, fromHttp, fromFtn) {
	if (!fromHttp && !fromFtn) return null;
	if (!fromFtn) return fromHttp;
	if (!fromHttp) return fromFtn;

	var seen = new Set();
	var releases = [];
	for (var r of (fromHttp.releases || [])) { seen.add(r.version); releases.push(r); }
	for (var f of (fromFtn.releases || [])) { if (!seen.has(f.version)) releases.push(f); }

	// Withdrawals are only ever published over HTTP; the file echo has no index.
	return {
		index_version: 1, channel: channel, updated: new Date().toISOString(),
		releases: releases, withdrawn: (fromHttp && fromHttp.withdrawn) || []
	};
}

/**
 * Run one check.
 *
 * @param {object} [opts]
 * @param {string} [opts.source]  'schedule' or 'manual'
 * @param {boolean} [opts.force]  run even when the check is disabled, which is
 *                                what a sysop pressing Check now means: they
 *                                are asking, so the opt-out does not apply
 * @returns {object} the evaluation, plus `error` and `notified`
 */
async function runCheck(opts) {
	var o = opts || {};
	var source = o.source || updateChecks.SOURCE_SCHEDULE;

	if (!appConfig.getBoolean('update_check_enabled', false) && !o.force) {
		return { skipped: true, reason: 'update_check_enabled is off' };
	}

	var current = systeminfo.canonicalVersion();
	var channel = appConfig.get('update_channel', 'stable');
	var base = appConfig.get('update_check_url', '');

	var transport = appConfig.get('update_check_transport', 'http');
	var useHttp = transport === 'http' || transport === 'both';
	var useFtn  = transport === 'ftn'  || transport === 'both';

	var indexes = {};
	var error = null;

	for (var name of channelsToCheck(channel)) {
		var fromHttp = null;
		var fromFtn = null;

		if (useHttp) {
			var url = indexUrl(base, name);
			if (!url) {
				error = 'update_check_url is not set';
			} else {
				try {
					var got = await fetchIndex(url);
					if (got.index) fromHttp = got.index;
					else alogger.writeAlog(3, '[UpdateCheck] no index published for the ' + name + ' channel', 'cyan');
				} catch (e) {
					// One channel failing should not discard the other, and one
					// transport failing should not discard the other either.
					error = e.message;
					alogger.writeAlog(2, '[UpdateCheck] ' + name + ' channel over HTTP: ' + e.message, 'yellowbright');
				}
			}
		}

		if (useFtn) {
			var shortcode = appConfig.get(name === 'development' ? 'update_dev_file_area' : 'update_stable_file_area', '');
			try {
				fromFtn = await buildChannelIndex(shortcode, name);
			} catch (e2) {
				error = e2.message;
				alogger.writeAlog(2, '[UpdateCheck] ' + name + ' channel over FTN: ' + e2.message, 'yellowbright');
			}
		}

		var merged = mergeIndexes(name, fromHttp, fromFtn);
		if (merged) indexes[name] = merged;
	}

	var applied = await appliedIds();
	var result = evaluate({
		current: current,
		channel: channel,
		indexes: indexes,
		appliedMigrations: applied,
		nodeVersion: process.versions.node
	});

	var notified = false;
	if (!error || result.best) {
		var last = await updateChecks.lastNotified();
		if (shouldNotify(result, last)) {
			var note = notificationFor(result);
			if (note) {
				await notifications.createSysop(NOTIFICATION_TYPE, note.title, note.body, {
					icon: 'arrow-up-circle',
					severity: note.severity,
					link: '/admin/update'
				});
				notified = true;
				alogger.writeAlog(2, '[UpdateCheck] ' + note.title, 'green');
			}
		}
	}

	await updateChecks.record({
		source: source,
		channel: channel,
		current: current,
		verdict: error && !result.best ? VERDICT_UNKNOWN : (result.best ? result.best.verdict : 'current'),
		result: result,
		error: error,
		notified: notified
	});

	result.error = error;
	result.notified = notified;
	return result;
}

export {
	NOTIFICATION_TYPE,
	FETCH_TIMEOUT_MS,
	indexUrl,
	fetchIndex,
	runCheck
};
