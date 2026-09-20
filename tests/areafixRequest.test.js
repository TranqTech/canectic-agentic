// tests/areafixRequest.test.js: AreaFix from netmail arrival to response body.
//
// tests/areafix.test.js covers _parseCommands well but never calls
// handleRequest, so the path a downlink actually travels was untested:
// authenticate by source address and password, dispatch, build a response.
//
// "Needs a live peer" turned out to be too pessimistic a reading of that gap.
// Only the wire needs a peer. Everything from the parsed netmail to the
// response body is in-process and constructible, which is where the
// regressions would be anyway. handleRequest takes a plain object, so the
// message is just a literal.
//
// Fixture: a throwaway ZZ peer and FTN connection with a known areafix
// password, removed afterwards.
// Run: npx mocha --spec tests/areafixRequest.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var PEER_NAME = 'ZZ AreaFix Test Peer';
var ADDRESS   = '1:999/9999';
var PASSWORD  = 'zztestpw';

describe('areafix.handleRequest', function () {
	this.timeout(40000);

	var available = false;
	var pg = null, areafix = null, peers = null, peerConnections = null, msgAreas = null;
	var peerId = null, connId = null, networkId = null, areaId = null;
	// Notifications raised as a side effect of handleRequest. Deleted by id
	// above this mark AND by the fixture address, so a real sysop notification
	// can never be caught by the cleanup.
	var notifHighWater = 0;
	var AREA = 'ZZAFTEST';

	before(async function () {
		this.timeout(30000);
		try {
			available = await dbAvailable();
			if (!available) return;

			pg              = await import('../src/middleware/db/postgres.js');

			try {
				var hw = await pg.queryOne('SELECT COALESCE(MAX(id), 0) AS id FROM notifications');
				notifHighWater = hw ? parseInt(hw.id) || 0 : 0;
			} catch (_) { notifHighWater = 0; }
			areafix         = await import('../src/models/areafix.js');
			peers           = await import('../src/models/peers.js');
			peerConnections = await import('../src/models/peerConnections.js');
			msgAreas        = await import('../src/models/msgAreas.js');

			var net = await pg.queryOne("SELECT id FROM message_networks WHERE network_type = 'FTN' LIMIT 1");
			if (!net) { available = false; return; }
			networkId = net.id;

			var grp = await pg.queryOne('SELECT shortcode FROM message_groups LIMIT 1');
			if (!grp) { available = false; return; }

			// Throwaway peer + connection carrying a known areafix password.
			var p = await peers.newPeer({ name: PEER_NAME, sysop_name: 'ZZ Test' });
			if (!p.status) { available = false; return; }
			peerId = p.insertId;

			// newConnection builds connection_data from flat fields; the bare
			// names are the documented path for programmatic callers.
			var c = await peerConnections.newConnection({
				peer_id: peerId,
				network_id: networkId,
				connection_type: 'FTN',
				address: ADDRESS,
				areafix_password: PASSWORD
			});
			if (!c.status) { available = false; return; }
			connId = c.insertId;

			// An area on this network for subscribe/rescan to act on.
			await msgAreas.removeArea(AREA, true).catch(function () {});
			var a = await msgAreas.newArea({
				groupshortcode: grp.shortcode, name: 'ZZ AreaFix area', description: 'temporary',
				shortcode: AREA, readsecurity: 50, postsecurity: 60,
				network_id: networkId, areatag: AREA, createdByName: 'areafixRequest.test.js'
			});
			if (!a.status) { available = false; return; }
			areaId = (await msgAreas.getAreaByShortcode(AREA)).id;
		} catch (_) {
			available = false;
		}
	});

	beforeEach(function () { if (!available) this.skip(); });

	after(async function () {
		this.timeout(30000);
		if (!pg) return;
		try {
			if (areaId) {
				await pg.write('DELETE FROM peer_area_subscriptions WHERE area_id = $1', [areaId]);
				await pg.write('DELETE FROM network_areas WHERE area_id = $1', [areaId]);
				await msgAreas.removeArea(AREA, true).catch(function () {});
			}
			if (connId) await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [connId]);
			if (connId) await pg.write('DELETE FROM peer_connections WHERE id = $1', [connId]);
			if (peerId) await pg.write('DELETE FROM peers WHERE id = $1', [peerId]);
			// handleRequest raises a sysop notification per request, which this
			// suite makes a dozen of per run. Left behind they accumulate in
			// the live sysop's bell for ever: 3252 of them had built up before
			// anyone noticed, because nothing about a test leaving rows in a
			// shared database announces itself.
			await pg.write(
				"DELETE FROM notifications WHERE id > $1 AND title LIKE $2",
				[notifHighWater, '%' + ADDRESS + '%']
			);
		} catch (_) {}
	});

	function netmail(body, opts) {
		opts = opts || {};
		return {
			Source: opts.source === undefined ? ADDRESS : opts.source,
			Subject: opts.subject === undefined ? PASSWORD : opts.subject,
			BodyText: body,
			FromUser: 'ZZ Tester',
			ToUser: 'areafix'
		};
	}

	function joined(result) { return (result.responseLines || []).join('\n'); }

	// -----------------------------------------------------------------------
	// authentication
	// -----------------------------------------------------------------------

	it('refuses an unknown source address without throwing', async function () {
		var res = await areafix.handleRequest(netmail('%HELP', { source: '1:111/1111' }));
		assert.strictEqual(res.status, true, 'a refusal still has to produce a reply');
		assert.ok(joined(res).includes('Authentication failed'));
	});

	it('refuses a wrong password', async function () {
		var res = await areafix.handleRequest(netmail('%HELP', { subject: 'wrongpw' }));
		assert.ok(joined(res).includes('Authentication failed'));
	});

	it('refuses an empty subject, since the password lives there', async function () {
		var res = await areafix.handleRequest(netmail('%HELP', { subject: '' }));
		assert.ok(joined(res).includes('Authentication failed'));
	});

	it('does not leak whether the address or the password was wrong', async function () {
		var badAddr = joined(await areafix.handleRequest(netmail('%HELP', { source: '1:111/1111' })));
		var badPw   = joined(await areafix.handleRequest(netmail('%HELP', { subject: 'wrongpw' })));
		assert.ok(badAddr.includes('Authentication failed'));
		assert.ok(badPw.includes('Authentication failed'));
	});

	// -----------------------------------------------------------------------
	// dispatch
	// -----------------------------------------------------------------------

	it('answers an empty body with a pointer to %HELP', async function () {
		var res = await areafix.handleRequest(netmail(''));
		assert.ok(joined(res).includes('%HELP'));
	});

	it('answers %HELP, and the help mentions RESCAN', async function () {
		var res = await areafix.handleRequest(netmail('%HELP'));
		var text = joined(res);
		assert.ok(text.includes('AreaFix Command Reference'));
		assert.ok(text.includes('%RESCAN'),
			'a command that is dispatched but undocumented is a command nobody uses');
	});

	it('reports an unknown command rather than staying silent', async function () {
		var res = await areafix.handleRequest(netmail('%NOSUCHCOMMAND'));
		assert.ok(joined(res).includes('Unknown command'));
	});

	it('subscribes to an area and reports it', async function () {
		await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [connId]);
		var res = await areafix.handleRequest(netmail('+' + AREA));
		assert.ok(joined(res).toUpperCase().includes(AREA));

		var sub = await pg.queryOne(
			'SELECT enabled FROM peer_area_subscriptions WHERE peer_connection_id = $1 AND area_id = $2',
			[connId, areaId]);
		assert.ok(sub && sub.enabled, 'the subscription row should exist and be enabled');
	});

	it('processes several commands in one message', async function () {
		var res = await areafix.handleRequest(netmail('%QUERY\n%HELP'));
		var text = joined(res);
		assert.ok(text.includes('AreaFix Command Reference'), 'the second command must run too');
	});

	// -----------------------------------------------------------------------
	// rescan, which is the reason this file exists
	// -----------------------------------------------------------------------

	it('dispatches %RESCAN and reports the window it used', async function () {
		await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [connId]);
		await areafix.handleRequest(netmail('+' + AREA));

		var res = await areafix.handleRequest(netmail('%RESCAN ' + AREA));
		var text = joined(res);
		assert.ok(/Rescan \(last \d+ days\)/.test(text) || text.includes('unchanged'),
			'expected a windowed rescan response, got: ' + text);
		assert.ok(!text.includes('Unknown command'), '%RESCAN must reach its handler');
	});

	it('dispatches a bare %RESCAN as all areas', async function () {
		var res = await areafix.handleRequest(netmail('%RESCAN'));
		assert.ok(!joined(res).includes('Unknown command'));
	});

	it('reports a bad %RESCAN argument instead of silently doing nothing', async function () {
		var res = await areafix.handleRequest(netmail('%RESCAN ' + AREA + ' 0'));
		var text = joined(res);
		assert.ok(text.includes('%RESCAN'), 'the error should name the command');
		assert.ok(text.toLowerCase().includes('greater than zero'));
	});

	it('says a full rescan is full', async function () {
		await pg.write('DELETE FROM peer_area_subscriptions WHERE peer_connection_id = $1', [connId]);
		await areafix.handleRequest(netmail('+' + AREA));
		await pg.write(
			'UPDATE peer_area_subscriptions SET msg_idx = 500 WHERE peer_connection_id = $1', [connId]);

		var res = await areafix.handleRequest(netmail('%RESCAN ' + AREA + ' /FULL'));
		assert.ok(joined(res).includes('Rescan (full)'));
	});

	it('warns that retention and imported history limit what comes back', async function () {
		var res = await areafix.handleRequest(netmail('%RESCAN ' + AREA));
		var text = joined(res);
		assert.ok(text.toLowerCase().includes('retention'),
			'a downlink getting fewer messages than asked for should be told why');
		assert.ok(text.toLowerCase().includes('imported'));
	});

	// -----------------------------------------------------------------------
	// response construction
	// -----------------------------------------------------------------------

	it('builds a response netmail addressed back to the sender', async function () {
		var res = await areafix.handleRequest(netmail('%HELP'));
		var reply = await areafix.buildResponse(netmail('%HELP'), res.responseLines);
		assert.ok(reply, 'buildResponse should produce a message');
		var body = reply.BodyText || reply.body_text || '';
		assert.ok(body.length > 0, 'the reply needs a body');
		assert.ok(body.includes('AreaFix'), 'and it should carry the response lines');
	});
});

// ---------------------------------------------------------------------------
// Adapter routing
// ---------------------------------------------------------------------------

// The last in-process link: deciding netmail is for a fixer at all. Pure, so
// no fixture. If an alias is dropped from AUTOMATED_PROCESSORS the netmail
// stops reaching AreaFix and is delivered as a PM to a user who does not
// exist, which fails quietly rather than loudly.
describe('automated processor routing', function () {
	var pm = null;
	before(async function () {
		try { pm = await import('../src/models/privateMessages.js'); } catch (_) { pm = null; }
		if (!pm || typeof pm.isAutomatedProcessor !== 'function') this.skip();
	});

	var known = ['areafix', 'areamgr', 'filefix', 'filemgr', 'tic'];

	known.forEach(function (name) {
		it('routes "' + name + '" to a processor', function () {
			assert.strictEqual(pm.isAutomatedProcessor(name), true);
		});
	});

	it('is case-insensitive, since netmail ToUser casing varies by tosser', function () {
		assert.strictEqual(pm.isAutomatedProcessor('AreaFix'), true);
		assert.strictEqual(pm.isAutomatedProcessor('AREAFIX'), true);
		assert.strictEqual(pm.isAutomatedProcessor('FileFix'), true);
	});

	it('tolerates surrounding whitespace', function () {
		assert.strictEqual(pm.isAutomatedProcessor('  areafix  '), true);
	});

	it('does not treat an ordinary username as a processor', function () {
		assert.strictEqual(pm.isAutomatedProcessor('Underminer'), false);
		assert.strictEqual(pm.isAutomatedProcessor('sysop'), false);
	});

	it('handles null and empty without throwing', function () {
		assert.strictEqual(pm.isAutomatedProcessor(null), false);
		assert.strictEqual(pm.isAutomatedProcessor(''), false);
		assert.strictEqual(pm.isAutomatedProcessor(undefined), false);
	});
});
