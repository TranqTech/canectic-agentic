// tests/releaseOrchestration.test.js: the few lines between "the suite passed"
// and "the artifact exists".
//
// This file exists because release.mjs used to say its orchestration was the
// part a test cannot usefully assert, and two bugs in one evening said
// otherwise. Both landed in the same window: after the changelog had been
// closed, the pending declarations cleared, package.json bumped and the release
// committed, and before anything had been built. That is the worst place in the
// program to be wrong, because undoing it is a reset and a tag deletion rather
// than a retry.
//
// The second one is the subject here. The tag call was given inherited stdio so
// the passphrase prompt would reach the terminal, and execFileSync returns null
// for stdout when it is not capturing. The git helper trimmed the result
// unconditionally, so a `git tag -s` that SUCCEEDED, and produced a correctly
// signed tag, raised "Cannot read properties of null" on the line after it.
//
// Importing release.mjs runs no release: main() is guarded on the file being
// the program.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { git } from '../scripts/release.mjs';

describe('the git helper the release script runs everything through', function () {
	this.timeout(20000);

	it('returns the output of a command whose output is captured', function () {
		var head = git(['rev-parse', 'HEAD']);
		assert.match(head, /^[0-9a-f]{40}$/, 'got ' + JSON.stringify(head));
	});

	// The bug. Node hands back null rather than a string when stdio is
	// inherited, so anything that trims the result turns success into a crash.
	it('survives a command whose output was NOT captured', function () {
		var out;
		assert.doesNotThrow(function () {
			out = git(['rev-parse', '--git-dir'], { stdio: 'inherit' });
		}, 'a successful git command raised because its output went to the terminal');
		assert.strictEqual(out, '', 'expected an empty string rather than null');
	});

	it('still throws when the command actually fails', function () {
		assert.throws(function () {
			git(['rev-parse', '--verify', 'refs/heads/a-branch-that-does-not-exist']);
		});
	});
});

// The first of the two bugs was that a signing failure was discovered after the
// repository had been written to. The probe that fixes it is tested in
// releaseSigning.test.js; what is asserted here is the ordering it depends on,
// namely that a real signed tag can be made and read back without the prompt
// needing inherited stdio. pinentry draws on the terminal named by GPG_TTY
// rather than on git's stdio, which is what makes capturing safe.
describe('signing a tag without inheriting stdio', function () {
	this.timeout(30000);

	var repo, home, fpr;

	before(function () {
		try { execFileSync('gpg', ['--version'], { stdio: 'ignore' }); }
		catch (e) { this.skip(); }

		home = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-tagkey-'));
		fs.chmodSync(home, 0o700);
		fs.writeFileSync(path.join(home, 'gpg-agent.conf'), 'allow-loopback-pinentry\n');
		var env = Object.assign({}, process.env, { GNUPGHOME: home });
		execFileSync('gpg', ['--batch', '--passphrase', '', '--pinentry-mode', 'loopback',
			'--quick-generate-key', 'Tag Test <tag@example.invalid>', 'ed25519', 'sign', '1y'],
			{ env: env, stdio: 'ignore' });
		fpr = execFileSync('gpg', ['--list-keys', '--with-colons'], { env: env, encoding: 'utf8' })
			.split('\n').filter(function (l) { return l.indexOf('fpr:') === 0; })[0].split(':')[9];

		repo = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-tagrepo-'));
		var g = function (args) {
			execFileSync('git', ['-C', repo].concat(args), { env: env, stdio: 'ignore' });
		};
		g(['init', '-q']);
		g(['config', 'user.email', 'tag@example.invalid']);
		g(['config', 'user.name', 'Tag Test']);
		fs.writeFileSync(path.join(repo, 'f'), 'x\n');
		g(['add', 'f']);
		g(['commit', '-q', '-m', 'x']);
	});

	after(function () {
		for (var d of [repo, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
	});

	it('produces a tag that verifies, with the output captured', function () {
		var env = Object.assign({}, process.env, { GNUPGHOME: home });
		var out = execFileSync('git', ['-C', repo, 'tag', '-s', '-u', fpr, 'v1', '-m', 'v1'],
			{ env: env, encoding: 'utf8' });
		assert.ok(out === '' || typeof out === 'string', 'captured output should be a string');

		var verified = execFileSync('git', ['-C', repo, 'tag', '-v', 'v1'],
			{ env: env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		assert.match(String(verified), /Tag Test/);
	});
});
