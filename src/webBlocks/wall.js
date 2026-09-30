// wall.js -- Web block: recent wall messages, with the post form for a user
// allowed to post. The post itself is POST /callflow/wall.
//
// Settings: how many to show, and whether always or only when someone other
// than this user has posted since their last call flow.

import { catalogEntry } from './catalog.js';
import { getRecentMessages, hasMessagesSince, canPost } from '../models/wall.js';

export default Object.assign({}, catalogEntry('wall'), {
	view: 'callflow/wall',

	async available(ctx, opts) {
		if (opts.show !== 'new') return {};
		var since = await ctx.lastCallflowAt();
		if (!since) return {};
		return (await hasMessagesSince(since, ctx.user ? ctx.user.username : '')) ? {} : null;
	},

	async load(ctx, opts) {
		var messages = await getRecentMessages(opts.count);
		return {
			messages: messages || [],
			canPost: ctx.user ? canPost(ctx.user) : false,
			currentUsername: ctx.user ? ctx.user.username : ''
		};
	}
});
