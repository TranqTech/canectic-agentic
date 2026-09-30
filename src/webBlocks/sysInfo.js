// sysInfo.js -- Web block: board details and system statistics, as on /stats.

import { catalogEntry } from './catalog.js';
import { getStats, formatFileSize } from '../models/systemStats.js';

export default Object.assign({}, catalogEntry('sysinfo'), {
	view: 'callflow/sysinfo',

	async load() {
		return { stats: await getStats(), formatFileSize: formatFileSize };
	}
});
