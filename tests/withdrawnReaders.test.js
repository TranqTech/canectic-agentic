// tests/withdrawnReaders.test.js: everything that reads the index, and the
// withdrawn list.
//
// A withdrawal takes a release out of `releases` and into `withdrawn`, so that
// boards and bootstraps written before withdrawal existed stop being offered
// it. The readers written since still have things to say about a withdrawn
// release: a board running one is told why, asking for one by name is refused
// with the reason, and its notes stay published.
//
// Run: npx mocha --no-config --exit tests/withdrawnReaders.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { evaluateChannel, VERDICT_CURRENT, VERDICT_AVAILABLE } from '../src/release/updateVerdict.js';
import { resolveRelease, dirSource } from '../src/maintenance/updateStaging.js';
import { withdrawRelease, replacementFor } from '../src/release/releaseIndex.js';
import { publishedVersions } from '../scripts/publish.mjs';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function index() {
	return {
		channel: 'stable',
		releases: [
			{ version: '0.9.9a', artifact: 'canectic-0.9.9a.zip', migrations: [] },
			{ version: '0.9.8a', artifact: 'canectic-0.9.8a.zip', migrations: [] },
			{ version: '0.9.6a', artifact: 'canectic-0.9.6a.zip', migrations: [] }
		]
	};
}

describe('the update check and a withdrawn release', function () {

	it('tells a board running one that it was withdrawn, and why', function () {
		var idx = withdrawRelease(index(), '0.9.8a', { reason: 'updater crashes', by: '0.9.9a' });
		var r = evaluateChannel({ index: idx, channel: 'stable', current: '0.9.8a', appliedMigrations: [] });
		assert.strictEqual(r.verdict, VERDICT_AVAILABLE);
		assert.strictEqual(r.available, '0.9.9a');
		assert.deepStrictEqual(r.withdrawn, { by: '0.9.9a', reason: 'updater crashes' });
	});

	it('says so even when nothing replaces it yet', function () {
		var idx = withdrawRelease(index(), '0.9.9a', { reason: 'updater crashes' });
		var r = evaluateChannel({ index: idx, channel: 'stable', current: '0.9.9a', appliedMigrations: [] });
		assert.strictEqual(r.verdict, VERDICT_CURRENT, 'nothing newer is listed');
		assert.deepStrictEqual(r.withdrawn, { by: null, reason: 'updater crashes' });
	});

	it('never offers it to anybody else', function () {
		var idx = withdrawRelease(index(), '0.9.9a', { reason: 'x' });
		var r = evaluateChannel({ index: idx, channel: 'stable', current: '0.9.6a', appliedMigrations: [] });
		assert.strictEqual(r.available, '0.9.8a');
	});
});

// The 0.9.7a case as published: withdrawn in favour of 0.9.8a, which was then
// withdrawn in favour of 0.9.9a. Reading 0.9.7a's own field sends a board to a
// release it will be refused.
function chained() {
	var idx = { channel: 'stable', releases: [
		{ version: '0.9.9a', migrations: [] }, { version: '0.9.8a', migrations: [] },
		{ version: '0.9.7a', migrations: [] }, { version: '0.9.6a', migrations: [] }
	] };
	idx = withdrawRelease(idx, '0.9.7a', { reason: 'updater freezes', by: '0.9.8a' });
	return withdrawRelease(idx, '0.9.8a', { reason: 'updater crashes', by: '0.9.9a' });
}

describe('the replacement for a withdrawn release', function () {

	it('follows a replacement that was itself withdrawn to the one that is listed', function () {
		assert.strictEqual(replacementFor(chained(), '0.9.7a'), '0.9.9a');
		assert.strictEqual(replacementFor(chained(), '0.9.8a'), '0.9.9a');
	});

	it('names the newest listed release, not an older one that was named first', function () {
		var idx = chained();
		idx.releases.unshift({ version: '0.9.10a', migrations: [] });
		assert.strictEqual(replacementFor(idx, '0.9.7a'), '0.9.10a');
	});

	it('finds the way out when the chain ends on a withdrawal with no replacement', function () {
		var idx = { channel: 'stable', releases: [
			{ version: '0.9.10a' }, { version: '0.9.8a' }, { version: '0.9.7a' }, { version: '0.9.6a' }] };
		idx = withdrawRelease(idx, '0.9.7a', { reason: 'x', by: '0.9.8a' });
		idx = withdrawRelease(idx, '0.9.8a', { reason: 'y' });
		assert.strictEqual(replacementFor(idx, '0.9.7a'), '0.9.10a');
		idx.releases = idx.releases.filter(function (r) { return r.version !== '0.9.10a'; });
		assert.strictEqual(replacementFor(idx, '0.9.7a'), null, 'nothing newer than the dead end is listed');
	});

	it('names nothing for a release withdrawn with no replacement', function () {
		assert.strictEqual(replacementFor(withdrawRelease(index(), '0.9.8a', { reason: 'x' }), '0.9.8a'), null);
		assert.strictEqual(replacementFor(index(), '0.9.8a'), null, 'not withdrawn at all');
	});

	it('does not loop on a cycle', function () {
		var idx = { channel: 'stable', releases: [{ version: '0.9.9a' }, { version: '0.9.8a' }, { version: '0.9.7a' }] };
		idx = withdrawRelease(idx, '0.9.8a', { reason: 'x', by: '0.9.9a' });
		idx = withdrawRelease(idx, '0.9.9a', { reason: 'y', by: '0.9.8a' });
		assert.strictEqual(replacementFor(idx, '0.9.8a'), null);
	});

	it('returns a name this index does not hold as it stands', function () {
		var idx = withdrawRelease({ channel: 'development', releases: [{ version: '0.9.9a.20260922' }] },
			'0.9.9a.20260922', { reason: 'x', by: '0.9.9b' });
		assert.strictEqual(replacementFor(idx, '0.9.9a.20260922'), '0.9.9b');
	});

	it('is what the update check tells a board running one', function () {
		var r = evaluateChannel({ index: chained(), channel: 'stable', current: '0.9.7a', appliedMigrations: [] });
		assert.deepStrictEqual(r.withdrawn, { by: '0.9.9a', reason: 'updater freezes' });
	});

	it('reads the first format, marked in place', function () {
		var idx = { channel: 'stable', releases: [
			{ version: '0.9.9a' }, { version: '0.9.8a', superseded_by: '0.9.9a', superseded_reason: 'old style' }] };
		var r = evaluateChannel({ index: idx, channel: 'stable', current: '0.9.8a', appliedMigrations: [] });
		assert.deepStrictEqual(r.withdrawn, { by: '0.9.9a', reason: 'old style' });
	});
});

describe('asking for a withdrawn release by name', function () {
	var dir;
	beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-withdrawn-')); });
	afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

	it('is refused with the reason and the replacement, not "not published"', async function () {
		fs.writeFileSync(path.join(dir, 'index-stable.json'),
			JSON.stringify(withdrawRelease(index(), '0.9.8a', { reason: 'updater crashes', by: '0.9.9a' })));
		await assert.rejects(resolveRelease(dirSource(dir), 'stable', '0.9.8a'),
			/0\.9\.8a has been withdrawn \(updater crashes\); 0\.9\.9a replaces it/);
	});

	it('names the release at the end of the chain, not a withdrawn one', async function () {
		fs.writeFileSync(path.join(dir, 'index-stable.json'), JSON.stringify(chained()));
		await assert.rejects(resolveRelease(dirSource(dir), 'stable', '0.9.7a'),
			/0\.9\.7a has been withdrawn \(updater freezes\); 0\.9\.9a replaces it/);
	});

	it('takes the newest listed release when none is named', async function () {
		fs.writeFileSync(path.join(dir, 'index-stable.json'),
			JSON.stringify(withdrawRelease(index(), '0.9.9a', { reason: 'x' })));
		assert.strictEqual((await resolveRelease(dirSource(dir), 'stable', null)).version, '0.9.8a');
	});
});

describe('publishing and a withdrawn release', function () {
	it('keeps its notes published', function () {
		var text = JSON.stringify(withdrawRelease(index(), '0.9.8a', { reason: 'x' }));
		assert.ok(publishedVersions([text]).indexOf('0.9.8a') !== -1);
	});
});

// The bootstrap is what a new sysop runs, and the published copy is what was
// taking releases[0] regardless. Run with --download-only against a publish
// directory; the archive is never unpacked.
describe('the bootstrap and a withdrawn release', function () {
	this.timeout(30000);
	var BOOTSTRAP = path.join(ROOT, 'setup', 'bootstrap.sh');
	var dir, out;

	function sha(file) { return execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0]; }
	function publish(versions, idx) {
		for (var v of versions) {
			var art = 'canectic-' + v + '.zip';
			fs.writeFileSync(path.join(dir, art), 'pretend ' + v + '\n');
			fs.writeFileSync(path.join(dir, 'canectic-' + v + '.json'), JSON.stringify({
				version: v, artifact: art, channel: 'stable', sha256: sha(path.join(dir, art)), delta: false
			}));
		}
		fs.writeFileSync(path.join(dir, 'index-stable.json'), JSON.stringify(idx));
	}
	function run(args) {
		try {
			return { ok: true, output: execFileSync('bash', [BOOTSTRAP, '--from', dir, '--download-only', '--target', out].concat(args),
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
		} catch (e) {
			return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') };
		}
	}

	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-boot-withdrawn-'));
		out = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-boot-out-'));
	});
	afterEach(function () {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(out, { recursive: true, force: true });
	});

	it('refuses a withdrawn release asked for by name, with the reason', function () {
		publish(['9.9.8a', '9.9.9a'], withdrawRelease({ channel: 'stable', releases: [
			{ version: '9.9.9a' }, { version: '9.9.8a' }] }, '9.9.9a', { reason: 'updater crashes' }));
		var r = run(['--version', '9.9.9a']);
		assert.strictEqual(r.ok, false, r.output);
		assert.ok(/9\.9\.9a has been withdrawn \(updater crashes\)/.test(r.output), r.output);
	});

	it('names the release at the end of the chain, not a withdrawn one', function () {
		var idx = withdrawRelease({ channel: 'stable', releases: [
			{ version: '9.9.10a' }, { version: '9.9.9a' }, { version: '9.9.8a' }] }, '9.9.8a', { reason: 'a', by: '9.9.9a' });
		idx = withdrawRelease(idx, '9.9.9a', { reason: 'b', by: '9.9.10a' });
		publish(['9.9.8a', '9.9.9a', '9.9.10a'], idx);
		var r = run(['--version', '9.9.8a']);
		assert.strictEqual(r.ok, false, r.output);
		assert.ok(/9\.9\.8a has been withdrawn \(a\); install 9\.9\.10a instead/.test(r.output), r.output);
	});

	it('names the newest listed release when the chain ends on a withdrawal with nothing after it', function () {
		var idx = withdrawRelease({ channel: 'stable', releases: [
			{ version: '9.9.10a' }, { version: '9.9.9a' }, { version: '9.9.8a' }] }, '9.9.8a', { reason: 'a', by: '9.9.9a' });
		idx = withdrawRelease(idx, '9.9.9a', { reason: 'b' });
		publish(['9.9.8a', '9.9.9a', '9.9.10a'], idx);
		var r = run(['--version', '9.9.8a']);
		assert.ok(/install 9\.9\.10a instead/.test(r.output), r.output);
	});

	it('skips a release still marked withdrawn in place, the first format', function () {
		publish(['9.9.8a', '9.9.9a'], { channel: 'stable', releases: [
			{ version: '9.9.9a', superseded_by: '9.9.10a', superseded_reason: 'x' }, { version: '9.9.8a' }] });
		var r = run([]);
		assert.strictEqual(r.ok, true, r.output);
		assert.ok(/release 9\.9\.8a/.test(r.output), r.output);
	});

	it('still installs by name from a directory with no index at all', function () {
		publish(['9.9.9a'], { channel: 'stable', releases: [] });
		fs.unlinkSync(path.join(dir, 'index-stable.json'));
		var r = run(['--version', '9.9.9a']);
		assert.strictEqual(r.ok, true, r.output);
	});
});
