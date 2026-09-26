// src/utils/qnetPaths.js: where a QWK connection keeps its packets (#68).
//
//   qnet/<ID>.hub/{in,out}    a connection where <ID> is our hub (we call it)
//   qnet/<ID>.node/{in,out}   a connection where <ID> is our node (it calls us)
//
// Every connection used qnet/<ID>/ before, so a system that is both our hub
// and our node shared one directory, including one in/extracted/. A REP left
// there by the hub role could then be imported by the next client pull as the
// hub's mail, into the other network's areas. With QWK IDs unique per role
// (#67) the ID and the role are enough to name a directory, so there is
// nothing to configure.
//
// The role is lower case after the LAST dot: IDs are stored upper case and may
// themselves contain dots, so `X.Y.hub` is unambiguous.
//
// The ONE place these paths are built. Pure (path and qwkId only).

import path from 'path';
import { normaliseQwkId, remoteRole } from './qwkId.js';

var ROLE_SUFFIXES = ['hub', 'node'];

function qnetRoot(root) {
	return path.join(root || process.cwd(), 'qnet');
}

function qnetDirName(connectionData) {
	var cd = connectionData || {};
	var id = normaliseQwkId(cd.remote_qwk_id);
	if (!id) throw new Error('QWK connection has no remote QWK ID');
	return id + '.' + remoteRole(cd);
}

function qnetDir(connectionData, root) {
	return path.join(qnetRoot(root), qnetDirName(connectionData));
}

function qnetInDir(connectionData, root) {
	return path.join(qnetDir(connectionData, root), 'in');
}

function qnetOutDir(connectionData, root) {
	return path.join(qnetDir(connectionData, root), 'out');
}

/** Is a directory name under qnet/ already in the per-role layout? */
function isRoleDirName(name) {
	var dot = String(name).lastIndexOf('.');
	return dot > 0 && ROLE_SUFFIXES.indexOf(String(name).slice(dot + 1)) !== -1;
}

export { ROLE_SUFFIXES, qnetRoot, qnetDirName, qnetDir, qnetInDir, qnetOutDir, isRoleDirName };
