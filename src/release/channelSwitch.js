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

// Shown before a switch to development, and required to be confirmed. The
// part people miss is the way back: releases never go backwards, so there is
// no returning to the stable this board runs now, only moving on to the next
// one, and a build's database change can hold that back until a stable that
// includes it.
export var DEVELOPMENT_WARNING =
	'Development builds are cut between stable releases and get less testing than stable. ' +
	'There is no going back to the stable you run now: switching back to stable waits for the next stable release, ' +
	'and if a build has made a database change that release does not include, for one that does. ' +
	'Stable is the better choice for a board other people rely on.';

/** Does a switch from `from` to `to` need the development warning confirmed? */
export function needsConfirmation(from, to) {
	return to === 'development' && from !== 'development';
}

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
