#!/usr/bin/env node
// bootUnit.js -- set up, or check, the systemd unit that starts PM2 at boot so
// that it survives nvm moving to a new Node (#21).
//
//   node src/tools/bootUnit.js              check, and say what is wrong (exit 1 if anything)
//   node src/tools/bootUnit.js --print      print the unit this would install
//   node src/tools/bootUnit.js --install    install the wrapper, write the unit (sudo), enable it
//
// Run it as the user the BBS runs as, from the install directory (or pass
// --target). --install asks sudo for the two steps that need root, writing the
// unit and reloading systemd, and never restarts anything: restarting the unit
// restarts the BBS, which is for the sysop to choose the moment of.
//
// Replaces running `pm2 startup` and hand-editing what it writes, which is what
// INSTALL.md used to describe and what the hub never got.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { locations, renderUnit, assessBoot, keepPath, WRAPPER_NAME } from '../maintenance/bootUnit.js';

var RED = '\x1b[0;31m', GREEN = '\x1b[0;32m', YELLOW = '\x1b[1;33m', CYAN = '\x1b[0;36m', NC = '\x1b[0m';
function info(m) { console.log(CYAN + '->' + NC + ' ' + m); }
function ok(m) { console.log(GREEN + '+' + NC + ' ' + m); }
function warn(m) { console.log(YELLOW + '!' + NC + ' ' + m); }
function die(m) { console.error(RED + 'x' + NC + ' ' + m); process.exit(1); }

function parseArgs(argv) {
	var o = { mode: 'check', target: process.cwd(), unitPath: null };
	for (var i = 0; i < argv.length; i++) {
		var a = argv[i];
		if (a === '--check') o.mode = 'check';
		else if (a === '--print') o.mode = 'print';
		else if (a === '--install') o.mode = 'install';
		else if (a === '--target') o.target = path.resolve(argv[++i]);
		else if (a === '--unit') o.unitPath = argv[++i];
		else if (a === '--help' || a === '-h') {
			console.log('node src/tools/bootUnit.js [--check | --print | --install] [--target DIR] [--unit PATH]');
			process.exit(0);
		} else die('unknown argument: ' + a);
	}
	return o;
}

function unitFor(o, loc) {
	var existing = null;
	try { existing = fs.readFileSync(loc.unitPath, 'utf8'); } catch (_) {}
	return renderUnit({
		user: loc.user, pm2Home: loc.pm2Home, wrapper: loc.wrapper, unitPath: loc.unitPath,
		nvmDir: loc.nvmDir && fs.existsSync(path.join(loc.nvmDir, 'nvm.sh')) ? loc.nvmDir : null,
		path: keepPath(existing, path.dirname(loc.wrapper))
	});
}

function check(o) {
	var r = assessBoot({ installRoot: o.target, unitPath: o.unitPath });
	info('unit     ' + r.locations.unitPath);
	info('wrapper  ' + r.locations.wrapper);
	info('dump     ' + r.locations.dump);
	console.log('');
	if (!r.problems.length) {
		ok('the pm2 boot unit goes through ' + WRAPPER_NAME + ', which is current, and dump.pm2 is on the current Node');
		return 0;
	}
	for (var p of r.problems) warn(p);
	console.log('');
	info('fix it with:  node src/tools/bootUnit.js --install');
	return 1;
}

/** Whether systemd is running the unit now, as against pm2 started by hand. */
function unitActive(name) {
	var r = spawnSync('systemctl', ['is-active', '--quiet', name], { stdio: 'ignore' });
	return r.status === 0;
}

// With SUDO_ASKPASS set, -A so sudo asks the helper rather than a terminal:
// how this is run where there is no terminal, such as over a script or ssh.
function sudo(args) {
	var r = spawnSync('sudo', (process.env.SUDO_ASKPASS ? ['-A'] : []).concat(args), { stdio: 'inherit' });
	if (r.status !== 0) die('sudo ' + args.join(' ') + ' failed');
}

function install(o) {
	if (process.getuid && process.getuid() === 0) {
		die('run this as the user the BBS runs as, not root: the unit is written for whoever runs it');
	}
	var loc = locations({ unitPath: o.unitPath });
	var shipped = path.join(o.target, 'setup', 'canectic-pm2.sh');
	if (!fs.existsSync(shipped)) die('no ' + shipped + ': run this from the install directory, or pass --target');

	// The wrapper lives outside the install on purpose: an update replaces
	// setup/, and a boot in the middle of one would find no wrapper.
	fs.mkdirSync(path.dirname(loc.wrapper), { recursive: true });
	fs.copyFileSync(shipped, loc.wrapper);
	fs.chmodSync(loc.wrapper, 0o755);
	ok('installed ' + loc.wrapper);

	var unit = unitFor(o, loc);
	var before = null;
	try { before = fs.readFileSync(loc.unitPath, 'utf8'); } catch (_) {}
	if (before === unit) {
		ok(loc.unitPath + ' is already this unit');
	} else {
		var tmp = path.join(os.tmpdir(), 'canectic-' + loc.unitName + '-' + process.pid);
		fs.writeFileSync(tmp, unit, { mode: 0o644 });
		if (before !== null) {
			var keep = loc.unitPath + '.before-canectic';
			info('keeping the existing unit as ' + keep);
			sudo(['cp', '-p', loc.unitPath, keep]);
		}
		info('writing ' + loc.unitPath + ' (sudo)');
		sudo(['install', '-m', '644', tmp, loc.unitPath]);
		fs.unlinkSync(tmp);
		sudo(['systemctl', 'daemon-reload']);
		sudo(['systemctl', 'enable', loc.unitName]);
		ok('wrote and enabled ' + loc.unitName);
	}

	console.log('');
	var r = assessBoot({ installRoot: o.target, unitPath: o.unitPath });
	for (var p of r.problems) warn(p);
	console.log('');
	console.log('  Nothing was restarted. The new unit takes effect the next time it starts: at');
	console.log('  the next boot, or now, at a quiet moment, since it restarts the BBS:');
	console.log('');
	// A pm2 daemon started by hand rather than by the unit has to be stopped
	// first: the unit's resurrect would only talk to it, and systemd refuses a
	// PID file naming a process outside the service. Found rehearsing this.
	if (unitActive(loc.unitName)) {
		console.log('    pm2 save && sudo systemctl restart ' + loc.unitName);
	} else {
		console.log('    pm2 save && pm2 kill && sudo systemctl start ' + loc.unitName);
	}
	console.log('');
	return r.problems.length ? 1 : 0;
}

var o = parseArgs(process.argv.slice(2));
if (o.mode === 'print') {
	process.stdout.write(unitFor(o, locations({ unitPath: o.unitPath })));
	process.exit(0);
}
process.exit(o.mode === 'install' ? install(o) : check(o));
