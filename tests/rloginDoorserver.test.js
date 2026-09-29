// tests/rloginDoorserver.test.js -- RLogin access to the door server (#86,
// phase E): the RFC 1282 handshake and the door-server reading of its fields.

import assert from 'assert';
import { parseHandshake, authFromHandshake } from '../src/servers/rloginserver.js';
import { getDefinition } from '../src/config/configDefaults.js';

describe('RLogin door server (#86, phase E)', function () {

	it('waits for the whole handshake', function () {
		assert.strictEqual(parseHandshake(Buffer.from('\0secret\0MYBBS:bob\0ans')), null);
		var h = parseHandshake(Buffer.from('\0secret\0MYBBS:bob\0lord/38400\0extra'));
		assert.deepStrictEqual({ c: h.clientUser, s: h.serverUser, t: h.terminal, sp: h.speed, rest: h.rest.toString() },
			{ c: 'secret', s: 'MYBBS:bob', t: 'lord', sp: 38400, rest: 'extra' });
	});

	it('reads the secret, system and user, and a door slug from the terminal field', function () {
		var a = authFromHandshake({ clientUser: 'cds_x', serverUser: 'MYBBS:Bob Smith', terminal: 'lord' });
		assert.strictEqual(a.system_id, 'MYBBS');
		assert.strictEqual(a.secret, 'cds_x');
		assert.deepStrictEqual(a.user, { name: 'Bob Smith', real_name: 'Bob Smith' });
		assert.strictEqual(a.door, 'lord');
	});

	it('treats a terminal type as a request for the door list', function () {
		for (var t of ['ansi', 'ANSI-BBS', 'vt100', 'xterm-256color', 'syncterm', '']) {
			assert.strictEqual(authFromHandshake({ clientUser: 's', serverUser: 'X:y', terminal: t }).door, undefined, t);
		}
	});

	it('is off by default, on a port a non-root board can use', function () {
		assert.strictEqual(getDefinition('doorserver_rlogin_enabled').defaultValue, 'false');
		assert.ok(parseInt(getDefinition('doorserver_rlogin_port').defaultValue) > 1024);
	});
});
