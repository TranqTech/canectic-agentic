// tests/doorserverAccess.test.js -- the door server's front door (#86,
// phase A).
//
// /ws/doorserver is mounted on every board. Its login was a stub that
// accepted ANY system id with a token published in the repository, and
// CallManager.launchDoor ran whatever door the remote client named. So anyone
// reaching a board's web port could launch any configured door. Now: the pool
// refuses everything unless doorserver_enabled is on (off by default), no
// system is known until registered systems exist, and a door-server session
// may launch only a door the sysop has made available to it.

import assert from 'assert';
import * as fs from 'fs';
import { getClientBBS } from '../src/models/doorserver.js';
import { mayLaunchDoor } from '../src/models/doors.js';
import { getDefinition } from '../src/config/configDefaults.js';

describe('door server access (#86, phase A)', function () {

	it('knows no client system, the old stub id included', async function () {
		assert.strictEqual(await getClientBBS('MY_BBS_01'), null);
		assert.strictEqual(await getClientBBS('anything'), null);
		var src = fs.readFileSync(new URL('../src/models/doorserver.js', import.meta.url), 'utf8');
		assert.ok(src.indexOf('12345654') === -1, 'the published stub token is still in the code');
	});

	it('is off unless the sysop turns it on', function () {
		var def = getDefinition('doorserver_enabled');
		assert.ok(def, 'doorserver_enabled is not defined');
		assert.strictEqual(def.defaultValue, 'false');
	});

	it('lets a door-server caller launch only doors made available to it', function () {
		// As the door_auth stage leaves a remote BBS's caller
		var remote = { doorsession: true, doorserver_session: true, caller_bbs: 'OTHER' };
		assert.deepStrictEqual(mayLaunchDoor(remote, { slug: 'lord', doorserverAvailable: true }), { ok: true });
		assert.strictEqual(mayLaunchDoor(remote, { slug: 'shell', doorserverAvailable: false }).ok, false);
		assert.strictEqual(mayLaunchDoor(remote, { slug: 'old' }).ok, false, 'a door with no flag is not available');
		assert.strictEqual(mayLaunchDoor(remote, null).ok, false);
	});

	it('leaves local callers to their menus, as before', function () {
		assert.strictEqual(mayLaunchDoor({ doorsession: false }, { slug: 'shell', doorserverAvailable: false }).ok, true);
		assert.strictEqual(mayLaunchDoor({}, { slug: 'shell' }).ok, true);
	});

	it('lets this board\'s own user play any door on the web, which is also a door session (#89)', function () {
		// As webdoor_auth leaves a web Play call: 0.9.13a refused every door
		// not offered to the door server here, because it checked doorsession
		var web = { doorsession: true, web_originated: true, user_record: { id: 1 } };
		assert.strictEqual(mayLaunchDoor(web, { slug: 'shell', doorserverAvailable: false }).ok, true);
	});

	it('marks a door-server login with its own flag, which web Play does not set', function () {
		var auth = fs.readFileSync(new URL('../src/handlers/doorauthhandler.js', import.meta.url), 'utf8');
		assert.ok(/call\.doorserver_session = true/.test(auth), 'door_auth must mark its calls');
		var web = fs.readFileSync(new URL('../src/handlers/webdoorauthhandler.js', import.meta.url), 'utf8');
		assert.ok(!/doorserver_session/.test(web), 'a web Play call is not a door-server caller');
	});

	it('checks every launch in CallManager.launchDoor', function () {
		var src = fs.readFileSync(new URL('../src/managers/callmanager.js', import.meta.url), 'utf8');
		var launch = src.slice(src.indexOf('async launchDoor('));
		launch = launch.slice(0, launch.indexOf('\n\t}\n'));
		assert.ok(/mayLaunchDoor\(this, doorConfig\)/.test(launch), 'launchDoor no longer checks mayLaunchDoor');
	});
});
