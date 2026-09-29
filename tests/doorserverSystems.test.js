// tests/doorserverSystems.test.js -- registered door-server systems and the
// door_auth protocol's frame reader (#86, phase B).

import assert from 'assert';
import { dbAvailable } from './helpers/dbAvailable.js';
import { normaliseSystemId, validateDetails, mayRegister } from '../src/models/doorserver.js';
import { takeFrames } from '../src/handlers/doorauthhandler.js';

function cfg(values) {
	return {
		getBoolean: function (k, d) { return values[k] !== undefined ? values[k] : d; },
		getNumber: function (k, d) { return values[k] !== undefined ? values[k] : d; }
	};
}

describe('door server systems (#86, phase B)', function () {

	describe('rules', function () {
		it('takes a system id of 2-12 letters, digits, _ or -, upper-cased', function () {
			assert.strictEqual(normaliseSystemId(' undermine '), 'UNDERMINE');
			assert.strictEqual(normaliseSystemId('A'), null);
			assert.strictEqual(normaliseSystemId('HAS SPACE'), null);
			assert.strictEqual(normaliseSystemId('X'.repeat(13)), null);
			assert.strictEqual(normaliseSystemId('a:b'), null, 'a colon would break the RLogin field');
		});

		it('reports every problem with a registration at once', function () {
			var r = validateDetails({ system_id: '!', bbs_name: '', sysop_name: '', contact_email: 'nope' }, { creating: true });
			assert.strictEqual(r.errors.length, 4);
			var ok = validateDetails({ system_id: 'mybbs', bbs_name: 'My BBS', sysop_name: 'Me' }, { creating: true });
			assert.deepStrictEqual(ok.errors, []);
			assert.strictEqual(ok.values.username_prefix, 'MYBBS', 'the prefix defaults to the system id');
		});

		it('lets only users at the configured level register, and only when the door server is on', function () {
			var on = cfg({ doorserver_enabled: true, doorserver_register_security: 100 });
			assert.strictEqual(mayRegister({ security: 100 }, on), true);
			assert.strictEqual(mayRegister({ security: 99 }, on), false);
			assert.strictEqual(mayRegister(null, on), false);
			assert.strictEqual(mayRegister({ security: 255 }, cfg({ doorserver_enabled: false })), false);
		});
	});

	describe('takeFrames', function () {
		it('splits complete objects and keeps a partial one for later', function () {
			var r = takeFrames('{"type":"auth","secret":"a}b{c"}{"type":"launch","door":"lo');
			assert.deepStrictEqual(r.frames, ['{"type":"auth","secret":"a}b{c"}']);
			assert.strictEqual(r.rest, '{"type":"launch","door":"lo');
			var more = takeFrames(r.rest + 'rd"}\n');
			assert.deepStrictEqual(more.frames.map(JSON.parse), [{ type: 'launch', door: 'lord' }]);
		});
		it('is not fooled by escaped quotes', function () {
			assert.deepStrictEqual(takeFrames('{"u":{"name":"a \\"}\\" b"}}').frames.length, 1);
		});
	});

	describe('against the database', function () {
		this.timeout(20000);
		var available = false, ds, pg;

		before(async function () {
			available = await dbAvailable();
			if (!available) return;
			ds = await import('../src/models/doorserver.js');
			pg = await import('../src/middleware/db/postgres.js');
		});
		async function cleanup() { await pg.write("DELETE FROM doorserver_systems WHERE system_id LIKE 'ZZ86%'"); }
		beforeEach(async function () { if (!available) return this.skip(); await cleanup(); });
		after(async function () { if (available) await cleanup(); });

		var details = { system_id: 'zz86a', bbs_name: 'ZZ Test BBS', sysop_name: 'Tester' };

		it('approves a system the sysop adds, and logs it in with its secret only', async function () {
			var r = await ds.createSystem(details, { bySysop: true, actor: 'sysop' });
			assert.ok(r.status, r.errors.join());
			assert.strictEqual(r.system.status, 'approved');
			assert.ok(r.secret.startsWith(ds.SECRET_PREFIX));
			assert.ok(!r.system.secret_hash.includes(r.secret), 'the secret is stored hashed');
			assert.strictEqual((await ds.verifyLogin('ZZ86A', r.secret)).ok, true);
			assert.strictEqual((await ds.verifyLogin('zz86a', r.secret)).ok, true, 'system id is case-insensitive');
			assert.strictEqual((await ds.verifyLogin('ZZ86A', r.secret + 'x')).ok, false);
			var unknown = await ds.verifyLogin('ZZ86NONE', r.secret);
			assert.strictEqual(unknown.ok, false); assert.strictEqual(unknown.unknown, true);
		});

		it('holds a user registration pending, ties it to the user, and refuses it until approved', async function () {
			var r = await ds.createSystem(details, { ownerUserId: 987654, actor: 'someuser' });
			assert.strictEqual(r.system.status, 'pending');
			assert.strictEqual(parseInt(r.system.owner_user_id), 987654);
			var v = await ds.verifyLogin('ZZ86A', r.secret);
			assert.strictEqual(v.ok, false); assert.ok(/pending/.test(v.reason));
			await ds.setStatus(r.system.uuid, 'approved', 'sysop');
			assert.strictEqual((await ds.verifyLogin('ZZ86A', r.secret)).ok, true);
			await ds.setStatus(r.system.uuid, 'suspended', 'sysop');
			assert.strictEqual((await ds.verifyLogin('ZZ86A', r.secret)).ok, false);
		});

		it('refuses a second registration of the same system id', async function () {
			await ds.createSystem(details, { bySysop: true });
			var again = await ds.createSystem(details, { bySysop: true });
			assert.strictEqual(again.status, false);
			assert.ok(/already registered/.test(again.errors[0]));
		});

		it('stops the old secret the moment a new one is made', async function () {
			var r = await ds.createSystem(details, { bySysop: true });
			var fresh = await ds.regenerateSecret(r.system.uuid);
			assert.strictEqual((await ds.verifyLogin('ZZ86A', r.secret)).ok, false);
			assert.strictEqual((await ds.verifyLogin('ZZ86A', fresh)).ok, true);
		});

		it('counts sessions', async function () {
			var r = await ds.createSystem(details, { bySysop: true });
			await ds.recordSession(r.system.uuid);
			var s = await ds.getByUuid(r.system.uuid);
			assert.strictEqual(parseInt(s.session_count), 1);
			assert.ok(s.last_connect);
		});
	});
});
