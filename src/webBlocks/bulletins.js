// bulletins.js -- Web block: the sysop's bulletins, each opening in place so
// the user never leaves the call flow to read one. A bulletin new or changed
// since the user's last call flow is marked and opened already.
//
// Setting: show always, or only when a bulletin is new or changed since
// their last visit.

import { catalogEntry } from './catalog.js';
import { getActiveBulletins } from '../models/bulletins.js';
import { getDefaultTheme, resolveWebColour } from '../models/themes.js';

// Someone who has never been through the flow has no "since", so nothing is
// marked new for them: every bulletin at once would be noise, not news.
function changedSince(b, since) {
	if (!since) return false;
	var t = b.updated_at || b.created_at;
	return !!t && new Date(t) > since;
}

async function bulletinsFor(ctx) {
	return ctx.once('bulletins', async function () {
		var since = await ctx.lastCallflowAt();
		return (await getActiveBulletins()).map(function (b) {
			return Object.assign({}, b, { _isNew: changedSince(b, since) });
		});
	});
}

export { changedSince };

export default Object.assign({}, catalogEntry('bulletins'), {
	view: 'callflow/bulletins',

	async available(ctx, opts) {
		var list = await bulletinsFor(ctx);
		if (list.length === 0) return null;
		if (opts.show !== 'new') return {};
		// Never been through the flow: show them, as the other "new" settings do
		if (!(await ctx.lastCallflowAt())) return {};
		var fresh = list.filter(function (b) { return b._isNew; }).length;
		return fresh > 0 ? { count: fresh } : null;
	},

	async load(ctx) {
		var theme = await getDefaultTheme();
		return {
			bulletins: await bulletinsFor(ctx),
			themeTextColour: resolveWebColour(theme, 'announcements')
		};
	}
});
