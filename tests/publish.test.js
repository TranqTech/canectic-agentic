// tests/publish.test.js: what scripts/publish.mjs sends to the release host.
//
// Most of what can go wrong here is quiet. A release note sent under the name
// the repository uses (v0.9.6a.md) is published and never shown, because the
// site looks notes up by the index's version, which has no v. A working file
// beside the notes (v0.9.6a-changes.md) sent by a looser match becomes a public
// page. And a --delete on the release rsync removes old stables from the host,
// which breaks every development build that deltas against them, without an
// error anywhere at publish time.
//
// Importing publish.mjs publishes nothing: main() is guarded on the file being
// the program, as in release.mjs.

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { publishedVersions, notesPlan, checkSums, rsyncCommands } from '../scripts/publish.mjs';

function index(channel, versions) {
	return JSON.stringify({
		index_version: 1,
		channel: channel,
		releases: versions.map(function (v) { return { version: v, artifact: 'canectic-' + v + '.zip' }; })
	});
}

describe('publish: which versions are published', function () {
	it('collects every version across the channel indexes, oldest first, once each', function () {
		var got = publishedVersions([
			index('stable', ['0.9.6a', '0.9.5a']),
			index('development', ['0.9.6a.20260918', '0.9.6a.20260917'])
		]);
		assert.deepStrictEqual(got, ['0.9.5a', '0.9.6a', '0.9.6a.20260917', '0.9.6a.20260918']);
	});

	it('refuses an index that is not one', function () {
		assert.throws(function () { publishedVersions(['<html>404</html>']); }, /not valid JSON/);
	});
});

describe('publish: release notes', function () {
	var inRepo = ['pending.json', 'v0.9.0-alpha.1.md', 'v0.9.1-alpha.1.md', 'v0.9.5a.md', 'v0.9.6a-changes.md', 'v0.9.6a.md'];

	it('sends v<version>.md as <version>.md, the name the site looks up', function () {
		assert.deepStrictEqual(notesPlan(['0.9.6a'], inRepo), [{ version: '0.9.6a', from: 'v0.9.6a.md', to: '0.9.6a.md' }]);
	});

	it('never sends the working file that sits beside the notes', function () {
		var sent = notesPlan(['0.9.5a', '0.9.6a'], inRepo).map(function (n) { return n.from; });
		assert.deepStrictEqual(sent, ['v0.9.5a.md', 'v0.9.6a.md']);
	});

	it('sends notes only for versions an index publishes', function () {
		assert.deepStrictEqual(notesPlan([], inRepo), []);
		assert.strictEqual(notesPlan(['0.9.6a'], inRepo).some(function (n) { return n.version === '0.9.5a'; }), false);
	});

	it('skips a published version that has no notes', function () {
		assert.deepStrictEqual(notesPlan(['0.9.6a.20260918'], inRepo), []);
	});
});

describe('publish: checking the local set before sending it', function () {
	var dir;

	function write(name, text) { fs.writeFileSync(path.join(dir, name), text); }
	function sums(names) {
		write('SHA256SUMS', names.map(function (n) {
			return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex') + '  ' + n;
		}).join('\n') + '\n');
	}

	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-test-'));
		write('canectic-0.9.6a.zip', 'zip bytes');
		write('index-stable.json', index('stable', ['0.9.6a']));
		sums(['canectic-0.9.6a.zip', 'index-stable.json']);
		write('SHA256SUMS.asc', 'signature');
	});

	afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

	it('passes a set that matches its list', function () {
		assert.deepStrictEqual(checkSums(dir), []);
	});

	it('refuses a file that changed after the cut', function () {
		write('canectic-0.9.6a.zip', 'other bytes');
		assert.deepStrictEqual(checkSums(dir), ['canectic-0.9.6a.zip does not match its checksum']);
	});

	it('refuses a listed file that is missing', function () {
		fs.unlinkSync(path.join(dir, 'index-stable.json'));
		assert.deepStrictEqual(checkSums(dir), ['index-stable.json is listed but missing']);
	});

	it('refuses a file the list does not vouch for', function () {
		write('notes.txt', 'dropped in by hand');
		assert.deepStrictEqual(checkSums(dir), ['notes.txt is not in SHA256SUMS']);
	});

	it('refuses a directory with no list at all', function () {
		fs.unlinkSync(path.join(dir, 'SHA256SUMS'));
		assert.match(checkSums(dir)[0], /^no SHA256SUMS in /);
	});
});

describe('publish: the rsync commands', function () {
	var opts = { host: 'canectic-release', root: 'site/canectic', releasesDir: '/repo/dist/releases', docsStage: '/tmp/stage', dryRun: false };

	it('never deletes anything on the host', function () {
		for (var dryRun of [false, true]) {
			for (var args of rsyncCommands(Object.assign({}, opts, { dryRun: dryRun }))) {
				var deleting = args.filter(function (a) { return /^--(del|delete|remove|prune)/.test(a); });
				assert.deepStrictEqual(deleting, [], 'rsync ' + args.join(' '));
			}
		}
	});

	it('sends releases and docs to their own directories', function () {
		var cmds = rsyncCommands(opts);
		assert.deepStrictEqual(cmds.map(function (a) { return a.slice(-2); }), [
			['/repo/dist/releases/', 'canectic-release:site/canectic/releases/'],
			['/tmp/stage/', 'canectic-release:site/canectic/docs/']
		]);
	});

	it('does not carry the staging directory mode onto the docs directory', function () {
		var docs = rsyncCommands(opts)[1];
		assert.strictEqual(docs.some(function (a) { return /^-[a-zA-Z]*a/.test(a) || a === '--perms'; }), false, docs.join(' '));
	});

	it('marks every command in a dry run', function () {
		for (var args of rsyncCommands(Object.assign({}, opts, { dryRun: true }))) assert.ok(args.indexOf('--dry-run') >= 0);
	});

	it('sends only the docs when there is nothing cut here', function () {
		var cmds = rsyncCommands(Object.assign({}, opts, { releasesDir: null }));
		assert.strictEqual(cmds.length, 1);
		assert.strictEqual(cmds[0][cmds[0].length - 1], 'canectic-release:site/canectic/docs/');
	});
});
