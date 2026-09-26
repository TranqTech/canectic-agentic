// 0008-qnet-role-dirs: move qnet/<ID>/ into qnet/<ID>.hub/ and qnet/<ID>.node/
// (#68).
//
// Every QWK connection used to work in qnet/<REMOTE_QWK_ID>/, so a system that
// was both our hub and our node shared one directory, including one
// in/extracted/, and a leftover from one role could be imported by the other.
// The code now uses one directory per role (src/utils/qnetPaths.js). qnet/ is
// sysop data no release touches, so existing directories are moved here, with
// every packet in flight kept. qnet/<ID> is left as a link to <ID>.node where
// the ID is our node, so a Synchronet node calling through qnet-directory.js
// with the old path keeps working. The rules are in src/maintenance/qnetLayout.js.

import { findLegacyDirs, migrateQnetLayout } from '../../src/maintenance/qnetLayout.js';

export const description = 'Move qnet/<ID>/ into per-role qnet/<ID>.hub/ and qnet/<ID>.node/';
export const phase = 'post';

async function qwkConnections(pg) {
	return (await pg.query(
		"SELECT pc.connection_data FROM peer_connections pc JOIN message_networks mn ON mn.id = pc.network_id " +
		"WHERE mn.network_type = 'QWK'", [])) || [];
}

export async function isNeeded(ctx) {
	var legacy = findLegacyDirs(process.cwd(), await qwkConnections(ctx.postgres));
	return legacy.some(function (d) { return d.roles.length > 0; });
}

export async function run(ctx) {
	var result = migrateQnetLayout(process.cwd(), await qwkConnections(ctx.postgres), ctx.log);
	ctx.log('  moved ' + result.moved.length + ' QWK directory(ies)' +
		(result.kept.length ? ', ' + result.kept.length + ' file(s) left in place' : ''));
}
