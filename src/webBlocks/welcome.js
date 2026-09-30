// welcome.js -- Web block: the greeting, with a random piece of web art.

import { catalogEntry } from './catalog.js';
import appConfig from '../config/appConfig.js';
import { getRandomWebArt } from '../utils/webArt.js';

export default Object.assign({}, catalogEntry('welcome'), {
	view: 'callflow/welcome',

	async load(ctx) {
		var artPath = await getRandomWebArt('welcome');
		return {
			username: ctx.user ? ctx.user.username : 'Guest',
			boardname: appConfig.get('boardname', 'Canectic BBS'),
			artUrl: artPath ? '/' + artPath : null
		};
	}
});
