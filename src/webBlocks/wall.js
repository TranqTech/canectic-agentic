// wall.js -- Web block: recent wall messages, with the post form for a user
// allowed to post. The post itself is POST /callflow/wall.

import { getRecentMessages, canPost } from '../models/wall.js';

export default {
	name: 'wall',
	label: 'The Wall',
	view: 'callflow/wall',
	requiresUser: false,

	async load(ctx) {
		var messages = await getRecentMessages(15);
		return {
			messages: messages || [],
			canPost: ctx.user ? canPost(ctx.user) : false,
			currentUsername: ctx.user ? ctx.user.username : ''
		};
	}
};
