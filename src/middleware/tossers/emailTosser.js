// emailTosser.js — Outbound internet email via SMTP relay.
//
// Queries pm_outbox for EMAIL transport messages and sends them through
// a configured SMTP smart relay using nodemailer.
//
// Success → markSent()
// Permanent failure (5xx) → markOutboxUndeliverable() (bounce to sender)
// Transient failure → markSendError() (retried next cycle)

import * as nodemailer from 'nodemailer';
import * as privateMessages from '../../models/privateMessages.js';
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

	var fromAddress = appConfig.get('email_from_address', '');
	if (!fromAddress) {
		alogger.writeAlog(2, '[EmailTosser] email_from_address not configured — cannot send', 'redbright');
		return { sent: 0, errors: 0 };
	}
	var fromName = appConfig.get('email_from_name', '') || appConfig.get('boardname', 'BBS');

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

		var mailOptions = {
			from: '"' + fromName.replace(/"/g, '\\"') + '" <' + fromAddress + '>',
			to: emailAddress,
			subject: pm.subject || '(no subject)',
			text: pm.utf8 || pm.body_text || '',
		};

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

export { tossOutbound, resetTransporter, _reconcileSecure, _isTlsMismatchError };
