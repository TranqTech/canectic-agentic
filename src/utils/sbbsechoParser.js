// sbbsechoParser.js -- Parse Synchronet sbbsecho.ini files.
//
// Extracts linked node definitions ([node:*]) and domain/network definitions
// ([domain:*]) from the INI-style config file. Skips global settings, archive
// definitions, echolist paths, and robot configs.
//
// Wildcard routing entries (address containing 'ALL') are filtered out -- these
// are routing rules, not real peer connections.
//
// Auto-groups nodes into proposed peer groups by matching BinkpHost (primary)
// and Name (secondary). Ungrouped nodes become singleton groups.
//
// Returns { nodes[], domains[], groups[] }.

// ---------------------------------------------------------------------------
// Section header parser
// ---------------------------------------------------------------------------

var NODE_HEADER_RE = /^\[node:(.+)\]$/i;
var DOMAIN_HEADER_RE = /^\[domain:(.+)\]$/i;
var SKIP_HEADER_RE = /^\[(archive|echolist|robot|binkp):/i;
var ANY_HEADER_RE = /^\[.+\]$/;

// Parse a node address from the section header value.
// Formats: "1:134/100@fidonet", "1:134/100", "999:999/999"
// Returns { zone, net, node, point, domain, address } or null if wildcard/invalid.
function parseNodeAddress(raw) {
	raw = raw.trim();

	// Split off @domain if present
	var domain = '';
	var atIdx = raw.indexOf('@');
	if (atIdx !== -1) {
		domain = raw.substring(atIdx + 1).trim().toLowerCase();
		raw = raw.substring(0, atIdx).trim();
	}

	// Skip wildcard entries (e.g. "1:ALL@fidonet")
	if (/\bALL\b/i.test(raw)) return null;

	// Parse Z:N/N or Z:N/N.P
	var match = raw.match(/^(\d+):(\d+)\/(\d+)(?:\.(\d+))?$/);
	if (!match) return null;

	return {
		zone:    parseInt(match[1]),
		net:     parseInt(match[2]),
		node:    parseInt(match[3]),
		point:   match[4] ? parseInt(match[4]) : 0,
		domain:  domain,
		address: raw + (domain ? '@' + domain : '')
	};
}

// ---------------------------------------------------------------------------
// INI parser
// ---------------------------------------------------------------------------

function parseSbbsecho(text) {
	if (!text) return { nodes: [], domains: [], groups: [] };

	var lines = text.split(/\r?\n/);
	var nodes = [];
	var domains = [];

	var currentSection = null;  // 'node', 'domain', 'skip', 'global'
	var currentObj = null;

	function flushSection() {
		if (!currentObj) return;
		if (currentSection === 'node') {
			nodes.push(currentObj);
		} else if (currentSection === 'domain') {
			domains.push(currentObj);
		}
		currentObj = null;
		currentSection = null;
	}

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i].trim();

		// Blank lines and comments
		if (!line || line.charAt(0) === ';') continue;

		// Check for section headers
		var nodeMatch = line.match(NODE_HEADER_RE);
		if (nodeMatch) {
			flushSection();
			var addr = parseNodeAddress(nodeMatch[1]);
			if (addr) {
				currentSection = 'node';
				currentObj = {
					zone:           addr.zone,
					net:            addr.net,
					node:           addr.node,
					point:          addr.point,
					domain:         addr.domain,
					address:        addr.address,
					ftn_address:    addr.zone + ':' + addr.net + '/' + addr.node + (addr.point ? '.' + addr.point : ''),
					name:           '',
					comment:        '',
					session_password: '',
					packet_password:  '',
					areafix_password: '',
					tic_password:     '',
					binkp_host:     '',
					binkp_port:     24554,
					binkp_poll:     false,
					local_address:  '',
					direct:         false,
					route:          '',
					status:         'NORMAL',
					group_hub:      ''
				};
			} else {
				currentSection = 'skip';
			}
			continue;
		}

		var domainMatch = line.match(DOMAIN_HEADER_RE);
		if (domainMatch) {
			flushSection();
			currentSection = 'domain';
			currentObj = {
				name:       domainMatch[1].trim().toLowerCase(),
				zones:      [],
				dns_suffix: '',
				nodelist:   ''
			};
			continue;
		}

		if (SKIP_HEADER_RE.test(line) || (ANY_HEADER_RE.test(line) && !nodeMatch && !domainMatch)) {
			flushSection();
			currentSection = 'skip';
			continue;
		}

		// Key = value pairs within a section
		if (currentSection === 'skip' || currentSection === 'global' || !currentObj) continue;

		var eqIdx = line.indexOf('=');
		if (eqIdx === -1) continue;

		var key = line.substring(0, eqIdx).trim().toLowerCase();
		var val = line.substring(eqIdx + 1).trim();

		if (currentSection === 'node') {
			switch (key) {
				case 'name':            currentObj.name = val; break;
				case 'comment':         currentObj.comment = val; break;
				case 'sessionpwd':      currentObj.session_password = val; break;
				case 'packetpwd':       currentObj.packet_password = val; break;
				case 'areafixpwd':      currentObj.areafix_password = val; break;
				case 'ticfilepwd':      currentObj.tic_password = val; break;
				case 'binkphost':       currentObj.binkp_host = val; break;
				case 'binkpport':       currentObj.binkp_port = val ? parseInt(val) || 24554 : 24554; break;
				case 'binkppoll':       currentObj.binkp_poll = val.toLowerCase() === 'true'; break;
				case 'localaddress':    currentObj.local_address = val; break;
				case 'direct':          currentObj.direct = val.toLowerCase() === 'true'; break;
				case 'route':           currentObj.route = val; break;
				case 'status':          currentObj.status = val.toUpperCase().trim() === 'CRASH' ? 'CRASH' : 'NORMAL'; break;
				case 'grouphub':        currentObj.group_hub = val; break;
			}
		} else if (currentSection === 'domain') {
			switch (key) {
				case 'zones':      currentObj.zones = val.split(',').map(function(z) { return parseInt(z.trim()); }).filter(function(z) { return !isNaN(z); }); break;
				case 'dnssuffix':  currentObj.dns_suffix = val; break;
				case 'nodelist':   currentObj.nodelist = val; break;
			}
		}
	}

	flushSection();

	// Filter domains to only those referenced by at least one real node
	var usedDomains = new Set();
	for (var n = 0; n < nodes.length; n++) {
		if (nodes[n].domain) usedDomains.add(nodes[n].domain);
	}
	domains = domains.filter(function(d) { return usedDomains.has(d.name); });

	// Auto-group nodes into proposed peer groups
	var groups = autoGroupNodes(nodes);

	return { nodes: nodes, domains: domains, groups: groups };
}

// ---------------------------------------------------------------------------
// Auto-grouping
// ---------------------------------------------------------------------------

function autoGroupNodes(nodes) {
	var groups = [];
	var assigned = new Set();

	// Pass 1: Group by BinkpHost (non-empty, case-insensitive)
	var hostMap = {};
	for (var i = 0; i < nodes.length; i++) {
		var host = (nodes[i].binkp_host || '').trim().toLowerCase();
		if (!host) continue;
		if (!hostMap[host]) hostMap[host] = [];
		hostMap[host].push(i);
	}
	for (var host in hostMap) {
		if (!hostMap.hasOwnProperty(host)) continue;
		var indices = hostMap[host];
		// Pick the best name from the group (first non-empty)
		var groupName = '';
		for (var j = 0; j < indices.length; j++) {
			if (nodes[indices[j]].name) {
				groupName = nodes[indices[j]].name;
				break;
			}
		}
		groups.push({
			peer_name:  groupName || host,
			sysop_name: '',
			node_indices: indices.slice()
		});
		for (var j = 0; j < indices.length; j++) {
			assigned.add(indices[j]);
		}
	}

	// Pass 2: Group remaining by Name (non-empty, case-insensitive)
	var nameMap = {};
	for (var i = 0; i < nodes.length; i++) {
		if (assigned.has(i)) continue;
		var name = (nodes[i].name || '').trim().toLowerCase();
		if (!name) continue;
		if (!nameMap[name]) nameMap[name] = [];
		nameMap[name].push(i);
	}
	for (var name in nameMap) {
		if (!nameMap.hasOwnProperty(name)) continue;
		var indices = nameMap[name];
		groups.push({
			peer_name:  nodes[indices[0]].name || name,
			sysop_name: '',
			node_indices: indices.slice()
		});
		for (var j = 0; j < indices.length; j++) {
			assigned.add(indices[j]);
		}
	}

	// Pass 3: Remaining unmatched nodes become singleton groups
	for (var i = 0; i < nodes.length; i++) {
		if (assigned.has(i)) continue;
		groups.push({
			peer_name:  nodes[i].name || nodes[i].ftn_address,
			sysop_name: '',
			node_indices: [i]
		});
	}

	return groups;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { parseSbbsecho, parseNodeAddress };
