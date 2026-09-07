// tests/netmailRelayPolicy.test.js: who may use this system as a relay.
//
// The setting used to be one boolean, and "on" was far more open than it read.
// resolveRoute finds a way to anything dialable in the nodelist, and walks up
// to a hub or coordinator for anything else, so relay-on meant transit for the
// whole of every network this system carries, in any direction, including
// between two networks that have nothing to do with each other.
//
// Three modes now: nodelist (the default), off, and on. Nodelist is the
// interesting one.
// Nodelists here are scoped per network, so requiring both ends to be listed in
// the *same* one stops this system carrying mail between networks while leaving
// ordinary routed netmail alone. A coordinator can still route outbound for
// their nodes, which any net-scoped rule would have broken immediately.
//
// It deliberately does not try to verify that the sender is who the message
// says. FTN cannot: the origin address is whatever the packet claims. That
// waits for a network whose nodelist can carry public keys.
//
// Run: npx mocha

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

var adapter = null;
try { adapter = await import('../src/models/ftnNetmailAdapter.js'); } catch (_) { adapter = null; }

describe('ftnNetmailAdapter.resolveRelayMode', function () {
	before(function () {
		if (!adapter || typeof adapter.resolveRelayMode !== 'function') this.skip();
	});

	it('accepts the three modes', function () {
		assert.strictEqual(adapter.resolveRelayMode('off'), 'off');
		assert.strictEqual(adapter.resolveRelayMode('nodelist'), 'nodelist');
		assert.strictEqual(adapter.resolveRelayMode('on'), 'on');
	});

	it('is case and whitespace tolerant, since sysops type this', function () {
		assert.strictEqual(adapter.resolveRelayMode('  Nodelist  '), 'nodelist');
		assert.strictEqual(adapter.resolveRelayMode('ON'), 'on');
		assert.strictEqual(adapter.resolveRelayMode('Off '), 'off');
	});

	it('defaults to nodelist when nothing is configured', function () {
		// Safe enough to leave on: it cannot reach a network this system does
		// not carry, or a node that does not exist. A new install is a good FTN
		// citizen without the sysop having to know the setting is there.
		assert.strictEqual(adapter.resolveRelayMode(''), 'nodelist');
		assert.strictEqual(adapter.resolveRelayMode(null), 'nodelist');
		assert.strictEqual(adapter.resolveRelayMode(undefined), 'nodelist');
	});

	it('fails closed on a value it does not recognise', function () {
		// Off, not the default. A misspelled mode is a mistake, and the safe
		// answer to a mistake is to carry nothing rather than to fall back to
		// something permissive.
		assert.strictEqual(adapter.resolveRelayMode('nodelists'), 'off');
		assert.strictEqual(adapter.resolveRelayMode('nodelsit'), 'off');
		assert.strictEqual(adapter.resolveRelayMode('true'), 'off');
		assert.strictEqual(adapter.resolveRelayMode('yes'), 'off');
		assert.strictEqual(adapter.resolveRelayMode('all'), 'off');
	});

	it('ignores the deprecated boolean entirely', function () {
		// It cannot be honoured. configStore seeds every default into the
		// settings table, so a sysop who deliberately set it false reads
		// identically to one who never touched it. Guessing either way would
		// pin every upgrade to the old behaviour or switch relay on for
		// someone who had turned it off, so it takes no argument at all.
		assert.strictEqual(adapter.resolveRelayMode.length, 1,
			'a second argument would imply a migration that cannot actually work');
	});
});

describe('ftnNetmailAdapter.relayAllowedByNodelist', function () {
	this.timeout(20000);

	var available = false;
	var pg = null, nodelist = null;
	// Two networks and a zone each, well outside anything a real install uses.
	var NET_A = null, NET_B = null;
	var ZONE_A = 9101, ZONE_A2 = 9102, ZONE_B = 9201;

	before(async function () {
		this.timeout(15000);
		try {
			available = await dbAvailable();
			if (!available || !adapter) { available = false; return; }
			pg = await import('../src/middleware/db/postgres.js');
			nodelist = await import('../src/models/ftnNodelist.js');

			await cleanup();

			var a = await pg.insertObject({ name: 'ZZRelayNetA', network_type: 'FTN',
				domain: 'zzrelaya', active: true, created_at: new Date() }, 'message_networks');
			var b = await pg.insertObject({ name: 'ZZRelayNetB', network_type: 'FTN',
				domain: 'zzrelayb', active: true, created_at: new Date() }, 'message_networks');
			NET_A = a.insertId; NET_B = b.insertId;

			// Our own addresses: one in each of A's two zones, one in B.
			for (var spec of [[NET_A, ZONE_A], [NET_A, ZONE_A2], [NET_B, ZONE_B]]) {
				await pg.insertObject({
					uuid: 'zz-relay-' + spec[1], network_id: spec[0], address: spec[1] + ':1/100',
					address_zone: spec[1], address_net: 1, address_node: 100, address_point: 0,
					active: true, created_at: new Date()
				}, 'system_addresses');
			}

			await nodelist.ensureTable();
			// Listed nodes: two in network A (different zones), one in B.
			await listNode(NET_A, ZONE_A, 229, 426);
			await listNode(NET_A, ZONE_A2, 5020, 1042);
			await listNode(NET_B, ZONE_B, 1, 200);
		} catch (err) {
			available = false;
		}
	});

	async function listNode(networkId, zone, net, node) {
		await pg.insertObject({
			network_id: networkId, zone: zone, net: net, node: node, point: 0,
			system_name: 'ZZ Test Node', location: 'Nowhere', sysop_name: 'Test',
			phone: '-Unpublished-', baud: 300, active: true,
			first_seen: new Date(), last_seen: new Date()
		}, 'ftn_nodelist');
	}

	async function cleanup() {
		try {
			await pg.write("DELETE FROM ftn_nodelist WHERE zone IN ($1,$2,$3)", [ZONE_A, ZONE_A2, ZONE_B]);
			await pg.write("DELETE FROM system_addresses WHERE uuid LIKE 'zz-relay-%'");
			await pg.write("DELETE FROM message_networks WHERE name IN ('ZZRelayNetA','ZZRelayNetB')");
		} catch (_) {}
	}

	beforeEach(function () { if (!available) this.skip(); });
	after(async function () { if (available) await cleanup(); });

	// -----------------------------------------------------------------------
	// the case it exists for
	// -----------------------------------------------------------------------

	it('refuses to carry mail between two networks it links with', function () {
		// The whole point. A node on one othernet must not be able to reach a
		// node on another through this system, even though both are listed and
		// both networks are carried.
		return adapter.relayAllowedByNodelist(ZONE_A + ':229/426', ZONE_B + ':1/200')
			.then(function (r) {
				assert.strictEqual(r.allowed, false);
				assert.ok(/different networks/.test(r.reason), r.reason);
			});
	});

	it('allows mail between two listed nodes of the same network', async function () {
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/426', ZONE_A + ':229/426');
		assert.strictEqual(r.allowed, true);
		assert.strictEqual(r.reason, null);
	});

	it('allows mail across zones of the same network', async function () {
		// FidoNet spans zones 1 to 6. A rule scoped to one zone, or to the
		// sender's own net, would refuse ordinary routed mail.
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/426', ZONE_A2 + ':5020/1042');
		assert.strictEqual(r.allowed, true, r.reason);
	});

	// -----------------------------------------------------------------------
	// unlisted ends
	// -----------------------------------------------------------------------

	it('refuses an unlisted sender', async function () {
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/999', ZONE_A + ':229/426');
		assert.strictEqual(r.allowed, false);
		assert.ok(/sender .* is not in the nodelist/.test(r.reason), r.reason);
	});

	it('refuses an unlisted recipient', async function () {
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/426', ZONE_A + ':229/999');
		assert.strictEqual(r.allowed, false);
		assert.ok(/recipient .* is not in the nodelist/.test(r.reason), r.reason);
	});

	it('names the address it could not find, so a sysop can check it', async function () {
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/999', ZONE_A + ':229/426');
		assert.ok(r.reason.indexOf(ZONE_A + ':229/999') !== -1, r.reason);
	});

	// -----------------------------------------------------------------------
	// points
	// -----------------------------------------------------------------------

	it('accepts a point by way of its boss node', async function () {
		// Points are not listed in a nodelist and never will be. A point's
		// mail is its boss node's responsibility, so the point is stripped
		// before the lookup. Without this every point on the network is
		// refused, which would be most of the traffic on some links.
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/426.1', ZONE_A + ':229/426.7');
		assert.strictEqual(r.allowed, true, r.reason);
	});

	it('still refuses a point whose boss node is unlisted', async function () {
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/999.1', ZONE_A + ':229/426');
		assert.strictEqual(r.allowed, false);
	});

	// -----------------------------------------------------------------------
	// zones we do not carry
	// -----------------------------------------------------------------------

	it('refuses a zone this system holds no address in', async function () {
		// We do not carry that network, so there is nothing to relay within.
		var r = await adapter.relayAllowedByNodelist('9999:1/1', ZONE_A + ':229/426');
		assert.strictEqual(r.allowed, false);
		assert.ok(/not a network this system carries/.test(r.reason), r.reason);
	});

	it('names which end was in the uncarried zone', async function () {
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/426', '9999:1/1');
		assert.ok(/recipient zone 9999/.test(r.reason), r.reason);
	});

	// -----------------------------------------------------------------------
	// shapes the ingest path can hand it
	// -----------------------------------------------------------------------

	it('strips a 5D domain suffix before looking up', async function () {
		var r = await adapter.relayAllowedByNodelist(
			ZONE_A + ':229/426@zzrelaya', ZONE_A + ':229/426@zzrelaya');
		assert.strictEqual(r.allowed, true, r.reason);
	});

	it('refuses an unparseable address rather than throwing', async function () {
		var r = await adapter.relayAllowedByNodelist('', ZONE_A + ':229/426');
		assert.strictEqual(r.allowed, false);
		assert.ok(/unparseable sender/.test(r.reason), r.reason);

		var r2 = await adapter.relayAllowedByNodelist(ZONE_A + ':229/426', null);
		assert.strictEqual(r2.allowed, false);
		assert.ok(/unparseable recipient/.test(r2.reason), r2.reason);
	});

	it('refuses a node that is in the nodelist but marked inactive', async function () {
		// Nodes are deactivated rather than deleted when they leave, so an
		// inactive row is a node that is no longer in the network.
		await listNode(NET_A, ZONE_A, 229, 777);
		await pg.write('UPDATE ftn_nodelist SET active = false WHERE zone = $1 AND net = 229 AND node = 777',
			[ZONE_A]);
		var r = await adapter.relayAllowedByNodelist(ZONE_A + ':229/777', ZONE_A + ':229/426');
		assert.strictEqual(r.allowed, false);
	});
});
