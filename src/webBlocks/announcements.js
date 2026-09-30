// announcements.js -- Web block: announcements new since the user's last
// call flow, plus any pinned one whatever its age.

import * as announcementsModel from '../models/announcements.js';
import { getDefaultTheme, resolveWebColour } from '../models/themes.js';

// Pinned counts as always relevant. The "new" badge is only for an unpinned
// one, so a pinned new announcement does not carry both badges.
async function relevantAnnouncements(ctx) {
	return ctx.once('announcements', async function () {
		var lastCf = await ctx.lastCallflowAt();
		var all = await announcementsModel.getActiveAnnouncements(20);
		var shown = [];
		for (var ann of all) {
			var isNew = !lastCf || new Date(ann.created_at) > lastCf;
			var isPinned = !!ann.pinned;
			if (isNew || isPinned) {
				ann._isNew = isNew && !isPinned;
				shown.push(ann);
			}
		}
		return shown;
	});
}

export default {
	name: 'announcements',
	label: 'Announcements',
	view: 'callflow/announcements',
	requiresUser: true,

	async available(ctx) {
		var shown = await relevantAnnouncements(ctx);
		return shown.length > 0 ? { count: shown.length } : null;
	},

	async load(ctx) {
		var theme = await getDefaultTheme();
		return {
			announcements: await relevantAnnouncements(ctx),
			themeTextColour: resolveWebColour(theme, 'announcements')
		};
	}
};
