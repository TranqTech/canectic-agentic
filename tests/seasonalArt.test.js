// tests/seasonalArt.test.js -- Unit tests for src/models/seasonalArt.js
//
// Tests cover the two exported pure functions (dateInRange, getActiveSeasonsForDate)
// and the exported constants (ART_FORMATS, ART_TYPES).  All DB-dependent exports
// are imported but not exercised here -- no postgres or redis connection required.

import assert from 'assert';
import {
	dateInRange,
	getActiveSeasonsForDate,
	ART_FORMATS,
	ART_TYPES,
	ensureTable,
	getAllSeasons,
	getActiveSeasons,
	getSeasonById,
	createSeason,
	updateSeason,
	deleteSeason,
	getCurrentSeasonSubdir,
	getCurrentSeasonSubdirSync,
	refreshSeasonCache,
	createSeasonDirectories,
	removeSeasonDirectories,
	ensureArtDirectories
} from '../src/models/seasonalArt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSeason(overrides) {
	return Object.assign({
		id: 1,
		name: 'Test Season',
		subdir: 'test',
		start_month: 10,
		start_day: 25,
		end_month: 10,
		end_day: 31,
		active: true,
		sort_order: 0
	}, overrides);
}

// ---------------------------------------------------------------------------
// Export validation
// ---------------------------------------------------------------------------

describe('seasonalArt exports', function () {
	it('should export dateInRange as a function', function () {
		assert.strictEqual(typeof dateInRange, 'function');
	});

	it('should export getActiveSeasonsForDate as a function', function () {
		assert.strictEqual(typeof getActiveSeasonsForDate, 'function');
	});

	it('should export ART_FORMATS as an array', function () {
		assert.ok(Array.isArray(ART_FORMATS));
	});

	it('should export ART_TYPES as an array', function () {
		assert.ok(Array.isArray(ART_TYPES));
	});

	var DB_EXPORTS = [
		'ensureTable', 'getAllSeasons', 'getActiveSeasons', 'getSeasonById',
		'createSeason', 'updateSeason', 'deleteSeason',
		'getCurrentSeasonSubdir', 'getCurrentSeasonSubdirSync', 'refreshSeasonCache',
		'createSeasonDirectories', 'removeSeasonDirectories', 'ensureArtDirectories'
	];

	for (var exportName of DB_EXPORTS) {
		// Capture loop variable for closure
		(function (name) {
			it('should export ' + name + ' as a function', function () {
				var exports = {
					ensureTable, getAllSeasons, getActiveSeasons, getSeasonById,
					createSeason, updateSeason, deleteSeason,
					getCurrentSeasonSubdir, getCurrentSeasonSubdirSync, refreshSeasonCache,
					createSeasonDirectories, removeSeasonDirectories, ensureArtDirectories
				};
				assert.strictEqual(typeof exports[name], 'function');
			});
		}(exportName));
	}
});

// ---------------------------------------------------------------------------
// ART_FORMATS
// ---------------------------------------------------------------------------

describe('ART_FORMATS', function () {
	it('should contain ans', function () {
		assert.ok(ART_FORMATS.includes('ans'));
	});

	it('should contain asc', function () {
		assert.ok(ART_FORMATS.includes('asc'));
	});

	it('should contain utf8', function () {
		assert.ok(ART_FORMATS.includes('utf8'));
	});

	it('should contain sixel', function () {
		assert.ok(ART_FORMATS.includes('sixel'));
	});

	it('should contain webart', function () {
		assert.ok(ART_FORMATS.includes('webart'));
	});

	it('should have at least 4 entries', function () {
		assert.ok(ART_FORMATS.length >= 4);
	});
});

// ---------------------------------------------------------------------------
// ART_TYPES
// ---------------------------------------------------------------------------

describe('ART_TYPES', function () {
	it('should contain screens', function () {
		assert.ok(ART_TYPES.includes('screens'));
	});

	it('should contain logon', function () {
		assert.ok(ART_TYPES.includes('logon'));
	});

	it('should contain logoff', function () {
		assert.ok(ART_TYPES.includes('logoff'));
	});

	it('should contain misc', function () {
		assert.ok(ART_TYPES.includes('misc'));
	});

	it('should have at least 5 entries', function () {
		assert.ok(ART_TYPES.length >= 5);
	});
});

// ---------------------------------------------------------------------------
// dateInRange -- same-year ranges
// ---------------------------------------------------------------------------

describe('dateInRange', function () {
	describe('same-year range (Oct 25 - Oct 31)', function () {
		var sm = 10, sd = 25, em = 10, ed = 31;

		it('should return true for a date inside the range', function () {
			assert.strictEqual(dateInRange(10, 28, sm, sd, em, ed), true);
		});

		it('should return true for the start boundary', function () {
			assert.strictEqual(dateInRange(10, 25, sm, sd, em, ed), true);
		});

		it('should return true for the end boundary', function () {
			assert.strictEqual(dateInRange(10, 31, sm, sd, em, ed), true);
		});

		it('should return false for a date before the range (same month)', function () {
			assert.strictEqual(dateInRange(10, 24, sm, sd, em, ed), false);
		});

		it('should return false for a date after the range (same month)', function () {
			// Nov 1 is after Oct 31 in same-year terms
			assert.strictEqual(dateInRange(11, 1, sm, sd, em, ed), false);
		});

		it('should return false for a date in a completely different month', function () {
			assert.strictEqual(dateInRange(6, 15, sm, sd, em, ed), false);
		});
	});

	describe('same-year range spanning two months (Mar 1 - Apr 15)', function () {
		var sm = 3, sd = 1, em = 4, ed = 15;

		it('should return true for a date in March', function () {
			assert.strictEqual(dateInRange(3, 10, sm, sd, em, ed), true);
		});

		it('should return true for a date in April within range', function () {
			assert.strictEqual(dateInRange(4, 10, sm, sd, em, ed), true);
		});

		it('should return false for April 16 (just outside end)', function () {
			assert.strictEqual(dateInRange(4, 16, sm, sd, em, ed), false);
		});

		it('should return false for Feb 28 (before start)', function () {
			assert.strictEqual(dateInRange(2, 28, sm, sd, em, ed), false);
		});
	});

	describe('year-wrapping range (Dec 15 - Jan 2)', function () {
		var sm = 12, sd = 15, em = 1, ed = 2;

		it('should return true for Dec 15 (start boundary)', function () {
			assert.strictEqual(dateInRange(12, 15, sm, sd, em, ed), true);
		});

		it('should return true for Dec 25 (inside December portion)', function () {
			assert.strictEqual(dateInRange(12, 25, sm, sd, em, ed), true);
		});

		it('should return true for Dec 31 (last day of year)', function () {
			assert.strictEqual(dateInRange(12, 31, sm, sd, em, ed), true);
		});

		it('should return true for Jan 1 (first day of new year)', function () {
			assert.strictEqual(dateInRange(1, 1, sm, sd, em, ed), true);
		});

		it('should return true for Jan 2 (end boundary)', function () {
			assert.strictEqual(dateInRange(1, 2, sm, sd, em, ed), true);
		});

		it('should return false for Jan 3 (just past end)', function () {
			assert.strictEqual(dateInRange(1, 3, sm, sd, em, ed), false);
		});

		it('should return false for Dec 14 (day before start)', function () {
			assert.strictEqual(dateInRange(12, 14, sm, sd, em, ed), false);
		});

		it('should return false for a mid-year date (July 4)', function () {
			assert.strictEqual(dateInRange(7, 4, sm, sd, em, ed), false);
		});
	});

	describe('year-wrapping range (Nov 30 - Feb 1)', function () {
		var sm = 11, sd = 30, em = 2, ed = 1;

		it('should return true for Dec 1 (deep in wrap zone)', function () {
			assert.strictEqual(dateInRange(12, 1, sm, sd, em, ed), true);
		});

		it('should return true for Jan 15', function () {
			assert.strictEqual(dateInRange(1, 15, sm, sd, em, ed), true);
		});

		it('should return false for Feb 2 (one day after end)', function () {
			assert.strictEqual(dateInRange(2, 2, sm, sd, em, ed), false);
		});

		it('should return false for Nov 29 (one day before start)', function () {
			assert.strictEqual(dateInRange(11, 29, sm, sd, em, ed), false);
		});
	});

	describe('edge case: start equals end (single day)', function () {
		it('should return true when date matches the single day', function () {
			assert.strictEqual(dateInRange(7, 4, 7, 4, 7, 4), true);
		});

		it('should return false when date does not match the single day', function () {
			assert.strictEqual(dateInRange(7, 5, 7, 4, 7, 4), false);
		});
	});

	describe('edge case: February boundary', function () {
		it('should include Feb 28 in a range of Feb 1 - Feb 28', function () {
			assert.strictEqual(dateInRange(2, 28, 2, 1, 2, 28), true);
		});

		it('should exclude Feb 29 from a range ending Feb 28', function () {
			// Feb 29 encodes as 229, which is > 228, so outside the range
			assert.strictEqual(dateInRange(2, 29, 2, 1, 2, 28), false);
		});

		it('should include Feb 29 in a range of Feb 1 - Mar 1', function () {
			assert.strictEqual(dateInRange(2, 29, 2, 1, 3, 1), true);
		});
	});
});

// ---------------------------------------------------------------------------
// getActiveSeasonsForDate
// ---------------------------------------------------------------------------

describe('getActiveSeasonsForDate', function () {
	it('should return empty array for empty seasons list', function () {
		var result = getActiveSeasonsForDate([], 10, 28);
		assert.deepStrictEqual(result, []);
	});

	it('should return empty array when no seasons match', function () {
		var seasons = [
			makeSeason({ start_month: 10, start_day: 25, end_month: 10, end_day: 31 })
		];
		var result = getActiveSeasonsForDate(seasons, 6, 15);
		assert.deepStrictEqual(result, []);
	});

	it('should return matching season when date is within range', function () {
		var season = makeSeason({ start_month: 10, start_day: 25, end_month: 10, end_day: 31 });
		var result = getActiveSeasonsForDate([season], 10, 28);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0], season);
	});

	it('should not include inactive seasons', function () {
		var inactive = makeSeason({ active: false, start_month: 10, start_day: 25, end_month: 10, end_day: 31 });
		var result = getActiveSeasonsForDate([inactive], 10, 28);
		assert.deepStrictEqual(result, []);
	});

	it('should not include inactive seasons even when date matches', function () {
		var inactive = makeSeason({ active: false, start_month: 1, start_day: 1, end_month: 12, end_day: 31 });
		var result = getActiveSeasonsForDate([inactive], 6, 15);
		assert.deepStrictEqual(result, []);
	});

	it('should return only active seasons when a mix of active and inactive both match', function () {
		var active = makeSeason({ id: 1, active: true, start_month: 10, start_day: 25, end_month: 10, end_day: 31 });
		var inactive = makeSeason({ id: 2, active: false, start_month: 10, start_day: 1, end_month: 10, end_day: 31 });
		var result = getActiveSeasonsForDate([active, inactive], 10, 28);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, 1);
	});

	it('should return multiple seasons when ranges overlap', function () {
		var halloween = makeSeason({
			id: 1,
			name: 'Halloween',
			subdir: 'halloween',
			start_month: 10, start_day: 25,
			end_month: 10, end_day: 31
		});
		var autumn = makeSeason({
			id: 2,
			name: 'Autumn',
			subdir: 'autumn',
			start_month: 9, start_day: 22,
			end_month: 11, end_day: 30
		});
		var result = getActiveSeasonsForDate([halloween, autumn], 10, 28);
		assert.strictEqual(result.length, 2);
	});

	it('should return seasons in the order they appear in the input array', function () {
		var first = makeSeason({ id: 10, subdir: 'first', start_month: 1, start_day: 1, end_month: 12, end_day: 31 });
		var second = makeSeason({ id: 20, subdir: 'second', start_month: 1, start_day: 1, end_month: 12, end_day: 31 });
		var result = getActiveSeasonsForDate([first, second], 6, 15);
		assert.strictEqual(result[0].id, 10);
		assert.strictEqual(result[1].id, 20);
	});

	it('should handle year-wrapping season matching a January date', function () {
		var christmas = makeSeason({
			name: 'Christmas',
			subdir: 'christmas',
			start_month: 12, start_day: 15,
			end_month: 1, end_day: 2
		});
		var result = getActiveSeasonsForDate([christmas], 1, 1);
		assert.strictEqual(result.length, 1);
	});

	it('should handle year-wrapping season not matching a mid-year date', function () {
		var christmas = makeSeason({
			name: 'Christmas',
			subdir: 'christmas',
			start_month: 12, start_day: 15,
			end_month: 1, end_day: 2
		});
		var result = getActiveSeasonsForDate([christmas], 7, 4);
		assert.deepStrictEqual(result, []);
	});

	it('should handle a season with active: 0 (falsy integer) as inactive', function () {
		var season = makeSeason({ active: 0, start_month: 10, start_day: 25, end_month: 10, end_day: 31 });
		var result = getActiveSeasonsForDate([season], 10, 28);
		assert.deepStrictEqual(result, []);
	});

	it('should treat active: true (boolean) as active', function () {
		var season = makeSeason({ active: true, start_month: 6, start_day: 1, end_month: 6, end_day: 30 });
		var result = getActiveSeasonsForDate([season], 6, 15);
		assert.strictEqual(result.length, 1);
	});

	it('should return empty array when all seasons are inactive', function () {
		var seasons = [
			makeSeason({ id: 1, active: false }),
			makeSeason({ id: 2, active: false }),
			makeSeason({ id: 3, active: 0 })
		];
		var result = getActiveSeasonsForDate(seasons, 10, 28);
		assert.deepStrictEqual(result, []);
	});
});
