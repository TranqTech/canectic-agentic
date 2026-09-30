// whosOnline.js -- Web block: terminal nodes in node order, then web users
// who are not also on a node, alphabetically.
//
// Setting: show always, or only when someone other than this user is online.

import { catalogEntry } from './catalog.js';
import { getOnlineUsers } from '../middleware/webActivity.js';
import { formatActivity } from '../utils/activityMap.js';

async function onlineUsersFor(ctx) {
	return ctx.once('onlineUsers', async function () {
		var terminalNodes = [];
		if (ctx.nodeManager) {
			terminalNodes = ctx.nodeManager.getActiveNodes();
			terminalNodes.sort(function(a, b) { return a.nodenum - b.nodenum; });
		}

		var webUsers = [];
		try { webUsers = await getOnlineUsers(); } catch (_) {}

		var onlineUsers = [];
		var webNodeUsers = {};

		for (var node of terminalNodes) {
			if (node.web_originated && node.username) {
				webNodeUsers[node.username.toLowerCase()] = true;
			}
			var connType = node.connection_type || '';
			var connLabel = (connType === 'Websock' || connType === 'Websocket' || connType === 'TCP' || connType === 'Telnet')
				? 'Terminal' : (connType || 'Unknown');
			if (node.web_originated) connLabel = 'Web';

			onlineUsers.push({
				nodenum: node.nodenum,
				username: node.username || '',
				activity: formatActivity(node.status, node.detail, node.detail_display),
				connection: connLabel
			});
		}

		webUsers.sort(function(a, b) { return (a.username || '').localeCompare(b.username || ''); });
		for (var wu of webUsers) {
			if (!wu.username) continue;
			if (webNodeUsers[wu.username.toLowerCase()]) continue;
			onlineUsers.push({
				nodenum: null,
				username: wu.username,
				activity: wu.activity || 'Browsing Web',
				connection: 'Web'
			});
		}
		return onlineUsers;
	});
}

export default Object.assign({}, catalogEntry('whosonline'), {
	view: 'callflow/whosonline',

	async available(ctx, opts) {
		if (opts.show !== 'others') return {};
		var me = ctx.user ? ctx.user.username.toLowerCase() : '';
		var users = await onlineUsersFor(ctx);
		return users.some(function (u) { return u.username && u.username.toLowerCase() !== me; }) ? {} : null;
	},

	async load(ctx) {
		return { onlineUsers: await onlineUsersFor(ctx) };
	}
});
