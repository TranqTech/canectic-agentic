// src/models/passwordReset.js
// Password reset token system.
//
// Generates a reset token, sends it via the user's mail transport
// (email or FTN netmail) with a clickable web link, and validates
// tokens for password change. Tokens expire after 4 hours.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';
import { v4 as uuidv4 } from 'uuid';

var RESET_TOKEN_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

// --- FTN address parser (shared with mailVerification) ---

function parseFtnAddress(addr) {
	if (!addr) return null;
	try {
		var raw = addr.trim();
		var ftnMatch = raw.match(/(?:^"[^"]*"|^[^@\s]+)?@?(\d+:\d+\/\d+(?:\.\d+)?(?:@\S+)?)$/);
		var addrPart = ftnMatch ? ftnMatch[1] : raw;
		var domainAt = addrPart.indexOf('@');
		if (domainAt >= 0) addrPart = addrPart.substring(0, domainAt);
		var zsplit = addrPart.split(':');
		var nnsplit = zsplit[1] ? zsplit[1].split('/') : [];
		var zone = parseInt(zsplit[0]);
		var net = parseInt(nnsplit[0]);
		var nodePart = (nnsplit[1] || '').split('.');
		var node = parseInt(nodePart[0]);
		if (isNaN(zone) || isNaN(net) || isNaN(node)) return null;
		return { zone: zone, net: net, node: node };
	} catch (e) {
		return null;
	}
}

// --- Request a password reset ---
// Looks up user by username, generates a token, sends via appropriate transport.
// Always returns the same message regardless of whether the user exists (prevents enumeration).

async function requestReset(username) {
	var result = { status: false, error: null };

	if (!username || !username.trim()) {
		result.error = 'Username is required';
		return result;
	}

	var user = await postgres.queryOne(
		'SELECT * FROM users WHERE UPPER(username) = UPPER($1)',
		[username.trim()]
	);

	if (!user || !user.mailaddress) {
		// Don't reveal whether user exists
		result.status = true;
		return result;
	}

	// Rate limit: don't send if a token was created in the last 2 minutes
	if (user.reset_token_created) {
		var elapsed = Date.now() - new Date(user.reset_token_created).getTime();
		if (elapsed < 120000) {
			result.status = true; // Still return success to prevent enumeration
			return result;
		}
	}

	// Generate token (UUID-based for URL safety)
	var token = uuidv4().replace(/-/g, '');

	await postgres.write(
		'UPDATE users SET reset_token = $1, reset_token_created = NOW(), updated_at = NOW() WHERE id = $2',
		[token, user.id]
	);

	// Build reset message
	var boardname = appConfig.get('boardname', 'BBS');
	var sitedomain = appConfig.get('sitedomain', '');
	var webport = appConfig.get('webport', '8080');

	var resetLink = '';
	if (sitedomain) {
		resetLink = 'https://' + sitedomain + '/users/reset/' + token;
	} else {
		resetLink = 'http://localhost:' + webport + '/users/reset/' + token;
	}

	var bodyText = 'A password reset was requested for your account on ' + boardname + '.\r\n\r\n' +
		'Your reset code is: ' + token.substring(0, 8).toUpperCase() + '\r\n\r\n' +
		'To reset your password via the web, visit:\r\n' +
		resetLink + '\r\n\r\n' +
		'This code expires in 4 hours.\r\n\r\n' +
		'If you did not request this, you can safely ignore this message.\r\n' +
		'Your password will not change unless you complete the reset.';

	// Send via appropriate transport
	var mailtype = (user.mailtype || 'email').toLowerCase();
	var subject = boardname + ' - Password Reset';

	try {
		var pm = await import('./privateMessages.js');

		if (mailtype === 'email') {
			var relayHost = appConfig.get('email_relay_host', '');
			var fromAddr = appConfig.get('email_from_address', '');
			if (!relayHost || !fromAddr) {
				alogger.writeAlog(3, 'Password reset: email relay not configured for ' + user.username, 'yellow');
				result.status = true;
				return result;
			}
			await pm.queueOutbound({
				user_id: 0,
				from_user: boardname,
				to_user: user.username,
				from_address: fromAddr,
				to_address: user.mailaddress,
				subject: subject,
				body_text: bodyText,
				utf8: bodyText,
				transport_type: 'EMAIL',
				transport_data: {
					email_address: user.mailaddress,
					system_notification: true
				},
				system_time: new Date()
			});
		} else if (mailtype === 'netmail') {
			var ftnAddr = parseFtnAddress(user.mailaddress);
			if (!ftnAddr) {
				alogger.writeAlog(3, 'Password reset: cannot parse FTN address for ' + user.username, 'yellow');
				result.status = true;
				return result;
			}
			await pm.queueOutbound({
				user_id: 0,
				from_user: appConfig.get('sysopname', 'Sysop'),
				to_user: user.username,
				from_address: '',
				to_address: user.mailaddress,
				subject: subject,
				body_text: bodyText,
				utf8: bodyText,
				transport_type: 'FTN',
				transport_data: {
					destination: user.mailaddress,
					destination_zone: ftnAddr.zone,
					destination_net: ftnAddr.net,
					destination_node: ftnAddr.node,
					source_zone: 0,
					source_net: 0,
					source_node: 0,
					system_notification: true
				},
				system_time: new Date()
			});
		} else {
			alogger.writeAlog(3, 'Password reset: unknown mail type for ' + user.username + ': ' + mailtype, 'yellow');
		}

		alogger.writeAlog(4, 'Password reset token sent to ' + user.mailaddress + ' for ' + user.username, 'cyan');
	} catch (err) {
		alogger.writeAlog(3, 'Password reset send failed for ' + user.username + ': ' + err.message, 'yellow');
	}

	result.status = true;
	return result;
}

// --- Validate a reset token ---
// Returns { valid, userId, username, error }

async function validateToken(token) {
	var result = { valid: false, userId: null, username: null, error: null };

	if (!token || !token.trim()) {
		result.error = 'No reset token provided';
		return result;
	}

	var user = await postgres.queryOne(
		'SELECT * FROM users WHERE reset_token = $1',
		[token.trim()]
	);

	if (!user) {
		result.error = 'Invalid or expired reset token';
		return result;
	}

	// Check expiry
	if (user.reset_token_created) {
		var elapsed = Date.now() - new Date(user.reset_token_created).getTime();
		if (elapsed > RESET_TOKEN_EXPIRY_MS) {
			await postgres.write(
				'UPDATE users SET reset_token = NULL, reset_token_created = NULL, updated_at = NOW() WHERE id = $1',
				[user.id]
			);
			result.error = 'Reset token has expired. Please request a new one.';
			return result;
		}
	}

	result.valid = true;
	result.userId = user.id;
	result.username = user.username;
	return result;
}

// --- Validate the short code (first 8 chars of token, uppercased) ---
// Used by terminal handler where full token URL isn't practical.

async function validateShortCode(username, shortCode) {
	var result = { valid: false, userId: null, error: null };

	if (!username || !shortCode) {
		result.error = 'Username and code are required';
		return result;
	}

	var user = await postgres.queryOne(
		'SELECT * FROM users WHERE UPPER(username) = UPPER($1)',
		[username.trim()]
	);

	if (!user || !user.reset_token) {
		result.error = 'Invalid code or no reset pending';
		return result;
	}

	// Check expiry
	if (user.reset_token_created) {
		var elapsed = Date.now() - new Date(user.reset_token_created).getTime();
		if (elapsed > RESET_TOKEN_EXPIRY_MS) {
			await postgres.write(
				'UPDATE users SET reset_token = NULL, reset_token_created = NULL, updated_at = NOW() WHERE id = $1',
				[user.id]
			);
			result.error = 'Reset code has expired. Please request a new one.';
			return result;
		}
	}

	// Compare short codes (first 8 chars, case-insensitive)
	var expectedShort = user.reset_token.substring(0, 8).toUpperCase();
	if (shortCode.trim().toUpperCase() !== expectedShort) {
		result.error = 'Incorrect reset code';
		return result;
	}

	result.valid = true;
	result.userId = user.id;
	return result;
}

// --- Complete the reset (change password and clear token) ---

async function completeReset(userId, newPassword) {
	var result = { status: false, error: null };

	if (!newPassword || newPassword.length < appConfig.getNumber('pwmin', 12)) {
		result.error = 'Password must be at least ' + appConfig.getNumber('pwmin', 12) + ' characters';
		return result;
	}

	var user = await postgres.queryOne('SELECT * FROM users WHERE id = $1', [userId]);
	if (!user) {
		result.error = 'User not found';
		return result;
	}

	// Change password
	try {
		var userMod = await import('./useraccounts.js');
		var success = await userMod.updateUserPassword(user.username, newPassword);
		if (!success) {
			result.error = 'Failed to update password';
			return result;
		}
	} catch (err) {
		result.error = 'Password update error: ' + err.message;
		return result;
	}

	// Clear token
	await postgres.write(
		'UPDATE users SET reset_token = NULL, reset_token_created = NULL, updated_at = NOW() WHERE id = $1',
		[userId]
	);

	alogger.writeAlog(3, 'Password reset completed for user ' + user.username, 'greenbright');
	result.status = true;
	return result;
}

export {
	requestReset,
	validateToken,
	validateShortCode,
	completeReset
};
