// nodelistParser.js — FTN nodelist file parser.
//
// Reads a standard FTN nodelist text file and returns an array of parsed
// node entry objects suitable for database import.  Does not touch the DB.
//
// Nodelist format (comma-separated):
//   Keyword,Number,SystemName,Location,SysopName,Phone,Baud,Flag1,Flag2,...
//
// Keywords: Zone, Region, Host, Hub, Pvt, Hold, Down, (empty = regular node)
// Underscores in SystemName/Location/SysopName represent spaces.
//
// Context tracking:
//   - Zone,N    → sets currentZone=N, resets region/net/hub
//   - Region,N  → sets currentRegion=N, resets net/hub
//   - Host,N    → sets currentNet=N, resets hub
//   - Hub,N     → sets currentHub=N
//
// Flag parsing extracts: INA:host, IBN[:port], ITN[:port], CM, IP

import { readFile } from 'fs/promises';

// ---------------------------------------------------------------------------
// parseFlagString — extract connectivity info from comma-separated flags
// ---------------------------------------------------------------------------

function parseFlagString(flags) {
	var result = {
		hostname:        null,
		binkpPort:       null,
		telnetPort:      null,
		isCM:            false,
		isIP:            false,
		isIBN:           false,
		connectionTypes: []
	};

	if (!flags || !Array.isArray(flags)) return result;

	for (var i = 0; i < flags.length; i++) {
		var flag = flags[i].trim();
		if (!flag) continue;

		var upper = flag.toUpperCase();

		if (upper === 'CM') {
			result.isCM = true;
		} else if (upper === 'IP') {
			result.isIP = true;
		} else if (upper.startsWith('INA:')) {
			result.hostname = flag.substring(4).trim() || null;
		} else if (upper === 'IBN') {
			result.isIBN = true;
			if (!result.binkpPort) result.binkpPort = 24554;
		} else if (upper.startsWith('IBN:')) {
			result.isIBN = true;
			var ibnVal = flag.substring(4).trim();
			var ibnPort = parseInt(ibnVal);
			if (!isNaN(ibnPort) && ibnPort > 0 && String(ibnPort) === ibnVal) {
				// Pure number — just a port (e.g. IBN:24554)
				result.binkpPort = ibnPort;
			} else if (ibnVal.includes(':')) {
				// hostname:port format (e.g. IBN:bbs.example.com:24554)
				var ibnParts = ibnVal.split(':');
				if (!result.hostname) result.hostname = ibnParts[0];
				var ibnP = parseInt(ibnParts[1]);
				result.binkpPort = (!isNaN(ibnP) && ibnP > 0) ? ibnP : 24554;
			} else if (ibnVal.length > 0) {
				// Hostname only (e.g. IBN:bbs.example.com)
				if (!result.hostname) result.hostname = ibnVal;
				if (!result.binkpPort) result.binkpPort = 24554;
			} else {
				if (!result.binkpPort) result.binkpPort = 24554;
			}
		} else if (upper === 'ITN') {
			if (!result.telnetPort) result.telnetPort = 23;
		} else if (upper.startsWith('ITN:')) {
			var itnVal = flag.substring(4).trim();
			var itnPort = parseInt(itnVal);
			if (!isNaN(itnPort) && itnPort > 0 && String(itnPort) === itnVal) {
				result.telnetPort = itnPort;
			} else if (itnVal.includes(':')) {
				var itnParts = itnVal.split(':');
				if (!result.hostname) result.hostname = itnParts[0];
				var itnP = parseInt(itnParts[1]);
				result.telnetPort = (!isNaN(itnP) && itnP > 0) ? itnP : 23;
			} else if (itnVal.length > 0) {
				if (!result.hostname) result.hostname = itnVal;
				if (!result.telnetPort) result.telnetPort = 23;
			} else {
				if (!result.telnetPort) result.telnetPort = 23;
			}
		}
	}

	// Infer is_ip from having any IP connectivity (INA, IBN, ITN)
	if (!result.isIP && (result.hostname || result.isIBN || result.telnetPort)) {
		result.isIP = true;
	}

	// Build connection_types array from parsed flags
	if (result.isIBN)                        result.connectionTypes.push('binkp');
	if (result.telnetPort)                   result.connectionTypes.push('telnet');
	if (result.isIP)                         result.connectionTypes.push('ip');

	// Check for additional protocol flags in the raw flag list
	for (var j = 0; j < flags.length; j++) {
		var uf = flags[j].trim().toUpperCase();
		if (uf === 'IVM' || uf.startsWith('IVM:'))   { if (!result.connectionTypes.includes('vmodem'))  result.connectionTypes.push('vmodem'); }
		if (uf === 'ISSH' || uf.startsWith('ISSH:')) { if (!result.connectionTypes.includes('ssh'))     result.connectionTypes.push('ssh'); }
		if (uf === 'IFC' || uf.startsWith('IFC:'))   { if (!result.connectionTypes.includes('ifcico'))  result.connectionTypes.push('ifcico'); }
		if (uf === 'IFT' || uf.startsWith('IFT:'))   { if (!result.connectionTypes.includes('ift'))     result.connectionTypes.push('ift'); }
		if (uf === 'BINK' || uf === 'BND')            { if (!result.connectionTypes.includes('binkd'))   result.connectionTypes.push('binkd'); }
		if (uf === 'ISDN' || uf.startsWith('ISDN:')) { if (!result.connectionTypes.includes('isdn'))    result.connectionTypes.push('isdn'); }
		if (uf === 'IMI' || uf.startsWith('IMI:'))   { if (!result.connectionTypes.includes('imi'))     result.connectionTypes.push('imi'); }
		if (uf === 'IEM' || uf.startsWith('IEM:'))   { if (!result.connectionTypes.includes('email'))   result.connectionTypes.push('email'); }
		if (uf === 'ICM' || uf.startsWith('ICM:'))   { if (!result.connectionTypes.includes('icm'))     result.connectionTypes.push('icm'); }
		if (uf === 'IUC' || uf.startsWith('IUC:'))   { if (!result.connectionTypes.includes('uucp'))    result.connectionTypes.push('uucp'); }
		if (uf === 'IPV6')                            { if (!result.connectionTypes.includes('ipv6'))    result.connectionTypes.push('ipv6'); }
		if (uf === 'INO4')                            { if (!result.connectionTypes.includes('ipv6only')) result.connectionTypes.push('ipv6only'); }
	}

	return result;
}

// ---------------------------------------------------------------------------
// parseNodelistText — parse raw nodelist text, return entries + errors
// ---------------------------------------------------------------------------

function parseNodelistText(text) {
	var entries = [];
	var errors  = [];

	if (!text || typeof text !== 'string') {
		return { entries, errors };
	}

	var lines = text.split(/\r?\n/);

	// Context state
	var currentZone   = 0;
	var currentRegion = 0;
	var currentNet    = 0;
	var currentHub    = null;

	for (var lineNum = 0; lineNum < lines.length; lineNum++) {
		var line = lines[lineNum];

		// Skip blank lines
		if (!line || line.trim().length === 0) continue;

		// Skip comment lines (start with ;)
		if (line.trim().charAt(0) === ';') continue;

		// Split on commas.  Fields 0-6 are positional; 7+ are flags.
		var parts = line.split(',');
		if (parts.length < 7) {
			errors.push({ line: lineNum + 1, text: line, reason: 'Too few fields (need at least 7)' });
			continue;
		}

		var keyword    = parts[0].trim();
		var number     = parseInt(parts[1]);
		var systemName = (parts[2] || '').replace(/_/g, ' ').trim();
		var location   = (parts[3] || '').replace(/_/g, ' ').trim();
		var sysopName  = (parts[4] || '').replace(/_/g, ' ').trim();
		var phone      = (parts[5] || '').trim();
		var baud       = parseInt(parts[6]) || 9600;
		var flagsArray = parts.slice(7);

		if (isNaN(number)) {
			errors.push({ line: lineNum + 1, text: line, reason: 'Invalid node number' });
			continue;
		}

		// Determine address components from keyword and context
		var zone   = currentZone;
		var region = currentRegion;
		var net    = currentNet;
		var node   = number;
		var hubNode = currentHub;
		var upperKw = keyword.toUpperCase();

		if (upperKw === 'ZONE') {
			currentZone   = number;
			currentRegion = 0;
			currentNet    = number;  // zone coord is zone:zone/0
			currentHub    = null;
			zone   = number;
			region = 0;
			net    = number;
			node   = 0;
			hubNode = null;
			keyword = 'Zone';
		} else if (upperKw === 'REGION') {
			currentRegion = number;
			currentNet    = number;  // region coord is zone:region/0
			currentHub    = null;
			zone   = currentZone;
			region = number;
			net    = number;
			node   = 0;
			hubNode = null;
			keyword = 'Region';
		} else if (upperKw === 'HOST') {
			currentNet = number;
			currentHub = null;
			zone   = currentZone;
			region = currentRegion;
			net    = number;
			node   = 0;
			hubNode = null;
			keyword = 'Host';
		} else if (upperKw === 'HUB') {
			currentHub = number;
			zone   = currentZone;
			region = currentRegion;
			net    = currentNet;
			node   = number;
			hubNode = null;  // the hub itself has no hub_node
			keyword = 'Hub';
		} else if (upperKw === 'PVT') {
			zone   = currentZone;
			region = currentRegion;
			net    = currentNet;
			node   = number;
			keyword = 'Pvt';
		} else if (upperKw === 'DOWN') {
			zone   = currentZone;
			region = currentRegion;
			net    = currentNet;
			node   = number;
			keyword = 'Down';
		} else if (upperKw === 'HOLD') {
			zone   = currentZone;
			region = currentRegion;
			net    = currentNet;
			node   = number;
			keyword = 'Hold';
		} else if (keyword === '') {
			// Regular node — inherits current context
			zone   = currentZone;
			region = currentRegion;
			net    = currentNet;
			node   = number;
			keyword = '';
		} else {
			// Unknown keyword — treat as regular but record the keyword
			zone   = currentZone;
			region = currentRegion;
			net    = currentNet;
			node   = number;
		}

		// Parse flags for connectivity info
		var flagInfo = parseFlagString(flagsArray);

		var entry = {
			zone:        zone,
			net:         net,
			node:        node,
			point:       0,
			keyword:     keyword,
			hub_node:    hubNode,
			region:      region,
			system_name: systemName,
			location:    location,
			sysop_name:  sysopName,
			phone:       phone,
			baud:        baud,
			hostname:    flagInfo.hostname,
			binkp_port:  flagInfo.binkpPort,
			telnet_port: flagInfo.telnetPort,
			is_cm:       flagInfo.isCM,
			is_ip:       flagInfo.isIP,
			is_ibn:           flagInfo.isIBN,
			connection_types: flagInfo.connectionTypes,
			flags:            flagsArray.join(',')
		};

		// Add POTS if phone is a real number
		if (phone && phone !== '-Unpublished-' && phone !== 'unpublished' && !phone.startsWith('-')) {
			if (!entry.connection_types.includes('pots')) entry.connection_types.push('pots');
		}

		entries.push(entry);
	}

	return { entries, errors };
}

// ---------------------------------------------------------------------------
// parseNodelistFile — read a file and parse it
// ---------------------------------------------------------------------------

async function parseNodelistFile(filePath) {
	var text = await readFile(filePath, 'latin1');
	return parseNodelistText(text);
}

export {
	parseNodelistFile,
	parseNodelistText,
	parseFlagString
};
