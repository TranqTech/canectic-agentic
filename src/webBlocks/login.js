// login.js -- Web block: a login form for visitors, with the links to
// register and to reset a password. Nothing for someone already logged in.

import { catalogEntry } from './catalog.js';
import appConfig from '../config/appConfig.js';

export default Object.assign({}, catalogEntry('login'), {
	view: 'callflow/login',

	async available(ctx) {
		return ctx.user ? null : {};
	},

	async load(ctx) {
		return {
			loggedIn: !!ctx.user,
			rememberDays: appConfig.getNumber('remember_me_days', 30)
		};
	}
});
