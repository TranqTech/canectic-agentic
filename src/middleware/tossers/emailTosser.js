// emailTosser.js — Outbound internet email via SMTP relay.
//
// Queries pm_outbox for EMAIL transport messages and sends them through
// a configured SMTP smart relay using nodemailer.
//
// Success → markSent()
// Permanent failure (5xx) → markOutboxUndeliverable() (bounce to sender)
// Transient failure → markSendError() (retried next cycle)
//
// Sender identity:
//   System-generated messages (verification, password reset, templates,
//   notifications) use email_from_address / email_from_name.
//   User-generated PMs use <username>@<mail_domain> with the sender's
//   realname (or username) as the display name so external recipients
//   can reply-to the actual BBS user.

import * as nodemailer from 'nodemailer';
import * as privateMessages from '../../models/privateMessages.js';
import * as postgres from '../../middleware/db/postgres.js';
import * as alogger from '../../utils/alogger.js';
import appConfig from '../../config/appConfig.js';

var _transporter = null;

// SMTP port convention cheat sheet:
//   25  — plaintext with optional STARTTLS
//   465 — implicit TLS (SMTPS) — secure must be true
//   587 — submission with STARTTLS — secure must be false
// Reconcile the sysop-configured secure flag against the port. Mismatched
// combinations produce the infamous OpenSSL "wrong version number" error,
// so we warn and override rather than silently attempting a bad handshake.
function _reconcileSecure(port, configuredSecure) {
	if (port === 465 && configuredSecure !== true) {
		alogger.writeAlog(2,
			'[EmailTosser] Port 465 implies implicit TLS but email_relay_secure is false. ' +
			'Overriding to true for this cycle -- update admin config to silence this warning.',
			'yellow');
		return true;
	}
	if ((port === 587 || port === 25) && configuredSecure === true) {
		alogger.writeAlog(2,
			'[EmailTosser] Port ' + port + ' expects STARTTLS (plaintext upgrade) but ' +
			'email_relay_secure is true. Overriding to false for this cycle -- update ' +
			'admin config to silence this warning.',
			'yellow');
		return false;
	}
	return configuredSecure;
}

function getTransporter() {
	var host = appConfig.get('email_relay_host', '');
	if (!host) return null;

	if (!_transporter) {
		var port = appConfig.getNumber('email_relay_port', 587);
		var secure = _reconcileSecure(port, appConfig.getBoolean('email_relay_secure', false));

		var opts = {
			host: host,
			port: port,
			secure: secure,
			auth: {
				user: appConfig.get('email_relay_user', ''),
				pass: appConfig.get('email_relay_password', ''),
			},
		};

		// On submission port 587, require the STARTTLS upgrade so nodemailer
		// refuses to fall back to plaintext if the relay stops advertising it.
		if (port === 587 && !secure) {
			opts.requireTLS = true;
		}

		_transporter = nodemailer.createTransport(opts);
	}
	return _transporter;
}

function resetTransporter() {
	if (_transporter) {
		try { _transporter.close(); } catch (_) {}
		_transporter = null;
	}
}

// OpenSSL "wrong version number" is the classic port/secure mismatch symptom.
// Also catch a few adjacent TLS errors that point at the same diagnosis.
function _isTlsMismatchError(err) {
	if (!err || !err.message) return false;
	var m = err.message;
	return /wrong version number/i.test(m)
		|| /ssl routines.*tls_validate_record_header/i.test(m)
		|| /unsupported protocol/i.test(m)
		|| /ssl3_get_record/i.test(m);
}

// Slugify a BBS username into the local-part of an email address.
// Matches the imapAdapter.networkEmailAddress convention so the same user
// looks consistent whether they're speaking IMAP or receiving an outbound
// email the system sent on their behalf: lowercase + whitespace → dots.
function _usernameToLocal(username) {
	if (!username) return 'unknown';
	return String(username).toLowerCase().replace(/\s+/g, '.');
}

// Escape a display name for RFC 5322 quoted-string so embedded quotes or
// backslashes don't truncate the header.
function _escapeDisplayName(name) {
	return String(name || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// A message is "system-generated" when the system composed it on behalf of
// the BBS itself (verification code, password reset, template notification,
// sysop broadcast) rather than a user deliberately sending a PM via EMAIL
// transport. These should use the configured email_from_address.
function _isSystemMessage(pm, transportData) {
	if (transportData && transportData.system_notification === true) return true;
	if (pm.from_user === 'SYSTEM') return true;
	// user_id 0/null signals the system as sender (mailVerification etc.
	// write user_id: 0 explicitly to mark internal origin)
	if (pm.user_id === 0 || pm.user_id === null || pm.user_id === undefined) return true;
	return false;
}

// Build the From header value for an outbound PM.
//
// Returns { from, replyTo, envelopeFrom } where:
//   from          — "Display Name" <address>  (RFC 5322 header)
//   replyTo       — same format, or undefined
//   envelopeFrom  — bare address for SMTP MAIL FROM
//
// Strategy:
//   - System-generated messages always use the configured email_from_*.
//   - User-generated messages build <username>@<mail_domain> and use the
//     user's realname (or username) for the display name. If mail_domain
//     is not configured, we fall back to the system from-address but log
//     a warning so the sysop knows the configuration is incomplete.
async function _resolveSender(pm, transportData, sysFromAddress, sysFromName) {
	if (_isSystemMessage(pm, transportData)) {
		return {
			from: '"' + _escapeDisplayName(sysFromName) + '" <' + sysFromAddress + '>',
			replyTo: undefined,
			envelopeFrom: sysFromAddress
		};
	}

	var mailDomain = appConfig.get('mail_domain', '');
	if (!mailDomain) {
		alogger.writeAlog(3,
			'[EmailTosser] mail_domain not configured -- user PM id=' + pm.id +
			' will be sent with system from-address. Set mail_domain in ' +
			'/admin/config network category to route replies back to the sender.',
			'yellow');
		return {
			from: '"' + _escapeDisplayName(sysFromName) + '" <' + sysFromAddress + '>',
			replyTo: undefined,
			envelopeFrom: sysFromAddress
		};
	}

	// Resolve display name: prefer realname > from_user > username
	var displayName = pm.from_user || 'User';
	if (pm.user_id) {
		try {
			var userRow = await postgres.queryOne(
				'SELECT username, realname FROM users WHERE id = $1',
				[pm.user_id]
			);
			if (userRow) {
				if (userRow.realname && String(userRow.realname).trim()) {
					displayName = String(userRow.realname).trim();
				} else if (userRow.username) {
					displayName = userRow.username;
				}
			}
		} catch (_) {
			// Non-fatal — use pm.from_user already set
		}
	}

	var localPart = _usernameToLocal(pm.from_user);
	var userAddress = localPart + '@' + mailDomain;

	return {
		from: '"' + _escapeDisplayName(displayName) + '" <' + userAddress + '>',
		// Reply-To matches From so external recipients hit a reply-able address
		replyTo: '"' + _escapeDisplayName(displayName) + '" <' + userAddress + '>',
		envelopeFrom: userAddress
	};
}

async function tossOutbound() {
	var relayHost = appConfig.get('email_relay_host', '');
	if (!relayHost) {
		alogger.writeAlog(4, '[EmailTosser] No relay configured — skipping', 'yellow');
		return { sent: 0, errors: 0 };
	}

	var transporter = getTransporter();
	if (!transporter) return { sent: 0, errors: 0 };

	var pending = await privateMessages.getPendingByTransport('EMAIL');
	if (!pending || pending.length === 0) {
		alogger.writeAlog(4, '[EmailTosser] No pending EMAIL messages', 'cyan');
		return { sent: 0, errors: 0 };
	}

	var maxBatch = appConfig.getNumber('email_max_outbound_batch', 50);
	var batch = pending.slice(0, maxBatch);

	var sysFromAddress = appConfig.get('email_from_address', '');
	if (!sysFromAddress) {
		alogger.writeAlog(2, '[EmailTosser] email_from_address not configured — cannot send', 'redbright');
		return { sent: 0, errors: 0 };
	}
	var sysFromName = appConfig.get('email_from_name', '') || appConfig.get('boardname', 'BBS');

	var sentCount = 0;
	var errorCount = 0;

	for (var pm of batch) {
		var transportData = typeof pm.transport_data === 'string'
			? JSON.parse(pm.transport_data)
			: (pm.transport_data || {});

		var emailAddress = transportData.email_address;
		if (!emailAddress) {
			alogger.writeAlog(3, '[EmailTosser] PM id=' + pm.id + ' missing email_address in transport_data', 'yellow');
			await privateMessages.markOutboxUndeliverable(pm.id, 'No email address in transport_data');
			errorCount++;
			continue;
		}

		var sender = await _resolveSender(pm, transportData, sysFromAddress, sysFromName);

		var mailOptions = {
			from: sender.from,
			envelope: { from: sender.envelopeFrom, to: emailAddress },
			to: emailAddress,
			subject: pm.subject || '(no subject)',
			text: pm.utf8 || pm.body_text || '',
		};
		if (sender.replyTo) {
			mailOptions.replyTo = sender.replyTo;
		}

		// Include HTML body if available
		if (pm.body_html) {
			mailOptions.html = pm.body_html;
		}

		// Include attachments if present
		if (pm.has_attachments && pm.uuid) {
			try {
				var pmAtt = await import('../../models/pmAttachments.js');
				var atts = await pmAtt.getAttachments(pm.uuid);
				if (atts.length > 0) {
					mailOptions.attachments = atts.map(function(att) {
						return {
							filename: att.filename,
							path: att.storage_path,
							contentType: att.mime_type || 'application/octet-stream'
						};
					});
				}
			} catch (attErr) {
				alogger.writeAlog(3, '[EmailTosser] Attachment load error for PM ' + pm.id + ': ' + attErr.message, 'yellow');
			}
		}

		try {
			await transporter.sendMail(mailOptions);
			await privateMessages.markSent(pm.id, 'EmailTosser');
			alogger.writeAlog(3, '[EmailTosser] Sent to ' + emailAddress + ' (PM id=' + pm.id + ')', 'green');
			sentCount++;
		} catch (err) {
			var code = err.responseCode || 0;
			var tlsMismatch = _isTlsMismatchError(err);

			if (code >= 500 && code < 600) {
				// Permanent failure — bounce
				alogger.writeAlog(2, '[EmailTosser] Permanent failure for PM id=' + pm.id +
					' to ' + emailAddress + ': ' + err.message, 'redbright');
				await privateMessages.markOutboxUndeliverable(pm.id,
					'SMTP ' + code + ': ' + (err.response || err.message));
			} else {
				// Transient failure — retry next cycle
				alogger.writeAlog(3, '[EmailTosser] Transient error for PM id=' + pm.id +
					' to ' + emailAddress + ': ' + err.message, 'yellow');
				await privateMessages.markSendError(pm.id, err.message);
			}

			if (tlsMismatch) {
				alogger.writeAlog(2,
					'[EmailTosser] TLS handshake mismatch detected. This almost always means ' +
					'email_relay_port and email_relay_secure disagree: port 465 needs ' +
					'secure=true (implicit TLS); ports 587 and 25 need secure=false (STARTTLS). ' +
					'Fix via /admin/config email category and retry.',
					'redbright');
				// Bad SSL state sticks to the cached transporter -- force a rebuild
				// next cycle so the retry starts clean (picks up config changes too).
				resetTransporter();
			}

			errorCount++;
		}
	}

	if (sentCount > 0 || errorCount > 0) {
		alogger.writeAlog(2, '[EmailTosser] Cycle complete: ' + sentCount + ' sent, ' +
			errorCount + ' errors (of ' + batch.length + ')', 'cyan');
	}

	return { sent: sentCount, errors: errorCount };
}

export {
	tossOutbound,
	resetTransporter,
	_reconcileSecure,
	_isTlsMismatchError,
	_isSystemMessage,
	_usernameToLocal,
	_resolveSender
};
