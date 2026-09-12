// tests/netmailRelayLog.test.js: a durable record of what we did with other
// people's netmail.
//
// Relay left traces before this, but no two in the same place. A success wrote
// an alog line and a pm_outbox row carrying transport_data.relayed. A refusal
// wrote a different alog line. A loop wrote an undeliverable row. An
// unroutable address wrote a text dump into ftn/bad. So "did we relay what we
// should have, and did it leave" took four searches, and two of the four
// sources roll over.
//
// The failure worth guarding hardest is the one none of those covered:
// accepting a message for relay, queueing it, and it never going out.
// Queueing looked like success at every point the old logging touched, and a
// message then sitting unsent produces no further event of any kind.
//
// This is diagnostic. A relay must never fail because its log entry could not
// be written, so logDecision swallowing its own errors is a tested property,
// not an accident.
//
// Needs PostgreSQL; skips without one.
// Run: npx mocha --spec tests/netmailRelayLog.test.js

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';

// Every row this suite writes carries this prefix, so cleanup cannot touch a
// real relay record on a development box.
var TAG = 'zz-relaylog-test-';

describe('netmailRelayLog', function () {
	this.timeout(20000);

	var relayLog = null, postgres = null, haveDb = false;

	before(async function () {
		this.timeout(15000);
		haveDb = await dbAvailable();
		if (!haveDb) return;
		var appConfig = (await import('../src/config/appConfig.js')).default;
		await appConfig.load();
		relayLog = await import('../src/models/netmailRelayLog.js');
		postgres = await import('../src/middleware/db/postgres.js');
	});

	beforeEach(function () { if (!haveDb) this.skip(); });

	afterEach(async function () {
		if (!haveDb) return;
		await postgres.query('DELETE FROM netmail_relay_log WHERE msg_id LIKE $1', [TAG + '%']);
		await postgres.query('DELETE FROM pm_outbox WHERE uuid LIKE $1', [TAG + '%']);
	});

	function entry(over) {
		return Object.assign({
			msgId: TAG + '1',
			fromUser: 'Alice', fromAddress: '1:153/757',
			toUser: 'Bob',     toAddress: '1:229/426',
			subject: 'transit', packetSource: '1:153/757',
			decision: relayLog.RELAY_SENT, relayMode: 'nodelist',
			nextHop: '1:229/1', routeMethod: 'coordinator'
		}, over || {});
	}

	it('records a relay with the route it chose', async function () {
		await relayLog.logDecision(entry({ viaStamped: '1:134/100' }));

		var rows = await relayLog.getByMsgId(TAG + '1');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].decision, 'relayed');
		assert.strictEqual(rows[0].next_hop, '1:229/1');
		assert.strictEqual(rows[0].route_method, 'coordinator');
		assert.strictEqual(rows[0].via_stamped, '1:134/100');
	});

	it('records a refusal, with the reason the gate gave', async function () {
		// A gate nobody can see refusing anything is a gate nobody can
		// validate, so refusals are as important as relays here.
		await relayLog.logDecision(entry({
			decision: relayLog.RELAY_REFUSED,
			reason: 'sender and recipient are not in the same network nodelist'
		}));

		var rows = await relayLog.getByMsgId(TAG + '1');
		assert.strictEqual(rows[0].decision, 'refused');
		assert.ok(/same network nodelist/.test(rows[0].reason));
	});

	it('keeps who wrote the message apart from who handed us the packet', async function () {
		// The same on mail a node originated, different on transit. Collapsing
		// them loses the only way to see which link is feeding you transit.
		await relayLog.logDecision(entry({ fromAddress: '1:153/757', packetSource: '1:229/1' }));

		var row = (await relayLog.getByMsgId(TAG + '1'))[0];
		assert.strictEqual(row.from_address, '1:153/757');
		assert.strictEqual(row.packet_source, '1:229/1');
	});

	it('never throws, whatever it is handed', async function () {
		// The property that matters most. A relay must not fail because its
		// log entry could not be written.
		await relayLog.logDecision(null);
		await relayLog.logDecision({});
		await relayLog.logDecision({ decision: relayLog.RELAY_ERROR, receivedAt: 'not a date' });
		assert.ok(true, 'no throw');
	});

	it('reports a write it could not make, rather than failing silently', async function () {
		// postgres.insertObject returns a failure rather than throwing, so
		// ignoring its result would leave a broken relay log indistinguishable
		// from a quiet one. That is the one thing a diagnostic log must not be.
		assert.strictEqual(
			await relayLog.logDecision({ msgId: TAG + 'bad', receivedAt: 'not a date' }), false);

		assert.strictEqual(await relayLog.logDecision(entry()), true, 'a good row still writes');
	});

	it('truncates an overlong subject instead of failing the insert', async function () {
		// subject is VARCHAR(255) and an FTN subject is not guaranteed to fit.
		await relayLog.logDecision(entry({ subject: 'x'.repeat(400) }));

		var rows = await relayLog.getByMsgId(TAG + '1');
		assert.strictEqual(rows.length, 1, 'the row was written');
		assert.strictEqual(rows[0].subject.length, 255);
	});

	describe('pendingDelivery', function () {
		it('finds a relay that was queued and never sent', async function () {
			// The invisible failure: accepted, queued, and gone nowhere.
			await relayLog.logDecision(entry({ outboundUuid: TAG + 'out1' }));
			await postgres.insertObject({
				uuid: TAG + 'out1', to_user: 'Bob', from_user: 'Alice',
				transport_type: 'FTN', queued: true, sent: false,
				created_at: new Date()
			}, 'pm_outbox');

			var stuck = await relayLog.pendingDelivery(0);
			var mine = stuck.filter(function (r) { return r.msg_id === TAG + '1'; });
			assert.strictEqual(mine.length, 1);
			assert.strictEqual(mine[0].sent, false);
		});

		it('leaves a relay that did go out alone', async function () {
			await relayLog.logDecision(entry({ outboundUuid: TAG + 'out2' }));
			await postgres.insertObject({
				uuid: TAG + 'out2', to_user: 'Bob', from_user: 'Alice',
				transport_type: 'FTN', queued: false, sent: true,
				sent_at: new Date(), created_at: new Date()
			}, 'pm_outbox');

			var stuck = await relayLog.pendingDelivery(0);
			assert.strictEqual(
				stuck.filter(function (r) { return r.msg_id === TAG + '1'; }).length, 0);
		});

		it('reports a relay whose outbound row went missing entirely', async function () {
			// A queue insert that failed, or a row deleted underneath us. The
			// left join has to surface this rather than hide it.
			await relayLog.logDecision(entry({ outboundUuid: TAG + 'nonexistent' }));

			var stuck = await relayLog.pendingDelivery(0);
			var mine = stuck.filter(function (r) { return r.msg_id === TAG + '1'; });
			assert.strictEqual(mine.length, 1);
			assert.strictEqual(mine[0].sent, null, 'no outbound row at all');
		});

		it('ignores refusals, which were never going to be sent', async function () {
			await relayLog.logDecision(entry({ decision: relayLog.RELAY_REFUSED }));

			var stuck = await relayLog.pendingDelivery(0);
			assert.strictEqual(
				stuck.filter(function (r) { return r.msg_id === TAG + '1'; }).length, 0);
		});
	});

	it('summarises by decision over a window', async function () {
		await relayLog.logDecision(entry({ msgId: TAG + '1' }));
		await relayLog.logDecision(entry({ msgId: TAG + '2', decision: relayLog.RELAY_REFUSED }));
		await relayLog.logDecision(entry({ msgId: TAG + '3', decision: relayLog.RELAY_REFUSED }));

		var byDecision = {};
		for (var row of await relayLog.summarise(7)) byDecision[row.decision] = row.count;

		assert.ok(byDecision.refused >= 2);
		assert.ok(byDecision.relayed >= 1);
	});

	it('purges rows older than the retention window', async function () {
		await relayLog.logDecision(entry());
		await postgres.query(
			"UPDATE netmail_relay_log SET received_at = NOW() - interval '400 days' WHERE msg_id LIKE $1",
			[TAG + '%']);

		await relayLog.purgeOld(180);
		assert.strictEqual((await relayLog.getByMsgId(TAG + '1')).length, 0);
	});

	it('keeps rows inside the retention window', async function () {
		await relayLog.logDecision(entry());
		await relayLog.purgeOld(180);
		assert.strictEqual((await relayLog.getByMsgId(TAG + '1')).length, 1);
	});
});
