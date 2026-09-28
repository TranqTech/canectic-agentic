//imports
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as alogger from "../utils/alogger.js";
import * as postgres from '../middleware/db/postgres.js';
import appConfig from "../config/appConfig.js";
import { sessionUpdateUser } from '../middleware/db/sessionstore.js';
import { newSinceMs } from '../utils/newSince.js';
import { logAuthFail, normaliseIp } from '../utils/authFailLog.js';

//setup
dotenv.config();
const saltRounds = 10;
const storeplain = process.env.storeplainindev_yesimsure;  // bootstrap — stays in .env

// Reserved usernumbers — these are never assigned to real user accounts
const RESERVED_USERNUMBERS = [512]; // 512 = guest/doorsession placeholder

// --- UUID helpers ---

async function checkUuidUnique(uuid) {
	var isUnique = await postgres.checkValueUnique("uuid", uuid, "users");
	return isUnique;
}

async function genUUID() {
	var uuid = "";
	var isgood = false;
	while (!isgood) {
		uuid = uuidv4();
		isgood = await checkUuidUnique(uuid);
	}
	return uuid;
}

async function getHighestUserNumber() {
	var row = await postgres.queryOne('SELECT COALESCE(MAX(usernumber), 0) AS maxnum FROM users');
	return row ? parseInt(row.maxnum) : 0;
}

// --- User retrieval ---

async function getUserRecord(pusername) {
	var row = await postgres.queryOne(
		'SELECT * FROM users WHERE UPPER(username) = UPPER($1)',
		[pusername.trim()]
	);
	return row;
}

async function getUserByUUID(uuid) {
	var row = await postgres.queryOne(
		'SELECT * FROM users WHERE uuid = $1',
		[uuid.trim()]
	);
	return row;
}

async function getUserList() {
	var rows = await postgres.query(
		'SELECT * FROM users ORDER BY UPPER(username) ASC'
	);
	return rows;
}

async function getCustomUserListByAge(filterObj) {
	// Generic filter — for now returns all sorted by creation date
	// TODO: build WHERE clauses from filterObj if needed
	var rows = await postgres.query(
		'SELECT * FROM users ORDER BY created_at ASC'
	);
	return rows;
}

async function getCustomUserListByNumber(filterObj) {
	var rows = await postgres.query(
		'SELECT * FROM users ORDER BY usernumber ASC'
	);
	return rows;
}

// --- Uniqueness checks ---

async function checkUsernameAvailable(pusername) {
	var name = pusername.trim().toLowerCase();

	// Reject honeypot usernames — prevent registration with names that trigger security logging
	var honeypotList = (appConfig.get('honeypot_usernames', '') || '').toLowerCase().split(',').map(function(s) { return s.trim(); }).filter(Boolean);
	if (honeypotList.includes(name)) return false;

	var isUnique = await postgres.checkValueUnique("username", pusername.trim(), "users");
	return isUnique;
}

async function checkMailUnique(mailaddress) {
	var isUnique = await postgres.checkValueUnique("mailaddress", mailaddress.trim().toLowerCase(), "users");
	return isUnique;
}

// --- User creation ---

async function createNewUser(newrecord) {
	var resultobj = {
		status: false,
		errormessages: [],
		resultmsg: "",
		resultid: null
	};

	if (!newrecord.username) {
		resultobj.errormessages.push("Username required for record creation");
	}
	if (!newrecord.password) {
		resultobj.errormessages.push("Password required for record creation");
	}
	if (resultobj.errormessages.length > 0) {
		return resultobj;
	}

	// Generate salt/pepper and hash password
	var salt = uuidv4().replace(/-/g, '');
	var pepper = uuidv4().replace(/-/g, '');
	var saltedpass = salt + newrecord.password.trim() + pepper;
	var storedpassword = await bcrypt.hash(saltedpass, saltRounds);

	var devpass = storeplain ? newrecord.password : storedpassword;

	// Security level
	var recsec = newrecord.security || appConfig.getNumber('defaultsecurity', 50);

	// Optional fields
	var recfirst = newrecord.firstname ? newrecord.firstname.trim() : null;
	var reclast = newrecord.lastname ? newrecord.lastname.trim() : null;
	var recfull = newrecord.fullname ? newrecord.fullname.trim() : null;
	if (!recfull && (recfirst || reclast)) {
		recfull = ((recfirst || "") + " " + (reclast || "")).trim();
	}
	var recloc = newrecord.location ? newrecord.location.trim() : null;

	// Mail address (email or netmail) - auto-detect type from address format
	var recmail = newrecord.mailaddress ? newrecord.mailaddress.trim().toLowerCase() : null;
	var recmailtype = newrecord.mailtype || detectMailType(recmail);

	var timenow = new Date();
	var assignuuid = await genUUID();
	var usernumber = await getHighestUserNumber() + 1;
	while (RESERVED_USERNUMBERS.includes(usernumber)) {
		usernumber++;
	}

	try {
		var rec = {
			uuid: assignuuid,
			usernumber: usernumber,
			username: newrecord.username.trim(),
			firstname: recfirst,
			lastname: reclast,
			fullname: recfull,
			salt: salt,
			pepper: pepper,
			password: storedpassword,
			ptpassword: devpass,
			mailaddress: recmail,
			mailtype: recmailtype,
			mailverified: false,
			mailverified_at: null,
			mailtoken: null,
			mailtoken_created: null,
			location: recloc,
			gender: newrecord.gender || null,
			birthdate: newrecord.birthdate || null,
			security: recsec,
			logoncount: 0,
			firstlogon: timenow,
			lastlogon: timenow,
			msg_group: null,
			msg_area: null,
			file_group: null,
			file_area: null,
			created_at: timenow,
			updated_at: null,
			restrictionflags: JSON.stringify(['Unverified'])
		};

		var dbres = await postgres.insertObject(rec, "users");
		if (dbres.status) {
			resultobj.status = true;
			resultobj.resultmsg = "User created with id: " + dbres.insertId;
			resultobj.resultid = dbres.insertId;
			alogger.writeAlog(5, "User created: " + rec.username + " (id: " + dbres.insertId + ")", "greenbright");

			// Auto-promote first registered user to Sysop
			if (usernumber === 1) {
				try {
					await makeSysop(rec.username);
					alogger.writeAlog(1, "First user " + rec.username + " auto-promoted to Sysop", "greenbright", true);
				} catch (e) {
					alogger.writeAlog(3, "Auto-promote Sysop failed: " + (e.message || e), "yellow");
				}
			}

			// Pre-populate message scan pointers for the new user
			try {
				var pointerMod = await import('./userMsgPointers.js');
				await pointerMod.initPointersForUser(dbres.insertId);
			} catch (e) {
				alogger.writeAlog(3, "createNewUser: pointer init failed for user " + dbres.insertId + ": " + (e.message || e), "yellow");
			}

			// Notify sysop of new registration
			try {
				var notif = await import('./notifications.js');
				await notif.createSysop('user_registered',
					'New user registered: ' + rec.username,
					'Location: ' + (rec.location || 'N/A'),
					{ severity: 'info', icon: 'person-plus', link: '/admin/users' }
				);
			} catch (_) {}

			// Fire user_registered template event (non-blocking)
			try {
				var tmplMod = await import('./messageTemplates.js');
				await tmplMod.fireEvent('user_registered', dbres.insertId, {});
			} catch (e) {
				alogger.writeAlog(3, "createNewUser: user_registered template fire failed: " + (e.message || e), "yellow");
			}

			// Send email/netmail verification code (non-blocking)
			if (recmail) {
				try {
					var verifyMod = await import('./mailVerification.js');
					await verifyMod.sendVerificationCode(dbres.insertId);
				} catch (e) {
					alogger.writeAlog(3, "createNewUser: verification send failed for user " + dbres.insertId + ": " + (e.message || e), "yellow");
				}
			}
		} else {
			resultobj.errormessages = resultobj.errormessages.concat(dbres.errormessages);
		}
	} catch (e) {
		resultobj.errormessages.push("Error creating user record: " + (e.message || e));
	}

	return resultobj;
}

// --- Authentication ---

async function checkUserPass(username, password, options) {
	var opts = options || {};
	// opts.ip: the client address, so a failure is written in a form fail2ban
	// can act on. opts.service: where the login came from ('IMAP', 'SMTP').
	var clientIp = normaliseIp(opts.ip);

	var resultobj = {
		status: false,
		resultmsg: "",
		errormessages: [],
		isvalid: false,
		useraccount: null,
		honeypot: false
	};

	if (!username || !password) {
		resultobj.errormessages.push("Invalid Request");
		resultobj.resultmsg = "Invalid request";
		alogger.writeAlog(5, "Invalid password check request!", "redbright");
		return resultobj;
	}

	// Honeypot check: known-bad usernames trigger immediate security log
	if (appConfig.getBoolean('honeypot_enabled', true)) {
		var honeypotList = (appConfig.get('honeypot_usernames', '') || '').toLowerCase().split(',').map(function(s) { return s.trim(); }).filter(Boolean);
		if (honeypotList.includes(username.toLowerCase().trim())) {
			alogger.writeClog(1,
				'[HONEYPOT] Login attempt with banned username "' + username + '" from ' + clientIp,
				'security', 'redbright'
			);
			resultobj.resultmsg = "No User";
			resultobj.errormessages.push("No User");
			resultobj.honeypot = true;
			return resultobj;
		}
	}

	var userobj = await getUserRecord(username);
	if (!userobj) {
		resultobj.errormessages.push("No User");
		resultobj.resultmsg = "No User";
		alogger.writeAlog(5, "No User Found", "redbright");
		logAuthFail('unknown', username, clientIp, opts.service);
		return resultobj;
	}

	if (!userobj.salt || !userobj.pepper) {
		alogger.writeAlog(5, "No seasoning found on user account for " + userobj.username, "redbright");
		resultobj.errormessages.push("No Seasoning Found!");
		resultobj.resultmsg = "No Seasoning Found";
		resultobj.useraccount = userobj;
		return resultobj;
	}

	var saltedpass = userobj.salt + password.trim() + userobj.pepper;
	var passgood = await bcrypt.compare(saltedpass, userobj.password);

	if (passgood) {
		alogger.writeAlog(5, "Password OK!", "greenbright");
		resultobj.resultmsg = "Password OK";
		resultobj.isvalid = true;
		resultobj.useraccount = userobj;
	} else {
		alogger.writeAlog(5, "User password incorrect", "redbright");
		logAuthFail('failed', username, clientIp, opts.service);
		resultobj.errormessages.push("Password BAD");
		resultobj.resultmsg = "Password BAD";
	}

	return resultobj;
}

// --- Password update ---

async function updateUserPassword(username, newpassword) {
	var userobj = await getUserRecord(username);
	if (!userobj) {
		alogger.writeAlog(4, "Password update failed — no user found: " + username, "redbright");
		return false;
	}

	var salt = uuidv4().replace(/-/g, '');
	var pepper = uuidv4().replace(/-/g, '');
	var saltedpass = salt + newpassword.trim() + pepper;
	var storedpassword = await bcrypt.hash(saltedpass, saltRounds);
	var devpass = storeplain ? newpassword : storedpassword;
	var currtime = new Date();

	var err = await postgres.write(
		'UPDATE users SET salt = $1, pepper = $2, password = $3, ptpassword = $4, updated_at = $5 WHERE UPPER(username) = UPPER($6)',
		[salt, pepper, storedpassword, devpass, currtime, username]
	);

	if (err) {
		alogger.writeAlog(3, "Password update error for " + username + ": " + err.message, "redbright");
		return false;
	}

	alogger.writeAlog(5, "Password updated for " + username, "greenbright");
	return true;
}

// --- Security and permissions ---

async function updateUserSecurity(username, securityLevel) {
	var currtime = new Date();
	var err = await postgres.write(
		'UPDATE users SET security = $1, updated_at = $2 WHERE UPPER(username) = UPPER($3)',
		[securityLevel, currtime, username]
	);
	if (err) {
		alogger.writeAlog(3, "Security update error for " + username + ": " + err.message, "redbright");
		return false;
	}
	await sessionUpdateUser(username, { security: String(securityLevel) });
	return true;
}

async function addUserPermissions(username, flagsToAdd) {
	return await _addFlags(username, "permissionflags", flagsToAdd);
}

async function removeUserPermissions(username, flagsToRemove) {
	return await _removeFlags(username, "permissionflags", flagsToRemove);
}

async function addUserRestrictions(username, flagsToAdd) {
	return await _addFlags(username, "restrictionflags", flagsToAdd);
}

async function removeUserRestrictions(username, flagsToRemove) {
	return await _removeFlags(username, "restrictionflags", flagsToRemove);
}

async function makeSysop(username) {
	var userobj = await getUserRecord(username);
	if (!userobj) {
		alogger.writeAlog(3, "makeSysop failed - no user found: " + username, "redbright");
		return false;
	}

	await updateUserSecurity(username, 255);
	await addUserPermissions(username, ["Sysop"]);

	// Clear all existing restriction flags (including Unverified)
	var existing = userobj.restrictionflags || [];
	if (existing.length > 0) {
		await removeUserRestrictions(username, existing);
	}

	// Mark as verified (sysop doesn't need to verify)
	await postgres.write(
		'UPDATE users SET mailverified = true, mailverified_at = NOW(), mailtoken = NULL, mailtoken_created = NULL, updated_at = NOW() WHERE UPPER(username) = UPPER($1)',
		[username]
	);

	alogger.writeAlog(4, "User " + username + " granted Sysop", "greenbright");
	return true;
}

async function _addFlags(username, column, flagsToAdd) {
	if (!flagsToAdd || flagsToAdd.length === 0) return true;

	var userobj = await getUserRecord(username);
	if (!userobj) return false;

	var existing = Array.isArray(userobj[column]) ? userobj[column] : [];
	var merged = [...existing];
	for (var flag of flagsToAdd) {
		if (!merged.includes(flag)) {
			merged.push(flag);
		}
	}

	var currtime = new Date();
	var err = await postgres.write(
		'UPDATE users SET ' + column + ' = $1, updated_at = $2 WHERE UPPER(username) = UPPER($3)',
		[JSON.stringify(merged), currtime, username]
	);
	if (err) {
		alogger.writeAlog(3, "Error adding " + column + " for " + username + ": " + err.message, "redbright");
		return false;
	}
	var sessionField = {};
	sessionField[column] = JSON.stringify(merged);
	// Keep isSysop in sync when permissionflags change
	if (column === 'permissionflags') {
		sessionField.isSysop = String(merged.includes('Sysop'));
	}
	await sessionUpdateUser(username, sessionField);
	return true;
}

async function _removeFlags(username, column, flagsToRemove) {
	if (!flagsToRemove || flagsToRemove.length === 0) return true;

	var userobj = await getUserRecord(username);
	if (!userobj) return false;

	var existing = Array.isArray(userobj[column]) ? userobj[column] : [];
	var filtered = existing.filter(flag => !flagsToRemove.includes(flag));

	var currtime = new Date();
	var err = await postgres.write(
		'UPDATE users SET ' + column + ' = $1, updated_at = $2 WHERE UPPER(username) = UPPER($3)',
		[JSON.stringify(filtered), currtime, username]
	);
	if (err) {
		alogger.writeAlog(3, "Error removing " + column + " for " + username + ": " + err.message, "redbright");
		return false;
	}
	var sessionField = {};
	sessionField[column] = JSON.stringify(filtered);
	// Keep isSysop in sync when permissionflags change
	if (column === 'permissionflags') {
		sessionField.isSysop = String(filtered.includes('Sysop'));
	}
	await sessionUpdateUser(username, sessionField);
	return true;
}

// --- User updates ---

async function updateUserCalls(userrecord) {
	var newcount = (userrecord.logoncount || 0) + 1;
	var currtime = new Date();
	await postgres.write(
		'UPDATE users SET logoncount = $1, lastlogon = $2, updated_at = $3 WHERE UPPER(username) = UPPER($4)',
		[newcount, currtime, currtime, userrecord.username]
	);

	// Fire login milestone template events (non-blocking)
	if (userrecord.id) {
		try {
			var tmplMod = await import('./messageTemplates.js');
			// First login
			if (newcount === 1) {
				await tmplMod.fireEvent('user_first_login', userrecord.id, {
					event: { login_number: 1 }
				});
			}
			// Nth login milestone (templates define which counts via conditions.nth_count)
			await tmplMod.fireEvent('user_nth_login', userrecord.id, {
				event: { login_number: newcount }
			});
		} catch (e) {
			alogger.writeAlog(3, 'updateUserCalls: login template fire failed: ' + (e.message || e), 'yellow');
		}
	}
}

async function updateUserMsgGroup(username, groupname) {
	var currtime = new Date();
	await postgres.write(
		'UPDATE users SET msg_group = $1, updated_at = $2 WHERE UPPER(username) = UPPER($3)',
		[groupname, currtime, username]
	);
}

async function updateUserMsgArea(username, areaname) {
	var currtime = new Date();
	await postgres.write(
		'UPDATE users SET msg_area = $1, updated_at = $2 WHERE UPPER(username) = UPPER($3)',
		[areaname, currtime, username]
	);
}

async function updateUserFileGroup(username, groupname) {
	var currtime = new Date();
	await postgres.write(
		'UPDATE users SET file_group = $1, updated_at = $2 WHERE UPPER(username) = UPPER($3)',
		[groupname, currtime, username]
	);
}

async function updateUserFileArea(username, areaname) {
	var currtime = new Date();
	await postgres.write(
		'UPDATE users SET file_area = $1, updated_at = $2 WHERE UPPER(username) = UPPER($3)',
		[areaname, currtime, username]
	);
}

async function saveUser(user) {
	var currtime = new Date();
	user.updated_at = currtime;

	// Find user by uuid or username
	var lookupField, lookupValue;
	if (user.uuid) {
		lookupField = "uuid";
		lookupValue = user.uuid;
	} else {
		lookupField = "username";
		lookupValue = user.username;
		user.uuid = await genUUID();
	}

	// Build SET clause from user object, excluding the lookup field and id
	var keys = Object.keys(user).filter(k => k !== "id" && k !== lookupField);
	var setClauses = [];
	var values = [];
	var i = 1;
	for (var key of keys) {
		setClauses.push(key + " = $" + i);
		values.push(user[key]);
		i++;
	}
	values.push(lookupValue);

	var sql = "UPDATE users SET " + setClauses.join(", ") + " WHERE UPPER(" + lookupField + ") = UPPER($" + i + ")";
	var err = await postgres.write(sql, values);
	if (err) {
		alogger.writeAlog(3, "saveUser error for " + (user.username || user.uuid) + ": " + err.message, "redbright");
	}
}

// --- Mail type detection ---

function detectMailType(mailaddress) {
	if (!mailaddress) return "email";
	var addr = mailaddress.trim();
	// Strip any leading username@ or "User Name"@ prefix to get the network address
	// Handles: user@1:134/101, "User Name"@1:134/101@fidonet, sysop@2:280/464
	var ftnPart = addr;
	var ftnMatch = addr.match(/^(?:"[^"]*"|[^@\s]+)?@?(\d+:\d+\/\d+(?:\.\d+)?(?:@\S+)?)$/);
	if (ftnMatch) {
		ftnPart = ftnMatch[1];
	}
	// FidoNet netmail format: zone:net/node[.point][@domain]
	var fidoRegex = /^\d+:\d+\/\d+(\.\d+)?(@\S+)?$/;
	return fidoRegex.test(ftnPart) ? "netmail" : "email";
}

// Re-detect mailtype for all users with a mail address.
// Fixes stale types from before detectMailType was properly wired in.
async function reconcileMailTypes() {
	var users = await postgres.query(
		"SELECT id, mailaddress, mailtype FROM users WHERE mailaddress IS NOT NULL AND mailaddress != ''"
	);
	var fixed = 0;
	for (var user of (users || [])) {
		var correctType = detectMailType(user.mailaddress);
		if (correctType !== user.mailtype) {
			await postgres.write(
				'UPDATE users SET mailtype = $1, updated_at = NOW() WHERE id = $2',
				[correctType, user.id]
			);
			fixed++;
			alogger.writeAlog(3, 'Fixed mailtype for user ' + user.id + ': ' + user.mailtype + ' -> ' + correctType, 'cyan');
		}
	}
	if (fixed > 0) {
		alogger.writeAlog(2, 'reconcileMailTypes: fixed ' + fixed + ' user(s)', 'cyan');
	}
	return { fixed: fixed };
}

// Delete unverified accounts older than the configured retention period.
// Skips sysops (they're auto-verified but guard against edge cases).
async function purgeUnverifiedUsers() {
	var days = appConfig.getNumber('unverified_retention_days', 14);
	if (days <= 0) return { purged: 0 };

	// Before purging, fire user_purge_warning for users in their last 1-3 days
	// so sysops can send a "your account will be deleted in N days" message.
	try {
		var warnRows = await postgres.query(
			"SELECT id, username, EXTRACT(DAY FROM (created_at + ($1 || ' days')::interval - NOW()))::int AS days_until_purge " +
			"FROM users WHERE mailverified = false AND (permissionflags IS NULL OR NOT permissionflags @> '[\"Sysop\"]') " +
			"AND created_at + ($1 || ' days')::interval > NOW() AND created_at + (($1::int - 3) || ' days')::interval <= NOW()",
			[days.toString()]
		);
		if (warnRows && warnRows.length > 0) {
			var tmplMod = await import('./messageTemplates.js');
			for (var wrow of warnRows) {
				try {
					await tmplMod.fireEvent('user_purge_warning', wrow.id, {
						event: { days_until_purge: wrow.days_until_purge }
					});
				} catch (_) {}
			}
		}
	} catch (e) {
		alogger.writeAlog(3, 'purgeUnverifiedUsers: warning fire failed: ' + (e.message || e), 'yellow');
	}

	var rows = await postgres.query(
		"DELETE FROM users WHERE mailverified = false AND created_at < NOW() - ($1 || ' days')::interval AND (permissionflags IS NULL OR NOT permissionflags @> '[\"Sysop\"]') RETURNING id, username",
		[days.toString()]
	);

	var purged = rows ? rows.length : 0;
	if (purged > 0) {
		for (var row of rows) {
			alogger.writeAlog(3, 'Purged unverified user: ' + row.username + ' (id: ' + row.id + ')', 'yellow');
		}
		alogger.writeAlog(2, 'purgeUnverifiedUsers: removed ' + purged + ' account(s) older than ' + days + ' days', 'cyan');
	}
	return { purged: purged };
}

// --- Daily template event checks ---
// Scans users for birthday, dormant, and anniversary events and fires
// matching templates. Called from the user-maintenance-daily job.
async function runDailyTemplateEvents() {
	var results = { birthdays: 0, anniversaries: 0, loginAnniversaries: 0, dormant: 0, errors: 0 };
	var tmplMod;
	try {
		tmplMod = await import('./messageTemplates.js');
	} catch (e) {
		alogger.writeAlog(3, 'runDailyTemplateEvents: could not load messageTemplates: ' + e.message, 'yellow');
		return results;
	}

	// --- Birthdays ---
	try {
		var bdayUsers = await postgres.query(
			"SELECT id, birthdate FROM users WHERE active = true AND birthdate IS NOT NULL " +
			"AND EXTRACT(MONTH FROM birthdate) = EXTRACT(MONTH FROM CURRENT_DATE) " +
			"AND EXTRACT(DAY FROM birthdate) = EXTRACT(DAY FROM CURRENT_DATE)"
		);
		if (bdayUsers && bdayUsers.length > 0) {
			for (var u of bdayUsers) {
				try {
					var age = null;
					if (u.birthdate) {
						var bd = new Date(u.birthdate);
						var today = new Date();
						age = today.getFullYear() - bd.getFullYear();
					}
					var res = await tmplMod.fireEvent('user_birthday', u.id, { event: { age: age } });
					if (res.fired > 0) results.birthdays++;
				} catch (_) { results.errors++; }
			}
		}
	} catch (e) {
		alogger.writeAlog(3, 'runDailyTemplateEvents: birthday scan failed: ' + e.message, 'yellow');
	}

	// --- Account anniversaries ---
	try {
		var annivUsers = await postgres.query(
			"SELECT id, created_at FROM users WHERE active = true AND created_at IS NOT NULL " +
			"AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) " +
			"AND EXTRACT(DAY FROM created_at) = EXTRACT(DAY FROM CURRENT_DATE) " +
			"AND created_at < CURRENT_DATE"
		);
		if (annivUsers && annivUsers.length > 0) {
			for (var au of annivUsers) {
				try {
					var years = new Date().getFullYear() - new Date(au.created_at).getFullYear();
					if (years < 1) continue;
					var res = await tmplMod.fireEvent('user_account_anniversary', au.id, {
						event: { anniversary_years: years }
					});
					if (res.fired > 0) results.anniversaries++;
				} catch (_) { results.errors++; }
			}
		}
	} catch (e) {
		alogger.writeAlog(3, 'runDailyTemplateEvents: anniversary scan failed: ' + e.message, 'yellow');
	}

	// --- Login anniversaries ---
	try {
		var loginAnnivUsers = await postgres.query(
			"SELECT id, firstlogon FROM users WHERE active = true AND firstlogon IS NOT NULL " +
			"AND EXTRACT(MONTH FROM firstlogon) = EXTRACT(MONTH FROM CURRENT_DATE) " +
			"AND EXTRACT(DAY FROM firstlogon) = EXTRACT(DAY FROM CURRENT_DATE) " +
			"AND firstlogon < CURRENT_DATE"
		);
		if (loginAnnivUsers && loginAnnivUsers.length > 0) {
			for (var lu of loginAnnivUsers) {
				try {
					var ly = new Date().getFullYear() - new Date(lu.firstlogon).getFullYear();
					if (ly < 1) continue;
					var res = await tmplMod.fireEvent('user_login_anniversary', lu.id, {
						event: { anniversary_years: ly }
					});
					if (res.fired > 0) results.loginAnniversaries++;
				} catch (_) { results.errors++; }
			}
		}
	} catch (e) {
		alogger.writeAlog(3, 'runDailyTemplateEvents: login anniversary scan failed: ' + e.message, 'yellow');
	}

	// --- Dormant users ---
	// Check against any active user_dormant templates to see what days_inactive
	// thresholds they want, then scan users matching those thresholds.
	try {
		var dormantTemplates = await tmplMod.getTemplatesForEvent('user_dormant');
		if (dormantTemplates && dormantTemplates.length > 0) {
			// Get dormant users once -- we'll filter by each template's conditions
			// inside fireEvent via evaluateConditions. Pick a conservative floor
			// (30 days) as the initial query, then fireEvent handles per-template
			// filtering via days_inactive condition.
			var dormantUsers = await postgres.query(
				"SELECT id FROM users WHERE active = true AND lastlogon IS NOT NULL " +
				"AND lastlogon < NOW() - INTERVAL '30 days'"
			);
			if (dormantUsers && dormantUsers.length > 0) {
				for (var du of dormantUsers) {
					try {
						var res = await tmplMod.fireEvent('user_dormant', du.id, {});
						if (res.fired > 0) results.dormant++;
					} catch (_) { results.errors++; }
				}
			}
		}
	} catch (e) {
		alogger.writeAlog(3, 'runDailyTemplateEvents: dormant scan failed: ' + e.message, 'yellow');
	}

	var totalFired = results.birthdays + results.anniversaries + results.loginAnniversaries + results.dormant;
	if (totalFired > 0 || results.errors > 0) {
		alogger.writeAlog(3, '[Template] Daily events: ' + results.birthdays + ' birthdays, ' +
			results.anniversaries + ' anniversaries, ' + results.loginAnniversaries + ' login anniversaries, ' +
			results.dormant + ' dormant' + (results.errors ? ', ' + results.errors + ' errors' : ''),
			totalFired > 0 ? 'cyan' : 'yellow');
	}
	return results;
}

// --- Admin user update ---

async function updateUser(uuid, formObj) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	var userobj = await postgres.queryOne('SELECT * FROM users WHERE uuid = $1', [uuid]);
	if (!userobj) {
		returnObj.errormessages.push("User not found");
		return returnObj;
	}

	// Build update object from only the fields present in the form
	var updateObj = {};
	if (formObj.firstname    !== undefined) updateObj.firstname    = formObj.firstname.trim()  || null;
	if (formObj.lastname     !== undefined) updateObj.lastname     = formObj.lastname.trim()   || null;
	if (formObj.location     !== undefined) updateObj.location     = formObj.location.trim()   || null;
	if (formObj.mailverified !== undefined) updateObj.mailverified = (formObj.mailverified === "true" || formObj.mailverified === true);
	if (formObj.birthdate    !== undefined) updateObj.birthdate    = formObj.birthdate || null;

	// Derive fullname from first/last if either is being updated
	if (formObj.firstname !== undefined || formObj.lastname !== undefined) {
		var first = (formObj.firstname !== undefined ? formObj.firstname.trim() : userobj.firstname) || "";
		var last  = (formObj.lastname  !== undefined ? formObj.lastname.trim()  : userobj.lastname)  || "";
		updateObj.fullname = (first + " " + last).trim() || null;
	}

	// Username — validate uniqueness if changed
	if (formObj.username !== undefined) {
		var newusername = formObj.username.trim();
		if (newusername && newusername.toUpperCase() !== (userobj.username || "").toUpperCase()) {
			var usernameAvailable = await checkUsernameAvailable(newusername);
			if (!usernameAvailable) {
				returnObj.errormessages.push("Username already in use");
				return returnObj;
			}
		}
		if (newusername) updateObj.username = newusername;
	}

	if (formObj.security !== undefined) {
		var sec = parseInt(formObj.security);
		if (isNaN(sec) || sec < 0 || sec > 255) {
			returnObj.errormessages.push("Security level must be between 0 and 255");
			return returnObj;
		}
		updateObj.security = sec;
	}

	// Mail address — validate uniqueness if changed, auto-detect type
	if (formObj.mailaddress !== undefined) {
		var newmail = formObj.mailaddress.trim().toLowerCase() || null;
		if (newmail && newmail !== (userobj.mailaddress || "").toLowerCase()) {
			var mailunique = await checkMailUnique(newmail);
			if (!mailunique) {
				returnObj.errormessages.push("Mail address already in use");
				return returnObj;
			}
		}
		updateObj.mailaddress = newmail;
		updateObj.mailtype    = detectMailType(newmail);
	}

	// Reconcile permission flags if submitted
	if (formObj.permissionflags !== undefined) {
		var desiredPerms = Array.isArray(formObj.permissionflags)
			? formObj.permissionflags
			: (formObj.permissionflags ? [formObj.permissionflags] : []);
		var currentPerms = Array.isArray(userobj.permissionflags) ? userobj.permissionflags : [];
		var permsToAdd    = desiredPerms.filter(f => !currentPerms.includes(f));
		var permsToRemove = currentPerms.filter(f => !desiredPerms.includes(f));
		if (permsToAdd.length > 0)    await addUserPermissions(userobj.username, permsToAdd);
		if (permsToRemove.length > 0) await removeUserPermissions(userobj.username, permsToRemove);
	}

	// Reconcile restriction flags if submitted
	if (formObj.restrictionflags !== undefined) {
		var desiredRestrictions = Array.isArray(formObj.restrictionflags)
			? formObj.restrictionflags
			: (formObj.restrictionflags ? [formObj.restrictionflags] : []);
		var currentRestrictions = Array.isArray(userobj.restrictionflags) ? userobj.restrictionflags : [];
		var restrictToAdd    = desiredRestrictions.filter(f => !currentRestrictions.includes(f));
		var restrictToRemove = currentRestrictions.filter(f => !desiredRestrictions.includes(f));
		if (restrictToAdd.length > 0)    await addUserRestrictions(userobj.username, restrictToAdd);
		if (restrictToRemove.length > 0) await removeUserRestrictions(userobj.username, restrictToRemove);
	}

	if (Object.keys(updateObj).length > 0) {
		updateObj.updated_at = new Date();
		var count = await postgres.updateById(userobj.id, updateObj, "users");
		if (count > 0) {
			alogger.writeAlog(5, "User updated: " + userobj.username, "greenbright");
		} else {
			returnObj.errormessages.push("No rows updated for user " + userobj.username);
			return returnObj;
		}
	}

	returnObj.status = true;
	return returnObj;
}

// --- Admin password reset ---

async function resetUserPassword(uuid, newpassword) {
	var returnObj = {
		status: false,
		errormessages: []
	};

	if (!newpassword || newpassword.trim().length === 0) {
		returnObj.errormessages.push("Password cannot be empty");
		return returnObj;
	}

	var userobj = await postgres.queryOne('SELECT * FROM users WHERE uuid = $1', [uuid]);
	if (!userobj) {
		returnObj.errormessages.push("User not found");
		return returnObj;
	}

	var success = await updateUserPassword(userobj.username, newpassword.trim());
	if (success) {
		alogger.writeAlog(4, "Password reset by admin for user: " + userobj.username, "yellow");
		returnObj.status = true;
	} else {
		returnObj.errormessages.push("Password reset failed");
	}

	return returnObj;
}

// --- Session data helper ---

// Flatten a user record into Redis-safe strings for session storage.
// sessionGet will parse permissionflags, restrictionflags, isSysop,
// and security back out.
function buildSessionData(userobj) {
	var perms = Array.isArray(userobj.permissionflags) ? userobj.permissionflags : [];
	return {
		id:               userobj.id               || 0,
		uuid:             userobj.uuid             || '',
		username:         userobj.username         || '',
		firstname:        userobj.firstname        || '',
		lastname:         userobj.lastname         || '',
		fullname:         userobj.fullname         || '',
		security:         String(userobj.security  || 0),
		isSysop:          String(perms.includes('Sysop')),
		permissionflags:  JSON.stringify(perms),
		restrictionflags: JSON.stringify(Array.isArray(userobj.restrictionflags) ? userobj.restrictionflags : []),
		mailaddress:      userobj.mailaddress      || '',
		mailtype:         userobj.mailtype         || '',
		// The start of the PREVIOUS visit, for "new since last login"
		// (src/utils/newSince.js). Built from the record as loaded, before
		// updateUserCalls overwrites lastlogon with this visit's start.
		prev_logon:       String(newSinceMs(userobj.lastlogon, userobj.created_at)),
	};
}

// --- Realname lookups (for PM recipient resolution) ---

// Single match by fullname (case-insensitive). Returns first match or null.
async function getUserByRealname(realname) {
	var row = await postgres.queryOne(
		'SELECT * FROM users WHERE UPPER(fullname) = UPPER($1)',
		[realname.trim()]
	);
	return row;
}

// All matches by fullname (case-insensitive). For ambiguity detection.
async function getUsersByRealname(realname) {
	var rows = await postgres.query(
		'SELECT * FROM users WHERE UPPER(fullname) = UPPER($1)',
		[realname.trim()]
	);
	return rows || [];
}

// --- Permission flag lookup (for sysop notifications, etc.) ---

// All users whose permissionflags JSONB array contains the given flag.
async function getUsersByPermissionFlag(flag) {
	var rows = await postgres.query(
		'SELECT * FROM users WHERE permissionflags @> $1',
		[JSON.stringify([flag])]
	);
	return rows || [];
}

export {
	checkUserPass,
	getUserRecord,
	createNewUser,
	buildSessionData,
	checkUsernameAvailable,
	checkMailUnique,
	getUserList,
	updateUserCalls,
	updateUserPassword,
	updateUserSecurity,
	addUserPermissions,
	removeUserPermissions,
	addUserRestrictions,
	removeUserRestrictions,
	makeSysop,
	updateUserMsgGroup,
	updateUserMsgArea,
	updateUserFileGroup,
	updateUserFileArea,
	getHighestUserNumber,
	getCustomUserListByAge,
	getCustomUserListByNumber,
	saveUser,
	updateUser,
	resetUserPassword,
	getUserByUUID,
	getUserByRealname,
	getUsersByRealname,
	getUsersByPermissionFlag,
	detectMailType,
	reconcileMailTypes,
	purgeUnverifiedUsers,
	runDailyTemplateEvents,
	getLastCallflowAt
};

// Get the timestamp of a user's last callflow completion. Returns Date or null.
async function getLastCallflowAt(userId) {
	var row = await postgres.queryOne(
		'SELECT last_callflow_at FROM users WHERE id = $1',
		[userId]
	);
	return row && row.last_callflow_at ? new Date(row.last_callflow_at) : null;
}