// tests/newSince.test.js — files are "new" since the start of your previous visit.
//
// Replaces the per-area read pointer (user_file_pointers) that the web area
// page, the JSON listing, the terminal browser's cursor and its M(ark read)
// key all moved forward. The baseline is the previous visit's start, captured
// BEFORE updateUserCalls overwrites users.lastlogon: session.prev_logon on the
// web (at login, registration and idle resume) and call.prev_logon on a
// terminal. Read afterwards, lastlogon is this visit's start and nothing would
// ever be new.
//
// Run: npx mocha --no-config --exit tests/newSince.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newSinceMs, isNewSince } from '../src/utils/newSince.js';
import { buildSessionData } from '../src/models/useraccounts.js';
import { forCall } from '../src/models/newFilesBaseline.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

describe('newSinceMs', function () {
	var LAST = new Date('2026-09-20T12:00:00Z');
	var MADE = new Date('2026-01-01T00:00:00Z');

	it('is the previous login when there is one', function () {
		assert.strictEqual(newSinceMs(LAST, MADE), LAST.getTime());
		assert.strictEqual(newSinceMs(LAST.toISOString(), MADE), LAST.getTime());
		assert.strictEqual(newSinceMs(String(LAST.getTime()), MADE), LAST.getTime());
	});

	it('falls back to when the account was made, so a new user is not shown everything', function () {
		assert.strictEqual(newSinceMs(null, MADE), MADE.getTime());
		assert.strictEqual(newSinceMs('', MADE), MADE.getTime());
	});

	it('is 0 only for a record with neither', function () {
		assert.strictEqual(newSinceMs(null, null), 0);
		assert.strictEqual(newSinceMs('not a date', undefined), 0);
	});
});

describe('isNewSince', function () {
	var SINCE = Date.parse('2026-09-20T12:00:00Z');
	it('is after the baseline, not at it', function () {
		assert.strictEqual(isNewSince('2026-09-20T12:00:01Z', SINCE), true);
		assert.strictEqual(isNewSince('2026-09-20T12:00:00Z', SINCE), false);
		assert.strictEqual(isNewSince(new Date('2026-09-25T00:00:00Z'), SINCE), true);
		assert.strictEqual(isNewSince(null, SINCE), false);
	});
});

describe('where the baseline comes from', function () {
	it('a web session carries the previous login, from before updateUserCalls', function () {
		var s = buildSessionData({ id: 1, username: 'A', lastlogon: new Date('2026-09-20T12:00:00Z'), created_at: new Date('2026-01-01T00:00:00Z') });
		assert.strictEqual(Number(s.prev_logon), Date.parse('2026-09-20T12:00:00Z'));
	});

	it('a terminal call uses call.prev_logon, else the record it logged in with', function () {
		assert.strictEqual(forCall({ prev_logon: 5000 }).getTime(), 5000);
		assert.strictEqual(forCall({ user_record: { lastlogon: '2026-09-20T12:00:00Z' } }).getTime(), Date.parse('2026-09-20T12:00:00Z'));
	});

	it('is captured before lastlogon is overwritten, at every place a visit starts', function () {
		var login = read('src/handlers/loginhandler.js');
		assert.ok(login.indexOf('this.call.prev_logon') < login.indexOf('updateUserCalls(useraccount)'), 'terminal: before updateUserCalls');
		var web = read('src/middleware/webActivity.js');
		assert.ok(web.indexOf('prev_logon') > 0 && web.indexOf('prev_logon') < web.indexOf('updateUserCalls(user)'), 'idle resume: before updateUserCalls');
	});
});

describe('nothing moves a pointer any more', function () {
	var consumers = [
		'src/routes/files.js', 'src/routes/callflow.js',
		'src/handlers/menucommands/fileBrowser.js', 'src/handlers/menucommands/fileAreaSelector.js',
		'src/handlers/menucommands/fileNewscan.js'
	];
	consumers.forEach(function (rel) {
		it(rel + ' uses the since-login rule, not user_file_pointers', function () {
			var src = read(rel);
			assert.doesNotMatch(src, /userFilePointers/);
			assert.match(src, /newFilesBaseline/);
		});
	});

	it('the terminal file browser has no Mark Read any more', function () {
		var src = read('src/handlers/menucommands/fileBrowser.js');
		assert.doesNotMatch(src, /Mark Read|mark read|_markAreaRead/);
	});
});
