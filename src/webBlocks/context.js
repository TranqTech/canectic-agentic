// context.js -- What a web block is given when it runs.
//
// One context per request. Blocks that need the same fact (the user's last
// call flow, their subscribed areas) ask for it through once(), so a page
// showing several blocks at a time (the #87 landing page) queries it once
// rather than once per block.

import * as postgres from '../middleware/db/postgres.js';

/**
 * When this user last completed the web call flow, from the database.
 * Null when they never have.
 */
async function getLastCallflowAt(userId) {
	var row = await postgres.queryOne(
		'SELECT last_callflow_at FROM users WHERE id = $1',
		[userId]
	);
	return row && row.last_callflow_at ? new Date(row.last_callflow_at) : null;
}

/**
 * @param {object} req   the Express request (blocks read the session and app locals from it)
 * @param {object|null} user  the session's user, or null for a visitor
 */
function createContext(req, user) {
	var memo = new Map();
	var locals = (req && req.app && req.app.locals) || {};
	return {
		req: req,
		user: user || null,
		userId: user ? parseInt(user.id) : null,
		nodeManager: locals.nodeManager || null,

		// Memoises the PROMISE, so two blocks asking at once share one query.
		once: function (key, fn) {
			if (!memo.has(key)) memo.set(key, Promise.resolve().then(fn));
			return memo.get(key);
		},

		lastCallflowAt: function () {
			var userId = this.userId;
			return this.once('lastCallflowAt', function () {
				return userId === null ? null : getLastCallflowAt(userId);
			});
		}
	};
}

export { createContext, getLastCallflowAt };
