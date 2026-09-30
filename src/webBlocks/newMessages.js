// newMessages.js -- Web block: unread messages in the user's subscribed
// areas, per area.

import { catalogEntry } from './catalog.js';
import * as msgAreas from '../models/msgAreas.js';
import * as userAreaSubs from '../models/userAreaSubs.js';
import * as userMsgPointers from '../models/userMsgPointers.js';

async function newscan(ctx) {
	return ctx.once('newMessages', async function () {
		var allAreas = await msgAreas.getAllAreas();
		var activeAreas = allAreas.filter(function(a) { return a.active; });
		var areasWithDefaults = activeAreas.map(function(a) {
			return { shortcode: a.shortcode, newscan_default: a.newscan_default };
		});
		var subscribed = await userAreaSubs.getSubscribedAreas(ctx.userId, areasWithDefaults);
		var summary = await userMsgPointers.getNewscanSummary(ctx.userId, subscribed);
		return { activeAreas: activeAreas, summary: summary };
	});
}

export default Object.assign({}, catalogEntry('newmsgs'), {
	view: 'callflow/newmsgs',

	async available(ctx) {
		var scan = await newscan(ctx);
		if (scan.summary.length === 0) return null;
		var total = 0;
		for (var ns of scan.summary) total += ns.unread_count;
		return { count: total, areas: scan.summary.length };
	},

	async load(ctx) {
		var scan = await newscan(ctx);
		var areaMap = {};
		for (var a of scan.activeAreas) areaMap[a.shortcode] = a;
		var items = [];
		for (var s of scan.summary) {
			var area = areaMap[s.area_shortcode];
			items.push({
				shortcode: s.area_shortcode,
				name: area ? area.name : s.area_shortcode,
				group: area ? area.group_shortcode : '',
				unread: s.unread_count
			});
		}
		return { items: items };
	}
});
