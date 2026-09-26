// src/maintenance/qwkIdAudit.js: tell the sysop about QWK IDs that break the
// rules (#67), found at gateway startup.
//
// Saves are checked from #67 on, but a board upgraded into it may already hold
// an ID that is too long, has a character Synchronet refuses, or is used twice
// in the same role. Refusing those at startup would stop a working link, so
// they are reported instead. One notification per distinct set of problems:
// the same list is not raised again on every restart, and a changed list is.
// Never throws, since a notice must not stop the gateway starting.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { auditQwkIds } from '../utils/qwkId.js';

var NOTIFY_TYPE = 'qwk_id_problem';

async function auditQwkIdsAndNotify() {
	try {
		var peerConnections = await import('../models/peerConnections.js');
		var msgNetworks = await import('../models/msgNetworks.js');
		var conns = await peerConnections.getQwkConnectionsForIdCheck();
		var nets = await msgNetworks.getNetworksByType('QWK');
		var networks = new Map();
		for (var n of nets || []) networks.set(String(n.id), n);
		var addresses = (await postgres.query(
			`SELECT sa.address, sa.network_id FROM system_addresses sa
			 JOIN message_networks mn ON mn.id = sa.network_id
			 WHERE mn.network_type = 'QWK' AND sa.active = true ORDER BY sa.id`, [])) || [];

		var lines = auditQwkIds(conns, addresses, networks);
		if (lines.length === 0) return { problems: 0, notified: false };

		for (var l of lines) alogger.writeAlog(2, '[QWK IDs] ' + l, 'yellow');
		var body = 'These QWK IDs break the rules new saves are held to. They keep working as they are, ' +
			'but each will be refused the next time its connection or address is saved until it is fixed. ' +
			'Duplicates in the same role share one packet and one directory, so fix those first.\n\n' +
			lines.map(function (x) { return '- ' + x; }).join('\n');

		var seen = await postgres.queryOne(
			'SELECT id FROM notifications WHERE type = $1 AND body = $2 LIMIT 1', [NOTIFY_TYPE, body]);
		if (seen) return { problems: lines.length, notified: false };

		var notifications = await import('../models/notifications.js');
		await notifications.createSysop(NOTIFY_TYPE,
			lines.length + ' QWK ID problem' + (lines.length === 1 ? '' : 's') + ' to fix', body,
			{ severity: 'warning', icon: 'exclamation-triangle', link: '/admin/peers' });
		return { problems: lines.length, notified: true };
	} catch (err) {
		alogger.writeAlog(2, '[QWK IDs] audit failed: ' + err.message, 'yellow');
		return { problems: 0, notified: false, error: err.message };
	}
}

export { auditQwkIdsAndNotify, NOTIFY_TYPE };
