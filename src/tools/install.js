#!/usr/bin/env node
// install.js -- the release's own installer.
//
// Run by setup/bootstrap.sh out of a verified, extracted release, which is the
// same handoff shape the updater uses and for the same reason: installing is
// version specific, so a release should install itself rather than be installed
// by whatever happened to fetch it.
//
//   node src/tools/install.js --target /opt/canectic
//
// It can also be run by hand from an extracted artifact, which is what a sysop
// who verified the checksum themselves and would rather not pipe a script into
// a shell will do.
//
// The file placement is the updater's, against an empty directory. Install is
// update from nothing; there is no second copier here.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';
import { fileURLToPath } from 'url';

import { makeRunId, newRun, summarise } from '../release/updatePhases.js';
import * as runStore from '../maintenance/updateRunStore.js';
import { runInstall } from '../maintenance/installer.js';
import { installedVersion } from '../maintenance/installTarget.js';

var STAGED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

var RED = '\x1b[0;31m', GREEN = '\x1b[0;32m', YELLOW = '\x1b[1;33m', CYAN = '\x1b[0;36m', BOLD = '\x1b[1m', NC = '\x1b[0m';
function info(m) { console.log(CYAN + '->' + NC + ' ' + m); }
function ok(m)   { console.log(GREEN + '+' + NC + ' ' + m); }
function warn(m) { console.log(YELLOW + '!' + NC + ' ' + m); }
function die(m)  { console.error(RED + 'x' + NC + ' ' + m); process.exit(1); }

function usage() {
	console.log([
		'',
		BOLD + 'Canectic install' + NC,
		'',
		'  node src/tools/install.js --target /opt/canectic',
		'',
		'  --target DIR       where to install. Asked for if not given',
		'  --db-name NAME     database name (default canectic_bbs)',
		'  --db-user NAME     database user (default canectic)',
		'  --db-pass PASS     database password',
		'  --db-host HOST     database host (default localhost)',
		'  --create-database  also create the role and database (needs sudo to postgres)',
		'  --no-deps          do not run npm install',
		'  --no-database      do not create the schema either',
		'  --no-start         do not start the BBS when it is done',
		'  --yes              take the defaults and ask nothing',
		'  --force            install over a directory that already holds Canectic',
		''
	].join('\n'));
}

function parseArgs(argv) {
	var o = {
		target: null, dbName: null, dbUser: null, dbPass: null, dbHost: null,
		createDatabase: false, dependencies: true, database: true, start: true,
		yes: false, force: false
	};
	for (var i = 0; i < argv.length; i++) {
		var a = argv[i];
		if (a === '--target')                 o.target = path.resolve(argv[++i]);
		else if (a === '--db-name')           o.dbName = argv[++i];
		else if (a === '--db-user')           o.dbUser = argv[++i];
		else if (a === '--db-pass')           o.dbPass = argv[++i];
		else if (a === '--db-host')           o.dbHost = argv[++i];
		else if (a === '--create-database')   o.createDatabase = true;
		else if (a === '--no-deps')           o.dependencies = false;
		else if (a === '--no-database')       o.database = false;
		else if (a === '--no-start')          o.start = false;
		else if (a === '--yes' || a === '-y') o.yes = true;
		else if (a === '--force')             o.force = true;
		else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
		else die('unknown argument: ' + a);
	}
	return o;
}

/**
 * Fill in what was not passed.
 *
 * A password is never defaulted. Generating one silently would leave a
 * credential nobody was told about in a file nobody looked at, and defaulting
 * it to something guessable is worse.
 */
async function ask(o) {
	if (o.yes && !o.target) die('--yes needs --target');
	if (o.target && o.dbPass !== null) return o;
	if (o.yes) return o;
	if (!process.stdin.isTTY) {
		if (!o.target) die('no --target, and nothing to ask on');
		return o;
	}

	var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		if (!o.target) {
			var t = (await rl.question('Install where? [/opt/canectic] ')).trim();
			o.target = path.resolve(t || '/opt/canectic');
		}
		if (o.database !== false && o.dbPass === null) {
			console.log('');
			console.log('  Database credentials. These go in .env, which is written with mode 600.');
			o.dbName = o.dbName || (await rl.question('  Database name [canectic_bbs]: ')).trim() || 'canectic_bbs';
			o.dbUser = o.dbUser || (await rl.question('  Database user [canectic]: ')).trim() || 'canectic';
			o.dbPass = (await rl.question('  Database password: ')).trim();
			if (!o.dbPass) warn('no password given; .env keeps the template value and you will have to edit it');
		}
	} finally {
		rl.close();
	}
	return o;
}

async function main() {
	var o = await ask(parseArgs(process.argv.slice(2)));
	if (!o.target) { usage(); die('nowhere to install to'); }

	if (!fs.existsSync(path.join(STAGED_ROOT, 'MANIFEST'))) {
		die('this does not look like an extracted release: no MANIFEST beside ' + STAGED_ROOT);
	}

	var already = installedVersion(o.target);
	if (already && !o.force) {
		die(o.target + ' already holds Canectic ' + already + '.\n' +
			'  Use the updater instead: node src/tools/update.js --target ' + o.target + ' --handoff\n' +
			'  It knows which of your files to leave alone. --force installs anyway.');
	}

	fs.mkdirSync(o.target, { recursive: true });
	info('installing into ' + o.target);

	var runId = makeRunId();
	runStore.save(o.target, newRun({
		runId: runId, from: null, to: installedVersion(STAGED_ROOT), target: o.target,
		stagedRoot: STAGED_ROOT
	}));

	var runFile = runStore.writeRunFile(o.target, runId, {
		handoff_version: 1, runId: runId, target: o.target, stagedRoot: STAGED_ROOT,
		from: null, to: installedVersion(STAGED_ROOT),
		launchedBy: 'src/tools/install.js', launchedAt: new Date().toISOString(),
		env: {
			dbname: o.dbName, dbuser: o.dbUser, dbpass: o.dbPass, dbhost: o.dbHost
		},
		options: {
			dependencies: o.dependencies, database: o.database, start: o.start,
			createDatabase: o.createDatabase, force: o.force
		}
	});

	var state = await runInstall({
		instructions: runStore.readRunFile(runFile),
		log: function (m) { console.log('   ' + m); }
	});

	var s = summarise(state);
	console.log('');
	for (var p of state.phases) {
		var mark = p.status === 'done' ? GREEN + 'done ' + NC
			: p.status === 'failed' ? RED + 'FAIL ' + NC
			: p.status === 'skipped' ? YELLOW + 'skip ' + NC : '     ';
		console.log('    ' + mark + ' ' + p.name.padEnd(13) + (p.detail || p.error || ''));
	}
	console.log('');
	for (var w of (state.warnings || [])) warn(w);

	if (s.status !== 'complete') die('the install did not finish');

	ok('Canectic ' + s.to + ' installed in ' + o.target);
	console.log('');
	console.log('  Next:');
	if (!o.database) console.log('    setup/create_pg_db_user.sh && node src/tools/dbmigrations.js');
	if (!o.start)    console.log('    pm2 start ecosystem.config.cjs && pm2 save');
	if (o.start)     console.log('    pm2 save');
	// Starting at boot, in a way that survives Node upgrades (#21), instead of
	// `pm2 startup` and a hand edit.
	console.log('    node src/tools/bootUnit.js --install    (start the BBS at boot, and keep it starting after a Node upgrade)');
	console.log('    Open the web interface and register; the first account is the sysop.');
	console.log('    docs/sysop/INSTALL.md covers the rest.');
	console.log('');
}

main().then(function () { process.exit(0); }, function (e) { die(e.message); });
