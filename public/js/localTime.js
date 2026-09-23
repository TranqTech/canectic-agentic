/**
 * Timestamps in the viewer's own timezone.
 *
 * The server renders every table timestamp in its own timezone, as
 * "2026-09-22 17:57:03" (src/utils/dateFormat.js formatTimestamp, via the `ts`
 * mixin), inside <time data-ts="<epoch ms>">. This rewrites each one in the
 * browser's timezone, in the same format, and names the zone in the tooltip.
 * For a sysop the two are nearly always the same; for anyone else this is what
 * makes the time theirs.
 *
 * Sorting never depends on this: DataTables cells carry the epoch as
 * data-order. Rows on other DataTables pages are not in the document when this
 * first runs, so it runs again on every table draw.
 *
 * Loaded as a module; `format` and `apply` are also on window.CanecticLocalTime
 * for scripts that build rows themselves.
 */

function pad(n) { return n < 10 ? '0' + n : String(n); }

/** Epoch milliseconds as "yyyy-MM-dd HH:mm:ss" (or "yyyy-MM-dd") in local time. */
export function format(ms, mode) {
	var d = new Date(Number(ms));
	if (isNaN(d.getTime())) return '';
	var out = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
	if (mode === 'date') return out;
	return out + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function zoneName() {
	try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
}

/** Rewrite every <time data-ts> under root (default: the document). */
export function apply(root) {
	var scope = root && root.querySelectorAll ? root : (typeof document !== 'undefined' ? document : null);
	if (!scope) return 0;
	var zone = zoneName();
	var n = 0;
	scope.querySelectorAll('time[data-ts]').forEach(function (el) {
		var text = format(el.getAttribute('data-ts'), el.getAttribute('data-ts-mode'));
		if (!text) return;
		el.textContent = text;
		if (zone && !el.title) el.title = zone;
		n++;
	});
	return n;
}

if (typeof window !== 'undefined') {
	window.CanecticLocalTime = { format: format, apply: apply };
	apply();
	if (window.jQuery) window.jQuery(document).on('draw.dt', function (e) { apply(e.target); });
}
