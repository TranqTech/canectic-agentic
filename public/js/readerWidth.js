/**
 * Message reader: how many columns a message body is sized to fill (#54).
 *
 * The font is scaled so a target number of monospace columns fills the width
 * of the reader. On desktop that is 80. On a phone it is 40 by default, a
 * READABILITY choice: 80 columns on a ~400px screen lands near 9px, too small
 * to read, and 40 gives about double that. The cost is that 80-column content,
 * ANSI art above all, wraps at 40 and breaks. So, below the breakpoint:
 *
 *   - the reader has a 40 | 80 switch for the whole view, remembered per area
 *     in this browser;
 *   - an area marked "Mostly ANSI art" (message_areas.ansi_area, #49) starts
 *     at 80 instead of 40;
 *   - a message detected as art (data-art on its body, from detectAnsiArt at
 *     render time) is always sized to 80, whatever the view is set to, since
 *     art at 40 is broken anyway.
 *
 * Moved out of the inline script in _msgAutoSize.pug so the rules can be
 * tested; the same pattern as messageAreas.js. Loaded as a module; `fit` is
 * also on window.fitMessageBodies, which the lazy loaders call after adding
 * messages.
 */

export var MOBILE_BREAKPOINT = 992;   // Bootstrap lg: the switch is d-lg-none
export var DESKTOP_COLS = 80;
export var MOBILE_COLS = 40;
var MIN_FONT_PX = 7;
var MAX_FONT_PX = 32;
var REFERENCE_PX = 16;

/** localStorage key for an area's remembered width. */
export function storageKey(shortcode) {
	return 'canectic.readerCols.' + String(shortcode || '').toUpperCase();
}

/**
 * The width the whole view is set to. Desktop is always 80. Below the
 * breakpoint: the reader's remembered choice, else the area's ansi_area
 * default, else 40.
 */
export function viewCols(o) {
	if (o.viewportWidth >= MOBILE_BREAKPOINT) return DESKTOP_COLS;
	if (o.stored === '40' || o.stored === '80') return Number(o.stored);
	return o.force80 ? DESKTOP_COLS : MOBILE_COLS;
}

/** The width one message is sized to: art is always 80. */
export function bodyCols(view, isArt) {
	return isArt ? DESKTOP_COLS : view;
}

/**
 * Font size that makes `cols` monospace characters fill `availableWidth`,
 * given the width of one character at the reference size. Clamped and
 * rounded to a tenth of a pixel.
 */
export function fontPx(availableWidth, charWidthAtRef, cols) {
	if (!(availableWidth > 0) || !(charWidthAtRef > 0) || !(cols > 0)) return null;
	var px = REFERENCE_PX * (availableWidth / (charWidthAtRef * cols));
	px = Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, px));
	return Math.round(px * 10) / 10;
}

function readStored(shortcode) {
	try { return window.localStorage.getItem(storageKey(shortcode)); } catch (_) { return null; }
}

function writeStored(shortcode, cols) {
	try { window.localStorage.setItem(storageKey(shortcode), String(cols)); } catch (_) { /* private window */ }
}

/** Width of one monospace character at the reference size, measured. */
function measureChar(container) {
	// font-family inline to match .monospace exactly; inherit would measure the
	// container's proportional font.
	var probe = document.createElement('span');
	probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;' +
		'font-family:"Consolas",monospace;font-size:' + REFERENCE_PX + 'px;';
	probe.textContent = '0'.repeat(DESKTOP_COLS);
	container.appendChild(probe);
	var w = probe.getBoundingClientRect().width / DESKTOP_COLS;
	container.removeChild(probe);
	return w;
}

/** Size every message body in the reader. */
export function fit() {
	var container = document.getElementById('messageContainer');
	if (!container) return;
	var style = window.getComputedStyle(container);
	var available = container.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
	if (available < 100) return;
	available -= 16;   // .px-2 on the body wrapper, 8px each side

	var view = viewCols({
		viewportWidth: window.innerWidth,
		stored: readStored(container.dataset.shortcode),
		force80: container.dataset.force80 === 'true'
	});
	var charWidth = measureChar(container);
	var sizes = {};
	sizes[MOBILE_COLS] = fontPx(available, charWidth, MOBILE_COLS);
	sizes[DESKTOP_COLS] = fontPx(available, charWidth, DESKTOP_COLS);

	var bodies = document.querySelectorAll('.messagebody');
	for (var i = 0; i < bodies.length; i++) {
		var px = sizes[bodyCols(view, bodies[i].dataset.art === 'true')];
		if (px) bodies[i].style.setProperty('font-size', px + 'px', 'important');
	}

	var buttons = document.querySelectorAll('[data-reader-width] [data-cols]');
	for (var j = 0; j < buttons.length; j++) {
		var on = Number(buttons[j].dataset.cols) === view;
		buttons[j].classList.toggle('active', on);
		buttons[j].setAttribute('aria-pressed', on ? 'true' : 'false');
	}
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	window.fitMessageBodies = fit;
	window.CanecticReaderWidth = { viewCols: viewCols, bodyCols: bodyCols, fontPx: fontPx, storageKey: storageKey };

	document.addEventListener('click', function (e) {
		var btn = e.target.closest && e.target.closest('[data-reader-width] [data-cols]');
		if (!btn) return;
		var container = document.getElementById('messageContainer');
		if (!container) return;
		writeStored(container.dataset.shortcode, btn.dataset.cols);
		fit();
	});

	var timer = null;
	window.addEventListener('resize', function () {
		clearTimeout(timer);
		timer = setTimeout(fit, 150);
	});

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fit);
	else fit();
}
