// src/routes/api/qnet.js — QWK networking hub over HTTP.
//
// Mounted under /api/v1/qnet. This is Canectic acting as a QWK HUB for a node
// that has a hub-transport connection here. Before it, the hub side had no
// network transport at all: a node could only exchange packets through a
// shared directory (src/external/synchronet/qnet-directory.js), and nothing
// ever called buildQwkForNode(), so a Canectic hub never produced a packet
// for its nodes. The matching client is the `http` transport in
// src/models/qwkTransport.js, which lets one Canectic board be a QWK node of
// another.
//
// Auth is HTTP Basic: the node's QWK ID and the hub connection's password
// (src/utils/qnetAuth.js). A failure is logged to security.log in the form
// the shipped fail2ban filter already matches.
//
//   GET  /hello             who you are to us; the client's connect step
//   GET  /packet            your QWK packet, 204 when there is nothing
//                           (X-Qnet-Packet-Id names it)
//   POST /packet/:id/ack    you have it: advance your HWMs, mark PMs sent
//   POST /rep               your REP, application/octet-stream; queued for
//                           import, 202
//
// An unacknowledged packet is offered again, unchanged, on the next GET, so
// a download that fails part way loses nothing.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as alogger from '../../utils/alogger.js';
import appConfig from '../../config/appConfig.js';
import * as peerConnections from '../../models/peerConnections.js';
import * as qwkPacketBuilder from '../../models/qwkPacketBuilder.js';
import * as networkTransfers from '../../models/networkTransfers.js';
import * as jobs from '../../queues/jobs.js';
import { parseBasic, matchNode, looksLikeZip } from '../../utils/qnetAuth.js';
import { qnetInDir } from '../../utils/qnetPaths.js';
import { logAuthFail } from '../../utils/authFailLog.js';

function clientIp(req) {
	return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function qnetAuth(req, res, next) {
	var creds = parseBasic(req.headers.authorization);
	var conn = null;
	if (creds) {
		try { conn = matchNode(creds, await peerConnections.getActiveConnectionsByNetworkType('QWK')); } catch (_) {}
	}
	if (!conn) {
		if (creds) {
			logAuthFail('failed', 'QWK node ' + creds.user, clientIp(req), 'QWK HTTP');
		}
		res.set('WWW-Authenticate', 'Basic realm="Canectic QWK hub"');
		return res.status(401).json({ error: 'unauthorized' });
	}
	req.qnetConn = conn;
	req.qnetNode = String(conn.connection_data.remote_qwk_id).trim().toUpperCase();
	next();
}

// The hub side of a transfer, for the transfer log. `direction` is the hub's:
// a node's REP arriving is a pull, a packet going out is a push.
async function record(req, direction, result, startedAt) {
	try {
		var r = Object.assign({ status: true, errormessages: [] }, result);
		var row = networkTransfers.rowFor('QWK', direction, req.qnetConn.uuid, req.qnetConn, r, startedAt, new Date());
		row.transport = 'http-hub';
		row.remote_host = clientIp(req);
		await networkTransfers.record(row);
	} catch (_) {}
}

async function handleHello(req, res) {
	res.json({ hub: appConfig.get('boardname', 'Canectic BBS'), node: req.qnetNode, protocol: 1 });
}

async function handlePacket(req, res) {
	var startedAt = new Date();
	var built = await qwkPacketBuilder.buildQwkForNode(req.qnetConn.uuid);
	if (!built.status) {
		await record(req, 'push', { status: false, stage: 'build', errormessages: built.errormessages }, startedAt);
		return res.status(500).json({ error: 'build_failed', message: built.errormessages.join('; ') });
	}
	if (!built.qwkPath) {
		// Nothing for this node: not recorded, since nothing was transferred.
		return res.status(204).end();
	}
	var size = 0;
	try { size = fs.statSync(built.qwkPath).size; } catch (_) {}
	res.set('X-Qnet-Packet-Id', built.packetId || 'legacy');
	res.set('X-Qnet-Messages', String(built.totalMessages || 0));
	res.set('Content-Type', 'application/octet-stream');
	res.set('Content-Disposition', 'attachment; filename="' + path.basename(built.qwkPath) + '"');
	res.sendFile(path.resolve(built.qwkPath), async function (err) {
		await record(req, 'push', err
			? { status: false, stage: 'upload', bytes: size, errormessages: [err.message] }
			: { status: true, stage: 'upload', bytes: size, totalPosted: built.totalMessages }, startedAt);
	});
}

async function handleAck(req, res) {
	var result = await qwkPacketBuilder.commitNodePacket(req.qnetConn.uuid, req.params.id);
	if (!result.status) return res.status(409).json({ error: 'not_committed', message: result.errormessages.join('; ') });
	res.json({ committed: true });
}

function handleRep(req, res) {
	var startedAt = new Date();
	var max = appConfig.getNumber('qnet_max_rep_bytes', 20 * 1024 * 1024);
	var inDir = qnetInDir(req.qnetConn.connection_data);
	try { fs.mkdirSync(inDir, { recursive: true }); } catch (_) {}
	// A unique name, so a second REP arriving before the first is imported
	// does not overwrite it. The hub pull takes them oldest first.
	var name = req.qnetNode + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.rep';
	var tmp = path.join(inDir, '.' + name + '.part');
	var chunks = [], size = 0, refused = false;

	req.on('data', function (chunk) {
		if (refused) return;
		size += chunk.length;
		if (size > max) {
			refused = true;
			record(req, 'pull', { status: false, stage: 'download', bytes: size,
				errormessages: ['REP larger than qnet_max_rep_bytes (' + max + ')'] }, startedAt);
			res.status(413).json({ error: 'too_large', max: max });
			req.destroy();
			return;
		}
		chunks.push(chunk);
	});
	req.on('end', async function () {
		if (refused) return;
		var buf = Buffer.concat(chunks);
		if (!looksLikeZip(buf)) {
			await record(req, 'pull', { status: false, stage: 'extract', bytes: size,
				errormessages: ['Upload is not a REP packet (not a ZIP archive)'] }, startedAt);
			return res.status(400).json({ error: 'not_a_packet' });
		}
		try {
			fs.writeFileSync(tmp, buf);
			fs.renameSync(tmp, path.join(inDir, name));
		} catch (err) {
			try { fs.unlinkSync(tmp); } catch (_) {}
			return res.status(500).json({ error: 'store_failed', message: err.message });
		}
		// The import itself records its own row when the worker runs it.
		try { await jobs.enqueueQwkHubInbound(req.qnetConn.uuid); } catch (err) {
			alogger.writeAlog(2, 'qnet: stored ' + name + ' but could not queue its import: ' + err.message, 'redbright');
		}
		res.status(202).json({ accepted: true, bytes: size });
	});
	req.on('error', function () { try { fs.unlinkSync(tmp); } catch (_) {} });
}

function registerQnetRoutes(parentRouter) {
	parentRouter.get('/qnet/hello', qnetAuth, handleHello);
	parentRouter.get('/qnet/packet', qnetAuth, handlePacket);
	parentRouter.post('/qnet/packet/:id/ack', qnetAuth, handleAck);
	parentRouter.post('/qnet/rep', qnetAuth, handleRep);
}

export { registerQnetRoutes, qnetAuth };
