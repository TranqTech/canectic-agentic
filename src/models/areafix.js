// areafix.js -- AreaFix automated echomail area manager.
//
// Processes netmail commands from FTN peers to subscribe/unsubscribe
// echomail areas. Authenticates via the areafix_password stored in
// the peer's connection_data. Sends a response netmail with results.
//
// Standard commands (case-insensitive, one per line in body):
//   +AREATAG        Subscribe to area
//   -AREATAG        Unsubscribe from area
//   %LIST           List all available areas
//   %QUERY          List currently subscribed areas
//   %HELP           Show help text
//   %PAUSE          Disable all subscriptions (keep config)
//   %RESUME         Re-enable all subscriptions
//
// Password is in the Subject line of the netmail.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import * as peerConnections from './peerConnections.js';
import * as networkAreas from './networkAreas.js';
import * as peerAreaSubscriptions from './peerAreaSubscriptions.js';
import { Message } from './ftnClasses.js';
import appConfig from '../config/appConfig.js';

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

// Process an AreaFix request netmail.
// ftnMessage: raw FTN Message object from the tosser
// Returns { status, responseLines[] }
async function handleRequest(ftnMessage) {
	var result = { status: false, responseLines: [] };

	var fromAddress = ftnMessage.Source || '';
	var password = (ftnMessage.Subject || '').trim();
	var bodyText = ftnMessage.BodyText || '';

	alogger.writeAlog(2, 'AreaFix: request from ' + fromAddress + ' (' + ftnMessage.FromUser + ')', 'cyan');

	// --- Authenticate: find the peer connection by address and verify password ---
	var auth = await _authenticate(fromAddress, password);
	if (!auth.authenticated) {
		result.responseLines.push('*** AreaFix: Authentication failed');
		result.responseLines.push('');
		result.responseLines.push(auth.reason || 'Invalid address or password');
		alogger.writeAlog(2, 'AreaFix: auth failed for ' + fromAddress + ': ' + auth.reason, 'yellow');
		result.status = true; // Still send the response
		return result;
	}

	var conn = auth.connection;
	var networkId = conn.network_id;

	// --- Parse commands from body ---
	var commands = _parseCommands(bodyText);

	if (commands.length === 0) {
		result.responseLines.push('AreaFix: no commands found in message body.');
		result.responseLines.push('Send %HELP for command reference.');
		result.status = true;
		return result;
	}

	// --- Execute each command ---
	for (var cmd of commands) {
		var lines = await _executeCommand(cmd, conn, networkId);
		for (var line of lines) {
			result.responseLines.push(line);
		}
		result.responseLines.push('');
	}

	alogger.writeAlog(2, 'AreaFix: processed ' + commands.length + ' command(s) for ' + fromAddress, 'greenbright');

	try {
		var notif = await import('./notifications.js');
		await notif.createSysop('areafix_request',
			'AreaFix request from ' + fromAddress,
			commands.length + ' command(s) from ' + (ftnMessage.FromUser || 'unknown'),
			{ severity: 'info', icon: 'diagram-3' }
		);
	} catch (_) {}

	result.status = true;
	return result;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function _authenticate(fromAddress, password) {
	if (!fromAddress) return { authenticated: false, reason: 'No source address' };
	if (!password) return { authenticated: false, reason: 'No password (must be in Subject line)' };

	// Find all FTN connections and match by address in connection_data
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

		// Address matched -- check password
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
// Command parsing
// ---------------------------------------------------------------------------

function _parseCommands(bodyText) {
	var commands = [];
	var lines = bodyText.split(/\r?\n/);

	for (var line of lines) {
		var trimmed = line.trim();
		if (!trimmed) continue;

		// Skip tear line and everything after
		if (trimmed.startsWith('---')) break;

		// Skip kludge lines
		if (trimmed.startsWith('\x01')) continue;

		// %COMMAND
		if (trimmed.startsWith('%')) {
			var cmdName = trimmed.substring(1).split(/\s/)[0].toUpperCase();
			commands.push({ type: 'command', name: cmdName, raw: trimmed });
			continue;
		}

		// +AREATAG (subscribe)
		if (trimmed.startsWith('+')) {
			var tag = trimmed.substring(1).trim().toUpperCase();
			if (tag) commands.push({ type: 'subscribe', areatag: tag, raw: trimmed });
			continue;
		}

		// -AREATAG (unsubscribe)
		if (trimmed.startsWith('-')) {
			var tag = trimmed.substring(1).trim().toUpperCase();
			if (tag) commands.push({ type: 'unsubscribe', areatag: tag, raw: trimmed });
			continue;
		}

		// Bare areatag (treated as subscribe, common convention)
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
				case 'LIST':
					return await _cmdList(conn, networkId);
				case 'QUERY':
					return await _cmdQuery(conn, networkId);
				case 'HELP':
					return _cmdHelp();
				case 'AREAS':
					return await _cmdAreas(conn, networkId);
				case 'PAUSE':
					return await _cmdPause(conn);
				case 'RESUME':
					return await _cmdResume(conn);
				default:
					return ['*** Unknown command: %' + cmd.name];
			}
		default:
			return ['*** Unrecognised: ' + cmd.raw];
	}
}

// +AREATAG -- subscribe (set allowed + enabled on the subscription row)
async function _cmdSubscribe(areatag, conn, networkId) {
	// Find the network area by areatag
	var netArea = await postgres.queryOne(
		'SELECT na.*, ma.name AS area_name FROM network_areas na JOIN message_areas ma ON ma.id = na.area_id WHERE na.network_id = $1 AND UPPER(na.areatag) = $2 AND na.active = true',
		[networkId, areatag]
	);

	if (!netArea) {
		return ['  ' + areatag + ': not found on this network'];
	}

	// Check if subscription row exists
	var sub = await postgres.queryOne(
		'SELECT * FROM peer_area_subscriptions WHERE peer_connection_id = $1 AND area_id = $2',
		[conn.id, netArea.area_id]
	);

	if (sub) {
		if (sub.allowed && sub.enabled) {
			return ['  ' + areatag + ': already subscribed'];
		}
		// Enable it
		await postgres.write(
			'UPDATE peer_area_subscriptions SET allowed = true, enabled = true, updated_at = NOW() WHERE id = $1',
			[sub.id]
		);
		return ['  ' + areatag + ': subscribed (' + (netArea.area_name || areatag) + ')'];
	}

	// Create subscription row
	await postgres.write(
		`INSERT INTO peer_area_subscriptions (peer_connection_id, area_id, allowed, enabled, msg_idx, created_at, updated_at)
		 VALUES ($1, $2, true, true, 0, NOW(), NOW())
		 ON CONFLICT DO NOTHING`,
		[conn.id, netArea.area_id]
	);

	return ['  ' + areatag + ': subscribed (' + (netArea.area_name || areatag) + ')'];
}

// -AREATAG -- unsubscribe (set enabled = false, keep allowed)
async function _cmdUnsubscribe(areatag, conn, networkId) {
	var netArea = await postgres.queryOne(
		'SELECT na.*, ma.name AS area_name FROM network_areas na JOIN message_areas ma ON ma.id = na.area_id WHERE na.network_id = $1 AND UPPER(na.areatag) = $2',
		[networkId, areatag]
	);

	if (!netArea) {
		return ['  ' + areatag + ': not found on this network'];
	}

	var sub = await postgres.queryOne(
		'SELECT * FROM peer_area_subscriptions WHERE peer_connection_id = $1 AND area_id = $2',
		[conn.id, netArea.area_id]
	);

	if (!sub || !sub.enabled) {
		return ['  ' + areatag + ': not currently subscribed'];
	}

	await postgres.write(
		'UPDATE peer_area_subscriptions SET enabled = false, updated_at = NOW() WHERE id = $1',
		[sub.id]
	);

	return ['  ' + areatag + ': unsubscribed'];
}

// %LIST -- list all available areas on this network
async function _cmdList(conn, networkId) {
	var areas = await networkAreas.getAreasByNetwork(networkId);
	if (!areas || areas.length === 0) {
		return ['  No areas available on this network.'];
	}

	// Get current subscriptions for this connection
	var subs = await peerAreaSubscriptions.getEnabledByConnection(conn.id);
	var enabledIds = new Set();
	if (subs) {
		for (var s of subs) enabledIds.add(s.area_id);
	}

	var lines = ['Available areas (' + areas.length + '):'];
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

// %QUERY -- list currently subscribed areas
async function _cmdQuery(conn, networkId) {
	var subs = await peerAreaSubscriptions.getEnabledByConnection(conn.id);
	if (!subs || subs.length === 0) {
		return ['  No areas currently subscribed.'];
	}

	// Get areatags for subscribed areas
	var lines = ['Currently subscribed areas:'];
	lines.push('');

	for (var sub of subs) {
		var netArea = await postgres.queryOne(
			'SELECT na.areatag, ma.name AS area_name FROM network_areas na JOIN message_areas ma ON ma.id = na.area_id WHERE na.network_id = $1 AND na.area_id = $2',
			[networkId, sub.area_id]
		);
		if (netArea) {
			lines.push('  ' + (netArea.areatag || '').padEnd(30) + ' ' + (netArea.area_name || ''));
		}
	}

	return lines;
}

// %HELP
function _cmdHelp() {
	return [
		'AreaFix Command Reference',
		'',
		'Place password in the Subject line.',
		'Commands go in the message body, one per line:',
		'',
		'  +AREATAG        Subscribe to an area',
		'  -AREATAG        Unsubscribe from an area',
		'  AREATAG         Subscribe (same as +AREATAG)',
		'  %LIST           List all available areas (* = subscribed)',
		'  %QUERY          List your currently subscribed areas',
		'  %AREAS          Get areas.bbs format listing (for import)',
		'  %HELP           This help text',
		'  %PAUSE          Disable all area subscriptions',
		'  %RESUME         Re-enable all area subscriptions',
		'',
		'Powered by Canectic BBS'
	];
}

// %AREAS -- output in areas.bbs format (AREATAG description, one per line)
async function _cmdAreas(conn, networkId) {
	var areas = await networkAreas.getAreasByNetwork(networkId);
	if (!areas || areas.length === 0) return ['  No areas available.'];

	var lines = ['; areas.bbs -- ' + appConfig.get('boardname', 'Canectic BBS')];
	lines.push('; Generated ' + new Date().toISOString().split('T')[0]);
	lines.push(';');
	for (var a of areas) {
		var tag = a.areatag || '';
		var name = a.area_name || a.shortcode || '';
		if (tag) lines.push(tag + ' ' + name);
	}

	return lines;
}

// %PAUSE -- disable all subscriptions (keep rows, set enabled=false)
async function _cmdPause(conn) {
	var result = await postgres.write(
		'UPDATE peer_area_subscriptions SET enabled = false, updated_at = NOW() WHERE peer_connection_id = $1 AND enabled = true',
		[conn.id]
	);
	return ['  All area subscriptions paused.'];
}

// %RESUME -- re-enable all allowed subscriptions
async function _cmdResume(conn) {
	var result = await postgres.write(
		'UPDATE peer_area_subscriptions SET enabled = true, updated_at = NOW() WHERE peer_connection_id = $1 AND allowed = true',
		[conn.id]
	);
	return ['  All allowed area subscriptions resumed.'];
}

// ---------------------------------------------------------------------------
// Response netmail builder
// ---------------------------------------------------------------------------

// Build an FTN Message object for the response netmail.
function buildResponse(ftnMessage, responseLines, processorName) {
	var msg = new Message();
	msg.Type = 'Netmail';
	msg.FromUser = processorName || 'AreaFix';
	msg.ToUser = ftnMessage.FromUser || '';
	msg.Subject = 'AreaFix Response';
	msg.Attribute = 0x0001; // Private
	msg.Cost = 0;

	// Swap source/destination
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

	// Add INTL kludge
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
