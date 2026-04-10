// src/tools/fireEvent.js — CLI tool for firing template events.
//
// Usage:
//   node src/tools/fireEvent.js --event <code> --user <username|id>
//   node src/tools/fireEvent.js --event <code> --all
//   node src/tools/fireEvent.js --event <code> --verified
//   node src/tools/fireEvent.js --event <code> --user bob --extra '{"event":{"note":"hi"}}'
//   node src/tools/fireEvent.js --list                         (list known events)
//
// Runs directly against the DB. Useful for cron-driven templates,
// external integrations, and sysop scripting.

import * as dotenv from 'dotenv';
import * as pgdb from '../middleware/db/postgres.js';
import * as messageTemplates from '../models/messageTemplates.js';

dotenv.config();

function parseArgs(argv) {
	var out = { event: null, user: null, all: false, verified: false, list: false, extra: null };
	for (var i = 0; i < argv.length; i++) {
		var a = argv[i];
		if (a === '--event' && argv[i + 1]) { out.event = argv[++i]; }
		else if (a === '--user' && argv[i + 1]) { out.user = argv[++i]; }
		else if (a === '--all') { out.all = true; }
		else if (a === '--verified') { out.verified = true; }
		else if (a === '--list') { out.list = true; }
		else if (a === '--extra' && argv[i + 1]) { out.extra = argv[++i]; }
		else if (a === '--help' || a === '-h') { out.help = true; }
	}
	return out;
}

function printUsage() {
	console.log('Usage:');
	console.log('  node src/tools/fireEvent.js --event <code> --user <username|id>');
	console.log('  node src/tools/fireEvent.js --event <code> --all         (all active users)');
	console.log('  node src/tools/fireEvent.js --event <code> --verified    (all verified users)');
	console.log('  node src/tools/fireEvent.js --event <code> --user bob --extra \'{"event":{"note":"hi"}}\'');
	console.log('  node src/tools/fireEvent.js --list');
	console.log('');
	console.log('Fires a template event to the target(s). All active templates attached');
	console.log('to the event will fire for each user (subject to their conditions).');
}

async function resolveUser(userArg) {
	// If numeric, treat as ID. Otherwise username.
	if (/^\d+$/.test(userArg)) {
		return await pgdb.queryOne('SELECT id, username FROM users WHERE id = $1', [parseInt(userArg)]);
	}
	return await pgdb.queryOne('SELECT id, username FROM users WHERE UPPER(username) = UPPER($1)', [userArg]);
}

async function main() {
	var args = parseArgs(process.argv.slice(2));

	if (args.help || (!args.event && !args.list)) {
		printUsage();
		process.exit(args.help ? 0 : 1);
	}

	if (args.list) {
		var events = await messageTemplates.getAllEvents();
		console.log('Registered template events:');
		for (var evt of events) {
			var type = evt.is_builtin ? '[builtin]' : '[custom] ';
			console.log('  ' + type + ' ' + evt.code.padEnd(30) + ' ' + evt.label);
		}
		console.log('');
		console.log('Total: ' + events.length);
		process.exit(0);
	}

	var extraVars = {};
	if (args.extra) {
		try {
			extraVars = JSON.parse(args.extra);
		} catch (e) {
			console.error('Invalid JSON in --extra: ' + e.message);
			process.exit(1);
		}
	}

	var userIds = [];

	if (args.user) {
		var user = await resolveUser(args.user);
		if (!user) {
			console.error('User not found: ' + args.user);
			process.exit(1);
		}
		console.log('Resolved user: ' + user.username + ' (id ' + user.id + ')');
		userIds = [user.id];
	} else if (args.all) {
		var rows = await pgdb.query('SELECT id FROM users WHERE active = true');
		userIds = (rows || []).map(function(r) { return r.id; });
		console.log('Target: ' + userIds.length + ' active users');
	} else if (args.verified) {
		var rows2 = await pgdb.query('SELECT id FROM users WHERE active = true AND mailverified = true');
		userIds = (rows2 || []).map(function(r) { return r.id; });
		console.log('Target: ' + userIds.length + ' verified users');
	} else {
		console.error('Must specify --user <name>, --all, or --verified');
		printUsage();
		process.exit(1);
	}

	if (userIds.length === 0) {
		console.log('No users matched. Nothing to do.');
		process.exit(0);
	}

	console.log('Firing event "' + args.event + '" to ' + userIds.length + ' user(s)...');

	var result = await messageTemplates.fireEventForMany(args.event, userIds, extraVars);
	console.log('');
	console.log('Result:');
	console.log('  Users processed: ' + result.usersProcessed);
	console.log('  Messages fired:  ' + result.fired);
	console.log('  Templates skipped: ' + result.skipped);
	if (result.errors.length > 0) {
		console.log('  Errors (' + result.errors.length + '):');
		for (var err of result.errors.slice(0, 10)) {
			console.log('    - ' + err);
		}
		if (result.errors.length > 10) {
			console.log('    ... and ' + (result.errors.length - 10) + ' more');
		}
	}

	process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch(function(err) {
	console.error('Fatal: ' + err.message);
	console.error(err.stack);
	process.exit(1);
});
