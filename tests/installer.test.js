// tests/installer.test.js: installing a release onto a machine with nothing.
//
// Install is update from nothing, and that is meant literally: the file
// placement is the updater's planner against an empty directory, so this does
// not re-test what applyPlan.test.js already covers. What is asserted here is
// the part that genuinely differs.
//
//   The scaffolding. A release ships no empty directories, because an empty
//   directory is not a file, so something has to create the FTN spool, the logs
//   and the art tree. That something used to be install.sh and an update never
//   ran it, which means a release that starts writing to a new directory works
//   on a fresh install and fails on every upgraded one, at the moment the
//   feature is first used. It now runs on both paths.
//
//   The .env. It is written once from the template and never overwritten,
//   because a directory that already has one belongs to somebody who set it up.
//   It holds a database password, so its mode matters.
//
//   The refusal. Installing over an existing installation would treat every one
//   of the sysop's files as new, which is the updater's job and not this one's.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildManifest, serialiseManifest, MANIFEST_FILENAME } from '../src/release/manifest.js';
import { newRun } from '../src/release/updatePhases.js';
import { runtimeDirs, FIXED_DIRS } from '../src/release/runtimeDirs.js';
import { createRuntimeDirs } from '../src/maintenance/updateCommands.js';
import { writeEnv, runInstall, ENV_TEMPLATE } from '../src/maintenance/installer.js';
import * as runStore from '../src/maintenance/updateRunStore.js';

var roots = [];
function tmp(tag) {
	var d = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-install-' + tag + '-'));
	roots.push(d);
	return d;
}
function write(root, files) {
	for (var p of Object.keys(files)) {
		var abs = path.join(root, p);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, files[p]);
	}
	return root;
}
after(function () {
	for (var d of roots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function stage(extra) {
	var files = Object.assign({
		'package.json': JSON.stringify({ name: 'canectic-bbs', version: '0.9.9a' }, null, 2),
		'src/a.js': 'code',
		[ENV_TEMPLATE]: 'dbname=canectic_bbs\ndbuser=canectic\ndbpass=\ndbhost=localhost\nwebport=8080\n'
	}, extra);
	var root = write(tmp('staged'), files);
	var entries = Object.keys(files).sort().map(function (p) { return { path: p, category: 'code' }; });
	var manifest = buildManifest({ root: root, files: entries, version: '0.9.9a' });
	fs.writeFileSync(path.join(root, MANIFEST_FILENAME), serialiseManifest(manifest));
	return root;
}

function scenario(opts) {
	var o = opts || {};
	var target = o.target || tmp('target');
	var stagedRoot = o.stagedRoot || stage();
	var runId = 'inst-' + Math.random().toString(36).substring(2, 8);
	runStore.save(target, newRun({ runId: runId, from: null, to: '0.9.9a', target: target }));
	return {
		target: target, stagedRoot: stagedRoot, runId: runId,
		instructions: {
			runId: runId, target: target, stagedRoot: stagedRoot, from: null, to: '0.9.9a',
			env: o.env || {},
			options: Object.assign({ dependencies: false, database: false, start: false }, o.options)
		}
	};
}

function execStub(record, failOn) {
	return function (command) {
		record.push(command);
		if (failOn && failOn.test(command)) throw new Error('pretend failure: ' + command);
		return '';
	};
}
function phase(state, name) {
	return state.phases.filter(function (p) { return p.name === name; })[0];
}

describe('runtimeDirs', function () {

	it('names the directories no release ships', function () {
		var dirs = runtimeDirs();
		for (var required of ['logs/production', 'ftn/in', 'ftn/out', 'ftn/bad', 'ftn/filebox',
			'files/staging', 'qwk', 'tmp', 'export']) {
			assert.ok(dirs.indexOf(required) !== -1, 'missing ' + required);
		}
	});

	it('enumerates the art tree on both axes', function () {
		// A directory only implied by a config default is one nobody can find.
		var dirs = runtimeDirs();
		assert.ok(dirs.indexOf('txtfiles/ans/welcome') !== -1);
		assert.ok(dirs.indexOf('txtfiles/sixel/logon') !== -1);
		assert.ok(dirs.indexOf('txtfiles/webart/screens') !== -1);
	});

	it('has no duplicates and is stable', function () {
		var dirs = runtimeDirs();
		assert.strictEqual(dirs.length, new Set(dirs).size);
		assert.deepStrictEqual(dirs, runtimeDirs());
	});
});

describe('createRuntimeDirs', function () {

	it('creates them and reports what it made', function () {
		var target = tmp('dirs');
		var made = createRuntimeDirs(target);
		assert.strictEqual(made.length, runtimeDirs().length);
		assert.ok(fs.existsSync(path.join(target, 'ftn/in')));
		assert.ok(fs.existsSync(path.join(target, 'txtfiles/ans/welcome')));
	});

	it('is idempotent, which is what lets an update run it too', function () {
		// A release that starts writing to a new directory has to get it on
		// upgraded installs as well, not only fresh ones.
		var target = tmp('dirs');
		createRuntimeDirs(target);
		assert.deepStrictEqual(createRuntimeDirs(target), [], 'a second run should make nothing');
	});

	it('reports only what was missing, so an update can say what it added', function () {
		var target = tmp('dirs');
		createRuntimeDirs(target);
		fs.rmSync(path.join(target, 'ftn/filebox'), { recursive: true });
		assert.deepStrictEqual(createRuntimeDirs(target), ['ftn/filebox']);
	});

	it('does not disturb what is already in them', function () {
		var target = tmp('dirs');
		createRuntimeDirs(target);
		fs.writeFileSync(path.join(target, 'ftn/in/packet.pkt'), 'mail');
		createRuntimeDirs(target);
		assert.strictEqual(fs.readFileSync(path.join(target, 'ftn/in/packet.pkt'), 'utf8'), 'mail');
	});
});

describe('writeEnv', function () {

	function targetWithTemplate() {
		return write(tmp('env'), {
			[ENV_TEMPLATE]: 'dbname=canectic_bbs\ndbuser=canectic\ndbpass=\n# a comment\nwebport=8080\n'
		});
	}

	it('fills in the values it was given and leaves the rest', function () {
		var target = targetWithTemplate();
		var r = writeEnv(target, { dbname: 'mybbs', dbpass: 'secret' });
		var text = fs.readFileSync(path.join(target, '.env'), 'utf8');
		assert.ok(/^dbname=mybbs$/m.test(text), text);
		assert.ok(/^dbpass=secret$/m.test(text), text);
		assert.ok(/^dbuser=canectic$/m.test(text), 'untouched keys keep the template value');
		assert.ok(/^webport=8080$/m.test(text));
		assert.ok(/# a comment/.test(text), 'comments survive');
		assert.deepStrictEqual(r.keys.sort(), ['dbname', 'dbpass']);
	});

	it('appends a key the template does not carry', function () {
		// Asking for something and then dropping it would be worse than not
		// asking.
		var target = targetWithTemplate();
		writeEnv(target, { dbhost: 'db.example' });
		assert.ok(/^dbhost=db\.example$/m.test(fs.readFileSync(path.join(target, '.env'), 'utf8')));
	});

	it('ignores values that were not supplied rather than blanking them', function () {
		var target = targetWithTemplate();
		writeEnv(target, { dbname: null, dbuser: undefined });
		var text = fs.readFileSync(path.join(target, '.env'), 'utf8');
		assert.ok(/^dbname=canectic_bbs$/m.test(text), text);
		assert.ok(/^dbuser=canectic$/m.test(text), text);
	});

	it('writes it unreadable to anyone else, because it holds a password', function () {
		var target = targetWithTemplate();
		writeEnv(target, { dbpass: 'secret' });
		assert.strictEqual(fs.statSync(path.join(target, '.env')).mode & 0o777, 0o600);
	});

	it('never overwrites a .env that is already there', function () {
		// A directory with a .env belongs to somebody who set it up, and their
		// credentials are worth more than the template.
		var target = targetWithTemplate();
		fs.writeFileSync(path.join(target, '.env'), 'dbpass=theirs\n');
		var r = writeEnv(target, { dbpass: 'ours' });
		assert.strictEqual(r.written, false);
		assert.strictEqual(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'dbpass=theirs\n');
	});

	it('says so plainly when the release ships no template', function () {
		assert.throws(function () { writeEnv(tmp('env'), {}); }, /ships no/);
	});
});

describe('runInstall', function () {

	it('lays down the release, the directories and the .env', async function () {
		var s = scenario({ env: { dbname: 'mybbs' } });
		var state = await runInstall({ instructions: s.instructions, exec: execStub([]) });

		assert.strictEqual(state.status, 'complete', state.error || '');
		assert.strictEqual(fs.readFileSync(path.join(s.target, 'src/a.js'), 'utf8'), 'code');
		assert.ok(fs.existsSync(path.join(s.target, 'ftn/in')));
		assert.ok(/^dbname=mybbs$/m.test(fs.readFileSync(path.join(s.target, '.env'), 'utf8')));
	});

	it('skips the update-only phases with reasons that say why', async function () {
		// Install is update from nothing, so these are the phases "nothing"
		// makes meaningless. Saying so beats leaving them pending.
		var state = await runInstall({ instructions: scenario().instructions, exec: execStub([]) });
		assert.strictEqual(phase(state, 'backup').status, 'skipped');
		assert.ok(/nothing to preserve/.test(phase(state, 'backup').detail));
		assert.strictEqual(phase(state, 'stop').status, 'skipped');
		assert.ok(/nothing is running/.test(phase(state, 'stop').detail));
		assert.strictEqual(phase(state, 'steps').status, 'skipped');
	});

	it('refuses to install over an existing installation', async function () {
		// Every one of the sysop's files would be treated as new. That is the
		// updater's job, and it knows which ones to leave alone.
		var target = write(tmp('target'), { 'package.json': JSON.stringify({ version: '0.9.6a' }) });
		var state = await runInstall({ instructions: scenario({ target: target }).instructions, exec: execStub([]) });
		assert.strictEqual(state.status, 'failed');
		assert.ok(/already holds Canectic 0\.9\.6a/.test(state.error), state.error);
		assert.ok(/updater/.test(state.error), 'it has to say what to use instead: ' + state.error);
	});

	it('installs over one anyway when told to', async function () {
		var target = write(tmp('target'), { 'package.json': JSON.stringify({ version: '0.9.6a' }) });
		var s = scenario({ target: target, options: { force: true } });
		var state = await runInstall({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(state.status, 'complete', state.error || '');
	});

	it('runs the schema when asked, and says what to run when not', async function () {
		var ran = [];
		var withDb = scenario({ options: { database: true, createDatabase: true } });
		await runInstall({ instructions: withDb.instructions, exec: execStub(ran) });
		assert.ok(ran.some(function (c) { return /create_pg_db_user/.test(c); }), ran.join(' | '));
		assert.ok(ran.some(function (c) { return /dbmigrations/.test(c); }), ran.join(' | '));

		var without = await runInstall({ instructions: scenario().instructions, exec: execStub([]) });
		assert.ok(/create_pg_db_user/.test(phase(without, 'schema').detail),
			'a skipped phase has to carry the command: ' + phase(without, 'schema').detail);
	});

	it('records a fresh database as born current rather than migrated', async function () {
		var s = scenario({ options: { database: true } });
		var state = await runInstall({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(phase(state, 'migrations').status, 'skipped');
		assert.ok(/born current/.test(phase(state, 'migrations').detail));
	});

	it('says the directory is safe to delete when it fails', async function () {
		// There was nothing underneath, so starting again is simpler and safer
		// than unpicking a partial install.
		var s = scenario({ options: { dependencies: true } });
		var state = await runInstall({ instructions: s.instructions, exec: execStub([], /npm install/) });
		assert.strictEqual(state.status, 'failed');
		assert.ok(state.warnings.some(function (w) { return /safe/.test(w) && /starting again/.test(w); }),
			JSON.stringify(state.warnings));
	});

	it('verifies the installation against the release when it is done', async function () {
		var s = scenario();
		var state = await runInstall({ instructions: s.instructions, exec: execStub([]) });
		assert.strictEqual(phase(state, 'verify').status, 'done');
		assert.ok(/match the release/.test(phase(state, 'verify').detail));
	});
});

describe('runInstall and npm rewriting the lockfile', function () {
	// Found by the install rehearsal on 2026-09-21: npm install synced the
	// lockfile's root version to package.json and added its own metadata, and
	// the final check reported the whole install failed, telling the sysop to
	// delete a working board.
	function lockText(version, extraField) {
		var l = { name: 'canectic-bbs', version: version, lockfileVersion: 3, packages: {
			'': { name: 'canectic-bbs', version: version },
			'node_modules/bindings': { version: '1.5.0', integrity: 'sha512-BBB' }
		} };
		if (extraField) l.packages['node_modules/bindings'].hasInstallScript = true;
		return JSON.stringify(l, null, 2) + '\n';
	}

	function npmStub(target, rewrite) {
		return function (command) {
			if (/npm install/.test(command)) fs.writeFileSync(path.join(target, 'package-lock.json'), rewrite());
			return '';
		};
	}

	it('completes when npm only normalises the lockfile', async function () {
		var s = scenario({ stagedRoot: stage({ 'package-lock.json': lockText('0.9.6a') }), options: { dependencies: true } });
		var state = await runInstall({ instructions: s.instructions,
			exec: npmStub(s.target, function () { return lockText('0.9.9a', true); }) });
		assert.strictEqual(state.status, 'complete', state.error || '');
	});

	it('still fails, naming the file, when npm pins something different', async function () {
		var s = scenario({ stagedRoot: stage({ 'package-lock.json': lockText('0.9.9a') }), options: { dependencies: true } });
		var state = await runInstall({ instructions: s.instructions, exec: npmStub(s.target, function () {
			return lockText('0.9.9a').replace('1.5.0', '9.9.9');
		}) });
		assert.strictEqual(state.status, 'failed');
		assert.ok(/package-lock\.json/.test(state.error), 'the failure must say which file: ' + state.error);
	});
});
