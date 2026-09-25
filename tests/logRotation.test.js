// tests/logRotation.test.js — daily log rotation, and the TIC log it rotates.
//
// Nothing trimmed logs/<env>/ before: every file grew for ever. rotateLogs()
// moves each non-empty *.log into archive/YYYY-MM-DD/ gzipped and deletes
// archive days past retention. Two ways of taking a file, because pm2 holds
// its out/error files open while alogger reopens by path on every write; the
// wrong one for pm2 means pm2 carries on writing into the archive.
//
// Also here: alogger writing one line to two files, which is how the TIC log
// keeps its failures in the system log too.
//
// Run: npx mocha --no-config --exit tests/logRotation.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
	rotationMethod, isRotatableLog, dayLabel, archiveName, expiredDays, rotateLogs, ARCHIVE_DIR
} from '../src/maintenance/logRotation.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gunzip(file) {
	return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
}

describe('log rotation rules', function () {

	it('copies and truncates what pm2 holds open, renames what alogger writes', function () {
		assert.strictEqual(rotationMethod('gateway-out.log'), 'copytruncate');
		assert.strictEqual(rotationMethod('worker-error.log'), 'copytruncate');
		assert.strictEqual(rotationMethod('system.log'), 'rename');
		assert.strictEqual(rotationMethod('tic.log'), 'rename');
		assert.strictEqual(rotationMethod('security.log'), 'rename');
	});

	it('agrees with the files ecosystem.config.cjs gives pm2', function () {
		// A pm2 file taken by rename is written into the archive until pm2
		// restarts, so every out/error file pm2 is told to use must read as
		// copytruncate.
		var require = createRequire(import.meta.url);
		var eco = require(path.join(ROOT, 'ecosystem.config.cjs'));
		var files = [];
		for (var app of eco.apps || []) {
			if (app.out_file) files.push(path.basename(app.out_file));
			if (app.error_file) files.push(path.basename(app.error_file));
		}
		assert.ok(files.length > 0, 'expected ecosystem.config.cjs to name pm2 log files');
		for (var f of files) {
			assert.strictEqual(rotationMethod(f), 'copytruncate', f + ' is held open by pm2');
		}
	});

	it('rotates only .log files at the top level', function () {
		assert.ok(isRotatableLog('mailer.log'));
		assert.ok(!isRotatableLog('archive'));
		assert.ok(!isRotatableLog('notes.txt'));
		assert.ok(!isRotatableLog('.system.log.123.rotating'));
	});

	it('dates by the local day', function () {
		assert.strictEqual(dayLabel(new Date(2026, 8, 5, 23, 59)), '2026-09-05');
	});

	it('does not overwrite an earlier rotation the same day', function () {
		assert.strictEqual(archiveName('system.log', []), 'system.log.gz');
		assert.strictEqual(archiveName('system.log', ['system.log.gz']), 'system.2.log.gz');
		assert.strictEqual(archiveName('system.log', ['system.log.gz', 'system.2.log.gz']), 'system.3.log.gz');
	});

	it('expires days past retention and keeps the window', function () {
		var now = new Date(2026, 8, 25, 23, 59);
		var dirs = ['2026-08-25', '2026-08-26', '2026-09-24', '2026-09-25', 'keep-me', '2026-8-1'];
		// 30 days keeps today and the 30 before it: 08-26 onwards.
		assert.deepStrictEqual(expiredDays(dirs, now, 30), ['2026-08-25']);
	});

	it('keeps everything when retention is 0', function () {
		assert.deepStrictEqual(expiredDays(['2000-01-01'], new Date(), 0), []);
	});
});

describe('rotateLogs', function () {
	var dir;
	var now = new Date(2026, 8, 25, 23, 59);

	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-logrot-'));
	});
	afterEach(function () {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('moves an alogger log into the day archive, gzipped, and leaves no file behind', async function () {
		fs.writeFileSync(path.join(dir, 'system.log'), 'line one\nline two\n');
		var r = await rotateLogs({ logDir: dir, now: now, retentionDays: 30 });
		assert.deepStrictEqual(r.errors, []);
		assert.ok(!fs.existsSync(path.join(dir, 'system.log')), 'the next write starts a fresh file');
		var gz = path.join(dir, ARCHIVE_DIR, '2026-09-25', 'system.log.gz');
		assert.strictEqual(gunzip(gz), 'line one\nline two\n');
		assert.deepStrictEqual(fs.readdirSync(path.join(dir, ARCHIVE_DIR, '2026-09-25')), ['system.log.gz']);
	});

	it('copies and empties a pm2 log in place', async function () {
		fs.writeFileSync(path.join(dir, 'gateway-out.log'), 'pm2 says hello\n');
		var r = await rotateLogs({ logDir: dir, now: now, retentionDays: 30 });
		assert.deepStrictEqual(r.errors, []);
		assert.strictEqual(fs.statSync(path.join(dir, 'gateway-out.log')).size, 0, 'same file, emptied');
		assert.strictEqual(gunzip(path.join(dir, ARCHIVE_DIR, '2026-09-25', 'gateway-out.log.gz')), 'pm2 says hello\n');
	});

	it('skips empty logs and rotates twice in a day without losing the first', async function () {
		fs.writeFileSync(path.join(dir, 'tic.log'), 'first\n');
		fs.writeFileSync(path.join(dir, 'empty.log'), '');
		await rotateLogs({ logDir: dir, now: now, retentionDays: 30 });
		fs.writeFileSync(path.join(dir, 'tic.log'), 'second\n');
		var r = await rotateLogs({ logDir: dir, now: now, retentionDays: 30 });
		var day = path.join(dir, ARCHIVE_DIR, '2026-09-25');
		assert.deepStrictEqual(fs.readdirSync(day).sort(), ['tic.2.log.gz', 'tic.log.gz']);
		assert.strictEqual(gunzip(path.join(day, 'tic.log.gz')), 'first\n');
		assert.strictEqual(gunzip(path.join(day, 'tic.2.log.gz')), 'second\n');
		assert.ok(fs.existsSync(path.join(dir, 'empty.log')), 'an empty log is left alone');
		assert.strictEqual(r.rotated.length, 1);
	});

	it('removes expired archive days and nothing it did not make', async function () {
		fs.mkdirSync(path.join(dir, ARCHIVE_DIR, '2026-01-01'), { recursive: true });
		fs.writeFileSync(path.join(dir, ARCHIVE_DIR, '2026-01-01', 'system.log.gz'), 'x');
		fs.mkdirSync(path.join(dir, ARCHIVE_DIR, 'sysop-notes'), { recursive: true });
		var r = await rotateLogs({ logDir: dir, now: now, retentionDays: 30 });
		assert.deepStrictEqual(r.removed, [path.join(ARCHIVE_DIR, '2026-01-01')]);
		assert.ok(!fs.existsSync(path.join(dir, ARCHIVE_DIR, '2026-01-01')));
		assert.ok(fs.existsSync(path.join(dir, ARCHIVE_DIR, 'sysop-notes')));
	});

	it('changes nothing on a dry run', async function () {
		fs.writeFileSync(path.join(dir, 'system.log'), 'keep\n');
		fs.mkdirSync(path.join(dir, ARCHIVE_DIR, '2026-01-01'), { recursive: true });
		var r = await rotateLogs({ logDir: dir, now: now, retentionDays: 30, dryRun: true });
		assert.strictEqual(r.rotated.length, 1);
		assert.strictEqual(r.removed.length, 1);
		assert.strictEqual(fs.readFileSync(path.join(dir, 'system.log'), 'utf8'), 'keep\n');
		assert.ok(fs.existsSync(path.join(dir, ARCHIVE_DIR, '2026-01-01')));
		assert.ok(!fs.existsSync(path.join(dir, ARCHIVE_DIR, '2026-09-25')));
	});

	it('returns empty for a log directory that does not exist yet', async function () {
		var r = await rotateLogs({ logDir: path.join(dir, 'nope'), now: now, retentionDays: 30 });
		assert.deepStrictEqual(r.rotated, []);
	});
});

describe('alogger writing one line to two files', function () {
	var dir;
	before(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-alog-'));
	});
	after(function () {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('puts the line in each named log, null meaning the system log', function () {
		// A child process, because alogger fixes its log path and mode from the
		// environment when it is first imported.
		var alogger = path.join(ROOT, 'src/utils/alogger.js');
		execFileSync(process.execPath, ['--input-type=module', '-e',
			'const a = await import(' + JSON.stringify(alogger) + ');' +
			'await a.writeAlog(2, "both", null, false, ["tic", null]);' +
			'await a.writeAlog(2, "tic only", null, false, "tic");'
		], { cwd: dir, env: Object.assign({}, process.env, { NODE_ENV: 'production', loglevel: '3', logtoconsole: '' }) });
		var logDir = path.join(dir, 'logs', 'production');
		var tic = fs.readFileSync(path.join(logDir, 'tic.log'), 'utf8');
		var sys = fs.readFileSync(path.join(logDir, 'system.log'), 'utf8');
		assert.match(tic, /- both/);
		assert.match(tic, /- tic only/);
		assert.match(sys, /- both/);
		assert.doesNotMatch(sys, /tic only/);
	});
});
