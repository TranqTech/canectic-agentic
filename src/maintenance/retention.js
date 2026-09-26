// retention.js — how many days each daily purge keeps, decided when it runs.
//
// The purges used to be registered with their retention BAKED INTO the
// schedule (`data: { days: 30 }`) and trusted it. Two faults followed:
//
//   - Setting a retention to keep-forever skipped registering the schedule,
//     but nothing removed the one already registered, and fixed schedules are
//     outside what the orphan prune may touch. The old schedule went on firing
//     every night with the old number of days, deleting what the sysop had
//     just asked to keep.
//   - Changing one number to another only applied after a gateway restart.
//
// Now a schedule carries no days, the job reads the setting when it runs,
// and registerSchedules removes the schedule of a purge that is switched off.
// A job enqueued by hand with an explicit number of days is marked `manual`
// and honoured; a scheduled job with a stale `days` from before this change
// is not, because it lacks the mark.
//
// Pure: the config is passed in, so every rule is testable.

// name -> the setting, its default, and whether a value means "do not purge".
// ftn_keep_tossed_days is the odd one: 0 means delete at toss time (the tosser
// does that, so there is nothing left to purge) and 999 means keep for ever.
export var RETENTION_JOBS = {
	'purge-pm-trash':        { key: 'pm_trash_retention_days',          defaultDays: 30,  schedule: 'purge-pm-trash-daily',        pattern: '0 3 * * *',    alwaysOn: true },
	'purge-notifications':   { key: 'notifications_retention_days',     defaultDays: 30,  schedule: 'purge-notifications-daily',   pattern: '0 30 2 * * *' },
	'purge-tossed':          { key: 'ftn_keep_tossed_days',             defaultDays: 7,   schedule: 'purge-tossed-daily',          pattern: '0 2 * * *',    keepForeverAt: 999 },
	'purge-bad-echomail':    { key: 'bad_echo_retention_days',          defaultDays: 30,  schedule: 'purge-bad-echomail-daily',    pattern: '0 45 3 * * *' },
	'purge-inbound-log':     { key: 'inbound_log_retention_days',       defaultDays: 90,  schedule: 'purge-inbound-log-daily',     pattern: '0 50 3 * * *' },
	'purge-outbound-log':    { key: 'outbound_log_retention_days',      defaultDays: 90,  schedule: 'purge-outbound-log-daily',    pattern: '0 52 3 * * *' },
	'purge-mailer-sessions': { key: 'mailer_session_retention_days',    defaultDays: 30,  schedule: 'purge-mailer-sessions-daily', pattern: '0 54 3 * * *' },
	'purge-network-transfers': { key: 'network_transfer_retention_days', defaultDays: 30, schedule: 'purge-network-transfers-daily', pattern: '0 57 3 * * *' },
	'purge-relay-log':       { key: 'netmail_relay_log_retention_days', defaultDays: 180, schedule: 'purge-relay-log-daily',       pattern: '0 56 3 * * *' },
	'purge-update-checks':   { key: 'update_check_retention_days',      defaultDays: 90,  schedule: 'purge-update-checks-daily',   pattern: '0 58 3 * * *' },
};

function asNumber(value) {
	var n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * The days a purge should keep on this run, or null to purge nothing.
 *
 * @param {string} name - the job name
 * @param {object} data - job data; `{ manual: true, days: N }` from a sysop
 * @param {function} getNumber - (key, default) => number, i.e. appConfig.getNumber
 * @returns {number|null}
 */
export function retentionDaysFor(name, data, getNumber) {
	var spec = RETENTION_JOBS[name];
	if (!spec) throw new Error('No retention rule for job ' + name);

	var days = null;
	if (data && data.manual) days = asNumber(data.days);
	if (days === null) days = asNumber(getNumber(spec.key, spec.defaultDays));
	if (days === null) days = spec.defaultDays;

	// PM trash has no keep-forever value; 0 purges all trash, as it always has.
	if (spec.alwaysOn) return days >= 0 ? days : spec.defaultDays;
	if (days <= 0) return null;
	if (spec.keepForeverAt && days >= spec.keepForeverAt) return null;
	return days;
}

/**
 * Whether a purge's daily schedule should exist at all.
 */
export function scheduleWanted(name, getNumber) {
	return retentionDaysFor(name, {}, getNumber) !== null;
}
