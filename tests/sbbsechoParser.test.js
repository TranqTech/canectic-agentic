// tests/sbbsechoParser.test.js -- Unit tests for src/utils/sbbsechoParser.js
//
// Tests parseSbbsecho(text) and parseNodeAddress(raw). No DB, Redis, or
// filesystem access -- both functions are pure transforms on strings/objects.
//
// Run: npx mocha tests/sbbsechoParser.test.js

import assert from 'assert';
import { parseSbbsecho, parseNodeAddress } from '../src/utils/sbbsechoParser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Produce a minimal but valid node section block.
function nodeSection(header, kvPairs) {
	var lines = ['[node:' + header + ']'];
	for (var key in kvPairs) {
		if (kvPairs.hasOwnProperty(key)) {
			lines.push(key + '=' + kvPairs[key]);
		}
	}
	return lines.join('\n');
}

// Produce a minimal domain section block.
function domainSection(name, kvPairs) {
	var lines = ['[domain:' + name + ']'];
	for (var key in kvPairs) {
		if (kvPairs.hasOwnProperty(key)) {
			lines.push(key + '=' + kvPairs[key]);
		}
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// parseNodeAddress
// ---------------------------------------------------------------------------

describe('parseNodeAddress', function () {

	describe('standard addresses', function () {

		it('should parse a full address with domain', function () {
			var result = parseNodeAddress('1:134/100@fidonet');
			assert.strictEqual(result.zone,    1);
			assert.strictEqual(result.net,     134);
			assert.strictEqual(result.node,    100);
			assert.strictEqual(result.point,   0);
			assert.strictEqual(result.domain,  'fidonet');
			assert.strictEqual(result.address, '1:134/100@fidonet');
		});

		it('should parse an address without domain', function () {
			var result = parseNodeAddress('999:999/999');
			assert.strictEqual(result.zone,    999);
			assert.strictEqual(result.net,     999);
			assert.strictEqual(result.node,    999);
			assert.strictEqual(result.domain,  '');
			assert.strictEqual(result.address, '999:999/999');
		});

		it('should parse an address with a point', function () {
			var result = parseNodeAddress('1:134/100.1@fidonet');
			assert.strictEqual(result.zone,  1);
			assert.strictEqual(result.net,   134);
			assert.strictEqual(result.node,  100);
			assert.strictEqual(result.point, 1);
		});

		it('should include point in ftn_address-style raw when point is non-zero', function () {
			var result = parseNodeAddress('1:134/100.3@fidonet');
			// address field omits the domain suffix behaviour: raw part is 1:134/100.3
			assert.strictEqual(result.address, '1:134/100.3@fidonet');
		});

		it('should return point 0 when no point is present', function () {
			var result = parseNodeAddress('2:20/228@fidonet');
			assert.strictEqual(result.point, 0);
		});

		it('should lowercase the domain', function () {
			var result = parseNodeAddress('1:1/1@FidoNet');
			assert.strictEqual(result.domain, 'fidonet');
		});

		it('should trim surrounding whitespace before parsing', function () {
			var result = parseNodeAddress('  1:134/100@fidonet  ');
			assert.strictEqual(result.zone, 1);
		});

	});

	describe('wildcard entries', function () {

		it('should return null for ALL wildcard in net position', function () {
			var result = parseNodeAddress('1:ALL@fidonet');
			assert.strictEqual(result, null);
		});

		it('should return null for ALL wildcard in different zone', function () {
			var result = parseNodeAddress('2:ALL@fidonet');
			assert.strictEqual(result, null);
		});

		it('should return null for ALL wildcard without domain', function () {
			var result = parseNodeAddress('3:ALL');
			assert.strictEqual(result, null);
		});

		it('should return null for ALL in the node position', function () {
			var result = parseNodeAddress('1:134/ALL@fidonet');
			assert.strictEqual(result, null);
		});

	});

	describe('invalid formats', function () {

		it('should return null for empty string', function () {
			var result = parseNodeAddress('');
			assert.strictEqual(result, null);
		});

		it('should return null for a bare hostname with no FTN address', function () {
			var result = parseNodeAddress('bbs.example.org');
			assert.strictEqual(result, null);
		});

		it('should return null for partial FTN address missing node', function () {
			var result = parseNodeAddress('1:134');
			assert.strictEqual(result, null);
		});

		it('should return null for non-numeric zone', function () {
			var result = parseNodeAddress('X:134/100');
			assert.strictEqual(result, null);
		});

		it('should return null for purely alpha content', function () {
			var result = parseNodeAddress('not:an/address');
			assert.strictEqual(result, null);
		});

	});

});

// ---------------------------------------------------------------------------
// parseSbbsecho -- node parsing
// ---------------------------------------------------------------------------

describe('parseSbbsecho - node parsing', function () {

	it('should return empty arrays for null input', function () {
		var result = parseSbbsecho(null);
		assert.deepStrictEqual(result.nodes,   []);
		assert.deepStrictEqual(result.domains,  []);
		assert.deepStrictEqual(result.groups,   []);
	});

	it('should return empty arrays for empty string input', function () {
		var result = parseSbbsecho('');
		assert.deepStrictEqual(result.nodes,   []);
		assert.deepStrictEqual(result.domains,  []);
		assert.deepStrictEqual(result.groups,   []);
	});

	it('should return empty arrays for input with only global settings and comments', function () {
		var text = [
			'; sbbsecho.ini example',
			'LogLevel=3',
			'PacketDir=./packets',
			'',
			'AreaFixLog=areafixchange.log'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 0);
	});

	it('should parse a node with all supported fields', function () {
		var text = nodeSection('1:134/100@fidonet', {
			Name:         'BBS Hub',
			Comment:      'Main hub',
			SessionPwd:   'sespass',
			PacketPwd:    'pktpass',
			AreaFixPwd:   'afpwd',
			TicFilePwd:   'ticpwd',
			BinkpHost:    'binkp.example.org',
			BinkpPort:    '24554',
			BinkpPoll:    'true',
			LocalAddress: '1:134/200',
			Direct:       'true',
			Route:        '1:134/100',
			Status:       'Normal',
			GroupHub:     'hub1'
		});

		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 1);

		var n = result.nodes[0];
		assert.strictEqual(n.zone,             1);
		assert.strictEqual(n.net,              134);
		assert.strictEqual(n.node,             100);
		assert.strictEqual(n.point,            0);
		assert.strictEqual(n.domain,           'fidonet');
		assert.strictEqual(n.address,          '1:134/100@fidonet');
		assert.strictEqual(n.ftn_address,      '1:134/100');
		assert.strictEqual(n.name,             'BBS Hub');
		assert.strictEqual(n.comment,          'Main hub');
		assert.strictEqual(n.session_password, 'sespass');
		assert.strictEqual(n.packet_password,  'pktpass');
		assert.strictEqual(n.areafix_password, 'afpwd');
		assert.strictEqual(n.tic_password,     'ticpwd');
		assert.strictEqual(n.binkp_host,       'binkp.example.org');
		assert.strictEqual(n.binkp_port,       24554);
		assert.strictEqual(n.binkp_poll,       true);
		assert.strictEqual(n.local_address,    '1:134/200');
		assert.strictEqual(n.direct,           true);
		assert.strictEqual(n.route,            '1:134/100');
		assert.strictEqual(n.status,           'NORMAL');
		assert.strictEqual(n.group_hub,        'hub1');
	});

	it('should default name and passwords to empty strings', function () {
		var text = nodeSection('1:1/1@fidonet', {});
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.name,             '');
		assert.strictEqual(n.session_password, '');
		assert.strictEqual(n.packet_password,  '');
		assert.strictEqual(n.areafix_password, '');
		assert.strictEqual(n.tic_password,     '');
	});

	it('should default binkp_port to 24554', function () {
		var text = nodeSection('1:1/1@fidonet', {});
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.binkp_port, 24554);
	});

	it('should default binkp_poll to false', function () {
		var text = nodeSection('1:1/1@fidonet', {});
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.binkp_poll, false);
	});

	it('should default direct to false', function () {
		var text = nodeSection('1:1/1@fidonet', {});
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.direct, false);
	});

	it('should default status to NORMAL', function () {
		var text = nodeSection('1:1/1@fidonet', {});
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.status, 'NORMAL');
	});

	it('should normalise Status=Normal to NORMAL', function () {
		var text = nodeSection('1:1/1@fidonet', { Status: 'Normal' });
		assert.strictEqual(parseSbbsecho(text).nodes[0].status, 'NORMAL');
	});

	it('should normalise Status=Crash to CRASH', function () {
		var text = nodeSection('1:1/1@fidonet', { Status: 'Crash' });
		assert.strictEqual(parseSbbsecho(text).nodes[0].status, 'CRASH');
	});

	it('should normalise Status=CRASH (uppercase) to CRASH', function () {
		var text = nodeSection('1:1/1@fidonet', { Status: 'CRASH' });
		assert.strictEqual(parseSbbsecho(text).nodes[0].status, 'CRASH');
	});

	it('should normalise any non-CRASH status to NORMAL', function () {
		var text = nodeSection('1:1/1@fidonet', { Status: 'Hold' });
		assert.strictEqual(parseSbbsecho(text).nodes[0].status, 'NORMAL');
	});

	it('should treat BinkpPoll=false as false', function () {
		var text = nodeSection('1:1/1@fidonet', { BinkpPoll: 'false' });
		assert.strictEqual(parseSbbsecho(text).nodes[0].binkp_poll, false);
	});

	it('should accept keys in any case (case-insensitive)', function () {
		var text = nodeSection('1:1/1@fidonet', {
			NAME:       'Case Test',
			BINKPHOST:  'host.example.org',
			binkpport:  '9999'
		});
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.name,      'Case Test');
		assert.strictEqual(n.binkp_host,'host.example.org');
		assert.strictEqual(n.binkp_port, 9999);
	});

	it('should include point in ftn_address when non-zero', function () {
		var text = nodeSection('1:134/100.2@fidonet', {});
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.ftn_address, '1:134/100.2');
		assert.strictEqual(n.point, 2);
	});

	it('should skip wildcard [node:*:ALL@*] sections', function () {
		var text = [
			'[node:1:ALL@fidonet]',
			'Name=Wildcard',
			'',
			'[node:1:134/100@fidonet]',
			'Name=Real Node'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 1);
		assert.strictEqual(result.nodes[0].name, 'Real Node');
	});

	it('should skip [archive:*] sections', function () {
		var text = [
			'[archive:zip]',
			'Pack=zip %a %f',
			'',
			'[node:1:134/100@fidonet]',
			'Name=Real Node'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 1);
	});

	it('should skip [echolist:*] sections', function () {
		var text = [
			'[echolist:fidonet]',
			'File=/path/to/echolist.na',
			'',
			'[node:1:134/100@fidonet]',
			'Name=Real Node'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 1);
	});

	it('should skip [robot:*] sections', function () {
		var text = [
			'[robot:areafix]',
			'Password=secret',
			'',
			'[node:1:134/100@fidonet]',
			'Name=Real Node'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 1);
	});

	it('should skip [binkp:*] sections', function () {
		var text = [
			'[binkp:listen]',
			'Port=24554',
			'',
			'[node:1:134/100@fidonet]',
			'Name=Real Node'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 1);
	});

	it('should ignore comment lines starting with ;', function () {
		var text = [
			'; This is a comment',
			'[node:1:134/100@fidonet]',
			'; another comment',
			'Name=Node With Comments',
			'; BinkpHost=ignored.example.org'
		].join('\n');
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.name,      'Node With Comments');
		assert.strictEqual(n.binkp_host, '');
	});

	it('should handle CRLF line endings', function () {
		var text = '[node:1:134/100@fidonet]\r\nName=CRLF Node\r\nBinkpHost=crlf.example.org\r\n';
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.name,       'CRLF Node');
		assert.strictEqual(n.binkp_host, 'crlf.example.org');
	});

	it('should parse multiple node sections', function () {
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'Node A', BinkpHost: 'a.example.org' }),
			'',
			nodeSection('2:200/100@fidonet', { Name: 'Node B', BinkpHost: 'b.example.org' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 2);
		assert.strictEqual(result.nodes[0].name, 'Node A');
		assert.strictEqual(result.nodes[1].name, 'Node B');
	});

	it('should parse a BinkpPort of 0 as the fallback default 24554', function () {
		var text = nodeSection('1:1/1@fidonet', { BinkpPort: '0' });
		// parseInt('0') || 24554 === 24554 because 0 is falsy
		assert.strictEqual(parseSbbsecho(text).nodes[0].binkp_port, 24554);
	});

	it('should use custom non-zero BinkpPort', function () {
		var text = nodeSection('1:1/1@fidonet', { BinkpPort: '24555' });
		assert.strictEqual(parseSbbsecho(text).nodes[0].binkp_port, 24555);
	});

});

// ---------------------------------------------------------------------------
// parseSbbsecho -- domain parsing
// ---------------------------------------------------------------------------

describe('parseSbbsecho - domain parsing', function () {

	it('should parse a domain section with zones and dns_suffix', function () {
		var text = [
			domainSection('fidonet', {
				Zones:     '1,2,3',
				DnsSuffix: 'fidonet.net',
				Nodelist:  'nodelist'
			}),
			'',
			nodeSection('1:134/100@fidonet', { Name: 'Hub' })
		].join('\n');

		var result = parseSbbsecho(text);
		assert.strictEqual(result.domains.length, 1);

		var d = result.domains[0];
		assert.strictEqual(d.name,       'fidonet');
		assert.deepStrictEqual(d.zones,  [1, 2, 3]);
		assert.strictEqual(d.dns_suffix, 'fidonet.net');
	});

	it('should lowercase the domain name', function () {
		var text = [
			domainSection('FidoNet', { Zones: '1,2,3' }),
			'',
			nodeSection('1:134/100@fidonet', { Name: 'Hub' })
		].join('\n');
		// domain header "FidoNet" lowercased to "fidonet"; node uses "fidonet"
		assert.strictEqual(parseSbbsecho(text).domains[0].name, 'fidonet');
	});

	it('should parse zones as integers', function () {
		var text = [
			domainSection('fidonet', { Zones: '1, 2 , 3' }),
			'',
			nodeSection('1:1/1@fidonet', {})
		].join('\n');
		assert.deepStrictEqual(parseSbbsecho(text).domains[0].zones, [1, 2, 3]);
	});

	it('should filter out non-integer zone tokens', function () {
		var text = [
			domainSection('fidonet', { Zones: '1,abc,3' }),
			'',
			nodeSection('1:1/1@fidonet', {})
		].join('\n');
		assert.deepStrictEqual(parseSbbsecho(text).domains[0].zones, [1, 3]);
	});

	it('should omit a domain not referenced by any node', function () {
		var text = [
			domainSection('fidonet',  { Zones: '1,2,3' }),
			domainSection('othernet', { Zones: '99' }),
			'',
			nodeSection('1:134/100@fidonet', { Name: 'Hub' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.domains.length, 1);
		assert.strictEqual(result.domains[0].name, 'fidonet');
	});

	it('should include a domain only once even when multiple nodes reference it', function () {
		var text = [
			domainSection('fidonet', { Zones: '1,2' }),
			'',
			nodeSection('1:134/100@fidonet', { Name: 'Node A' }),
			'',
			nodeSection('1:134/200@fidonet', { Name: 'Node B' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.domains.length, 1);
	});

	it('should return empty domains array when no nodes are present', function () {
		var text = domainSection('fidonet', { Zones: '1,2,3' });
		assert.deepStrictEqual(parseSbbsecho(text).domains, []);
	});

	it('should return empty domains array when nodes have no domain', function () {
		var text = [
			domainSection('fidonet', { Zones: '1,2,3' }),
			'',
			nodeSection('1:134/100', { Name: 'No Domain Node' })
		].join('\n');
		assert.deepStrictEqual(parseSbbsecho(text).domains, []);
	});

});

// ---------------------------------------------------------------------------
// parseSbbsecho -- auto-grouping
// ---------------------------------------------------------------------------

describe('parseSbbsecho - auto-grouping', function () {

	it('should place nodes with the same BinkpHost into one group', function () {
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'Zone 1 Hub',  BinkpHost: 'binkp.example.org' }),
			'',
			nodeSection('2:200/100@fidonet', { Name: 'Zone 2 Hub',  BinkpHost: 'binkp.example.org' })
		].join('\n');

		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups.length, 1);
		assert.strictEqual(result.groups[0].node_indices.length, 2);
	});

	it('should use the first non-empty name as peer_name for a host group', function () {
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'First Hub',  BinkpHost: 'binkp.example.org' }),
			'',
			nodeSection('2:200/100@fidonet', { Name: 'Second Hub', BinkpHost: 'binkp.example.org' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups[0].peer_name, 'First Hub');
	});

	it('should fall back to the host string as peer_name when all nodes lack a name', function () {
		var text = [
			nodeSection('1:134/100@fidonet', { BinkpHost: 'binkp.example.org' }),
			'',
			nodeSection('2:200/100@fidonet', { BinkpHost: 'binkp.example.org' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups[0].peer_name, 'binkp.example.org');
	});

	it('should group by Name when BinkpHost is absent but names match', function () {
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'SameSysop' }),
			'',
			nodeSection('2:200/100@fidonet', { Name: 'SameSysop' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups.length, 1);
		assert.strictEqual(result.groups[0].node_indices.length, 2);
		assert.strictEqual(result.groups[0].peer_name, 'SameSysop');
	});

	it('should be case-insensitive when matching names for grouping', function () {
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'My BBS' }),
			'',
			nodeSection('2:200/100@fidonet', { Name: 'my bbs' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups.length, 1);
	});

	it('should make a singleton group for a node with a unique name and no host', function () {
		var text = nodeSection('1:134/100@fidonet', { Name: 'Lone Node' });
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups.length, 1);
		assert.strictEqual(result.groups[0].node_indices.length, 1);
		assert.strictEqual(result.groups[0].peer_name, 'Lone Node');
	});

	it('should make a singleton group for a node with no name and no host, using ftn_address', function () {
		var text = nodeSection('1:134/100@fidonet', {});
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups.length, 1);
		assert.strictEqual(result.groups[0].peer_name, '1:134/100');
	});

	it('should not double-assign a node: host-grouped nodes are excluded from name grouping', function () {
		// Node 0 and Node 1 share a host. Node 1 also shares a name with Node 0.
		// Only one group should be created.
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'SharedSysop', BinkpHost: 'binkp.example.org' }),
			'',
			nodeSection('2:200/100@fidonet', { Name: 'SharedSysop', BinkpHost: 'binkp.example.org' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups.length, 1);
		var allIndices = result.groups.reduce(function(acc, g) { return acc.concat(g.node_indices); }, []);
		// Each node index should appear exactly once
		assert.deepStrictEqual(allIndices.sort(), [0, 1]);
	});

	it('should assign every node to exactly one group', function () {
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'Hub A',  BinkpHost: 'a.example.org' }),
			'',
			nodeSection('1:134/101@fidonet', { Name: 'Hub A',  BinkpHost: 'a.example.org' }),
			'',
			nodeSection('2:200/100@fidonet', { Name: 'Sysop B' }),
			'',
			nodeSection('2:200/101@fidonet', { Name: 'Sysop B' }),
			'',
			nodeSection('3:300/100@fidonet', {})
		].join('\n');

		var result = parseSbbsecho(text);
		var allIndices = result.groups.reduce(function(acc, g) { return acc.concat(g.node_indices); }, []);
		allIndices.sort(function(a, b) { return a - b; });
		assert.deepStrictEqual(allIndices, [0, 1, 2, 3, 4]);
	});

	it('should initialise sysop_name as empty string for all groups', function () {
		var text = nodeSection('1:134/100@fidonet', { Name: 'Hub' });
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups[0].sysop_name, '');
	});

	it('should produce no groups when there are no nodes', function () {
		var result = parseSbbsecho('');
		assert.deepStrictEqual(result.groups, []);
	});

	it('should treat BinkpHost comparison as case-insensitive', function () {
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'Node A', BinkpHost: 'BinkP.Example.Org' }),
			'',
			nodeSection('2:200/100@fidonet', { Name: 'Node B', BinkpHost: 'binkp.example.org' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.groups.length, 1);
	});

});

// ---------------------------------------------------------------------------
// parseSbbsecho -- edge cases
// ---------------------------------------------------------------------------

describe('parseSbbsecho - edge cases', function () {

	it('should handle a file with only wildcard node sections', function () {
		var text = [
			'[node:1:ALL@fidonet]',
			'Name=Wildcard',
			'',
			'[node:2:ALL@fidonet]',
			'Name=Another Wildcard'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.deepStrictEqual(result.nodes,   []);
		assert.deepStrictEqual(result.domains,  []);
		assert.deepStrictEqual(result.groups,   []);
	});

	it('should handle a file with only non-node sections', function () {
		var text = [
			'[archive:zip]',
			'Pack=zip %a %f',
			'',
			'[robot:areafix]',
			'Password=robotpwd'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 0);
	});

	it('should ignore key-value lines before any section header', function () {
		var text = [
			'LogLevel=3',
			'PacketDir=./packets',
			'',
			'[node:1:134/100@fidonet]',
			'Name=Actual Node'
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 1);
		assert.strictEqual(result.nodes[0].name, 'Actual Node');
	});

	it('should parse a domain section that appears after its referencing node', function () {
		// Domain filter is applied post-parse, so order should not matter.
		var text = [
			nodeSection('1:134/100@fidonet', { Name: 'Hub' }),
			'',
			domainSection('fidonet', { Zones: '1,2,3' })
		].join('\n');
		var result = parseSbbsecho(text);
		assert.strictEqual(result.domains.length, 1);
	});

	it('should flush the last section even when there is no trailing blank line', function () {
		var text = '[node:1:134/100@fidonet]\nName=Last Node';
		var result = parseSbbsecho(text);
		assert.strictEqual(result.nodes.length, 1);
		assert.strictEqual(result.nodes[0].name, 'Last Node');
	});

	it('should ignore lines inside a node section that have no = sign', function () {
		var text = [
			'[node:1:134/100@fidonet]',
			'Name=Valid',
			'ThisLineHasNoEqualsSign',
			'BinkpHost=valid.host.org'
		].join('\n');
		var n = parseSbbsecho(text).nodes[0];
		assert.strictEqual(n.name,       'Valid');
		assert.strictEqual(n.binkp_host, 'valid.host.org');
	});

});
