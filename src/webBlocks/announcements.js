// announcements.js -- Web block: announcements.
//
// Setting: 'new' (the call flow's default) shows those posted since the
// user's last call flow plus any pinned one whatever its age; 'all' (the
// home page's) shows every current announcement.

import { catalogEntry } from './catalog.js';
import * as announcementsModel from '../models/announcements.js';
import { getDefaultTheme, resolveWebColour } from '../models/themes.js';

// The "new" badge is only for an unpinned one, so a pinned new announcement
// does not carry both. With 'all', someone with no last visit (a visitor,
// a first login) sees no badges: everything new is no news.
function markAnnouncements(all, lastCf, show) {
	var shown = [];
	for (var ann of all || []) {
		var isPinned = !!ann.pinned;
		var isNew = show === 'all'
			? (!!lastCf && new Date(ann.created_at) > lastCf)
			: (!lastCf || new Date(ann.created_at) > lastCf);
		if (show === 'all' || isNew || isPinned) {
			shown.push(Object.assign({}, ann, { _isNew: isNew && !isPinned }));
		}
	}
	return shown;
}

async function relevantAnnouncements(ctx, show) {
	return ctx.once('announcements:' + show, async function () {
		var lastCf = await ctx.lastCallflowAt();
		return markAnnouncements(await announcementsModel.getActiveAnnouncements(20), lastCf, show);
	});
}

export { markAnnouncements };

export default Object.assign({}, catalogEntry('announcements'), {
	view: 'callflow/announcements',

	async available(ctx, opts) {
		var shown = await relevantAnnouncements(ctx, opts.show);
		return shown.length > 0 ? { count: shown.length } : null;
	},

	async load(ctx, opts) {
		var theme = await getDefaultTheme();
		return {
			announcements: await relevantAnnouncements(ctx, opts.show),
			themeTextColour: resolveWebColour(theme, 'announcements')
		};
	}
});
