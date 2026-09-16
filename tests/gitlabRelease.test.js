// tests/gitlabRelease.test.js: mirroring a release onto the GitLab page.
//
// The repository has carried a release object per tag since v0.9.0-alpha.1, all
// three of them made by hand while the release script only ever tagged. So the
// first release cut by script would have been the first one absent from the
// page people look at.
//
// Absent would not even be the worst of it. GitLab generates "Source code
// (zip)" for a tag on its own, so the page looks like it offers a download when
// what it offers is a git tree: no MANIFEST, no CANECTIC.ID, no FILE_ID.DIZ,
// and installing it takes the from-source path rather than the bootstrap one.
// The v0.9.5a release object has exactly those four auto-sources and nothing
// else.
//
// Mirroring signed artifacts is safe in a way mirroring unsigned ones is not.
// The signature is over the content rather than over a location, so a copy
// somewhere else cannot say anything the original does not. That is what makes
// a second fetch location cost nothing, and it is why this arrived in the same
// release as the signing.
//
// Pure, plus a filesystem check against the real publish directory. No network
// and no glab call: creating a release is not something a test should do.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
	releaseTitle, releaseDescription, releaseAssets, resolveAssets, PACKAGE_NAME
} from '../src/release/gitlabRelease.js';
import { artifactName, metadataName, manifestName, SUMS_FILENAME } from '../src/release/metadata.js';
import { PUBLIC_KEY_FILENAME, signatureName } from '../src/release/signing.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the GitLab release object', function () {

	it('is named the way every earlier one was', function () {
		assert.strictEqual(releaseTitle('0.9.6a'), 'Canectic BBS v0.9.6a');
	});

	it('uses a stable package name, so asset URLs do not move between releases', function () {
		assert.strictEqual(PACKAGE_NAME, 'release-assets');
	});
});

describe('the description GitLab shows', function () {

	// GitLab prints the release name directly above the description, so keeping
	// the notes file's own H1 renders the version twice, the second time bigger
	// than the first.
	it('drops the notes file title', function () {
		var out = releaseDescription('# Canectic BBS v0.9.6a\n\n**A tagline.**\n\n## Highlights\n');
		assert.ok(out.indexOf('# Canectic BBS') === -1, 'the title survived');
		assert.ok(out.indexOf('**A tagline.**') === 0, 'got ' + JSON.stringify(out.slice(0, 40)));
	});

	it('keeps headings that are not the title', function () {
		var out = releaseDescription('# Title\n\nBody\n\n## Highlights\n\nMore\n');
		assert.match(out, /## Highlights/);
		assert.match(out, /More/);
	});

	it('leaves a file with no title alone', function () {
		assert.strictEqual(releaseDescription('Just body text.\n'), 'Just body text.\n');
	});

	it('survives empty input rather than throwing', function () {
		for (var v of ['', null, undefined]) assert.strictEqual(releaseDescription(v), '\n');
	});

	it('renders the real notes without the doubled title', function () {
		var notes = fs.readFileSync(path.join(ROOT, 'docs', 'releases', 'v0.9.6a.md'), 'utf8');
		var out = releaseDescription(notes);
		assert.ok(out.length > 1000, 'the notes came back nearly empty');
		assert.ok(!/^#\s/.test(out), 'it still starts with a title');
	});
});

describe('what gets attached', function () {

	it('is the archive, its sidecars, the signed checksums and the key', function () {
		assert.deepStrictEqual(releaseAssets('0.9.6a'), [
			artifactName('0.9.6a'),
			metadataName('0.9.6a'),
			manifestName('0.9.6a'),
			SUMS_FILENAME,
			signatureName(SUMS_FILENAME),
			PUBLIC_KEY_FILENAME
		]);
	});

	// bootstrap.sh defaults to fetching from the release host, so a copy
	// downloaded from a GitLab release page is a trap for as long as that host
	// is not serving. The archive on its own installs fine and the notes say how.
	it('does not include the bootstrap', function () {
		assert.ok(releaseAssets('0.9.6a').indexOf('bootstrap.sh') === -1);
	});

	it('names the delta archive for a development build', function () {
		var names = releaseAssets('0.9.6a.20260913', { delta: true });
		assert.ok(names[0].indexOf('.delta.zip') !== -1, 'got ' + names[0]);
	});

	it('reports an unsigned cut as a missing signature rather than a failure', function () {
		var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-gl-'));
		try {
			for (var n of releaseAssets('0.9.6a')) {
				if (n === signatureName(SUMS_FILENAME)) continue;
				fs.writeFileSync(path.join(dir, n), 'x');
			}
			var r = resolveAssets(dir, '0.9.6a');
			assert.deepStrictEqual(r.absent, [signatureName(SUMS_FILENAME)]);
			assert.strictEqual(r.present.length, 5);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('finds every one of them in the publish this release actually produced', function () {
		var dir = path.join(ROOT, 'dist', 'releases');
		if (!fs.existsSync(path.join(dir, artifactName('0.9.6a')))) return this.skip();
		var r = resolveAssets(dir, '0.9.6a');
		assert.deepStrictEqual(r.absent, [], 'the cut did not produce: ' + r.absent.join(', '));
	});
});
