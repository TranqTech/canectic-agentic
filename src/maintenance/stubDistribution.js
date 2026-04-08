// maintenance/stubDistribution.js — Generate and distribute coordinator stubs.
//
// Called by the worker when a generate-stub job fires. Generates the
// nodelist segment from managed_nodes, writes the stub file, and
// distributes it according to the segment's distribution_method.

import * as fs from 'fs';
import * as path from 'path';
import * as alogger from '../utils/alogger.js';
import * as managedNodes from '../models/managedNodes.js';
import * as coordinatorSegments from '../models/coordinatorSegments.js';
import * as peerConnections from '../models/peerConnections.js';
import { resolveFileboxPath } from '../utils/fileboxPath.js';
import appConfig from '../config/appConfig.js';

/**
 * Generate a stub for a segment and distribute it.
 *
 * @param {number} segmentId
 * @returns {object} { success, filename, distributed, method, error }
 */
async function generateAndDistribute(segmentId) {
	var segment = await coordinatorSegments.getById(segmentId);
	if (!segment) {
		return { success: false, error: 'Segment not found' };
	}
	if (!segment.active) {
		return { success: false, error: 'Segment inactive' };
	}
	if (segment.source === 'external') {
		return { success: false, error: 'External segments do not generate stubs' };
	}

	// Generate the stub content
	var stubContent = await managedNodes.generateStub(segment.network_id, segmentId);
	if (!stubContent || stubContent.trim().length === 0) {
		alogger.writeAlog(5, '[StubDist] No active nodes for segment: ' + segment.name, 'yellow');
		return { success: false, error: 'No active nodes' };
	}

	// Build filename: stub_filename.DDD (day of year)
	var now = new Date();
	var dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
	var baseName = segment.stub_filename || segment.name.replace(/\s+/g, '').toUpperCase().substring(0, 8);
	var filename = baseName + '.' + String(dayOfYear).padStart(3, '0');

	// Write stub to a temp location
	var tempDir = appConfig.get('MAILER_TEMP_DIR', 'ftn/tmp');
	if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
	var tempPath = path.join(tempDir, filename);
	fs.writeFileSync(tempPath, stubContent, 'utf8');

	alogger.writeAlog(3,
		'[StubDist] Generated stub for ' + segment.name + ': ' + filename +
		' (' + stubContent.split('\n').length + ' lines)',
		'greenbright'
	);

	// Update last_generated_at
	await coordinatorSegments.update(segmentId, { last_generated_at: now });

	// Distribute based on method
	var distributed = false;
	var method = segment.distribution_method || 'manual';

	if (method === 'manual') {
		alogger.writeAlog(5, '[StubDist] Distribution: manual — stub generated but not sent', 'cyan');
	} else if (method === 'filebox') {
		distributed = await _distributeViaFilebox(segment, tempPath, filename);
	} else if (method === 'tic') {
		distributed = await _distributeViaTic(segment, tempPath, filename);
	} else if (method === 'netmail_attach') {
		distributed = await _distributeViaNetmailAttach(segment, tempPath, filename);
	}

	return { success: true, filename, distributed, method };
}

// ---------------------------------------------------------------------------
// Distribution methods
// ---------------------------------------------------------------------------

async function _distributeViaFilebox(segment, stubPath, filename) {
	if (!segment.upstream_connection_id) {
		alogger.writeAlog(3, '[StubDist] Filebox: no upstream connection configured for ' + segment.name, 'yellow');
		return false;
	}

	var conn = await peerConnections.getConnectionById(segment.upstream_connection_id);
	if (!conn) {
		alogger.writeAlog(3, '[StubDist] Filebox: upstream connection not found', 'yellow');
		return false;
	}

	var cd = conn.connection_data || {};
	if (!cd.outbox_dir) {
		alogger.writeAlog(3, '[StubDist] Filebox: upstream connection has no outbox_dir', 'yellow');
		return false;
	}

	var outboxPath = resolveFileboxPath(cd.outbox_dir);
	if (!fs.existsSync(outboxPath)) {
		fs.mkdirSync(outboxPath, { recursive: true });
	}

	var destPath = path.join(outboxPath, filename);
	try {
		fs.copyFileSync(stubPath, destPath);
		alogger.writeAlog(3, '[StubDist] Placed stub in filebox: ' + destPath, 'greenbright');
		return true;
	} catch (err) {
		alogger.writeAlog(3, '[StubDist] Filebox copy failed: ' + err.message, 'redbright');
		return false;
	}
}

async function _distributeViaTic(segment, stubPath, filename) {
	// Stage the stub in the outbound directory with a .flo entry for the upstream peer
	if (!segment.upstream_connection_id) {
		alogger.writeAlog(3, '[StubDist] TIC: no upstream connection configured', 'yellow');
		return false;
	}

	var conn = await peerConnections.getConnectionById(segment.upstream_connection_id);
	if (!conn) {
		alogger.writeAlog(3, '[StubDist] TIC: upstream connection not found', 'yellow');
		return false;
	}

	var cd = conn.connection_data || {};
	var address = cd.address || '';
	if (!address) {
		alogger.writeAlog(3, '[StubDist] TIC: upstream has no FTN address', 'yellow');
		return false;
	}

	// Parse address for BSO hex naming
	var addrParts = address.split(':');
	var nnParts = (addrParts[1] || '').split('/');
	var zone = parseInt(addrParts[0]) || 1;
	var net = parseInt(nnParts[0]) || 0;
	var node = parseInt(nnParts[1]) || 0;

	var netHex = net.toString(16).padStart(4, '0');
	var nodeHex = node.toString(16).padStart(4, '0');
	var destHex = netHex + nodeHex;

	// Resolve zone-aware outbound dir
	var baseDir = appConfig.get('ftnoutbound', 'ftn/out');
	var outDir = zone === 1 ? baseDir : baseDir + '.' + zone.toString(16).padStart(3, '0');
	if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

	// Copy stub to outbound
	var outPath = path.join(outDir, filename);
	fs.copyFileSync(stubPath, outPath);

	// Create .flo entry
	var floPath = path.join(outDir, destHex + '.flo');
	fs.appendFileSync(floPath, '^' + outPath + '\r\n');

	alogger.writeAlog(3, '[StubDist] Staged stub for BSO delivery to ' + address + ': ' + filename, 'greenbright');

	// Trigger BSO scan
	try {
		var jobs = await import('../queues/jobs.js');
		await jobs.enqueueMailerBsoScan();
	} catch (_) {}

	return true;
}

async function _distributeViaNetmailAttach(segment, stubPath, filename) {
	// Create a netmail with file-attach flag to the upstream address
	if (!segment.upstream_address) {
		alogger.writeAlog(3, '[StubDist] Netmail attach: no upstream address configured', 'yellow');
		return false;
	}

	// For now, use the same BSO flow file approach as TIC
	// A proper netmail file-attach would create a netmail message with the 0x0010 flag
	// and reference the file. For Phase 2, BSO direct delivery covers the use case.
	alogger.writeAlog(3, '[StubDist] Netmail attach: falling back to BSO delivery for ' + segment.upstream_address, 'cyan');

	// Reuse the TIC method since it creates the .flo entry
	return await _distributeViaTic(segment, stubPath, filename);
}

export { generateAndDistribute };
