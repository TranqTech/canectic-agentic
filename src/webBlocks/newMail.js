// newMail.js -- Web block: the user's unread private mail, newest first,
// each opening the message and finishing the call flow on the way.
//
// Setting: how many unread messages to list (the count shown is all of them).

import { catalogEntry } from './catalog.js';
import { getUnreadCount, getInbox } from '../models/privateMessages.js';

export default Object.assign({}, catalogEntry('newmail'), {
	view: 'callflow/newmail',

	async available(ctx) {
		var unread = await ctx.once('unreadMail', function () { return getUnreadCount(ctx.userId); });
		return unread > 0 ? { count: unread } : null;
	},

	async load(ctx, opts) {
		var unread = await ctx.once('unreadMail', function () { return getUnreadCount(ctx.userId); });
		var messages = await getInbox(ctx.userId, { limit: opts.count, unreadOnly: true });
		return { unread: unread, messages: messages || [] };
	}
});
