/**
 * Message areas list: client-side sorting.
 *
 * Split out of the template so the comparator can be tested. Inline in a pug
 * script block it was unreachable from node, and the failure mode it guards
 * against is quiet: a row with a missing or mistyped sort key does not throw,
 * it sorts to the bottom as though the area had never carried a message. That
 * looks like a working feature giving a wrong answer.
 *
 * Loaded as `<script type="module">`, which executes before DOMContentLoaded,
 * so the view's existing inline handler can reach it on `window` without
 * itself becoming a module.
 *
 * The first project-authored file in public/js. Everything else there is
 * vendor.
 */

/**
 * Order two areas.
 *
 * Rows are plain `{ order, lastMessage }`:
 *   order        position the server sent, so the sysop ordering is restorable
 *                without a reload
 *   lastMessage  epoch milliseconds, 0 when the area has never carried one
 *
 * `recent` sorts newest first and falls back to the server order for ties,
 * which keeps areas that have never carried a message in their configured
 * order at the bottom instead of an arbitrary one.
 *
 * Any other mode is the server order.
 */
function compareAreas(a, b, mode) {
	if (mode === 'recent') {
		var at = numeric(a && a.lastMessage);
		var bt = numeric(b && b.lastMessage);
		if (bt !== at) return bt - at;
	}
	return numeric(a && a.order) - numeric(b && b.order);
}

/**
 * Coerce a data attribute to a number.
 *
 * Attributes arrive as strings, and a missing one is undefined. Left to
 * parseInt those become NaN, and NaN in a comparator makes the sort order
 * unspecified rather than merely wrong, so it is worth pinning to 0.
 */
function numeric(value) {
	var n = parseInt(value, 10);
	return isNaN(n) ? 0 : n;
}

/**
 * Read a table row into the shape compareAreas wants.
 */
function rowToArea(row) {
	var d = (row && row.dataset) || {};
	return { order: numeric(d.order), lastMessage: numeric(d.lastMessage) };
}

/**
 * Reorder the rows of every group in `root`.
 *
 * Sorting happens inside each group rather than across the page, so the
 * grouping still means something.
 */
function applyAreaSort(root, mode) {
	if (!root || !root.querySelectorAll) return 0;

	var sections = root.querySelectorAll('.group-section');
	var moved = 0;

	for (var i = 0; i < sections.length; i++) {
		var body = sections[i].querySelector('tbody');
		if (!body) continue;

		var rows = Array.prototype.slice.call(body.querySelectorAll('.area-row'));
		if (rows.length < 2) continue;

		rows.sort(function (x, y) {
			return compareAreas(rowToArea(x), rowToArea(y), mode);
		});

		for (var j = 0; j < rows.length; j++) body.appendChild(rows[j]);
		moved += rows.length;
	}

	return moved;
}

export { compareAreas, applyAreaSort, rowToArea };

// Browser convenience. Module scripts run before DOMContentLoaded, so the
// view's inline handler finds this already set.
if (typeof window !== 'undefined') {
	window.CanecticAreaSort = { compareAreas: compareAreas, applyAreaSort: applyAreaSort };
}
