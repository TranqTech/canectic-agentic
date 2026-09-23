// tests/bootUnit.test.js: the PM2 boot unit survives nvm changing Node (#21).
//
// PM2 stays; what this guards is the systemd unit that starts it. The unit
// `pm2 startup` writes pins one Node version, and on 2026-09-22 the hub was
// still running exactly that. bootUnit.js writes the unit that goes through
// setup/canectic-pm2.sh instead and reports what is wrong with the one a board
// has; the wrapper re-pins dump.pm2 on resurrect after a Node upgrade.
//
// The wrapper tests run the real script against a fake `pm2` that records the
// commands it is given, with the real Node on PATH.
//
// Run: npx mocha --no-config --exit tests/bootUnit.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
	renderUnit, assessUnit, assessWrapper, assessDump, assessBoot, nvmDefaultNode, keepPath
} from '../src/maintenance/bootUnit.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var WRAPPER = path.join(ROOT, 'setup', 'canectic-pm2.sh');

// The hub's unit as found on 2026-09-22, abridged.
var HUB_UNIT = [
	'[Service]', 'User=kostie',
	'Environment=PATH=/home/kostie/.nvm/versions/node/v26.8.1/bin:/usr/local/bin:/usr/bin:/bin:/usr/games:/snap/bin',
	'Environment=PM2_HOME=/home/kostie/.pm2',
	'ExecStart=/home/kostie/.nvm/versions/node/v26.8.1/lib/node_modules/pm2/bin/pm2 resurrect',
	'ExecReload=/home/kostie/.nvm/versions/node/v26.8.1/lib/node_modules/pm2/bin/pm2 reload all',
	'ExecStop=/home/kostie/.nvm/versions/node/v26.8.1/lib/node_modules/pm2/bin/pm2 kill'
].join('\n');

var W = '/home/kostie/.local/bin/canectic-pm2';

function render(extra) {
	return renderUnit(Object.assign({ user: 'kostie', pm2Home: '/home/kostie/.pm2', wrapper: W,
		nvmDir: '/home/kostie/.nvm', path: keepPath(HUB_UNIT, '/home/kostie/.local/bin') }, extra || {}));
}

describe('the unit bootUnit.js writes', function () {

	it('names no Node version anywhere, and runs every Exec line through the wrapper', function () {
		var u = render();
		assert.ok(!/\.nvm\/versions/.test(u), u);
		assert.ok(/^ExecStart=\/home\/kostie\/\.local\/bin\/canectic-pm2 resurrect$/m.test(u));
		assert.ok(/^ExecReload=\/home\/kostie\/\.local\/bin\/canectic-pm2 reload all$/m.test(u));
		assert.ok(/^ExecStop=\/home\/kostie\/\.local\/bin\/canectic-pm2 kill$/m.test(u));
		assert.deepStrictEqual(assessUnit(u, W).problems, []);
	});

	it('keeps the PATH pm2 startup captured, minus the nvm version, wrapper first', function () {
		assert.strictEqual(keepPath(HUB_UNIT, '/home/kostie/.local/bin'),
			'/home/kostie/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/games:/snap/bin');
		assert.ok(/^\/x\/bin:\/usr\/local\/sbin/.test(keepPath(null, '/x/bin')), 'a default when there is no unit');
	});

	it('carries NVM_DIR only where nvm is installed', function () {
		assert.ok(/^Environment=NVM_DIR=\/home\/kostie\/\.nvm$/m.test(render()));
		assert.ok(!/NVM_DIR/.test(render({ nvmDir: null })), 'a native Node install goes straight to the pm2 on PATH');
	});

	it('keeps the parts pm2 startup writes that the service depends on', function () {
		var u = render();
		for (var line of ['Type=forking', 'User=kostie', 'PIDFile=/home/kostie/.pm2/pm2.pid',
			'Environment=PM2_HOME=/home/kostie/.pm2', 'Restart=on-failure', 'WantedBy=multi-user.target']) {
			assert.ok(u.split('\n').indexOf(line) !== -1, line);
		}
	});
});

describe('checking a board\'s unit', function () {

	it('reports the hub\'s stock unit as pinned', function () {
		var a = assessUnit(HUB_UNIT, W);
		assert.strictEqual(a.pinnedTo, 'v26.8.1');
		assert.strictEqual(a.usesWrapper, false);
		assert.ok(/pinned to Node v26\.8\.1: once that version is uninstalled the BBS will not start at boot/.test(a.problems[0]));
	});

	it('reports a native install that does not use the wrapper, and a missing unit', function () {
		var native = 'ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect\nExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill';
		assert.ok(/does not go through canectic-pm2/.test(assessUnit(native, W).problems[0]));
		assert.ok(/no pm2 boot unit/.test(assessUnit(null, W).problems[0]));
	});

	it('reports a missing or out of date wrapper', function () {
		assert.strictEqual(assessWrapper(null, 'x').present, false);
		assert.strictEqual(assessWrapper('old', 'new').current, false);
		assert.deepStrictEqual(assessWrapper('same', 'same').problems, []);
	});

	it('finds BBS processes dump.pm2 pins to another Node, and ignores other installs', function () {
		var dump = JSON.stringify([
			{ name: 'gateway', exec_interpreter: '/n/v26/bin/node', pm_cwd: '/opt/canectic' },
			{ name: 'worker', exec_interpreter: '/n/v28/bin/node', pm_cwd: '/opt/canectic' },
			{ name: 'other', exec_interpreter: '/n/v26/bin/node', pm_cwd: '/srv/elsewhere' }
		]);
		var d = assessDump(dump, '/n/v28/bin/node', '/opt/canectic');
		assert.deepStrictEqual(d.stale.map(function (s) { return s.name; }), ['gateway']);
		assert.deepStrictEqual(assessDump('not json', '/n', '/x').stale, []);
	});

	it('works out the Node nvm\'s default alias names, as nvm would', function () {
		var nvm = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-nvm-'));
		try {
			fs.mkdirSync(path.join(nvm, 'alias'), { recursive: true });
			for (var v of ['v26.8.1', 'v26.10.0', 'v28.0.0']) fs.mkdirSync(path.join(nvm, 'versions', 'node', v, 'bin'), { recursive: true });
			fs.writeFileSync(path.join(nvm, 'alias', 'default'), '26\n');
			assert.strictEqual(nvmDefaultNode(nvm), path.join(nvm, 'versions', 'node', 'v26.10.0', 'bin', 'node'), 'newest 26, numerically');
			fs.writeFileSync(path.join(nvm, 'alias', 'default'), 'v28.0.0');
			assert.strictEqual(nvmDefaultNode(nvm), path.join(nvm, 'versions', 'node', 'v28.0.0', 'bin', 'node'));
			fs.writeFileSync(path.join(nvm, 'alias', 'default'), 'lts/*');
			assert.strictEqual(nvmDefaultNode(nvm), null, 'an alias of an alias is left to nvm');
		} finally { fs.rmSync(nvm, { recursive: true, force: true }); }
	});

	it('puts it together for a board, from files on disk', function () {
		var home = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-home-'));
		try {
			var unitPath = path.join(home, 'pm2-test.service');
			fs.writeFileSync(unitPath, HUB_UNIT);
			var r = assessBoot({ user: 'test', home: home, nvmDir: null, unitPath: unitPath, installRoot: ROOT, currentNode: process.execPath });
			assert.strictEqual(r.unit.pinnedTo, 'v26.8.1');
			assert.strictEqual(r.wrapper.present, false);
			assert.strictEqual(r.problems.length, 3, r.problems.join(' | '));
			assert.ok(/pm2 has nothing saved for the boot unit to start/.test(r.problems[2]),
				'no dump.pm2: the unit would start pm2 and nothing else');
		} finally { fs.rmSync(home, { recursive: true, force: true }); }
	});
});

describe('the wrapper, on resurrect', function () {
	var dir, log, pm2Home, install;

	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-wrap-'));
		var bin = path.join(dir, 'bin');
		fs.mkdirSync(bin);
		log = path.join(dir, 'pm2.log');
		// A pm2 that records what it was asked, one line per call.
		fs.writeFileSync(path.join(bin, 'pm2'), '#!/usr/bin/env bash\necho "$*" >> "' + log + '"\n', { mode: 0o755 });
		pm2Home = path.join(dir, 'pm2home');
		fs.mkdirSync(pm2Home);
		install = path.join(dir, 'canectic');
		fs.mkdirSync(install);
		fs.writeFileSync(path.join(install, 'ecosystem.config.cjs'), 'module.exports = {}\n');
	});
	afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

	function run(args, dump) {
		if (dump) fs.writeFileSync(path.join(pm2Home, 'dump.pm2'), JSON.stringify(dump));
		var r = spawnSync('bash', [WRAPPER].concat(args), {
			encoding: 'utf8', timeout: 20000,
			env: { PATH: path.join(dir, 'bin') + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin',
				PM2_HOME: pm2Home, NVM_DIR: path.join(dir, 'no-nvm'), HOME: dir }
		});
		var calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
		return { status: r.status, stderr: r.stderr, calls: calls };
	}

	it('re-pins BBS processes dump.pm2 recorded on another Node, then saves', function () {
		var r = run(['resurrect'], [
			{ name: 'gateway', exec_interpreter: '/gone/v26.8.1/bin/node', pm_cwd: install },
			{ name: 'worker', exec_interpreter: '/gone/v26.8.1/bin/node', pm_cwd: install }
		]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.deepStrictEqual(r.calls, [
			'resurrect',
			'delete gateway worker',
			'start ecosystem.config.cjs --only gateway,worker',
			'save'
		]);
		assert.ok(/gateway worker in .* were saved on another Node/.test(r.stderr), r.stderr);
	});

	it('leaves processes alone when dump.pm2 already names the current Node', function () {
		var r = run(['resurrect'], [
			{ name: 'gateway', exec_interpreter: fs.realpathSync(process.execPath), pm_cwd: install }
		]);
		assert.deepStrictEqual(r.calls, ['resurrect']);
	});

	it('does not touch another program\'s processes that have no ecosystem.config.cjs', function () {
		var r = run(['resurrect'], [
			{ name: 'somethingelse', exec_interpreter: '/gone/bin/node', pm_cwd: path.join(dir, 'elsewhere') }
		]);
		assert.deepStrictEqual(r.calls, ['resurrect']);
	});

	it('passes every other command straight through', function () {
		assert.deepStrictEqual(run(['reload', 'all']).calls, ['reload all']);
	});
});
