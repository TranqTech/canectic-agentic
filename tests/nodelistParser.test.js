// tests/nodelistParser.test.js — Unit tests for nodelistParser.js
//
// Tests parseNodelistText() and parseFlagString() without any DB or network.
// Run: npx mocha tests/nodelistParser.test.js

import assert from 'assert';
import { parseNodelistText, parseFlagString } from '../src/utils/nodelistParser.js';

// ---------------------------------------------------------------------------
// parseFlagString
// ---------------------------------------------------------------------------

describe('parseFlagString', function () {

	describe('empty / null input', function () {
		it('should return all-false result for null', function () {
			var r = parseFlagString(null);
			assert.strictEqual(r.isCM, false);
			assert.strictEqual(r.isIP, false);
			assert.strictEqual(r.isIBN, false);
			assert.strictEqual(r.hostname, null);
			assert.deepStrictEqual(r.connectionTypes, []);
		});

		it('should return all-false result for empty array', function () {
			var r = parseFlagString([]);
			assert.strictEqual(r.isCM, false);
			assert.strictEqual(r.isIP, false);
			assert.strictEqual(r.hostname, null);
		});

		it('should return all-false result for non-array', function () {
			var r = parseFlagString('CM');
			assert.strictEqual(r.isCM, false);
		});
	});

	describe('CM flag', function () {
		it('should set isCM for CM flag', function () {
			var r = parseFlagString(['CM']);
			assert.strictEqual(r.isCM, true);
		});

		it('should be case-insensitive', function () {
			var r = parseFlagString(['cm']);
			assert.strictEqual(r.isCM, true);
		});
	});

	describe('IP flag', function () {
		it('should set isIP for IP flag', function () {
			var r = parseFlagString(['IP']);
			assert.strictEqual(r.isIP, true);
		});
	});

	describe('INA flag', function () {
		it('should extract hostname from INA:host', function () {
			var r = parseFlagString(['INA:bbs.example.com']);
			assert.strictEqual(r.hostname, 'bbs.example.com');
		});

		it('should set isIP when INA is present', function () {
			var r = parseFlagString(['INA:bbs.example.com']);
			assert.strictEqual(r.isIP, true);
		});
	});

	describe('IBN flag', function () {
		it('should set isIBN and default binkpPort 24554 for bare IBN', function () {
			var r = parseFlagString(['IBN']);
			assert.strictEqual(r.isIBN, true);
			assert.strictEqual(r.binkpPort, 24554);
		});

		it('should set port from IBN:port format', function () {
			var r = parseFlagString(['IBN:24554']);
			assert.strictEqual(r.isIBN, true);
			assert.strictEqual(r.binkpPort, 24554);
		});

		it('should extract hostname and port from IBN:host:port', function () {
			var r = parseFlagString(['IBN:bbs.example.com:24554']);
			assert.strictEqual(r.isIBN, true);
			assert.strictEqual(r.hostname, 'bbs.example.com');
			assert.strictEqual(r.binkpPort, 24554);
		});

		it('should extract hostname from IBN:host (no port)', function () {
			var r = parseFlagString(['IBN:bbs.example.com']);
			assert.strictEqual(r.isIBN, true);
			assert.strictEqual(r.hostname, 'bbs.example.com');
			assert.strictEqual(r.binkpPort, 24554);
		});

		it('should add binkp to connectionTypes', function () {
			var r = parseFlagString(['IBN']);
			assert.ok(r.connectionTypes.includes('binkp'));
		});

		it('should infer isIP from IBN', function () {
			var r = parseFlagString(['IBN']);
			assert.strictEqual(r.isIP, true);
		});
	});

	describe('ITN flag', function () {
		it('should set telnetPort to 23 for bare ITN', function () {
			var r = parseFlagString(['ITN']);
			assert.strictEqual(r.telnetPort, 23);
		});

		it('should set custom telnet port from ITN:port', function () {
			var r = parseFlagString(['ITN:2323']);
			assert.strictEqual(r.telnetPort, 2323);
		});

		it('should add telnet to connectionTypes', function () {
			var r = parseFlagString(['ITN']);
			assert.ok(r.connectionTypes.includes('telnet'));
		});
	});

	describe('additional protocol flags', function () {
		it('should detect IVM as vmodem', function () {
			var r = parseFlagString(['IVM']);
			assert.ok(r.connectionTypes.includes('vmodem'));
		});

		it('should detect ISSH as ssh', function () {
			var r = parseFlagString(['ISSH']);
			assert.ok(r.connectionTypes.includes('ssh'));
		});

		it('should detect IMI as imi', function () {
			var r = parseFlagString(['IMI']);
			assert.ok(r.connectionTypes.includes('imi'));
		});

		it('should detect IPV6', function () {
			var r = parseFlagString(['IPV6']);
			assert.ok(r.connectionTypes.includes('ipv6'));
		});

		it('should detect BINK as binkd', function () {
			var r = parseFlagString(['BINK']);
			assert.ok(r.connectionTypes.includes('binkd'));
		});

		it('should not duplicate connectionTypes entries', function () {
			var r = parseFlagString(['IBN', 'IBN:24554']);
			var count = r.connectionTypes.filter(function(t) { return t === 'binkp'; }).length;
			assert.strictEqual(count, 1);
		});
	});

	describe('combined flags', function () {
		it('should handle CM IBN INA together', function () {
			var r = parseFlagString(['CM', 'IBN', 'INA:bbs.example.com']);
			assert.strictEqual(r.isCM, true);
			assert.strictEqual(r.isIBN, true);
			assert.strictEqual(r.hostname, 'bbs.example.com');
			assert.strictEqual(r.isIP, true);
		});
	});
});

// ---------------------------------------------------------------------------
// parseNodelistText
// ---------------------------------------------------------------------------

describe('parseNodelistText', function () {

	describe('empty / invalid input', function () {
		it('should return empty entries for empty string', function () {
			var r = parseNodelistText('');
			assert.deepStrictEqual(r.entries, []);
			assert.deepStrictEqual(r.errors, []);
		});

		it('should return empty entries for null', function () {
			var r = parseNodelistText(null);
			assert.deepStrictEqual(r.entries, []);
		});

		it('should skip comment lines starting with ;', function () {
			var text = '; This is a comment\n; Another comment';
			var r = parseNodelistText(text);
			assert.strictEqual(r.entries.length, 0);
		});

		it('should skip blank lines', function () {
			var text = '\n\n   \n';
			var r = parseNodelistText(text);
			assert.strictEqual(r.entries.length, 0);
		});

		it('should record error for lines with too few fields', function () {
			var text = 'Zone,1,TestBBS,Location';
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 1);
			assert.ok(r.errors[0].reason.includes('Too few fields'));
		});

		it('should record error for invalid node number', function () {
			var text = ',notanumber,TestBBS,Location,Sysop,555-1234,9600';
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 1);
			assert.ok(r.errors[0].reason.includes('Invalid node number'));
		});
	});

	describe('Zone keyword', function () {
		it('should set zone context and produce a zone entry', function () {
			var text = 'Zone,1,FidoNet,Worldwide,Boss_Sysop,-Unpublished-,9600,CM,IBN';
			var r = parseNodelistText(text);
			assert.strictEqual(r.entries.length, 1);
			var e = r.entries[0];
			assert.strictEqual(e.keyword, 'Zone');
			assert.strictEqual(e.zone, 1);
			assert.strictEqual(e.net, 1);
			assert.strictEqual(e.node, 0);
		});
	});

	describe('Host keyword', function () {
		it('should set net context and produce host entry', function () {
			var text = [
				'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Host,100,RegionHost,Location,Sysop,-Unpublished-,9600'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			var host = r.entries[1];
			assert.strictEqual(host.keyword, 'Host');
			assert.strictEqual(host.zone, 1);
			assert.strictEqual(host.net, 100);
			assert.strictEqual(host.node, 0);
		});
	});

	describe('Hub keyword', function () {
		it('should track hub for subsequent nodes', function () {
			var text = [
				'Zone,2,Net2,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Host,200,Net200,Location,Sysop,-Unpublished-,9600',
				'Hub,500,HubSystem,HubCity,HubSysop,-Unpublished-,9600',
				',501,NodeAfterHub,NodeCity,NodeSysop,555-1234,9600'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			var hubEntry = r.entries[2];
			assert.strictEqual(hubEntry.keyword, 'Hub');
			assert.strictEqual(hubEntry.node, 500);
			assert.strictEqual(hubEntry.hub_node, null); // hub itself has no hub_node
			var nodeEntry = r.entries[3];
			assert.strictEqual(nodeEntry.hub_node, 500);
		});
	});

	describe('Regular node (empty keyword)', function () {
		it('should parse a regular node inheriting zone/net context', function () {
			var text = [
				'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Host,100,Net100,Location,Sysop,-Unpublished-,9600',
				',42,MyBBS,My_City,My_Sysop,555-1234,9600,CM,IBN:bbs.mysite.com'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			var node = r.entries[2];
			assert.strictEqual(node.keyword, '');
			assert.strictEqual(node.zone, 1);
			assert.strictEqual(node.net, 100);
			assert.strictEqual(node.node, 42);
			assert.strictEqual(node.system_name, 'MyBBS');
			assert.strictEqual(node.location, 'My City');  // underscores replaced
			assert.strictEqual(node.sysop_name, 'My Sysop');
			assert.strictEqual(node.phone, '555-1234');
			assert.strictEqual(node.is_cm, true);
			assert.strictEqual(node.is_ibn, true);
			assert.strictEqual(node.hostname, 'bbs.mysite.com');
		});
	});

	describe('Pvt / Hold / Down keywords', function () {
		it('should parse Pvt entry', function () {
			var text = [
				'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Host,100,Net100,Location,Sysop,-Unpublished-,9600',
				'Pvt,99,PrivateBBS,City,Sysop,-Unpublished-,9600'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			var pvt = r.entries[2];
			assert.strictEqual(pvt.keyword, 'Pvt');
			assert.strictEqual(pvt.node, 99);
		});

		it('should parse Hold entry', function () {
			var text = [
				'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Host,100,Net100,Location,Sysop,-Unpublished-,9600',
				'Hold,88,HoldBBS,City,Sysop,-Unpublished-,9600'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			assert.strictEqual(r.entries[2].keyword, 'Hold');
		});

		it('should parse Down entry', function () {
			var text = [
				'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Host,100,Net100,Location,Sysop,-Unpublished-,9600',
				'Down,77,DownBBS,City,Sysop,-Unpublished-,9600'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			assert.strictEqual(r.entries[2].keyword, 'Down');
		});
	});

	describe('POTS phone handling', function () {
		it('should add pots to connection_types for a real phone number', function () {
			var text = [
				'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Host,100,Net100,Location,Sysop,-Unpublished-,9600',
				',10,PotsNode,City,Sysop,1-800-555-0100,9600'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			var node = r.entries[2];
			assert.ok(node.connection_types.includes('pots'));
		});

		it('should NOT add pots for -Unpublished-', function () {
			var text = [
				'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Host,100,Net100,Location,Sysop,-Unpublished-,9600',
				',11,InetNode,City,Sysop,-Unpublished-,9600,IBN'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			var node = r.entries[2];
			assert.ok(!node.connection_types.includes('pots'));
		});
	});

	describe('underscore handling in system name', function () {
		it('should replace underscores with spaces in system_name', function () {
			var text = 'Zone,1,My_BBS_System,My_Town,Sysop_Name,-Unpublished-,9600';
			var r = parseNodelistText(text);
			assert.strictEqual(r.entries[0].system_name, 'My BBS System');
			assert.strictEqual(r.entries[0].location, 'My Town');
			assert.strictEqual(r.entries[0].sysop_name, 'Sysop Name');
		});
	});

	describe('default baud handling', function () {
		it('should default baud to 9600 when not a valid number', function () {
			var text = 'Zone,1,TestBBS,City,Sysop,-Unpublished-,notabaud';
			var r = parseNodelistText(text);
			assert.strictEqual(r.entries[0].baud, 9600);
		});
	});

	describe('flags field in entry', function () {
		it('should store raw flags string', function () {
			var text = 'Zone,1,TestBBS,City,Sysop,-Unpublished-,9600,CM,IBN,INA:example.com';
			var r = parseNodelistText(text);
			assert.ok(r.entries[0].flags.includes('CM'));
			assert.ok(r.entries[0].flags.includes('IBN'));
		});
	});

	describe('CRLF line endings', function () {
		it('should handle CRLF line endings correctly', function () {
			var text = 'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600\r\nHost,100,Net100,Loc,Sysop,-Unpublished-,9600';
			var r = parseNodelistText(text);
			assert.strictEqual(r.entries.length, 2);
			assert.strictEqual(r.errors.length, 0);
		});
	});

	describe('Region keyword', function () {
		it('should parse Region entry and update context', function () {
			var text = [
				'Zone,1,FidoNet,Worldwide,ZoneCoord,-Unpublished-,9600',
				'Region,10,Region10,Location,RegCoord,-Unpublished-,9600'
			].join('\n');
			var r = parseNodelistText(text);
			assert.strictEqual(r.errors.length, 0);
			var region = r.entries[1];
			assert.strictEqual(region.keyword, 'Region');
			assert.strictEqual(region.zone, 1);
			assert.strictEqual(region.region, 10);
			assert.strictEqual(region.net, 10);
			assert.strictEqual(region.node, 0);
		});
	});

	describe('point field', function () {
		it('should always have point set to 0 in parsed entries', function () {
			var text = 'Zone,1,TestBBS,City,Sysop,-Unpublished-,9600';
			var r = parseNodelistText(text);
			assert.strictEqual(r.entries[0].point, 0);
		});
	});
});
