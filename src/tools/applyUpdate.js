#!/usr/bin/env node
// applyUpdate.js -- the updater, as run FROM THE STAGED TREE.
//
// Never invoked by hand. The running Canectic stages a release, verifies it, and
// spawns THIS copy of this file out of the new tree, detached, then stops.
// Everything below therefore runs as the new version, against an installation
// that is still the old one.
//
// That is the point of the split. Applying an upgrade is version specific and is
// where the bugs are, so a release can ship a fixed updater and it takes effect
// for that upgrade rather than the one after.
//
// Its only argument is the path to a run file. The contract between the release
// that launches and the release that applies has to survive both of them
// changing, so it is a JSON document: a newer updater reading an older file
// defaults what is missing, an older one ignores what it does not know, and
// neither is possible with a positional argument list.
//
//   node <staged>/src/tools/applyUpdate.js --run <target>/logs/update/<id>.run.json
//
// Deliberately thin. The phase sequence lives in updateRunner.js, which
// `update.js --apply` also calls, because two programs that both claim to apply
// an update is how install.sh and update.sh drifted until one of them deleted
// every sysop-added asset under public/.

import appConfig from '../config/appConfig.js';
import * as runStore from '../maintenance/updateRunStore.js';
import { runUpdate } from '../maintenance/updateRunner.js';
import { summarise } from '../release/updatePhases.js';

function log(msg) {
	// Goes to the log file the launcher opened, which is the only place anybody
	// can read this from once the gateway has been replaced.
	console.log(new Date().toISOString() + '  ' + msg);
}

async function main() {
	var argv = process.argv.slice(2);
	var runFile = null;
	for (var i = 0; i < argv.length; i++) if (argv[i] === '--run') runFile = argv[++i];

	if (!runFile) {
		console.error('applyUpdate.js is launched by the update handoff, not by hand. It needs --run <file>.');
		process.exit(2);
	}

	var instructions = runStore.readRunFile(runFile);
	log('updater starting from ' + instructions.stagedRoot);
	log('target ' + instructions.target + ', ' +
		(instructions.from || '?') + ' -> ' + (instructions.to || '?'));

	// Config is read from the installation, whose .env is where the launcher
	// pointed our working directory. A failure here is not fatal: every setting
	// this run needs has a default, and refusing to update because the settings
	// table is unreachable would be the wrong way round.
	try {
		await appConfig.load();
	} catch (e) {
		log('could not load configuration, continuing on defaults: ' + e.message);
	}

	var state = await runUpdate({ instructions: instructions, log: log });
	var s = summarise(state);
	log(s.status + ': ' + JSON.stringify(s));
	process.exit(s.status === 'complete' ? 0 : 1);
}

main().catch(function (e) {
	console.error('updater crashed: ' + (e && e.stack ? e.stack : e));
	process.exit(1);
});
