//imports
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

//internal modules
import * as alogger from "../utils/alogger.js";
import * as postgres from '../middleware/db/postgres.js';

//setup
dotenv.config();
const defaultsecurity = process.env.defaultsecurity || 50;
const saltRounds = 10;
const storeplain = process.env.storeplainindev_yesimsure;

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
	var recsec = newrecord.security || defaultsecurity;

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
	await addUserPermissions(username, ["Sysop", "Admin"]);

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

	var existing = userobj[column] || [];
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
	return true;
}

async function _removeFlags(username, column, flagsToRemove) {
	if (!flagsToRemove || flagsToRemove.length === 0) return true;

	var userobj = await getUserRecord(username);
	if (!userobj) return false;

	var existing = userobj[column] || [];
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
		console.log("Error saving user:", err.message);
	}
}

export {
	checkUserPass,
	getUserRecord,
	createNewUser,
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
	saveUser
};