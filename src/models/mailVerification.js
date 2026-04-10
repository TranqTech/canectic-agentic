// src/models/mailVerification.js
// Email/netmail address verification system.
//
// Generates a 6-digit verification code, stores it on the user record,
// and sends it via the appropriate transport (EMAIL PM for internet email,
// LOCAL PM for netmail/other). Provides verification callback to mark
// the address as verified.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

// --- FTN address parser ---

function parseFtnAddress(addr) {
	if (!addr) return null;
	try {
		var raw = addr.trim();
		// Strip username@ prefix if present (e.g. "kostie@1:134/101" or "User Name"@1:134/101)
		var ftnMatch = raw.match(/(?:^"[^"]*"|^[^@\s]+)?@?(\d+:\d+\/\d+(?:\.\d+)?(?:@\S+)?)$/);
		var addrPart = ftnMatch ? ftnMatch[1] : raw;
		// Strip 5D domain suffix (e.g. 1:134/101@fidonet -> 1:134/101)
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

// --- Token generation ---

function generateToken() {
	// 6-digit numeric code, zero-padded
	return String(Math.floor(100000 + Math.random() * 900000));
}

// --- Send verification message ---
// Creates a token, stores it on the user record, and queues an outbound
// message containing the code. Returns { status, token, error }.

async function sendVerificationCode(userId) {
	var result = { status: false, token: null, error: null };

	// Fetch user record
	var user = await postgres.queryOne('SELECT * FROM users WHERE id = $1', [userId]);
	if (!user) {
		result.error = 'User not found';
		return result;
	}

	if (!user.mailaddress) {
		result.error = 'No email/netmail address on file';
		return result;
	}

	if (user.mailverified) {
		result.error = 'Address is already verified';
		return result;
	}

	// Rate limit: don't send if a token was created in the last 60 seconds
	if (user.mailtoken_created) {
		var elapsed = Date.now() - new Date(user.mailtoken_created).getTime();
		if (elapsed < 60000) {
			result.error = 'Please wait before requesting a new code';
			return result;
		}
	}

	// Generate and store token
	var token = generateToken();
	await postgres.write(
		'UPDATE users SET mailtoken = $1, mailtoken_created = NOW(), updated_at = NOW() WHERE id = $2',
		[token, userId]
	);

	// Build verification message body
	var boardname = appConfig.get('boardname', 'BBS');
	var bodyText = 'Your ' + boardname + ' verification code is:\r\n\r\n' +
		'    ' + token + '\r\n\r\n' +
		'Enter this code when prompted to verify your address.\r\n' +
		'This code expires in 24 hours.\r\n\r\n' +
		'If you did not request this, you can safely ignore this message.';

	// Determine transport and send - must go via external transport, never local
	var mailtype = (user.mailtype || 'email').toLowerCase();
	var subject = boardname + ' - Verification Code';

	try {
		var pm = await import('./privateMessages.js');

		if (mailtype === 'email') {
			// Verify relay is configured before wasting a token
			var relayHost = appConfig.get('email_relay_host', '');
			var fromAddr = appConfig.get('email_from_address', '');
			if (!relayHost || !fromAddr) {
				// Clear the token we just stored - can't send it
				await postgres.write(
					'UPDATE users SET mailtoken = NULL, mailtoken_created = NULL WHERE id = $1',
					[userId]
				);
				result.error = 'Email relay is not configured. Contact the sysop.';
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
				await postgres.write(
					'UPDATE users SET mailtoken = NULL, mailtoken_created = NULL WHERE id = $1',
					[userId]
				);
				result.error = 'Could not parse FTN address: ' + user.mailaddress;
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
			result.error = 'Unknown mail type "' + mailtype + '". Cannot send verification.';
			return result;
		}

		alogger.writeAlog(4, 'Verification code sent via ' + mailtype + ' to ' + user.mailaddress + ' for user ' + user.username, 'cyan');
		result.status = true;
		result.token = token;
	} catch (err) {
		alogger.writeAlog(3, 'Failed to send verification code to ' + user.mailaddress + ': ' + err.message, 'yellow');
		result.error = 'Failed to send verification message';
	}

	return result;
}

// --- Verify a submitted code ---
// Returns { status, error }.

async function verifyCode(userId, submittedCode) {
	var result = { status: false, error: null };

	if (!submittedCode || typeof submittedCode !== 'string') {
		result.error = 'No code provided';
		return result;
	}

	var user = await postgres.queryOne('SELECT * FROM users WHERE id = $1', [userId]);
	if (!user) {
		result.error = 'User not found';
		return result;
	}

	if (user.mailverified) {
		result.error = 'Address is already verified';
		return result;
	}

	if (!user.mailtoken) {
		result.error = 'No verification code has been sent. Request a new one.';
		return result;
	}

	// Check expiry (24 hours)
	if (user.mailtoken_created) {
		var elapsed = Date.now() - new Date(user.mailtoken_created).getTime();
		if (elapsed > 24 * 60 * 60 * 1000) {
			// Clear expired token
			await postgres.write(
				'UPDATE users SET mailtoken = NULL, mailtoken_created = NULL, updated_at = NOW() WHERE id = $1',
				[userId]
			);
			result.error = 'Code has expired. Please request a new one.';
			return result;
		}
	}

	// Compare codes
	if (submittedCode.trim() !== user.mailtoken.trim()) {
		result.error = 'Incorrect code';
		return result;
	}

	// Mark verified, clear token
	await postgres.write(
		'UPDATE users SET mailverified = true, mailverified_at = NOW(), mailtoken = NULL, mailtoken_created = NULL, updated_at = NOW() WHERE id = $1',
		[userId]
	);

	// Remove Unverified restriction flag
	try {
		var userMod = await import('./useraccounts.js');
		await userMod.removeUserRestrictions(user.username, ['Unverified']);
	} catch (e) {
		alogger.writeAlog(3, 'verifyCode: failed to remove Unverified flag: ' + (e.message || e), 'yellow');
	}

	// Bump security level to verified_security if currently lower
	var verifiedSecurity = appConfig.getNumber('verified_security', 60);
	var currentSecurity = parseInt(user.security) || 0;
	if (currentSecurity < verifiedSecurity) {
		await postgres.write(
			'UPDATE users SET security = $1, updated_at = NOW() WHERE id = $2',
			[verifiedSecurity, userId]
		);
		alogger.writeAlog(4, 'Security level for ' + user.username + ' raised to ' + verifiedSecurity + ' on verification', 'cyan');
	}

	alogger.writeAlog(3, 'Mail address verified for user ' + user.username + ' (' + user.mailaddress + ')', 'greenbright');

	// Fire user_verified template event (non-blocking)
	try {
		var tmplMod = await import('./messageTemplates.js');
		await tmplMod.fireEvent('user_verified', userId, {});
	} catch (e) {
		alogger.writeAlog(3, 'verifyCode: user_verified template fire failed: ' + (e.message || e), 'yellow');
	}

	result.status = true;
	return result;
}

// --- Check verification status ---

async function isVerified(userId) {
	var user = await postgres.queryOne('SELECT mailverified FROM users WHERE id = $1', [userId]);
	return user ? (user.mailverified === true) : false;
}

export {
	sendVerificationCode,
	verifyCode,
	isVerified,
	generateToken
};
