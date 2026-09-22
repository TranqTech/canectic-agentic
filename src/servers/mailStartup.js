// mailStartup.js -- whether the mail process has anything to serve.
//
// The mail process used to exit when mail was not configured. pm2 restarts
// anything that exits, so a board with no mail_domain (every fresh install)
// had a mail process restarting every few seconds until pm2 gave up on it,
// which reads as a fault on the pm2 status screen and in the logs. It now
// waits instead, and starts its servers when the configuration changes to
// allow it. This is the rule for "allow it", kept pure so it can be tested.

/**
 * Why mail cannot start, or null when it can.
 *
 * @param {object} cfg  appConfig-shaped: get(key, def), getNumber(key, def)
 * @returns {string|null}
 */
function mailDisabledReason(cfg) {
	var domain = String(cfg.get('mail_domain', '') || '').trim();
	if (!domain) return 'mail_domain is not configured';
	var imap = cfg.getNumber('imapport', 10143);
	var smtp = cfg.getNumber('smtpport', 10587);
	var inbound = cfg.getNumber('email_inbound_port', 0);
	if (!(imap > 0) && !(smtp > 0) && !(inbound > 0)) {
		return 'no mail server is enabled (imapport, smtpport and email_inbound_port are all 0)';
	}
	return null;
}

export { mailDisabledReason };
