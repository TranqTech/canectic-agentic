// seasonalArt.js -- Seasonal/holiday art configuration.
//
// Manages date ranges that override the default art pool with seasonal
// variants. When today's date falls within an active season, the art
// resolver looks in {arttype}/{season_subdir}/ before falling back to
// the default {arttype}/ pool.
//
// Works for both terminal art (txtfiles/{format}/{arttype}/{season}/)
// and web art (txtfiles/webart/{arttype}/{season}/).

import * as fs from 'fs';
import * as path from 'path';
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

// Art format directories that need seasonal subdirectories
var ART_FORMATS = ['ans', 'asc', 'utf8', 'sixel', 'rip', 'webart'];

// Art type subdirectories
var ART_TYPES = ['screens', 'headers', 'logon', 'login', 'logoff', 'goodbye', 'register', 'welcome', 'misc', 'random'];

// Default seasons seeded on first run
var DEFAULT_SEASONS = [
	{ name: 'Christmas',  subdir: 'christmas',  start_month: 12, start_day: 15, end_month: 1,  end_day: 2,  active: true },
	{ name: 'Halloween',  subdir: 'halloween',  start_month: 10, start_day: 25, end_month: 10, end_day: 31, active: true },
	{ name: 'New Year',   subdir: 'newyear',    start_month: 1,  start_day: 1,  end_month: 1,  end_day: 3,  active: true }
];

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

async function ensureTable() {
	await postgres.write(`
		CREATE TABLE IF NOT EXISTS seasonal_art (
			id SERIAL PRIMARY KEY,
			name VARCHAR(64) NOT NULL,
			subdir VARCHAR(64) NOT NULL UNIQUE,
			start_month INTEGER NOT NULL,
			start_day INTEGER NOT NULL,
			end_month INTEGER NOT NULL,
			end_day INTEGER NOT NULL,
			active BOOLEAN DEFAULT true,
			sort_order INTEGER DEFAULT 0,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP
		)
	`);

	// Seed defaults if table is empty
	var count = await postgres.queryOne('SELECT COUNT(*) AS cnt FROM seasonal_art');
	if (count && parseInt(count.cnt) === 0) {
		for (var def of DEFAULT_SEASONS) {
			await postgres.insertObject({
				name: def.name,
				subdir: def.subdir,
				start_month: def.start_month,
				start_day: def.start_day,
				end_month: def.end_month,
				end_day: def.end_day,
				active: def.active,
				sort_order: 0,
				created_at: new Date()
			}, 'seasonal_art');
		}
		alogger.writeAlog(5, 'Seeded ' + DEFAULT_SEASONS.length + ' default seasonal art entries', 'greenbright');
	}
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getAllSeasons() {
	var rows = await postgres.query(
		'SELECT * FROM seasonal_art ORDER BY start_month ASC, start_day ASC',
		[]
	);
	return rows || [];
}

async function getActiveSeasons() {
	var rows = await postgres.query(
		'SELECT * FROM seasonal_art WHERE active = true ORDER BY start_month ASC, start_day ASC',
		[]
	);
	return rows || [];
}

async function getSeasonById(id) {
	return await postgres.queryOne('SELECT * FROM seasonal_art WHERE id = $1', [id]);
}

async function createSeason(data) {
	var result = { status: false, errormessages: [] };

	var name = (data.name || '').trim();
	var subdir = (data.subdir || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

	if (!name) result.errormessages.push('Name is required');
	if (!subdir) result.errormessages.push('Directory name is required');
	if (!data.start_month || !data.start_day) result.errormessages.push('Start date is required');
	if (!data.end_month || !data.end_day) result.errormessages.push('End date is required');
	if (result.errormessages.length > 0) return result;

	// Check unique subdir
	var existing = await postgres.queryOne('SELECT id FROM seasonal_art WHERE subdir = $1', [subdir]);
	if (existing) {
		result.errormessages.push('A season with that directory name already exists');
		return result;
	}

	var dbObj = {
		name: name,
		subdir: subdir,
		start_month: parseInt(data.start_month),
		start_day: parseInt(data.start_day),
		end_month: parseInt(data.end_month),
		end_day: parseInt(data.end_day),
		active: data.active !== 'false' && data.active !== false,
		sort_order: parseInt(data.sort_order) || 0,
		created_at: new Date()
	};

	var dbres = await postgres.insertObject(dbObj, 'seasonal_art');
	if (dbres.status) {
		result.status = true;
		result.insertId = dbres.insertId;

		// Create directories
		createSeasonDirectories(subdir);
		alogger.writeAlog(5, 'Seasonal art created: ' + name + ' (' + subdir + ')', 'greenbright');
	} else {
		result.errormessages = result.errormessages.concat(dbres.errormessages);
	}

	return result;
}

async function updateSeason(id, data) {
	var result = { status: false, errormessages: [] };

	var updates = {};
	if (data.name !== undefined) updates.name = (data.name || '').trim();
	if (data.start_month !== undefined) updates.start_month = parseInt(data.start_month);
	if (data.start_day !== undefined) updates.start_day = parseInt(data.start_day);
	if (data.end_month !== undefined) updates.end_month = parseInt(data.end_month);
	if (data.end_day !== undefined) updates.end_day = parseInt(data.end_day);
	if (data.active !== undefined) updates.active = data.active === 'true' || data.active === true || data.active === 'on';

	if (Object.keys(updates).length === 0) {
		result.errormessages.push('No changes');
		return result;
	}

	updates.updated_at = new Date();
	var count = await postgres.updateById(id, updates, 'seasonal_art');
	if (count > 0) {
		result.status = true;
	} else {
		result.errormessages.push('No rows updated');
	}

	return result;
}

async function deleteSeason(id, deleteDirectories) {
	var season = await getSeasonById(id);
	if (!season) return;

	await postgres.write('DELETE FROM seasonal_art WHERE id = $1', [id]);
	alogger.writeAlog(5, 'Seasonal art deleted: ' + season.name, 'cyan');

	if (deleteDirectories) {
		removeSeasonDirectories(season.subdir);
	}
}

// ---------------------------------------------------------------------------
// Season matching
// ---------------------------------------------------------------------------

// Get the active season(s) matching today's date.
// Returns array of matching seasons (usually 0 or 1, but could overlap).
function getActiveSeasonsForDate(seasons, month, day) {
	var matches = [];
	for (var s of seasons) {
		if (!s.active) continue;
		if (dateInRange(month, day, s.start_month, s.start_day, s.end_month, s.end_day)) {
			matches.push(s);
		}
	}
	return matches;
}

// Check if month/day falls within a start-end range.
// Handles year-wrapping (e.g. Dec 15 - Jan 2).
function dateInRange(month, day, startMonth, startDay, endMonth, endDay) {
	var start = startMonth * 100 + startDay;
	var end = endMonth * 100 + endDay;
	var current = month * 100 + day;

	if (start <= end) {
		// Same year range (e.g. Oct 25 - Oct 31)
		return current >= start && current <= end;
	} else {
		// Year-wrapping range (e.g. Dec 15 - Jan 2)
		return current >= start || current <= end;
	}
}

// Get the first matching season subdir for today, or null.
async function getCurrentSeasonSubdir() {
	var seasons = await getActiveSeasons();
	var now = new Date();
	var matches = getActiveSeasonsForDate(seasons, now.getMonth() + 1, now.getDate());
	return matches.length > 0 ? matches[0].subdir : null;
}

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

function createSeasonDirectories(subdir) {
	var textdir = appConfig.get('textdir', 'txtfiles');

	for (var fmt of ART_FORMATS) {
		for (var artType of ART_TYPES) {
			var dirPath = path.join(textdir, fmt, artType, subdir);
			try {
				fs.mkdirSync(dirPath, { recursive: true });
			} catch (_) {}
		}
	}

	alogger.writeAlog(5, 'Created seasonal art directories for: ' + subdir, 'cyan');
}

function removeSeasonDirectories(subdir) {
	var textdir = appConfig.get('textdir', 'txtfiles');
	var removed = 0;

	for (var fmt of ART_FORMATS) {
		for (var artType of ART_TYPES) {
			var dirPath = path.join(textdir, fmt, artType, subdir);
			try {
				// Only remove if empty
				var contents = fs.readdirSync(dirPath);
				if (contents.length === 0) {
					fs.rmdirSync(dirPath);
					removed++;
				} else {
					alogger.writeAlog(5, 'Seasonal dir not empty, keeping: ' + dirPath, 'yellow');
				}
			} catch (_) {}
		}
	}

	alogger.writeAlog(5, 'Removed ' + removed + ' empty seasonal art directories for: ' + subdir, 'cyan');
}

// Create all standard art directories (called by setup/bootstrap).
function ensureArtDirectories() {
	var textdir = appConfig.get('textdir', 'txtfiles');

	for (var fmt of ART_FORMATS) {
		for (var artType of ART_TYPES) {
			var dirPath = path.join(textdir, fmt, artType);
			try {
				fs.mkdirSync(dirPath, { recursive: true });
			} catch (_) {}
		}
	}
}

// ---------------------------------------------------------------------------
// Cached sync accessor for terminal use
// ---------------------------------------------------------------------------

var _cachedSeasons = null;
var _cacheTime = 0;
var CACHE_TTL_MS = 300000; // 5 minutes

// Synchronous: returns the current season subdir or null.
// Uses a 5-minute cache of the DB data. Call refreshSeasonCache() at
// startup or after admin changes to prime it.
function getCurrentSeasonSubdirSync() {
	if (!_cachedSeasons || (Date.now() - _cacheTime) > CACHE_TTL_MS) {
		return null; // Cache expired or not primed -- no seasonal override
	}
	var now = new Date();
	var matches = getActiveSeasonsForDate(_cachedSeasons, now.getMonth() + 1, now.getDate());
	return matches.length > 0 ? matches[0].subdir : null;
}

async function refreshSeasonCache() {
	_cachedSeasons = await getActiveSeasons();
	_cacheTime = Date.now();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	ensureTable,
	getAllSeasons,
	getActiveSeasons,
	getSeasonById,
	createSeason,
	updateSeason,
	deleteSeason,
	getActiveSeasonsForDate,
	dateInRange,
	getCurrentSeasonSubdir,
	getCurrentSeasonSubdirSync,
	refreshSeasonCache,
	createSeasonDirectories,
	removeSeasonDirectories,
	ensureArtDirectories,
	ART_FORMATS,
	ART_TYPES
};
