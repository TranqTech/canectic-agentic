// lastCallers.js -- Web block: the most recent callers, terminal and web.

import { getLastCallers } from '../models/callers.js';

export default {
	name: 'lastcallers',
	label: 'Last Callers',
	view: 'callflow/lastcallers',
	requiresUser: false,

	async load() {
		var callers = await getLastCallers(15);
		return { callers: callers || [] };
	}
};
