// bootUnit.js -- the systemd unit that starts PM2 at boot, and whether it will
// survive the next Node upgrade (#21).
//
// Canectic runs under PM2, and PM2 is started at boot by the unit
// `pm2 startup` writes. That unit hardcodes one Node version into PATH and
// every Exec* line (~/.nvm/versions/node/vX.Y.Z/...), so under nvm the BBS
// stops booting once that version is uninstalled. setup/canectic-pm2.sh is a
// wrapper that resolves Node at start time instead; this module writes a unit
// that uses it, and says what is wrong with the one a board has.
//
// On 2026-09-22 the hub was still on the stock pinned unit with no wrapper,
// because the fix was a hand edit described in INSTALL.md and made only where
// it was written. `node src/tools/bootUnit.js --install` replaces the edit.
//
// Three things are checked, all pure given what was read:
//   the unit     pinned to a Node version, or not going through the wrapper
//   the wrapper  missing from ~/.local/bin, or older than the release's copy
//   dump.pm2     children pinned to a Node that is not the current one, which
//                the wrapper now repairs on resurrect but a check still reports
//
// Builtins only.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

var WRAPPER_NAME = 'canectic-pm2';

/** Where things live for a user, all derived from the home directory. */
function locations(opts) {
	var o = opts || {};
	var user = o.user || os.userInfo().username;
	var home = o.home || os.homedir();
	var pm2Home = o.pm2Home || process.env.PM2_HOME || path.join(home, '.pm2');
	return {
		user: user,
		home: home,
		pm2Home: pm2Home,
		nvmDir: o.nvmDir !== undefined ? o.nvmDir : (process.env.NVM_DIR || path.join(home, '.nvm')),
		wrapper: path.join(home, '.local', 'bin', WRAPPER_NAME),
		unitName: 'pm2-' + user + '.service',
		unitPath: o.unitPath || path.join('/etc/systemd/system', 'pm2-' + user + '.service'),
		dump: path.join(pm2Home, 'dump.pm2')
	};
}

/**
 * The unit, in the shape pm2 startup writes, with the Node version kept out of
 * it. Environment carries NVM_DIR only when nvm is installed: without it the
 * wrapper goes straight to the pm2 on PATH, which is the native-Node case.
 *
 * @param {object} o  { user, pm2Home, nvmDir|null, wrapper, unitPath, path }
 *                    `path` is the PATH to keep, from keepPath(); the default
 *                    covers the usual system directories
 */
function renderUnit(o) {
	var lines = [
		'# ' + (o.unitPath || '/etc/systemd/system/pm2-' + o.user + '.service'),
		'# PM2 process manager -- Canectic BBS',
		'#',
		'# Written by `node src/tools/bootUnit.js --install`. The shape is the one',
		'# `pm2 startup` writes, with one difference: the Node version is not frozen',
		'# into it. The Exec* lines call ' + o.wrapper + ', which resolves Node at',
		'# start time (nvm\'s `default` alias when nvm is present, the pm2 on PATH when',
		'# it is not) and, on resurrect, re-pins the BBS processes when dump.pm2 still',
		'# names a Node that has since been replaced.',
		'#',
		'# Upgrading Node therefore needs no edit here. Under nvm:',
		'#     nvm install <new> && nvm alias default <new>',
		'#     npm install -g pm2                  # globals are per-version under nvm',
		'#     sudo systemctl restart ' + 'pm2-' + o.user,
		'# See docs/sysop/INSTALL.md, "Surviving Node Upgrades", and issue #21.',
		'',
		'[Unit]',
		'Description=PM2 process manager',
		'Documentation=https://pm2.keymetrics.io/',
		'After=network.target',
		'',
		'[Service]',
		'Type=forking',
		'User=' + o.user,
		'LimitNOFILE=infinity',
		'LimitNPROC=infinity',
		'LimitCORE=infinity',
		'',
		'# No Node version directory here: the wrapper puts the active Node on PATH',
		'# itself. This only has to cover the system tools doors and helpers use.',
		'Environment=PATH=' + (o.path || (path.dirname(o.wrapper) + ':' + DEFAULT_PATH)),
		'Environment=PM2_HOME=' + o.pm2Home
	];
	if (o.nvmDir) lines.push('# Explicit, so the wrapper does not depend on systemd exporting HOME.', 'Environment=NVM_DIR=' + o.nvmDir);
	lines.push(
		'',
		'PIDFile=' + path.join(o.pm2Home, 'pm2.pid'),
		'Restart=on-failure',
		'',
		'ExecStart=' + o.wrapper + ' resurrect',
		'ExecReload=' + o.wrapper + ' reload all',
		'ExecStop=' + o.wrapper + ' kill',
		'',
		'[Install]',
		'WantedBy=multi-user.target',
		''
	);
	return lines.join('\n');
}

var PINNED = /\/\.nvm\/versions\/node\/(v[0-9][^/\s]*)\//;
var DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The PATH a new unit should carry: the existing unit's, which `pm2 startup`
 * captured from the sysop's shell and which doors and helpers may rely on
 * (/usr/games, snap, linuxbrew), with every nvm version directory taken out,
 * duplicates dropped, and the wrapper's directory first.
 */
function keepPath(unitText, wrapperDir) {
	var m = /^Environment=PATH=(.*)$/m.exec(String(unitText || ''));
	var parts = (m ? m[1] : DEFAULT_PATH).split(':');
	var out = [wrapperDir];
	for (var p of parts) {
		if (!p || PINNED.test(p + '/') || out.indexOf(p) !== -1) continue;
		out.push(p);
	}
	return out.join(':');
}

/**
 * What is wrong with a unit, if anything.
 *
 * @returns {{present, usesWrapper, pinnedTo, problems: string[]}}
 */
function assessUnit(text, wrapperPath) {
	if (text === null || text === undefined) {
		return { present: false, usesWrapper: false, pinnedTo: null,
			problems: ['there is no pm2 boot unit, so the BBS does not start at boot'] };
	}
	var exec = String(text).split('\n').filter(function (l) { return /^Exec(Start|Reload|Stop)=/.test(l.trim()); });
	var usesWrapper = exec.length > 0 && exec.every(function (l) {
		return wrapperPath ? l.indexOf(wrapperPath) !== -1 : l.indexOf('/' + WRAPPER_NAME) !== -1;
	});
	var m = PINNED.exec(String(text));
	var problems = [];
	if (m && !usesWrapper) {
		problems.push('the pm2 boot unit is pinned to Node ' + m[1] + ': once that version is uninstalled the BBS will not start at boot');
	} else if (m) {
		problems.push('the pm2 boot unit still names Node ' + m[1] + ' in its PATH');
	} else if (!usesWrapper) {
		problems.push('the pm2 boot unit does not go through ' + WRAPPER_NAME + ', so a Node upgrade can change what it starts without warning');
	}
	return { present: true, usesWrapper: usesWrapper, pinnedTo: m ? m[1] : null, problems: problems };
}

/** Whether the installed wrapper is there and matches the release's copy. */
function assessWrapper(installedText, shippedText) {
	if (installedText === null || installedText === undefined) {
		return { present: false, current: false, problems: [WRAPPER_NAME + ' is not installed in ~/.local/bin'] };
	}
	var current = shippedText === null || shippedText === undefined || installedText === shippedText;
	return { present: true, current: current,
		problems: current ? [] : ['the installed ' + WRAPPER_NAME + ' is older than the one this release ships'] };
}

/**
 * BBS processes in dump.pm2 whose interpreter is not the current Node. They
 * restart on the old one at boot until re-pinned.
 *
 * @param {string} dumpText    contents of dump.pm2
 * @param {string} currentNode path of the Node that will be current at boot
 * @param {string} [installRoot] only processes started from here count
 */
function assessDump(dumpText, currentNode, installRoot) {
	var apps;
	try { apps = JSON.parse(dumpText); } catch (_) { return { stale: [], problems: [] }; }
	if (!Array.isArray(apps)) return { stale: [], problems: [] };
	var stale = apps.filter(function (a) {
		if (!a || !a.exec_interpreter || a.exec_interpreter === 'none') return false;
		if (installRoot && a.pm_cwd && path.resolve(a.pm_cwd) !== path.resolve(installRoot)) return false;
		return path.resolve(a.exec_interpreter) !== path.resolve(currentNode);
	}).map(function (a) { return { name: a.name, interpreter: a.exec_interpreter }; });
	return { stale: stale, problems: stale.length
		? [stale.length + ' BBS process(es) in dump.pm2 are pinned to ' + stale[0].interpreter +
			', not the current Node (' + currentNode + '); the wrapper re-pins them on the next boot, or run pm2 save now']
		: [] };
}

/**
 * The Node binary nvm's `default` alias names, or null when that cannot be
 * worked out without running nvm: no nvm, no alias, or an alias naming
 * another alias (lts/*, node, stable), which only nvm resolves reliably.
 * A partial version ("26") takes the newest installed match, as nvm does.
 */
function nvmDefaultNode(nvmDir) {
	if (!nvmDir) return null;
	var alias = readOrNull(path.join(nvmDir, 'alias', 'default'));
	if (!alias) return null;
	var want = alias.trim().replace(/^v/, '');
	if (!/^\d+(\.\d+){0,2}$/.test(want)) return null;
	var installed;
	try { installed = fs.readdirSync(path.join(nvmDir, 'versions', 'node')); } catch (_) { return null; }
	var parts = function (v) { return v.replace(/^v/, '').split('.').map(Number); };
	var match = installed.filter(function (v) {
		var p = parts(v), w = want.split('.').map(Number);
		return w.every(function (n, i) { return p[i] === n; });
	}).sort(function (a, b) {
		var x = parts(a), y = parts(b);
		for (var i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
		return 0;
	});
	return match.length ? path.join(nvmDir, 'versions', 'node', match[0], 'bin', 'node') : null;
}

function readOrNull(file) {
	try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

/**
 * Everything, read from disk. `currentNode` is the Node that will be current at
 * boot: nvm's default when nvm is present, otherwise this process's own.
 */
function assessBoot(opts) {
	var o = opts || {};
	var loc = locations(o);
	var installRoot = o.installRoot || process.cwd();
	var unit = assessUnit(readOrNull(loc.unitPath), loc.wrapper);
	var wrapper = assessWrapper(readOrNull(loc.wrapper), readOrNull(path.join(installRoot, 'setup', 'canectic-pm2.sh')));
	var dumpText = readOrNull(loc.dump);
	// The Node current at boot: nvm's default under nvm, which is not
	// necessarily the one this process runs on (in the gateway it is the very
	// Node the dump pins, so comparing against execPath would never find it).
	var bootNode = o.currentNode || (loc.nvmDir && fs.existsSync(loc.nvmDir) ? nvmDefaultNode(loc.nvmDir) : process.execPath);
	var dump = dumpText && bootNode ? assessDump(dumpText, bootNode, installRoot) : { stale: [], problems: [] };
	if (!dumpText && unit.present) {
		// The unit runs `resurrect`, which starts what `pm2 save` recorded. With
		// nothing recorded the unit starts pm2 and nothing else.
		dump.problems = ['pm2 has nothing saved for the boot unit to start: run pm2 save while the BBS is running'];
	}
	return {
		locations: loc, unit: unit, wrapper: wrapper, dump: dump,
		problems: unit.problems.concat(wrapper.problems, dump.problems)
	};
}

export {
	WRAPPER_NAME,
	locations,
	renderUnit,
	assessUnit,
	assessWrapper,
	assessDump,
	assessBoot,
	nvmDefaultNode,
	keepPath
};
