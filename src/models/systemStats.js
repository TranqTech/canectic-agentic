// src/models/systemStats.js
// Aggregated system statistics for the info panel.

import * as postgres from '../middleware/db/postgres.js';
import appConfig from '../config/appConfig.js';

async function getStats() {
	var queries = await Promise.all([
		postgres.queryOne('SELECT COUNT(*) AS count FROM users'),
		postgres.queryOne('SELECT COUNT(*) AS count FROM calls'),
		postgres.queryOne('SELECT COUNT(*) AS count FROM message_networks'),
		postgres.queryOne('SELECT COUNT(*) AS count FROM message_areas'),
		postgres.queryOne('SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS total_size FROM file_entries WHERE active = true'),
	]);

	return {
		totalUsers:     parseInt(queries[0]?.count) || 0,
		totalCalls:     parseInt(queries[1]?.count) || 0,
		totalNetworks:  parseInt(queries[2]?.count) || 0,
		totalAreas:     parseInt(queries[3]?.count) || 0,
		totalFiles:     parseInt(queries[4]?.count) || 0,
		totalFileSize:  parseInt(queries[4]?.total_size) || 0,
		boardName:      appConfig.get('boardname', 'BBS'),
		sysopName:      appConfig.get('sysopname', 'Sysop'),
		boardLocation:  appConfig.get('boardlocation', ''),
		systemVersion:  appConfig.get('version', ''),
	};
}

function formatFileSize(bytes) {
	if (bytes === 0) return '0 B';
	var units = ['B', 'KB', 'MB', 'GB', 'TB'];
	var i = Math.floor(Math.log(bytes) / Math.log(1024));
	return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

export { getStats, formatFileSize };
