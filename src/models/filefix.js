// filefix.js -- FileFix automated TIC file area manager.
//
// Processes netmail commands from FTN peers to subscribe/unsubscribe
// TIC file distribution areas. Parallel to AreaFix for file areas.
// Same command set, same authentication (uses areafix_password).
//
// Standard commands (case-insensitive, one per line in body):
//   +AREATAG        Subscribe to file area
//   -AREATAG        Unsubscribe from file area
//   %LIST           List all available file areas
//   %QUERY          List currently subscribed file areas
//   %HELP           Show help text
//   %PAUSE          Disable all subscriptions
//   %RESUME         Re-enable all subscriptions

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as fileNetworkAreas from './fileNetworkAreas.js';
import { Message } from './ftnClasses.js';
import appConfig from '../config/appConfig.js';

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleRequest(ftnMessage) {
	var result = { status: false, responseLines: [] };

	var fromAddress = ftnMessage.Source || '';
	var password = (ftnMessage.Subject || '').trim();
	var bodyText = ftnMessage.BodyText || '';

	alogger.writeAlog(2, 'FileFix: request from ' + fromAddress + ' (' + ftnMessage.FromUser + ')', 'cyan');

	// --- Authenticate (same mechanism as AreaFix) ---
	var auth = await _authenticate(fromAddress, password);
	if (!auth.authenticated) {
		result.responseLines.push('*** FileFix: Authentication failed');
		result.responseLines.push('');
		result.responseLines.push(auth.reason || 'Invalid address or password');
		alogger.writeAlog(2, 'FileFix: auth failed for ' + fromAddress + ': ' + auth.reason, 'yellow');
		result.status = true;
		return result;
	}

	var conn = auth.connection;
	var networkId = conn.network_id;

	var commands = _parseCommands(bodyText);

	if (commands.length === 0) {
		result.responseLines.push('FileFix: no commands found in message body.');
		result.responseLines.push('Send %HELP for command reference.');
		result.status = true;
		return result;
	}

	for (var cmd of commands) {
		var lines = await _executeCommand(cmd, conn, networkId);
		for (var line of lines) {
			result.responseLines.push(line);
		}
		result.responseLines.push('');
	}

	alogger.writeAlog(2, 'FileFix: processed ' + commands.length + ' command(s) for ' + fromAddress, 'greenbright');

	try {
		var notif = await import('./notifications.js');
		await notif.createSysop('filefix_request',
			'FileFix request from ' + fromAddress,
			commands.length + ' command(s) from ' + (ftnMessage.FromUser || 'unknown'),
			{ severity: 'info', icon: 'file-earmark-arrow-down' }
		);
	} catch (_) {}

	result.status = true;
	return result;
}

// ---------------------------------------------------------------------------
// Authentication (shared pattern with AreaFix)
// ---------------------------------------------------------------------------

async function _authenticate(fromAddress, password) {
	if (!fromAddress) return { authenticated: false, reason: 'No source address' };
	if (!password) return { authenticated: false, reason: 'No password (must be in Subject line)' };

	var allConns = await postgres.query(
		`SELECT pc.*, mn.id AS network_id, mn.network_type
		 FROM peer_connections pc
		 JOIN message_networks mn ON mn.id = pc.network_id
		 WHERE mn.network_type = 'FTN' AND pc.active = true`,
		[]
	);

	if (!allConns) return { authenticated: false, reason: 'No active FTN connections' };

	var normalised = fromAddress.trim().toLowerCase();

	for (var conn of allConns) {
		var cd = conn.connection_data;
		if (typeof cd === 'string') {
			try { cd = JSON.parse(cd); } catch (_) { continue; }
		}
		if (!cd || !cd.address) continue;

		var connAddr = cd.address.trim().toLowerCase();
		if (connAddr !== normalised) continue;

		var areafixPw = (cd.areafix_password || '').trim();
		if (!areafixPw) {
			return { authenticated: false, reason: 'No AreaFix password configured for this connection' };
		}
		if (areafixPw !== password) {
			return { authenticated: false, reason: 'Incorrect password' };
		}

		return { authenticated: true, connection: conn };
	}

	return { authenticated: false, reason: 'No connection found for address ' + fromAddress };
}

// ---------------------------------------------------------------------------
// Command parsing (identical to AreaFix)
// ---------------------------------------------------------------------------

function _parseCommands(bodyText) {
	var commands = [];
	var lines = bodyText.split(/\r?\n/);

	for (var line of lines) {
		var trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith('---')) break;
		if (trimmed.startsWith('\x01')) continue;

		if (trimmed.startsWith('%')) {
			var cmdName = trimmed.substring(1).split(/\s/)[0].toUpperCase();
			commands.push({ type: 'command', name: cmdName, raw: trimmed });
			continue;
		}

		if (trimmed.startsWith('+')) {
			var tag = trimmed.substring(1).trim().toUpperCase();
			if (tag) commands.push({ type: 'subscribe', areatag: tag, raw: trimmed });
			continue;
		}

		if (trimmed.startsWith('-')) {
			var tag = trimmed.substring(1).trim().toUpperCase();
			if (tag) commands.push({ type: 'unsubscribe', areatag: tag, raw: trimmed });
			continue;
		}

		var bareTag = trimmed.toUpperCase();
		if (/^[A-Z0-9._-]+$/.test(bareTag)) {
			commands.push({ type: 'subscribe', areatag: bareTag, raw: trimmed });
		}
	}

	return commands;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

async function _executeCommand(cmd, conn, networkId) {
	switch (cmd.type) {
		case 'subscribe':
			return await _cmdSubscribe(cmd.areatag, conn, networkId);
		case 'unsubscribe':
			return await _cmdUnsubscribe(cmd.areatag, conn, networkId);
		case 'command':
			switch (cmd.name) {
				case 'LIST':   return await _cmdList(conn, networkId);
				case 'QUERY':  return await _cmdQuery(conn, networkId);
				case 'HELP':   return _cmdHelp();
				case 'PAUSE':  return await _cmdPause(conn);
				case 'AREAS':  return await _cmdAreas(conn, networkId);
				case 'RESUME': return await _cmdResume(conn);
				default:       return ['*** Unknown command: %' + cmd.name];
			}
		default:
			return ['*** Unrecognised: ' + cmd.raw];
	}
}

async function _cmdSubscribe(areatag, conn, networkId) {
	var netArea = await postgres.queryOne(
		`SELECT fna.*, fa.name AS area_name
		 FROM file_network_areas fna
		 JOIN file_areas fa ON fa.id = fna.area_id
		 WHERE fna.network_id = $1 AND UPPER(fna.areatag) = $2 AND fna.active = true`,
		[networkId, areatag]
	);

	if (!netArea) return ['  ' + areatag + ': not found on this network'];

	var sub = await postgres.queryOne(
		'SELECT * FROM file_peer_subscriptions WHERE peer_connection_id = $1 AND file_area_id = $2',
		[conn.id, netArea.area_id]
	);

	if (sub) {
		if (sub.allowed && sub.enabled) {
			return ['  ' + areatag + ': already subscribed'];
		}
		await postgres.write(
			'UPDATE file_peer_subscriptions SET allowed = true, enabled = true, updated_at = NOW() WHERE id = $1',
			[sub.id]
		);
		return ['  ' + areatag + ': subscribed (' + (netArea.area_name || areatag) + ')'];
	}

	await postgres.write(
		`INSERT INTO file_peer_subscriptions (peer_connection_id, file_area_id, allowed, enabled, created_at, updated_at)
		 VALUES ($1, $2, true, true, NOW(), NOW())
		 ON CONFLICT DO NOTHING`,
		[conn.id, netArea.area_id]
	);

	return ['  ' + areatag + ': subscribed (' + (netArea.area_name || areatag) + ')'];
}

async function _cmdUnsubscribe(areatag, conn, networkId) {
	var netArea = await postgres.queryOne(
		`SELECT fna.*, fa.name AS area_name
		 FROM file_network_areas fna
		 JOIN file_areas fa ON fa.id = fna.area_id
		 WHERE fna.network_id = $1 AND UPPER(fna.areatag) = $2`,
		[networkId, areatag]
	);

	if (!netArea) return ['  ' + areatag + ': not found on this network'];

	var sub = await postgres.queryOne(
		'SELECT * FROM file_peer_subscriptions WHERE peer_connection_id = $1 AND file_area_id = $2',
		[conn.id, netArea.area_id]
	);

	if (!sub || !sub.enabled) return ['  ' + areatag + ': not currently subscribed'];

	await postgres.write(
		'UPDATE file_peer_subscriptions SET enabled = false, updated_at = NOW() WHERE id = $1',
		[sub.id]
	);

	return ['  ' + areatag + ': unsubscribed'];
}

async function _cmdList(conn, networkId) {
	var areas = await fileNetworkAreas.getMappingsForNetwork(networkId);
	if (!areas || areas.length === 0) return ['  No file areas available on this network.'];

	var subs = await postgres.query(
		'SELECT file_area_id FROM file_peer_subscriptions WHERE peer_connection_id = $1 AND allowed = true AND enabled = true',
		[conn.id]
	);
	var enabledIds = new Set();
	if (subs) {
		for (var s of subs) enabledIds.add(s.file_area_id);
	}

	var lines = ['Available file areas (' + areas.length + '):'];
	lines.push('');
	for (var a of areas) {
		var marker = enabledIds.has(a.area_id) ? '*' : ' ';
		var tag = (a.areatag || '').padEnd(30);
		var name = a.area_name || a.shortcode || '';
		lines.push('  ' + marker + ' ' + tag + ' ' + name);
	}
	lines.push('');
	lines.push('* = currently subscribed');

	return lines;
}

async function _cmdQuery(conn, networkId) {
	var subs = await postgres.query(
		'SELECT fps.file_area_id FROM file_peer_subscriptions fps WHERE fps.peer_connection_id = $1 AND fps.allowed = true AND fps.enabled = true',
		[conn.id]
	);
	if (!subs || subs.length === 0) return ['  No file areas currently subscribed.'];

	var lines = ['Currently subscribed file areas:'];
	lines.push('');

	for (var sub of subs) {
		var netArea = await postgres.queryOne(
			'SELECT fna.areatag, fa.name AS area_name FROM file_network_areas fna JOIN file_areas fa ON fa.id = fna.area_id WHERE fna.network_id = $1 AND fna.area_id = $2',
			[networkId, sub.file_area_id]
		);
		if (netArea) {
			lines.push('  ' + (netArea.areatag || '').padEnd(30) + ' ' + (netArea.area_name || ''));
		}
	}

	return lines;
}

function _cmdHelp() {
	return [
		'FileFix Command Reference',
		'',
		'Place password in the Subject line.',
		'Commands go in the message body, one per line:',
		'',
		'  +AREATAG        Subscribe to a file area',
		'  -AREATAG        Unsubscribe from a file area',
		'  AREATAG         Subscribe (same as +AREATAG)',
		'  %LIST           List all available file areas (* = subscribed)',
		'  %QUERY          List your currently subscribed file areas',
		'  %AREAS          Get areas.bbs format listing (for import)',
		'  %HELP           This help text',
		'  %PAUSE          Disable all file area subscriptions',
		'  %RESUME         Re-enable all file area subscriptions',
		'',
		'Powered by Canectic BBS'
	];
}

async function _cmdAreas(conn, networkId) {
	var areas = await fileNetworkAreas.getMappingsForNetwork(networkId);
	if (!areas || areas.length === 0) return ['  No file areas available.'];

	var lines = ['; files.bbs -- ' + appConfig.get('boardname', 'Canectic BBS')];
	lines.push('; Generated ' + new Date().toISOString().split('T')[0]);
	lines.push(';');
	for (var a of areas) {
		var tag = a.areatag || '';
		var name = a.area_name || a.shortcode || '';
		if (tag) lines.push(tag + ' ' + name);
	}

	return lines;
}

async function _cmdPause(conn) {
	await postgres.write(
		'UPDATE file_peer_subscriptions SET enabled = false, updated_at = NOW() WHERE peer_connection_id = $1 AND enabled = true',
		[conn.id]
	);
	return ['  All file area subscriptions paused.'];
}

async function _cmdResume(conn) {
	await postgres.write(
		'UPDATE file_peer_subscriptions SET enabled = true, updated_at = NOW() WHERE peer_connection_id = $1 AND allowed = true',
		[conn.id]
	);
	return ['  All allowed file area subscriptions resumed.'];
}

// ---------------------------------------------------------------------------
// Response netmail builder
// ---------------------------------------------------------------------------

function buildResponse(ftnMessage, responseLines, processorName) {
	var msg = new Message();
	msg.Type = 'Netmail';
	msg.FromUser = processorName || 'FileFix';
	msg.ToUser = ftnMessage.FromUser || '';
	msg.Subject = 'FileFix Response';
	msg.Attribute = 0x0001;
	msg.Cost = 0;

	msg.SourceZone = ftnMessage.DestinationZone;
	msg.SourceNet = ftnMessage.DestinationNet;
	msg.SourceNode = ftnMessage.DestinationNode;
	msg.Source = ftnMessage.Destination;
	msg.DestinationZone = ftnMessage.SourceZone;
	msg.DestinationNet = ftnMessage.SourceNet;
	msg.DestinationNode = ftnMessage.SourceNode;
	msg.Destination = ftnMessage.Source;

	msg.BodyText = responseLines.join('\r') + '\r';
	msg.OptionalAttributes = [];

	if (msg.Destination && msg.Source) {
		msg.OptionalAttributes.push({ attribute: 'INTL', value: msg.Destination + ' ' + msg.Source });
	}

	return msg;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	handleRequest,
	buildResponse,
	_parseCommands,
	_authenticate
};
