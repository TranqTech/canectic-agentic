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
		assert.ok(server._trustedHosts.exact.has('127.0.0.1'));
		assert.ok(server._trustedHosts.exact.has('10.0.0.1'));
		assert.ok(server._trustedHosts.exact.has('192.168.1.100'));
		assert.strictEqual(server._trustedHosts.exact.size, 3);
		assert.strictEqual(server._trustedHosts.cidrs.length, 0);
	});

	it('should parse CIDR blocks alongside exact hosts', function () {
		var server = new smtpModule.SmtpServer(0, 'mybbs.example.com', {
			trusted: true,
			trustedHosts: '127.0.0.1, 10.0.0.0/8, 192.168.1.0/24'
		});
		assert.strictEqual(server._trustedHosts.exact.size, 1);
		assert.strictEqual(server._trustedHosts.cidrs.length, 2);
	});

	it('should default to 127.0.0.1 when trustedHosts is empty', function () {
		var server = new smtpModule.SmtpServer(0, 'mybbs.example.com', {
			trusted: true
		});
		assert.ok(server._trustedHosts.exact.has('127.0.0.1'));
	});

	it('should not create trustedHosts for non-trusted servers', function () {
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

// ============================================================
// Email tosser — SMTP port/secure reconciliation + TLS error detection
// ============================================================

var emailTosser;
try {
	emailTosser = await import('../src/middleware/tossers/emailTosser.js');
} catch (err) {
	emailTosser = null;
}

describe('Email tosser — port/secure reconciliation', function () {
	if (!emailTosser) {
		it.skip('skipped — emailTosser module not loadable', function () {});
		return;
	}

	it('leaves port 465 + secure=true alone (implicit TLS, matches convention)', function () {
		assert.strictEqual(emailTosser._reconcileSecure(465, true), true);
	});

	it('overrides port 465 + secure=false to true (would fail handshake otherwise)', function () {
		assert.strictEqual(emailTosser._reconcileSecure(465, false), true);
	});

	it('leaves port 587 + secure=false alone (STARTTLS submission, matches convention)', function () {
		assert.strictEqual(emailTosser._reconcileSecure(587, false), false);
	});

	it('overrides port 587 + secure=true to false (the AWS SES misconfig case)', function () {
		assert.strictEqual(emailTosser._reconcileSecure(587, true), false);
	});

	it('overrides port 25 + secure=true to false (plain SMTP with STARTTLS)', function () {
		assert.strictEqual(emailTosser._reconcileSecure(25, true), false);
	});

	it('leaves port 25 + secure=false alone', function () {
		assert.strictEqual(emailTosser._reconcileSecure(25, false), false);
	});

	it('does not touch non-standard ports — trusts the sysop', function () {
		assert.strictEqual(emailTosser._reconcileSecure(2525, true), true);
		assert.strictEqual(emailTosser._reconcileSecure(2525, false), false);
		assert.strictEqual(emailTosser._reconcileSecure(1025, true), true);
	});
});

// ============================================================
// SMTP trusted-host allowlist (CIDR + exact match)
// ============================================================

var smtpServer;
try {
	smtpServer = await import('../src/servers/smtpServer.js');
} catch (err) {
	smtpServer = null;
}

describe('SMTP trusted-host allowlist', function () {
	if (!smtpServer) {
		it.skip('skipped — smtpServer module not loadable', function () {});
		return;
	}

	describe('_ipv4ToInt', function () {
		it('parses valid IPv4 addresses to 32-bit ints', function () {
			assert.strictEqual(smtpServer._ipv4ToInt('0.0.0.0'), 0);
			assert.strictEqual(smtpServer._ipv4ToInt('127.0.0.1'), 0x7F000001);
			assert.strictEqual(smtpServer._ipv4ToInt('10.0.0.1'), 0x0A000001);
			assert.strictEqual(smtpServer._ipv4ToInt('192.168.1.1'), 0xC0A80101);
			assert.strictEqual(smtpServer._ipv4ToInt('255.255.255.255'), 0xFFFFFFFF);
		});

		it('rejects malformed IPv4 addresses', function () {
			assert.strictEqual(smtpServer._ipv4ToInt('256.0.0.1'), null);
			assert.strictEqual(smtpServer._ipv4ToInt('10.0.0'), null);
			assert.strictEqual(smtpServer._ipv4ToInt('10.0.0.1.2'), null);
			assert.strictEqual(smtpServer._ipv4ToInt('not.an.ip.addr'), null);
			assert.strictEqual(smtpServer._ipv4ToInt(''), null);
			assert.strictEqual(smtpServer._ipv4ToInt(null), null);
			assert.strictEqual(smtpServer._ipv4ToInt('10.0.0.-1'), null);
		});
	});

	describe('_parseTrustedHostList', function () {
		it('parses a plain IP list into exact matches', function () {
			var parsed = smtpServer._parseTrustedHostList('127.0.0.1,192.168.1.5');
			assert.strictEqual(parsed.exact.size, 2);
			assert.strictEqual(parsed.exact.has('127.0.0.1'), true);
			assert.strictEqual(parsed.exact.has('192.168.1.5'), true);
			assert.strictEqual(parsed.cidrs.length, 0);
		});

		it('parses CIDR notation into base/mask pairs', function () {
			var parsed = smtpServer._parseTrustedHostList('10.0.0.0/8');
			assert.strictEqual(parsed.cidrs.length, 1);
			assert.strictEqual(parsed.cidrs[0].base, 0x0A000000);
			assert.strictEqual(parsed.cidrs[0].mask, 0xFF000000);
		});

		it('mixes exact IPs and CIDR blocks', function () {
			var parsed = smtpServer._parseTrustedHostList('127.0.0.1, 10.0.0.0/8, 192.168.1.5');
			assert.strictEqual(parsed.exact.size, 2);
			assert.strictEqual(parsed.cidrs.length, 1);
		});

		it('canonicalises CIDR base IPs with non-zero host bits (e.g. 10.0.0.1/8)', function () {
			// 10.0.0.1/8 → base should mask to 10.0.0.0
			var parsed = smtpServer._parseTrustedHostList('10.0.0.1/8');
			assert.strictEqual(parsed.cidrs.length, 1);
			assert.strictEqual(parsed.cidrs[0].base, 0x0A000000);
		});

		it('handles /32 (single host) and /0 (any host)', function () {
			var parsed32 = smtpServer._parseTrustedHostList('10.0.0.5/32');
			assert.strictEqual(parsed32.cidrs[0].base, 0x0A000005);
			assert.strictEqual(parsed32.cidrs[0].mask, 0xFFFFFFFF);

			var parsed0 = smtpServer._parseTrustedHostList('0.0.0.0/0');
			assert.strictEqual(parsed0.cidrs[0].base, 0);
			assert.strictEqual(parsed0.cidrs[0].mask, 0);
		});

		it('rejects malformed CIDR (invalid prefix)', function () {
			var parsed = smtpServer._parseTrustedHostList('10.0.0.0/33, 127.0.0.1');
			assert.strictEqual(parsed.cidrs.length, 0);
			// exact-match entry still parsed
			assert.strictEqual(parsed.exact.has('127.0.0.1'), true);
		});

		it('rejects malformed CIDR (invalid base IP)', function () {
			var parsed = smtpServer._parseTrustedHostList('not.an.ip/24, 127.0.0.1');
			assert.strictEqual(parsed.cidrs.length, 0);
			assert.strictEqual(parsed.exact.has('127.0.0.1'), true);
		});

		it('handles empty / whitespace-only input', function () {
			var empty = smtpServer._parseTrustedHostList('');
			assert.strictEqual(empty.exact.size, 0);
			assert.strictEqual(empty.cidrs.length, 0);

			var ws = smtpServer._parseTrustedHostList('   ,  ,  ');
			assert.strictEqual(ws.exact.size, 0);
			assert.strictEqual(ws.cidrs.length, 0);
		});

		it('trims whitespace around entries', function () {
			var parsed = smtpServer._parseTrustedHostList('  127.0.0.1  ,  10.0.0.0/8  ');
			assert.strictEqual(parsed.exact.has('127.0.0.1'), true);
			assert.strictEqual(parsed.cidrs.length, 1);
		});
	});

	describe('_matchesTrustedHost', function () {
		it('matches exact IPs', function () {
			var parsed = smtpServer._parseTrustedHostList('127.0.0.1,192.168.1.5');
			assert.strictEqual(smtpServer._matchesTrustedHost('127.0.0.1', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('192.168.1.5', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('192.168.1.6', parsed), false);
			assert.strictEqual(smtpServer._matchesTrustedHost('10.0.0.1', parsed), false);
		});

		it('matches IPs inside /8 CIDR', function () {
			var parsed = smtpServer._parseTrustedHostList('10.0.0.0/8');
			assert.strictEqual(smtpServer._matchesTrustedHost('10.0.0.1', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('10.255.255.254', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('11.0.0.1', parsed), false);
			assert.strictEqual(smtpServer._matchesTrustedHost('127.0.0.1', parsed), false);
		});

		it('matches IPs inside /24 CIDR', function () {
			var parsed = smtpServer._parseTrustedHostList('192.168.1.0/24');
			assert.strictEqual(smtpServer._matchesTrustedHost('192.168.1.1', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('192.168.1.254', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('192.168.2.1', parsed), false);
			assert.strictEqual(smtpServer._matchesTrustedHost('192.168.0.1', parsed), false);
		});

		it('matches IPs inside /16 CIDR', function () {
			var parsed = smtpServer._parseTrustedHostList('172.16.0.0/12');
			// Private range: 172.16.0.0 - 172.31.255.255
			assert.strictEqual(smtpServer._matchesTrustedHost('172.16.0.1', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('172.20.50.100', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('172.31.255.254', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('172.32.0.1', parsed), false);
			assert.strictEqual(smtpServer._matchesTrustedHost('172.15.255.254', parsed), false);
		});

		it('mixes exact and CIDR matching', function () {
			var parsed = smtpServer._parseTrustedHostList('127.0.0.1, 10.0.0.0/8');
			assert.strictEqual(smtpServer._matchesTrustedHost('127.0.0.1', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('10.50.100.200', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('192.168.1.1', parsed), false);
		});

		it('matches the AWS-sized user example: 10.0.30.X in 10.0.0.0/8', function () {
			var parsed = smtpServer._parseTrustedHostList('10.0.0.0/8');
			assert.strictEqual(smtpServer._matchesTrustedHost('10.0.30.50', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('10.0.30.1', parsed), true);
		});

		it('returns false for malformed remote address', function () {
			var parsed = smtpServer._parseTrustedHostList('10.0.0.0/8');
			assert.strictEqual(smtpServer._matchesTrustedHost('not.an.ip', parsed), false);
			assert.strictEqual(smtpServer._matchesTrustedHost('', parsed), false);
		});

		it('/0 matches any IPv4', function () {
			var parsed = smtpServer._parseTrustedHostList('0.0.0.0/0');
			assert.strictEqual(smtpServer._matchesTrustedHost('1.2.3.4', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('10.0.30.50', parsed), true);
			assert.strictEqual(smtpServer._matchesTrustedHost('255.255.255.255', parsed), true);
		});
	});
});

describe('Email tosser — system vs user sender detection', function () {
	if (!emailTosser) {
		it.skip('skipped — emailTosser module not loadable', function () {});
		return;
	}

	it('treats transport_data.system_notification=true as system', function () {
		var pm = { from_user: 'Kostie', user_id: 42 };
		assert.strictEqual(emailTosser._isSystemMessage(pm, { system_notification: true }), true);
	});

	it('treats from_user=SYSTEM as system', function () {
		var pm = { from_user: 'SYSTEM', user_id: 0 };
		assert.strictEqual(emailTosser._isSystemMessage(pm, {}), true);
	});

	it('treats user_id=0 as system (mailVerification et al. pattern)', function () {
		var pm = { from_user: 'My BBS', user_id: 0 };
		assert.strictEqual(emailTosser._isSystemMessage(pm, {}), true);
	});

	it('treats user_id=null as system', function () {
		var pm = { from_user: 'My BBS', user_id: null };
		assert.strictEqual(emailTosser._isSystemMessage(pm, null), true);
	});

	it('treats a real user with no system flag as user-generated', function () {
		var pm = { from_user: 'Kostie', user_id: 42 };
		assert.strictEqual(emailTosser._isSystemMessage(pm, {}), false);
	});

	it('treats a real user even if from_user contains BBS-ish text', function () {
		var pm = { from_user: 'Kostie Muirhead', user_id: 42 };
		assert.strictEqual(emailTosser._isSystemMessage(pm, { email_address: 'x@y.com' }), false);
	});
});

describe('Email tosser — username to local-part slugification', function () {
	if (!emailTosser) {
		it.skip('skipped — emailTosser module not loadable', function () {});
		return;
	}

	it('lowercases simple usernames', function () {
		assert.strictEqual(emailTosser._usernameToLocal('Kostie'), 'kostie');
		assert.strictEqual(emailTosser._usernameToLocal('ADMIN'), 'admin');
	});

	it('replaces spaces with dots', function () {
		assert.strictEqual(emailTosser._usernameToLocal('Kostie Muirhead'), 'kostie.muirhead');
		assert.strictEqual(emailTosser._usernameToLocal('First Middle Last'), 'first.middle.last');
	});

	it('collapses runs of whitespace', function () {
		assert.strictEqual(emailTosser._usernameToLocal('Kostie   Muirhead'), 'kostie.muirhead');
		assert.strictEqual(emailTosser._usernameToLocal('A\tB'), 'a.b');
	});

	it('returns "unknown" for empty / null input', function () {
		assert.strictEqual(emailTosser._usernameToLocal(''), 'unknown');
		assert.strictEqual(emailTosser._usernameToLocal(null), 'unknown');
		assert.strictEqual(emailTosser._usernameToLocal(undefined), 'unknown');
	});
});

describe('Email tosser — TLS mismatch error detection', function () {
	if (!emailTosser) {
		it.skip('skipped — emailTosser module not loadable', function () {});
		return;
	}

	it('recognises OpenSSL "wrong version number"', function () {
		var err = new Error('009D0B57677A0000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number');
		assert.strictEqual(emailTosser._isTlsMismatchError(err), true);
	});

	it('recognises the tls_validate_record_header prefix on its own', function () {
		var err = new Error('SSL routines tls_validate_record_header failure');
		assert.strictEqual(emailTosser._isTlsMismatchError(err), true);
	});

	it('recognises "unsupported protocol"', function () {
		var err = new Error('SSL alert: unsupported protocol');
		assert.strictEqual(emailTosser._isTlsMismatchError(err), true);
	});

	it('recognises legacy ssl3_get_record errors', function () {
		var err = new Error('ssl3_get_record: wrong version number');
		assert.strictEqual(emailTosser._isTlsMismatchError(err), true);
	});

	it('does not false-positive on unrelated SMTP errors', function () {
		assert.strictEqual(
			emailTosser._isTlsMismatchError(new Error('550 5.1.1 User unknown')),
			false
		);
		assert.strictEqual(
			emailTosser._isTlsMismatchError(new Error('Connection timed out')),
			false
		);
		assert.strictEqual(
			emailTosser._isTlsMismatchError(new Error('Authentication failed')),
			false
		);
	});

	it('handles null / undefined / empty errors safely', function () {
		assert.strictEqual(emailTosser._isTlsMismatchError(null), false);
		assert.strictEqual(emailTosser._isTlsMismatchError(undefined), false);
		assert.strictEqual(emailTosser._isTlsMismatchError({}), false);
	});
});
