//imports
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as alogger from "../utils/alogger.js";
import * as postgres from '../middleware/db/postgres.js';
import appConfig from "../config/appConfig.js";
import { sessionUpdateUser } from '../middleware/db/sessionstore.js';

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

	// Mail address (email or netmail)
	var recmail = newrecord.mailaddress ? newrecord.mailaddress.trim().toLowerCase() : null;
	var recmailtype = newrecord.mailtype || "email";

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
			updated_at: null
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
		} else {
			resultobj.errormessages = resultobj.errormessages.concat(dbres.errormessages);
		}
	} catch (e) {
		resultobj.errormessages.push("Error creating user record: " + (e.message || e));
	}

	return resultobj;
}

// --- Authentication ---

async function checkUserPass(username, password) {
	var resultobj = {
		status: false,
		resultmsg: "",
		errormessages: [],
		isvalid: false,
		useraccount: null
	};

	if (!username || !password) {
		resultobj.errormessages.push("Invalid Request");
		resultobj.resultmsg = "Invalid request";
		alogger.writeAlog(5, "Invalid password check request!", "redbright");
		return resultobj;
	}

	var userobj = await getUserRecord(username);
	if (!userobj) {
		resultobj.errormessages.push("No User");
		resultobj.resultmsg = "No User";
		alogger.writeAlog(5, "No User Found", "redbright");
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
		alogger.writeAlog(3, "makeSysop failed — no user found: " + username, "redbright");
		return false;
	}

	await updateUserSecurity(username, 255);
	await addUserPermissions(username, ["Sysop"]);

	// Clear all existing restriction flags
	var existing = userobj.restrictionflags || [];
	if (existing.length > 0) {
		await removeUserRestrictions(username, existing);
	}

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
	// FidoNet netmail format: zone:net/node or zone:net/node.point
	var fidoRegex = /^\d+:\d+\/\d+(\.\d+)?(@\S+)?$/;
	return fidoRegex.test(mailaddress.trim()) ? "netmail" : "email";
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
	getUsersByPermissionFlag
};