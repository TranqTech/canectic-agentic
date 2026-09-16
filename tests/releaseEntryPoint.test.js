// tests/releaseEntryPoint.test.js: the files a sysop fetches before they have
// anything, and the checksum list that vouches for a publish directory.
//
// Two bugs of the same shape, found while preparing the first cut, are what
// these assert against.
//
// The first: SHA256SUMS was built from a pattern naming `.tar.gz`. The artifact
// became a ZIP and the pattern went on matching, silently, so the published
// list vouched for the metadata sidecars and not for the software, and it never
// covered `index-<channel>.json` at all. Signing that list would have signed
// everything except the thing worth signing. `checksummedNames` is therefore
// stated as an exclusion: everything published, less the list itself and its
// own signature. A rule that enumerates what to include has to be revisited
// whenever something new is published and fails quietly when it is not.
//
// The second: README, INSTALL.md and the bootstrap's own header all tell a new
// sysop to fetch `bootstrap.sh` and `bootstrap.sh.sha256` from the release
// host, and nothing produced either one. The bootstrap cannot ship inside a
// release, because resolving a release is its job, so it is the one file that
// has to be published beside the indexes.
//
// Filesystem, in a temp directory. No database, no services.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
	BOOTSTRAP_NAME, BOOTSTRAP_SUMS_NAME, INSTALL_DOC_NAME, PUBLIC_KEY_FILENAME,
	entryPointSources, publishEntryPoint
} from '../src/release/entryPoint.js';
import { checksummedNames, releaseDate, artifactName, metadataName, manifestName } from '../src/release/metadata.js';
import { indexName } from '../src/release/releaseIndex.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the checksum list over a publish directory', function () {

	it('covers the artifact, whatever extension the artifact has', function () {
		var names = checksummedNames([
			artifactName('0.9.6a'),
			metadataName('0.9.6a'),
			manifestName('0.9.6a'),
			indexName('stable')
		]);
		// The bug: a pattern naming tar.gz left the software itself uncovered.
		assert.ok(names.indexOf(artifactName('0.9.6a')) !== -1, 'the artifact is not covered');
		assert.ok(names.indexOf(indexName('stable')) !== -1, 'the channel index is not covered');
		assert.strictEqual(names.length, 4);
	});

	it('covers a development delta as readily as a stable', function () {
		var delta = artifactName('0.9.6a.20260913', { delta: true });
		assert.ok(checksummedNames([delta]).indexOf(delta) !== -1);
	});

	it('covers the bootstrap and its checksum file', function () {
		var names = checksummedNames([BOOTSTRAP_NAME, BOOTSTRAP_SUMS_NAME, INSTALL_DOC_NAME]);
		assert.deepStrictEqual(names, [BOOTSTRAP_SUMS_NAME, BOOTSTRAP_NAME, INSTALL_DOC_NAME].sort());
	});

	// Deliberately listed rather than excluded. A key whose checksum appears in
	// a file signed by that key is not circular in any harmful way: an attacker
	// who swaps the key cannot re-sign the list, and listing it catches plain
	// corruption in transit. Excluding it would also mean a name-specific
	// exception in a rule whose whole point is that it has none.
	it('covers the public key', function () {
		assert.deepStrictEqual(checksummedNames([PUBLIC_KEY_FILENAME]), [PUBLIC_KEY_FILENAME]);
	});

	it('does not list itself, and does not list a signature over itself', function () {
		var names = checksummedNames(['SHA256SUMS', 'SHA256SUMS.asc', artifactName('0.9.6a')]);
		assert.deepStrictEqual(names, [artifactName('0.9.6a')]);
	});

	it('ignores dotfiles', function () {
		assert.deepStrictEqual(checksummedNames(['.DS_Store', '.htaccess']), []);
	});

	it('is sorted, so the published list is stable between cuts', function () {
		var a = checksummedNames(['c.json', 'a.zip', 'b.json']);
		assert.deepStrictEqual(a, ['a.zip', 'b.json', 'c.json']);
	});
});

describe('the release date', function () {

	// Local, for the reason buildStamp is local: the date a maintainer means is
	// the one on their wall. A UTC date puts an evening cut west of Greenwich
	// into the following day, in the changelog heading and the metadata both,
	// permanently. (In a UTC timezone the two implementations agree, so this
	// proves the property rather than the bug.)
	it('is the local calendar date at every hour of the day', function () {
		for (var hour = 0; hour < 24; hour++) {
			var d = new Date(2026, 8, 15, hour, 30, 0);
			assert.strictEqual(releaseDate(d), '2026-09-15', 'wrong date at ' + hour + ':30 local');
		}
	});

	it('pads month and day', function () {
		assert.strictEqual(releaseDate(new Date(2027, 0, 5, 12, 0, 0)), '2027-01-05');
	});
});

describe('publishing the entry point', function () {

	var work;

	beforeEach(function () {
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-entrypoint-'));
	});

	afterEach(function () {
		fs.rmSync(work, { recursive: true, force: true });
	});

	it('names sources that exist in this repository', function () {
		for (var src of entryPointSources(ROOT)) {
			assert.ok(fs.existsSync(src.from), src.name + ' is not where the publisher looks: ' + src.from);
		}
	});

	it('writes the bootstrap, its checksum, the install guide and the key', function () {
		var written = publishEntryPoint({ root: ROOT, output: work });
		assert.deepStrictEqual(written.slice().sort(),
			[BOOTSTRAP_NAME, BOOTSTRAP_SUMS_NAME, INSTALL_DOC_NAME, PUBLIC_KEY_FILENAME].sort());
		for (var name of written) {
			assert.ok(fs.existsSync(path.join(work, name)), name + ' was not published');
		}
	});

	it('publishes the bootstrap this release actually ships', function () {
		publishEntryPoint({ root: ROOT, output: work });
		assert.strictEqual(
			fs.readFileSync(path.join(work, BOOTSTRAP_NAME), 'utf8'),
			fs.readFileSync(path.join(ROOT, 'setup', BOOTSTRAP_NAME), 'utf8'),
			'the published bootstrap is not the one in the tree');
	});

	it('leaves the bootstrap executable', function () {
		publishEntryPoint({ root: ROOT, output: work });
		var mode = fs.statSync(path.join(work, BOOTSTRAP_NAME)).mode & 0o777;
		assert.strictEqual(mode & 0o111, 0o111, 'mode is ' + mode.toString(8));
	});

	// The command INSTALL.md tells people to run is `sha256sum -c
	// bootstrap.sh.sha256`, so that is the command the test runs. A checksum in
	// a format the documented command cannot read looks checked and is not.
	it('writes a checksum the documented command verifies', function () {
		publishEntryPoint({ root: ROOT, output: work });
		var out = execFileSync('sha256sum', ['-c', BOOTSTRAP_SUMS_NAME], { cwd: work, encoding: 'utf8' });
		assert.match(out, /bootstrap\.sh: OK/);
	});

	it('fails the verification when the published bootstrap is altered', function () {
		publishEntryPoint({ root: ROOT, output: work });
		fs.appendFileSync(path.join(work, BOOTSTRAP_NAME), '\n# tampered\n');
		assert.throws(function () {
			execFileSync('sha256sum', ['-c', BOOTSTRAP_SUMS_NAME], { cwd: work, stdio: 'pipe' });
		});
	});

	it('creates the publish directory when it is not there yet', function () {
		var fresh = path.join(work, 'nested', 'releases');
		publishEntryPoint({ root: ROOT, output: fresh });
		assert.ok(fs.existsSync(path.join(fresh, BOOTSTRAP_NAME)));
	});

	it('refuses rather than publishing a partial entry point', function () {
		var empty = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-noroot-'));
		try {
			assert.throws(function () {
				publishEntryPoint({ root: empty, output: work });
			}, /bootstrap\.sh/);
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe('what the documentation tells a new sysop to fetch', function () {

	// The bootstrap is the one file that cannot ship inside a release, so these
	// names are a contract between four documents and the publisher. They were
	// written down in all four and produced by none.
	var docs = [
		path.join(ROOT, 'README.md'),
		path.join(ROOT, 'docs', 'sysop', 'INSTALL.md'),
		path.join(ROOT, 'setup', 'bootstrap.sh')
	];

	it('is published by the release script', function () {
		for (var file of docs) {
			var text = fs.readFileSync(file, 'utf8');
			if (text.indexOf(BOOTSTRAP_SUMS_NAME) === -1) continue;
			assert.ok(text.indexOf(BOOTSTRAP_NAME) !== -1,
				path.basename(file) + ' asks for a checksum of a file it never names');
		}
		var written = publishEntryPoint({ root: ROOT, output: fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-docs-')) });
		assert.ok(written.indexOf(BOOTSTRAP_SUMS_NAME) !== -1);
	});
});
