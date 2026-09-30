// verifyMail.js -- Web block: asks a user who has not verified their mail
// address to do it, as the terminal's verify_mail stage does, with how long
// an unverified account is kept when the board deletes them.

import { catalogEntry } from './catalog.js';
import * as postgres from '../middleware/db/postgres.js';
import appConfig from '../config/appConfig.js';

async function accountFor(ctx) {
	return ctx.once('mailAccount', function () {
		return postgres.queryOne('SELECT mailaddress, mailverified, created_at FROM users WHERE id = $1', [ctx.userId]);
	});
}

// Days left before an unverified account is removed, or null when the board
// keeps them (unverified_retention_days 0). Same arithmetic as /users/verify.
function daysRemaining(createdAt, now) {
	var retDays = appConfig.getNumber('unverified_retention_days', 14);
	if (!(retDays > 0) || !createdAt) return null;
	var expires = new Date(createdAt).getTime() + retDays * 86400000;
	return Math.max(0, Math.ceil((expires - (now || Date.now())) / 86400000));
}

export default Object.assign({}, catalogEntry('verifymail'), {
	view: 'callflow/verifymail',

	async available(ctx) {
		var acct = await accountFor(ctx);
		return acct && acct.mailverified !== true ? {} : null;
	},

	async load(ctx) {
		var acct = await accountFor(ctx);
		return {
			address: acct ? acct.mailaddress : '',
			daysRemaining: acct ? daysRemaining(acct.created_at) : null
		};
	}
});
