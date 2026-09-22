// tests/mailStartup.test.js: when the mail process has anything to serve.
//
// The mail process exited when mail was not configured, and pm2 restarts
// anything that exits, so every fresh install (no mail_domain) showed the mail
// process restarting in a loop until pm2 gave up. It now waits, and starts its
// servers when the configuration allows. This is that rule.
//
// Run: npx mocha --no-config --exit tests/mailStartup.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { mailDisabledReason } from '../src/servers/mailStartup.js';

var REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cfg(values) {
	return {
		get: function (k, d) { return values[k] !== undefined ? values[k] : d; },
		getNumber: function (k, d) { return values[k] !== undefined ? Number(values[k]) : d; }
	};
}

describe('mailDisabledReason', function () {
	it('waits without a mail domain', function () {
		assert.ok(/mail_domain/.test(mailDisabledReason(cfg({}))));
		assert.ok(/mail_domain/.test(mailDisabledReason(cfg({ mail_domain: '   ' }))));
	});

	it('waits when every mail port is 0', function () {
		var r = mailDisabledReason(cfg({ mail_domain: 'bbs.example', imapport: 0, smtpport: 0, email_inbound_port: 0 }));
		assert.ok(/no mail server is enabled/.test(r), r);
	});

	it('starts with a domain and the default ports', function () {
		assert.strictEqual(mailDisabledReason(cfg({ mail_domain: 'bbs.example' })), null);
	});

	it('starts with only the inbound gateway enabled', function () {
		assert.strictEqual(mailDisabledReason(cfg({ mail_domain: 'bbs.example', imapport: 0, smtpport: 0,
			email_inbound_port: 2525 })), null);
	});
});

describe('the mail process', function () {
	it('never exits just because mail is not configured', function () {
		// An exit here is a pm2 restart loop on every board without mail.
		var src = fs.readFileSync(path.join(REPO, 'bin/mail.js'), 'utf8');
		var exits = src.split('\n').filter(function (l) { return /process\.exit\(0\)/.test(l); });
		assert.strictEqual(exits.length, 1, 'only shutdown may exit cleanly: ' + exits.join(' | '));
		assert.ok(/mailDisabledReason\(appConfig\)/.test(src), 'the start decision must go through the tested rule');
	});
});
