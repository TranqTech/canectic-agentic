/**
 * Size a scrolling list to the space actually left for it on screen.
 *
 * The message views make the page itself unscrollable (body overflow: hidden)
 * and scroll a list inside it, whose height was `calc(100vh - 190px)`: 190px
 * being a guess at everything above the list. On a phone the title and the
 * progress bar wrap onto more lines, the list started ~237px down, and its
 * bottom sat below the screen where nothing could scroll to it. 100vh on a
 * phone is also the height with the address bar HIDDEN, so while the bar shows
 * even more was out of reach. So the last message in an area was often cut
 * off.
 *
 * Any element with `data-fit-height` gets a max-height of what is visible
 * below its top, less whatever its card puts under it, recomputed on resize,
 * rotation and when the phone's address bar comes or goes (visualViewport).
 * The inline calc() stays as the value before this runs, and without script.
 *
 * `fitHeight` is pure and tested; the rest is wiring.
 */

export var MIN_HEIGHT = 200;

/**
 * @param {number} visibleHeight - the height the reader can see
 * @param {number} top - the element's top, relative to what is visible
 * @param {number} below - what must stay visible under it (card border, padding)
 * @returns {number} max-height in px
 */
export function fitHeight(visibleHeight, top, below) {
	var h = Math.floor(visibleHeight - top - (below > 0 ? below : 0));
	return h > MIN_HEIGHT ? h : MIN_HEIGHT;
}

function visibleHeight() {
	return (window.visualViewport && window.visualViewport.height) || window.innerHeight;
}

// What the element's card adds below it: its padding, border and anything
// after the element inside the card, plus a little room at the page edge.
function spaceBelow(el) {
	var card = el.closest('.card') || el.parentElement;
	var gap = 8;
	if (!card) return gap;
	return Math.max(0, card.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom) + gap;
}

export function fitAll() {
	var els = document.querySelectorAll('[data-fit-height]');
	for (var i = 0; i < els.length; i++) {
		var el = els[i];
		var below = spaceBelow(el);
		var top = el.getBoundingClientRect().top;
		el.style.maxHeight = fitHeight(visibleHeight(), top, below) + 'px';
	}
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	var timer = null;
	var later = function () { clearTimeout(timer); timer = setTimeout(fitAll, 100); };
	window.addEventListener('resize', later);
	window.addEventListener('orientationchange', later);
	if (window.visualViewport) window.visualViewport.addEventListener('resize', later);
	window.fitScrollHeights = fitAll;
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fitAll);
	else fitAll();
	// Fonts and the reader's own sizing can change what sits above the list
	// after DOMContentLoaded.
	window.addEventListener('load', fitAll);
}
