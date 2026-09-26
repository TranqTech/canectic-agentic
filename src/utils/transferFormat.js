// transferFormat.js -- what a QWK or NNTP pull or push came to, in words.
//
// The mailer has kept one row per session since mailer_sessions; the QWK and
// NNTP tossers kept nothing. Their detail went to tosser.log at level 3 to 5,
// and the worker then logged "Toss job qwk:pull finished" and published
// "Messages imported" whatever had happened. An FTP control socket timing out
// on every pull for days looked, everywhere a sysop would look, like a pull
// that worked and found nothing. network_transfers now takes a row per
// attempt, and this decides what to call it.
//
// The tossers report a result object (status, errormessages, counts) and, for
// this, the stage they had reached when they stopped: config, connect, auth,
// download, extract, import, build, upload, fetch or post. The stage is what
// tells a timeout reaching the server from one halfway through a download.
//
// Pure, so the classification is testable without a server to fail against.

import { formatBytes, relativeAge, formatDuration, summariseConnection } from './mailerFormat.js';

// Outcomes that count as "it worked". `idle` is a success that moved nothing:
// no packet waiting, nothing to send. Kept apart from `complete` so the page
// can show when mail last actually arrived, not merely when a pull last ran.
var SUCCESS_OUTCOMES = ['complete', 'idle', 'partial'];

var NETWORK_ERROR = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN|EPIPE|socket hang up|getaddrinfo/i;
var TIMEOUT = /timeout|timed out|ETIMEDOUT/i;
// 530 is FTP "not logged in"; 481/482 are NNTP authentication rejected.
var AUTH = /\b530\b|\b481\b|\b482\b|authenticat|login incorrect|not logged in/i;

function firstError(result) {
	var errs = (result && result.errormessages) || [];
	return errs.length > 0 ? String(errs[0]) : '';
}

/**
 * The outcome of one pull or push.
 *
 * A failure is `status: false` OR any error message: pushToQwkPeer and
 * pushToNntpPeer both return status true after a failed upload, so the index
 * can advance past what did go, and taking status alone would record those as
 * successes.
 *
 * @param {object} result - the tosser's returnObj plus `stage`
 * @param {string} direction - 'pull' or 'push'
 * @returns {string} complete | idle | partial | config_error | connect_failed |
 *   timeout | auth_failed | transfer_failed | processing_failed | failed
 */
function classifyTransfer(result, direction) {
	var r = result || {};
	var err = firstError(r);
	var stage = r.stage || '';

	if (r.status && !err) {
		if ((parseInt(r.totalRejected) || 0) > 0) return 'partial';
		var moved = direction === 'push'
			? (parseInt(r.totalPosted) || 0)
			: (parseInt(r.totalImported) || 0) + (parseInt(r.totalDuplicate) || 0);
		// A packet that arrived and held only duplicates still arrived.
		if (moved > 0 || (parseInt(r.bytes) || 0) > 0) return 'complete';
		return 'idle';
	}

	if (stage === 'config') return 'config_error';
	if (stage === 'auth' || AUTH.test(err)) return 'auth_failed';
	if (TIMEOUT.test(err)) return 'timeout';
	if (stage === 'connect' || NETWORK_ERROR.test(err)) return 'connect_failed';
	if (['download', 'upload', 'fetch', 'post'].indexOf(stage) >= 0) return 'transfer_failed';
	if (['extract', 'import', 'build'].indexOf(stage) >= 0) return 'processing_failed';
	return 'failed';
}

function isSuccess(outcome) {
	return SUCCESS_OUTCOMES.indexOf(outcome) >= 0;
}

function outcomeLabel(outcome) {
	switch (outcome) {
		case 'complete':          return 'ok';
		case 'idle':              return 'nothing';
		case 'partial':           return 'partial';
		case 'config_error':      return 'config';
		case 'connect_failed':    return 'no connect';
		case 'timeout':           return 'timeout';
		case 'auth_failed':       return 'auth';
		case 'transfer_failed':   return 'transfer';
		case 'processing_failed': return 'processing';
		case 'failed':            return 'failed';
		default:                  return outcome || 'unknown';
	}
}

function outcomeClass(outcome) {
	if (outcome === 'complete') return 'success';
	if (outcome === 'idle') return 'secondary';
	if (outcome === 'partial') return 'warning';
	if (outcome === 'config_error' || outcome === 'processing_failed') return 'warning';
	return 'danger';
}

/**
 * The worker's line for a finished job: what happened, at what level, and
 * whether it is honest to announce imported messages.
 *
 * @returns {{ok: boolean, level: number, colour: string, text: string}}
 */
function describeResult(protocol, direction, uuid, result) {
	var outcome = (result && result.outcome) || classifyTransfer(result, direction);
	var ok = isSuccess(outcome);
	var what = protocol + ' ' + direction + ' ' + (uuid || '');
	var r = result || {};
	if (!ok) {
		return { ok: false, outcome: outcome, level: 2, colour: 'redbright',
			text: what + ' FAILED (' + outcomeLabel(outcome) + (r.stage ? ' at ' + r.stage : '') + '): ' +
				(firstError(r) || 'no reason given') };
	}
	var counts = direction === 'push'
		? 'posted ' + (parseInt(r.totalPosted) || 0) +
			((parseInt(r.totalRejected) || 0) ? ', rejected ' + r.totalRejected : '')
		: 'imported ' + (parseInt(r.totalImported) || 0) + ', duplicates ' + (parseInt(r.totalDuplicate) || 0);
	return { ok: true, outcome: outcome, level: outcome === 'idle' ? 3 : 2,
		colour: outcome === 'partial' ? 'yellow' : 'cyan',
		text: what + ': ' + (outcome === 'idle' ? 'nothing to transfer' : counts) };
}

/**
 * Whether a finished pull brought anything in, which is the only time it is
 * true to publish MESSAGES_IMPORTED. The worker used to publish it after every
 * pull, failed or empty.
 */
function importedAnything(result) {
	return (parseInt(result && result.totalImported) || 0) > 0;
}

/**
 * The page's row for one connection. Same shape and rules as the mailer's
 * summariseConnection, whose "never contacted is not failing" and "last
 * success over all history" rules apply here unchanged; only the counts differ.
 */
function summariseTransfers(stats, contact, opts) {
	var s = stats || {};
	var base = summariseConnection(s, contact, opts);
	base.messagesIn = parseInt(s.messages_in) || 0;
	base.messagesOut = parseInt(s.messages_out) || 0;
	base.duplicates = parseInt(s.duplicates) || 0;
	base.bytes = parseInt(s.bytes) || 0;
	base.lastMail = contact && contact.last_mail ? new Date(contact.last_mail) : null;
	base.lastMailAge = base.lastMail ? relativeAge(base.lastMail, opts && opts.now) : null;
	return base;
}

function formatMs(ms) {
	var n = parseInt(ms);
	if (isNaN(n)) return '-';
	if (n < 1000) return n + 'ms';
	return formatDuration(Math.round(n / 1000));
}

export {
	SUCCESS_OUTCOMES,
	classifyTransfer,
	isSuccess,
	outcomeLabel,
	outcomeClass,
	describeResult,
	importedAnything,
	summariseTransfers,
	formatMs,
	formatBytes,
	relativeAge
};
