// channelSwitch.js -- what changing update channel means for this board.
//
// Switching is harmless in itself: it only changes which releases a board is
// offered. What it does NOT do is the part that needs saying. A development
// build carries the last stable plus a date and sorts ABOVE that stable
// (version.js), so a board on a build that switches to stable is not offered
// the stable it was built on; it stays where it is until the next stable. Said
// nowhere, that reads as "switching did nothing".
//
// Pure, so the wording is decided in one place and tested.

import { isDevelopment, baseStable } from '../utils/version.js';

export var CHANNELS = ['stable', 'development'];

/**
 * What switching from `from` to `to` means for a board running `running`.
 * @returns {string|null} null when nothing is changing
 */
export function describeSwitch(running, from, to) {
	if (!CHANNELS.includes(to) || from === to) return null;
	if (to === 'development') {
		return 'Development builds are now offered as soon as they are cut, alongside stable releases. ' +
			'You can switch back at any time.';
	}
	if (isDevelopment(running)) {
		return waitingForStable(running);
	}
	return 'Only stable releases are offered now.';
}

/**
 * The standing note for a board on stable that runs a development build, or
 * null when that is not this board's situation.
 */
export function waitingForStable(running) {
	if (!isDevelopment(running)) return null;
	return 'This board runs development build ' + running + ', which is newer than stable ' +
		baseStable(running) + ', so nothing changes now. It moves onto stable with the first stable release after ' +
		baseStable(running) + '. If a development build applied a database change that release does not ship, ' +
		'the Update page will say so rather than offer it.';
}
