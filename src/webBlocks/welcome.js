// welcome.js -- Web block: the greeting, with a random piece of web art.

import appConfig from '../config/appConfig.js';
import { getRandomWebArt } from '../utils/webArt.js';

export default {
	name: 'welcome',
	label: 'Welcome',
	view: 'callflow/welcome',
	requiresUser: false,

	async load(ctx) {
		var artPath = await getRandomWebArt('welcome');
		return {
			username: ctx.user ? ctx.user.username : 'Guest',
			boardname: appConfig.get('boardname', 'Canectic BBS'),
			artUrl: artPath ? '/' + artPath : null
		};
	}
};
