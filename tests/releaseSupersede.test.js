// tests/releaseSupersede.test.js: withdrawing a release, and its signature.
//
// `release.mjs --supersede ... --sign` returned before the step that chooses
// the signing key, so it handed SHA256SUMS no key, which reads as an unsigned
// build: the old SHA256SUMS.asc was removed, nothing was signed, and the script
// printed "SHA256SUMS rewritten and signed". Found withdrawing 0.9.7a on
// 2026-09-22. A withdrawal that cannot sign must now leave the directory exactly
// as it was.
//
// Runs the script with an empty gpg home, so no key can sign. Stops gpg's
// daemons for that home afterwards: a stray daemon on a small box is not
// harmless. Skips without gpg.
//
// Run: npx mocha --no-config --exit tests/releaseSupersede.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeSums } from '../scripts/release.mjs';
import { gpgAvailable } from '../src/release/signing.js';

var SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release.mjs');

describe('withdrawing a release', function () {
	this.timeout(60000);
	var work, out, home;

	function index() {
		return {
			channel: 'stable',
			releases: [
				{ version: '0.9.8a', artifact: 'canectic-0.9.8a.zip', migrations: [] },
				{ version: '0.9.7a', artifact: 'canectic-0.9.7a.zip', migrations: [] }
			]
		};
	}

	function supersede(extra) {
		return spawnSync(process.execPath, [SCRIPT, '--supersede', '0.9.7a', '--by', '0.9.8a',
			'--reason', 'the updater fails', '--output', out].concat(extra || []), {
			encoding: 'utf8', timeout: 45000,
			env: Object.assign({}, process.env, { GNUPGHOME: home, GPG_TTY: '' })
		});
	}

	beforeEach(function () {
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-supersede-'));
		out = path.join(work, 'releases');
		home = path.join(work, 'gnupg');
		fs.mkdirSync(out);
		fs.mkdirSync(home, { mode: 0o700 });
		fs.writeFileSync(path.join(out, 'canectic-0.9.8a.zip'), 'artifact');
		fs.writeFileSync(path.join(out, 'index-stable.json'), JSON.stringify(index(), null, 2) + '\n');
		writeSums(out, null);
		fs.writeFileSync(path.join(out, 'SHA256SUMS.asc'), '-----BEGIN PGP SIGNATURE-----\npublished\n');
	});
	afterEach(function () {
		spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore' });
		fs.rmSync(work, { recursive: true, force: true });
	});

	it('changes nothing when --sign is asked for and no key can sign', function () {
		if (!gpgAvailable()) return this.skip();
		var indexBefore = fs.readFileSync(path.join(out, 'index-stable.json'), 'utf8');
		var sumsBefore = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8');

		var r = supersede(['--sign']);
		var said = r.stdout + r.stderr;

		assert.notStrictEqual(r.status, 0, 'it must fail: ' + said);
		assert.ok(!/and signed/.test(said), 'it must not claim a signature it did not make: ' + said);
		assert.strictEqual(fs.readFileSync(path.join(out, 'index-stable.json'), 'utf8'), indexBefore,
			'the index was rewritten by a withdrawal that could not be signed');
		assert.strictEqual(fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8'), sumsBefore);
		assert.ok(fs.existsSync(path.join(out, 'SHA256SUMS.asc')),
			'the published signature was removed and nothing replaced it');
	});

	it('withdraws without --sign and says plainly that nothing is signed', function () {
		var r = supersede([]);
		var said = r.stdout + r.stderr;
		assert.strictEqual(r.status, 0, said);
		var idx = JSON.parse(fs.readFileSync(path.join(out, 'index-stable.json'), 'utf8'));
		assert.strictEqual(idx.releases[1].superseded_by, '0.9.8a');
		assert.ok(/UNSIGNED/.test(said), said);
		assert.ok(!fs.existsSync(path.join(out, 'SHA256SUMS.asc')), 'a signature over the old list cannot stay');
	});
});

describe('writeSums reports whether it signed', function () {
	it('says unsigned when it was not asked to sign', function () {
		var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-sums-report-'));
		try {
			fs.writeFileSync(path.join(dir, 'canectic-1.0.0.zip'), 'artifact');
			var r = writeSums(dir, null);
			assert.strictEqual(r.signed, false);
			assert.strictEqual(r.path, path.join(dir, 'SHA256SUMS'));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
