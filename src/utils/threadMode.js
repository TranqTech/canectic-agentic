/**
 * The thread mode vocabulary, in one place.
 *
 * `thread_mode` decides whether an area reads as threads or as a flat list,
 * and it is now settable on a message GROUP as a default for its areas as
 * well as on each area. That is two models validating the same value, on top
 * of the two places msgAreas already did it, so the list was on its way to
 * living in four copies.
 *
 * A copy that falls out of step does not fail: an unrecognised mode is
 * silently replaced with 'standard', so an area a sysop set to flat would
 * quietly come back threaded, and only on some paths. Config keys with a fixed
 * set of values carry an `options` list in configDefaults for exactly this
 * reason; this is the same rule for a column.
 */

export const THREAD_MODES = ['standard', 'subscribe_only', 'no_threads'];

export const THREAD_MODE_LABELS = {
	standard:       'Standard (threaded)',
	no_threads:     'No Threads (flat)',
	subscribe_only: 'Subscribe Only',
};

/**
 * Coerce a submitted value to a valid mode.
 *
 * @param {*} value
 * @param {string} [fallback] - what an unrecognised value becomes
 * @returns {string}
 */
export function normaliseThreadMode(value, fallback) {
	var mode = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
	if (THREAD_MODES.indexOf(mode) !== -1) return mode;
	return fallback || 'standard';
}

/**
 * Is this a value we recognise? Distinct from normalising it, because a form
 * handler updating a row needs to tell "not submitted" from "submitted as
 * nonsense" and leave the stored value alone in the first case.
 */
export function isThreadMode(value) {
	if (value === undefined || value === null) return false;
	return THREAD_MODES.indexOf(String(value).trim().toLowerCase()) !== -1;
}

/**
 * The human label, for a view that has a stored value rather than a form.
 */
export function threadModeLabel(value) {
	return THREAD_MODE_LABELS[normaliseThreadMode(value)];
}
