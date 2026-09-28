// authFailLog.js -- the [AUTHFAIL] lines fail2ban reads from security.log.
//
// One definition, because the filter in examples/fail2ban/filter.d is a regex
// over this text and every writer has to match it:
//
//   [AUTHFAIL] Failed login for "<who>" from <ip>[ via <service>]
//   [AUTHFAIL] Login attempt for unknown user "<who>" from <ip>[ via <service>]
//
// Before #83 a failed IMAP or SMTP login was written "from unknown", since
// neither passed the client address, and a rejected API token was not written
// at all, so fail2ban could act on neither. The address is normalised here:
// a socket on a dual-stack listener reports IPv4 clients as ::ffff:a.b.c.d,
// which fail2ban would ban as an IPv6 address the client never uses.

import * as alogger from './alogger.js';

var _sink = null;

// Tests only: capture lines instead of writing security.log.
function setAuthFailSink(fn) {
	_sink = fn || null;
}

function normaliseIp(ip) {
	var s = String(ip || '').trim();
	if (!s) return 'unknown';
	return s.replace(/^::ffff:/i, '');
}

// kind: 'failed' (wrong password or credential) or 'unknown' (no such user)
function authFailMessage(kind, who, ip, service) {
	var name = String(who === undefined || who === null ? '' : who).replace(/"/g, '');
	var head = kind === 'unknown' ? 'Login attempt for unknown user' : 'Failed login for';
	return '[AUTHFAIL] ' + head + ' "' + name + '" from ' + normaliseIp(ip) +
		(service ? ' via ' + service : '');
}

function logAuthFail(kind, who, ip, service) {
	var line = authFailMessage(kind, who, ip, service);
	if (_sink) { _sink(line); return; }
	alogger.writeClog(3, line, 'security', 'yellow');
}

export { logAuthFail, authFailMessage, normaliseIp, setAuthFailSink };
