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
 * Mode "list" is for a date column that has to share a phone's width: the
 * full timestamp on a wide screen, and on a narrow one (below Bootstrap's lg)
 * the short form the board's list columns use everywhere else, "Sep 25" while
 * recent and "Sep 2025" once older than six months (formatListDate in
 * src/utils/dateFormat.js). The full time stays in the tooltip, and the text
 * follows the screen across the breakpoint.
 *
 * Loaded as a module; `format` and `apply` are also on window.CanecticLocalTime
 * for scripts that build rows themselves.
 */

function pad(n) { return n < 10 ? '0' + n : String(n); }

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export var RECENT_MONTHS = 6;   // formatListDate's DEFAULT_RECENT_MONTHS
export var NARROW_QUERY = '(max-width: 991.98px)';

/**
 * The short list form: "Sep 25" within RECENT_MONTHS of `now` (or in the
 * future: clock skew is normal in FTN), "Sep 2025" before that.
 */
export function shortDate(ms, now) {
	var d = new Date(Number(ms));
	if (isNaN(d.getTime())) return '';
	var ref = now ? new Date(Number(now)) : new Date();
	var cutoff = new Date(ref.getTime());
	cutoff.setMonth(cutoff.getMonth() - RECENT_MONTHS);
	return d > cutoff ? MONTHS[d.getMonth()] + ' ' + pad(d.getDate()) : MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

/**
 * Epoch milliseconds as "yyyy-MM-dd HH:mm:ss" (or "yyyy-MM-dd") in local time.
 * Mode "list" gives shortDate when `narrow`, the full timestamp otherwise.
 */
export function format(ms, mode, narrow) {
	var d = new Date(Number(ms));
	if (isNaN(d.getTime())) return '';
	if (mode === 'list' && narrow) return shortDate(ms);
	var out = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
	if (mode === 'date') return out;
	return out + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function zoneName() {
	try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
}

function isNarrow() {
	try { return !!(window.matchMedia && window.matchMedia(NARROW_QUERY).matches); } catch (_) { return false; }
}

/** Rewrite every <time data-ts> under root (default: the document). */
export function apply(root) {
	var scope = root && root.querySelectorAll ? root : (typeof document !== 'undefined' ? document : null);
	if (!scope) return 0;
	var zone = zoneName();
	var narrow = isNarrow();
	var resized = new Set();
	var n = 0;
	scope.querySelectorAll('time[data-ts]').forEach(function (el) {
		var mode = el.getAttribute('data-ts-mode');
		var text = format(el.getAttribute('data-ts'), mode, narrow);
		if (!text) return;
		el.textContent = text;
		if (mode === 'list') el.title = format(el.getAttribute('data-ts'), 'datetime') + (zone ? ' ' + zone : '');
		else if (zone && !el.title) el.title = zone;
		if (mode === 'list' && el.textContent !== el.dataset.tsShown) { el.dataset.tsShown = el.textContent; resized.add(el.closest('table')); }
		n++;
	});
	// DataTables sizes its columns from what the cells held when it drew, which
	// was the full timestamp; a column that has since shrunk to "Sep 25" left
	// a gap. Re-measure the tables whose list dates changed (adjust recomputes
	// widths without redrawing, so this cannot loop through draw.dt).
	resized.forEach(function (table) {
		try {
			if (table && window.jQuery && window.jQuery.fn.dataTable && window.jQuery.fn.dataTable.isDataTable(table)) {
				window.jQuery(table).DataTable().columns.adjust();
			}
		} catch (_) {}
	});
	return n;
}

if (typeof window !== 'undefined') {
	window.CanecticLocalTime = { format: format, apply: apply };
	apply();
	if (window.jQuery) window.jQuery(document).on('draw.dt', function (e) { apply(e.target); });
	// Rotating a tablet, or resizing a window, across the breakpoint.
	try {
		var mq = window.matchMedia && window.matchMedia(NARROW_QUERY);
		if (mq && mq.addEventListener) mq.addEventListener('change', function () { apply(); });
	} catch (_) {}
}
