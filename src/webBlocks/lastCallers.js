// lastCallers.js -- Web block: the most recent callers, terminal and web.
//
// Settings: how many to list, and whether to show them always or only when
// someone other than this user has called since their last call flow.

import { catalogEntry } from './catalog.js';
import { getLastCallers, hasCallsSince } from '../models/callers.js';

export default Object.assign({}, catalogEntry('lastcallers'), {
	view: 'callflow/lastcallers',

	async available(ctx, opts) {
		if (opts.show !== 'new') return {};
		var since = await ctx.lastCallflowAt();
		// Never been through the call flow: everything is new
		if (!since) return {};
		return (await hasCallsSince(since, ctx.user ? ctx.user.username : '')) ? {} : null;
	},

	async load(ctx, opts) {
		var callers = await getLastCallers(opts.count);
		return { callers: callers || [] };
	}
});
