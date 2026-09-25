// logRotation.js — daily log rotation for logs/<env>/.
//
// Nothing trimmed the log files before this: alogger appends to system.log,
// mailer.log, tosser.log, tic.log and the rest for ever, and pm2 appends to
// the *-out.log / *-error.log files named in ecosystem.config.cjs. The hub's
// mailer.log alone reached 9.7 MB.
//
// Once a day each non-empty *.log at the top of the log directory moves to
//
//   logs/<env>/archive/YYYY-MM-DD/<name>.log.gz
//
// dated by the local day the rotation ran, and archive days older than the
// retention window are deleted. The job is scheduled for 23:59 so the day on
// the directory is the day its contents cover.
//
// Two ways to take a file, because two kinds of writer hold them:
//
//   rename        alogger opens its file by path on every write, so a file
//                 renamed away is simply recreated by the next line. Atomic;
//                 nothing is lost.
//   copytruncate  pm2 holds its out/error files open for the life of the
//                 daemon. Renamed, pm2 would go on writing into the archive.
//                 So the file is copied and then truncated in place, and a
//                 line written between the two is lost. pm2 opens them in
//                 append mode, so writes after the truncate land at the start
//                 rather than leaving a hole.
//
// Which is which is decided from the name, `-out.log` / `-error.log`, the
// names ecosystem.config.cjs gives pm2; tests/logRotation.test.js fails if
// the two ever disagree.
//
// The rules are pure and exported; rotateLogs() is the part that touches disk
// and isolates each file, so one it cannot read does not stop the rest.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';

export var ARCHIVE_DIR = 'archive';

var DAY_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// How a log file must be taken, from its name.
export function rotationMethod(filename) {
	return /-(out|error)\.log$/.test(filename) ? 'copytruncate' : 'rename';
}

// Whether a directory entry is a log this job rotates.
export function isRotatableLog(filename) {
	return typeof filename === 'string' && filename.endsWith('.log') && !filename.startsWith('.');
}

// The local calendar day, as the archive directory name.
export function dayLabel(date) {
	var d = date instanceof Date ? date : new Date(date);
	var mm = String(d.getMonth() + 1).padStart(2, '0');
	var dd = String(d.getDate()).padStart(2, '0');
	return d.getFullYear() + '-' + mm + '-' + dd;
}

// The name a log gets inside its day's archive directory. A second rotation
// the same day (run by hand, say) must not overwrite the first, so a taken
// name gets .2, .3 before the extension.
export function archiveName(filename, taken) {
	var have = new Set(taken || []);
	var base = filename.replace(/\.log$/, '');
	var name = base + '.log.gz';
	for (var n = 2; have.has(name); n++) {
		name = base + '.' + n + '.log.gz';
	}
	return name;
}

// Which archive day directories are past retention. A day is kept while it
// is within `retentionDays` whole days of today, so 30 keeps today and the 30
// before it. 0 or less keeps everything. Anything not named like a day is
// never a candidate: it is not ours.
export function expiredDays(dirNames, now, retentionDays) {
	var days = Number(retentionDays);
	if (!Number.isFinite(days) || days <= 0) return [];
	var today = new Date(now);
	var cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
	var expired = [];
	for (var name of dirNames || []) {
		var m = DAY_DIR_RE.exec(name);
		if (!m) continue;
		var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
		if (day < cutoff) expired.push(name);
	}
	return expired.sort();
}

async function gzipTo(readStream, destPath) {
	var tmp = destPath + '.partial';
	try {
		await pipeline(readStream, zlib.createGzip(), fs.createWriteStream(tmp));
		await fs.promises.rename(tmp, destPath);
	} catch (err) {
		await fs.promises.rm(tmp, { force: true });
		throw err;
	}
}

async function rotateOne(logDir, dayDir, filename, taken) {
	var src = path.join(logDir, filename);
	var stat = await fs.promises.stat(src);
	if (!stat.isFile() || stat.size === 0) return null;

	var method = rotationMethod(filename);
	var outName = archiveName(filename, taken);
	var dest = path.join(dayDir, outName);

	if (method === 'rename') {
		// Move first, compress after: the writer starts a fresh file the
		// moment the rename lands, however long compressing takes.
		var moved = path.join(dayDir, '.' + filename + '.' + process.pid + '.rotating');
		await fs.promises.rename(src, moved);
		try {
			await gzipTo(fs.createReadStream(moved), dest);
		} catch (err) {
			// Keep the uncompressed copy rather than lose the log.
			await fs.promises.rename(moved, path.join(dayDir, outName.replace(/\.gz$/, '')));
			throw err;
		}
		await fs.promises.rm(moved, { force: true });
	} else {
		// Copy what is there now, then cut the file back. Reading to the size
		// seen at stat keeps a line being written mid-copy out of the archive
		// half-finished; it is lost with the truncate instead (see header).
		await gzipTo(fs.createReadStream(src, { start: 0, end: stat.size - 1 }), dest);
		await fs.promises.truncate(src, 0);
	}
	taken.push(outName);
	return { file: filename, archived: path.relative(logDir, dest), bytes: stat.size, method: method };
}

/**
 * Rotate every log in `logDir` into today's archive directory and delete
 * archive days past retention.
 *
 * @param {object} opts
 * @param {string} opts.logDir
 * @param {number} opts.retentionDays - 0 keeps every archive
 * @param {Date}   [opts.now]
 * @param {boolean} [opts.dryRun] - report what would happen, change nothing
 * @returns {Promise<{rotated: object[], removed: string[], errors: object[], archiveDir: string}>}
 */
export async function rotateLogs(opts) {
	var logDir = opts.logDir;
	var now = opts.now || new Date();
	var result = { rotated: [], removed: [], errors: [], archiveDir: null };

	var archiveRoot = path.join(logDir, ARCHIVE_DIR);
	var dayDir = path.join(archiveRoot, dayLabel(now));
	result.archiveDir = path.relative(logDir, dayDir);

	var entries;
	try {
		entries = await fs.promises.readdir(logDir);
	} catch (err) {
		if (err.code === 'ENOENT') return result;
		throw err;
	}

	var logs = entries.filter(isRotatableLog).sort();

	if (opts.dryRun) {
		for (var name of logs) {
			try {
				var st = await fs.promises.stat(path.join(logDir, name));
				if (st.isFile() && st.size > 0) {
					result.rotated.push({ file: name, bytes: st.size, method: rotationMethod(name) });
				}
			} catch (err) {
				result.errors.push({ file: name, error: err.message });
			}
		}
	} else {
		if (logs.length > 0) await fs.promises.mkdir(dayDir, { recursive: true });
		var taken = [];
		try { taken = await fs.promises.readdir(dayDir); } catch (_) { taken = []; }
		for (var file of logs) {
			try {
				var done = await rotateOne(logDir, dayDir, file, taken);
				if (done) result.rotated.push(done);
			} catch (err) {
				result.errors.push({ file: file, error: err.message });
			}
		}
	}

	var dayDirs = [];
	try { dayDirs = await fs.promises.readdir(archiveRoot); } catch (_) { dayDirs = []; }
	for (var day of expiredDays(dayDirs, now, opts.retentionDays)) {
		if (!opts.dryRun) {
			try {
				await fs.promises.rm(path.join(archiveRoot, day), { recursive: true, force: true });
			} catch (err) {
				result.errors.push({ file: path.join(ARCHIVE_DIR, day), error: err.message });
				continue;
			}
		}
		result.removed.push(path.join(ARCHIVE_DIR, day));
	}

	return result;
}
