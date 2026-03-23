#!/usr/bin/env node

// promoteSysop.js — Promote a user to Sysop from the command line.
//
// Sets security level 255, adds Sysop permission flag, clears all
// restriction flags. Updates active sessions if the user is logged in.
//
// Usage:
//   node src/tools/promoteSysop.js <username>
//   node src/tools/promoteSysop.js --help

import * as dotenv from 'dotenv';
import { pgpool } from '../middleware/db/postgres.js';
import * as redis from '../middleware/db/redis.js';
import { getUserRecord, makeSysop } from '../models/useraccounts.js';

dotenv.config();

var args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
	console.log('Usage: node src/tools/promoteSysop.js <username>');
	console.log('');
	console.log('Promotes a user to Sysop:');
	console.log('  - Security level set to 255');
	console.log('  - Sysop permission flag added');
	console.log('  - All restriction flags cleared');
	console.log('  - Active sessions updated immediately');
	process.exit(0);
}

var username = args[0];

async function main() {
	console.log('Looking up user: ' + username);

	var user = await getUserRecord(username);
	if (!user) {
		console.error('Error: user "' + username + '" not found.');
		process.exit(1);
	}

	console.log('Found: ' + user.username + ' (UUID: ' + user.uuid + ')');
	console.log('Current security: ' + user.security);
	console.log('Current permissions: ' + JSON.stringify(user.permissionflags || []));
	console.log('Current restrictions: ' + JSON.stringify(user.restrictionflags || []));
	console.log('');

	var ok = await makeSysop(user.username);
	if (ok) {
		console.log('✓ ' + user.username + ' promoted to Sysop.');
		console.log('  Security: 255');
		console.log('  Permissions: ["Sysop"]');
		console.log('  Restrictions: []');
	} else {
		console.error('Error: promotion failed.');
		process.exit(1);
	}

	pgpool.end();
	redis.shutdown();
}

await main();
