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

function getTransporter() {
	var host = appConfig.get('email_relay_host', '');
	if (!host) return null;

	if (!_transporter) {
		_transporter = nodemailer.createTransport({
			host: host,
			port: appConfig.getNumber('email_relay_port', 587),
			secure: appConfig.getBoolean('email_relay_secure', false),
			auth: {
				user: appConfig.get('email_relay_user', ''),
				pass: appConfig.get('email_relay_password', ''),
			},
		});
	}
	return _transporter;
}

function resetTransporter() {
	if (_transporter) {
		_transporter.close();
		_transporter = null;
	}
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
			errorCount++;
		}
	}

	if (sentCount > 0 || errorCount > 0) {
		alogger.writeAlog(2, '[EmailTosser] Cycle complete: ' + sentCount + ' sent, ' +
			errorCount + ' errors (of ' + batch.length + ')', 'cyan');
	}

	return { sent: sentCount, errors: errorCount };
}

export { tossOutbound, resetTransporter };
