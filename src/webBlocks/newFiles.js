// newFiles.js -- Web block: files new since the start of the user's previous
// visit in their subscribed file areas (the rule is src/utils/newSince.js).

import * as fileAreas from '../models/fileAreas.js';
import * as userFileSubs from '../models/userFileSubs.js';
import * as fileEntries from '../models/fileEntries.js';
import * as newFilesBaseline from '../models/newFilesBaseline.js';

async function newFilesByArea(ctx) {
	return ctx.once('newFiles', async function () {
		var allFileAreas = await fileAreas.getAllAreas();
		var activeFileAreas = allFileAreas.filter(function(a) { return a.active; });
		var withDefaults = activeFileAreas.map(function(a) {
			return { shortcode: a.shortcode, newscan_default: a.newscan_default };
		});
		var subscribed = await userFileSubs.getSubscribedAreas(ctx.userId, withDefaults);
		var newSince = await newFilesBaseline.forWeb(ctx.req, ctx.user);

		var items = [];
		for (var sc of subscribed) {
			var fa = activeFileAreas.find(function(a) { return a.shortcode === sc; });
			if (!fa) continue;
			var count = await fileEntries.countNewSince(fa.id, newSince);
			if (count > 0) items.push({ shortcode: sc, name: fa.name || sc, count: count });
		}
		return items;
	});
}

export default {
	name: 'newfiles',
	label: 'New Files',
	view: 'callflow/newfiles',
	requiresUser: true,

	async available(ctx) {
		var items = await newFilesByArea(ctx);
		if (items.length === 0) return null;
		var total = 0;
		for (var it of items) total += it.count;
		return { count: total, areas: items.length };
	},

	async load(ctx) {
		return { items: await newFilesByArea(ctx) };
	}
};
