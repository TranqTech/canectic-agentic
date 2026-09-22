// tests/releaseSums.test.js: SHA256SUMS and a signature that no longer fits it.
//
// A build that did not sign regenerated SHA256SUMS and left the previous
// SHA256SUMS.asc beside it. That signature covers the OLD list, so the release
// directory then carried a signature that fails to verify, which reads as
// tampering to anybody who checks. Found while building the rehearsal
// candidate on 2026-09-21. Unsigned is honest; stale is not.
//
// Run: npx mocha --no-config --exit tests/releaseSums.test.js

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSums } from '../scripts/release.mjs';

describe('writing SHA256SUMS', function () {
	var dir;
	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-sums-'));
		fs.writeFileSync(path.join(dir, 'canectic-1.0.0.zip'), 'artifact');
	});
	afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

	it('removes a signature over the previous list when this build is not signed', function () {
		fs.writeFileSync(path.join(dir, 'SHA256SUMS'), 'old list\n');
		fs.writeFileSync(path.join(dir, 'SHA256SUMS.asc'), '-----BEGIN PGP SIGNATURE-----\nold\n');
		writeSums(dir, null);
		assert.strictEqual(fs.existsSync(path.join(dir, 'SHA256SUMS.asc')), false,
			'a signature over the old list cannot vouch for the new one');
		assert.ok(/canectic-1\.0\.0\.zip/.test(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8')));
	});

	it('writes the list when there was never a signature', function () {
		writeSums(dir, null);
		assert.ok(fs.existsSync(path.join(dir, 'SHA256SUMS')));
		assert.strictEqual(fs.existsSync(path.join(dir, 'SHA256SUMS.asc')), false);
	});
});
