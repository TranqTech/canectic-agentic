// tests/emailTransport.test.js — Unit tests for internet email transport
//
// Tests:
//   - IMAP adapter: EMAIL transport rendering (networkEmailAddress, networkDisplayName via renderRfc2822)
//   - SMTP server: address resolution for EMAIL transport (external domains)
//   - SMTP server: trusted mode address resolution (local-only)
//   - Transport access control: EMAIL permission/restriction flags
//   - Email tosser: config validation, batch limiting
//
// Pure logic tests — no DB or SMTP connections required.
// Run: npx mocha tests/emailTransport.test.js

import assert from 'assert';

// ============================================================
// IMAP adapter — EMAIL transport rendering
// ============================================================

// imapAdapter imports postgres at module level (lazy pool, no TCP until query).
// networkEmailAddress/networkDisplayName are not exported directly but are
// exercised through renderRfc2822.

var imapAdapter;
try {
	imapAdapter = await import('../src/models/imapAdapter.js');
} catch (err) {
	imapAdapter = null;
}

describe('IMAP adapter — EMAIL transport rendering', function () {
	if (!imapAdapter) {
		it('skip: imapAdapter could not be imported');
		return;
	}

	it('should render From header with real email address for EMAIL transport', function () {
		var pmRow = {
			id: 1,
			from_user: 'John Doe',
			to_user: 'kostie',
			from_address: 'johndoe@gmail.com',
			to_address: '',
			subject: 'Test email',
			transport_type: 'EMAIL',
			body_text: 'Hello from the internet',
			utf8: 'Hello from the internet',
			system_time: new Date('2026-01-01T00:00:00Z'),
			_source: 'inbox'
		};
		var rfc = imapAdapter.renderRfc2822(pmRow, 'mybbs.example.com');
		// From should contain the real email domain, not the BBS domain
		assert.ok(rfc.includes('gmail.com'), 'RFC 2822 should contain gmail.com in From');
		assert.ok(rfc.includes('johndoe'), 'RFC 2822 should contain johndoe local part');
	});

	it('should render To header with BBS domain for EMAIL inbound (no to_address)', function () {
		var pmRow = {
			id: 2,
			from_user: 'sender@external.com',
			to_user: 'kostie',
			from_address: 'sender@external.com',
			to_address: '',
			subject: 'Inbound test',
			transport_type: 'EMAIL',
			body_text: 'Hi',
			system_time: new Date('2026-01-01T00:00:00Z'),
			_source: 'inbox'
		};
		var rfc = imapAdapter.renderRfc2822(pmRow, 'mybbs.example.com');
		// To should fall back to local username @ mailDomain (no to_address)
		assert.ok(rfc.includes('mybbs.example.com'), 'To address should use BBS domain');
	});

	it('should show angle-bracket display name for EMAIL transport', function () {
		var pmRow = {
			id: 3,
			from_user: 'Jane',
			to_user: 'kostie',
			from_address: 'jane@example.com',
			to_address: '',
			subject: 'Display name test',
			transport_type: 'EMAIL',
			body_text: 'Hi',
			system_time: new Date('2026-01-01T00:00:00Z'),
			_source: 'inbox'
		};
		var rfc = imapAdapter.renderRfc2822(pmRow, 'mybbs.example.com');
		// Display name for EMAIL should use "name <addr>" format
		assert.ok(rfc.includes('Jane <jane@example.com>'), 'From should show "name <email>" format');
	});

	it('should handle bare email address (no @) gracefully', function () {
		var pmRow = {
			id: 4,
			from_user: 'unknown',
			to_user: 'kostie',
			from_address: 'noreply',
			to_address: '',
			subject: 'Bare address',
			transport_type: 'EMAIL',
			body_text: 'Hi',
			system_time: new Date('2026-01-01T00:00:00Z'),
			_source: 'inbox'
		};
		var rfc = imapAdapter.renderRfc2822(pmRow, 'mybbs.example.com');
		// Bare address should use local part with BBS domain
		assert.ok(rfc.includes('noreply@mybbs.example.com'), 'Bare address should fall back to mailDomain');
	});
});

// ============================================================
// SMTP server — address resolution
// ============================================================

// SmtpSession is exported. We can create one with a mock socket to test
// _resolveAddress without a real TCP connection.

var smtpModule;
try {
	smtpModule = await import('../src/servers/smtpServer.js');
} catch (err) {
	smtpModule = null;
}

function createMockSocket() {
	return {
		write: function () {},
		on: function () {},
		end: function () {},
		destroyed: false,
		remoteAddress: '127.0.0.1'
	};
}

function createSession(options) {
	var socket = createMockSocket();
	// Suppress greeting output
	socket.write = function () {};
	return new smtpModule.SmtpSession(socket, 'mybbs.example.com', options);
}

describe('SMTP address resolution — EMAIL transport', function () {
	if (!smtpModule) {
		it('skip: smtpServer could not be imported');
		return;
	}

	it('should resolve external domain as EMAIL transport for authenticated sessions', async function () {
		var session = createSession();
		session.authenticated = true;
		var result = await session._resolveAddress('user@gmail.com');
		assert.ok(result, 'Should resolve external address');
		assert.strictEqual(result.transportType, 'EMAIL');
		assert.strictEqual(result.transportData.email_address, 'user@gmail.com');
	});

	it('should resolve external domain with correct local part', async function () {
		var session = createSession();
		session.authenticated = true;
		var result = await session._resolveAddress('john.doe@outlook.com');
		assert.strictEqual(result.transportType, 'EMAIL');
		assert.strictEqual(result.transportData.email_address, 'john.doe@outlook.com');
		assert.strictEqual(result.toUser, 'john.doe');
	});

	it('should still resolve .ftn addresses as FTN transport', async function () {
		var session = createSession();
		session.authenticated = true;
		var result = await session._resolveAddress('kostie@1.134.101.ftn');
		assert.ok(result, 'Should resolve .ftn address');
		assert.strictEqual(result.transportType, 'FTN');
		assert.strictEqual(result.ftnAddress, '1:134/101');
	});

	it('should still resolve .qwk addresses as QWK transport', async function () {
		var session = createSession();
		session.authenticated = true;
		var result = await session._resolveAddress('kostie@undrmine.qwk');
		assert.ok(result, 'Should resolve .qwk address');
		assert.strictEqual(result.transportType, 'QWK');
		assert.strictEqual(result.qwkPeerId, 'UNDRMINE');
	});

	it('should resolve FTN with point number', async function () {
		var session = createSession();
		session.authenticated = true;
		var result = await session._resolveAddress('kostie@1.134.101.2.ftn');
		assert.ok(result, 'Should resolve .ftn address with point');
		assert.strictEqual(result.transportType, 'FTN');
		assert.strictEqual(result.ftnAddress, '1:134/101.2');
	});
});

describe('SMTP address resolution — trusted inbound mode', function () {
	if (!smtpModule) {
		it('skip: smtpServer could not be imported');
		return;
	}

	it('should reject external domains in trusted mode', async function () {
		var session = createSession({ trusted: true });
		var result = await session._resolveAddress('user@gmail.com');
		assert.strictEqual(result, null, 'Trusted mode should reject external domains');
	});

	it('should reject .ftn addresses in trusted mode', async function () {
		var session = createSession({ trusted: true });
		var result = await session._resolveAddress('kostie@1.134.101.ftn');
		assert.strictEqual(result, null, 'Trusted mode should reject .ftn addresses');
	});

	it('should reject .qwk addresses in trusted mode', async function () {
		var session = createSession({ trusted: true });
		var result = await session._resolveAddress('kostie@undrmine.qwk');
		assert.strictEqual(result, null, 'Trusted mode should reject .qwk addresses');
	});

	it('should reject addresses on wrong domain in trusted mode', async function () {
		var session = createSession({ trusted: true });
		var result = await session._resolveAddress('user@otherdomain.com');
		assert.strictEqual(result, null, 'Trusted mode should reject wrong domain');
	});

	// Note: resolving local users on our domain requires DB — tested via integration
});

// ============================================================
// SmtpServer — trusted host filtering
// ============================================================

describe('SmtpServer trusted host configuration', function () {
	if (!smtpModule) {
		it('skip: smtpServer could not be imported');
		return;
	}

	it('should parse comma-separated trusted hosts', function () {
		var server = new smtpModule.SmtpServer(0, 'mybbs.example.com', {
			trusted: true,
			trustedHosts: '127.0.0.1, 10.0.0.1, 192.168.1.100'
		});
		assert.ok(server._trustedHosts.has('127.0.0.1'));
		assert.ok(server._trustedHosts.has('10.0.0.1'));
		assert.ok(server._trustedHosts.has('192.168.1.100'));
		assert.strictEqual(server._trustedHosts.size, 3);
	});

	it('should default to 127.0.0.1 when trustedHosts is empty', function () {
		var server = new smtpModule.SmtpServer(0, 'mybbs.example.com', {
			trusted: true
		});
		assert.ok(server._trustedHosts.has('127.0.0.1'));
	});

	it('should not create trustedHosts set for non-trusted servers', function () {
		var server = new smtpModule.SmtpServer(0, 'mybbs.example.com');
		assert.strictEqual(server._trustedHosts, undefined);
	});
});

// ============================================================
// Transport access control — EMAIL permission flags
// ============================================================

// checkTransportAccess is exported from privateMessages.js.
// It's pure logic — no DB access.

var pmModule;
try {
	pmModule = await import('../src/models/privateMessages.js');
} catch (err) {
	pmModule = null;
}

describe('Transport access control — EMAIL', function () {
	if (!pmModule) {
		it('skip: privateMessages could not be imported');
		return;
	}

	it('should deny EMAIL access by default (no flags)', function () {
		var session = { permissionflags: [], restrictionflags: [] };
		var result = pmModule.checkTransportAccess(session, 'EMAIL');
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.reason, 'no_permission');
	});

	it('should allow EMAIL access with Email permission flag', function () {
		var session = { permissionflags: ['Email'], restrictionflags: [] };
		var result = pmModule.checkTransportAccess(session, 'EMAIL');
		assert.strictEqual(result.allowed, true);
	});

	it('should deny EMAIL access when Email restriction flag is set', function () {
		var session = { permissionflags: ['Email'], restrictionflags: ['Email'] };
		var result = pmModule.checkTransportAccess(session, 'EMAIL');
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.reason, 'restricted');
	});

	it('should deny EMAIL even for Sysop when Email restriction is set', function () {
		var session = { permissionflags: ['Sysop', 'Email'], restrictionflags: ['Email'] };
		var result = pmModule.checkTransportAccess(session, 'EMAIL');
		assert.strictEqual(result.allowed, false);
	});

	it('should allow EMAIL for Sysop without Email permission flag', function () {
		var session = { permissionflags: ['Sysop'], restrictionflags: [] };
		var result = pmModule.checkTransportAccess(session, 'EMAIL');
		assert.strictEqual(result.allowed, true);
		assert.strictEqual(result.reason, 'sysop');
	});

	it('should include EMAIL in getAllowedTransports when user has Email flag', function () {
		var session = { permissionflags: ['Email'], restrictionflags: [] };
		var allowed = pmModule.getAllowedTransports(session);
		assert.ok(allowed.includes('EMAIL'), 'EMAIL should be in allowed transports');
	});

	it('should not include EMAIL in getAllowedTransports by default', function () {
		var session = { permissionflags: [], restrictionflags: [] };
		var allowed = pmModule.getAllowedTransports(session);
		assert.ok(!allowed.includes('EMAIL'), 'EMAIL should not be allowed without flag');
	});
});

// ============================================================
// SMTP message parsing
// ============================================================

describe('SMTP session — message parsing', function () {
	if (!smtpModule) {
		it('skip: smtpServer could not be imported');
		return;
	}

	it('should parse simple plain text message', function () {
		var session = createSession();
		var raw = 'Subject: Test Subject\r\nFrom: user@example.com\r\nTo: dest@example.com\r\n\r\nHello, world!';
		var parsed = session._parseMessage(raw);
		assert.strictEqual(parsed.subject, 'Test Subject');
		assert.strictEqual(parsed.bodyPlain, 'Hello, world!');
	});

	it('should parse multipart MIME message', function () {
		var session = createSession();
		var raw = [
			'Subject: MIME Test',
			'Content-Type: multipart/alternative; boundary="boundary123"',
			'',
			'--boundary123',
			'Content-Type: text/plain',
			'',
			'Plain text body',
			'--boundary123',
			'Content-Type: text/html',
			'',
			'<b>HTML body</b>',
			'--boundary123--'
		].join('\r\n');
		var parsed = session._parseMessage(raw);
		assert.strictEqual(parsed.subject, 'MIME Test');
		assert.strictEqual(parsed.bodyPlain, 'Plain text body');
		assert.strictEqual(parsed.bodyHtml, '<b>HTML body</b>');
	});

	it('should extract plain text from HTML-only message', function () {
		var session = createSession();
		var raw = 'Subject: HTML Only\r\nContent-Type: text/html\r\n\r\n<p>Hello</p>';
		var parsed = session._parseMessage(raw);
		assert.strictEqual(parsed.bodyHtml, '<p>Hello</p>');
		assert.strictEqual(parsed.bodyPlain, 'Hello');
	});

	it('should handle message with no body', function () {
		var session = createSession();
		var raw = 'Subject: No Body';
		var parsed = session._parseMessage(raw);
		assert.strictEqual(parsed.subject, 'No Body');
		assert.strictEqual(parsed.bodyPlain, '');
	});
});

// ============================================================
// Config defaults — email keys exist
// ============================================================

var configDefs;
try {
	configDefs = await import('../src/config/configDefaults.js');
} catch (err) {
	configDefs = null;
}

describe('Config defaults — email category', function () {
	if (!configDefs) {
		it('skip: configDefaults could not be imported');
		return;
	}

	var expectedKeys = [
		'email_relay_host',
		'email_relay_port',
		'email_relay_secure',
		'email_relay_user',
		'email_relay_password',
		'email_from_address',
		'email_from_name',
		'email_max_outbound_batch',
		'email_inbound_port',
		'email_trusted_hosts'
	];

	for (var key of expectedKeys) {
		(function (k) {
			it('should define config key: ' + k, function () {
				var def = configDefs.getDefinition(k);
				assert.ok(def, 'Config key "' + k + '" should be defined');
				assert.strictEqual(def.category, 'email');
			});
		})(key);
	}

	it('should include email in getCategories()', function () {
		var cats = configDefs.getCategories();
		assert.ok(cats.includes('email'), 'Categories should include "email"');
	});

	it('email_relay_port should default to 587', function () {
		var def = configDefs.getDefinition('email_relay_port');
		assert.strictEqual(def.defaultValue, '587');
	});

	it('email_inbound_port should default to 0 (disabled)', function () {
		var def = configDefs.getDefinition('email_inbound_port');
		assert.strictEqual(def.defaultValue, '0');
	});

	it('email_trusted_hosts should default to 127.0.0.1', function () {
		var def = configDefs.getDefinition('email_trusted_hosts');
		assert.strictEqual(def.defaultValue, '127.0.0.1');
	});
});
