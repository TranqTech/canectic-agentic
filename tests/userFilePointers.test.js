// tests/userFilePointers.test.js — the arithmetic behind the new-file badge.
//
// postgres hands integer columns back as STRINGS. The web area view used to
// walk its result rows with `if (f.id > maxId) maxId = f.id`, which is correct
// exactly once: the first comparison is string-against-number and coerces, and
// every comparison after it is string-against-string. '9' > '37' is true, so
// an area whose ids had reached double digits advanced the pointer to 9.
//
// Nothing failed. advancePointer writes GREATEST(existing, new), so the bad
// value was simply discarded and the pointer stayed where it was, for ever.
// The user-visible symptom was a new-file count that viewing the area would
// not clear, which reads as the badge being broken rather than the pointer.
//
// These are the cases that distinguish a numeric max from a lexicographic one.
// Pure: no database.
// Run: npx mocha --no-config --no-package tests/userFilePointers.test.js

import assert from 'assert';
import { highestId } from '../src/models/userFilePointers.js';

// Rows as postgres actually returns them.
function rows(ids) {
	return ids.map(function (id) { return { id: String(id) }; });
}

describe('userFilePointers.highestId', function () {

	it('takes the numeric maximum of string ids', function () {
		// The regression, in its smallest form: lexicographically '9' wins.
		assert.strictEqual(highestId(rows([37, 36, 9, 7, 3])), 37);
	});

	it('is not fooled by a single-digit id arriving last', function () {
		// Listing order is upload_date DESC, so the oldest row comes last and
		// is the one most likely to have a short id.
		assert.strictEqual(highestId(rows([100, 99, 10, 9])), 100);
	});

	it('is not fooled by a single-digit id arriving first', function () {
		assert.strictEqual(highestId(rows([9, 10])), 10);
	});

	it('returns a number, not a string', function () {
		// A string reaching advancePointer casts cleanly to bigint in SQL, so
		// the write would succeed and be wrong somewhere else instead.
		assert.strictEqual(typeof highestId(rows([41, 40])), 'number');
	});

	it('handles numeric ids too', function () {
		assert.strictEqual(highestId([{ id: 5 }, { id: 12 }, { id: 3 }]), 12);
	});

	it('ignores rows whose id will not parse, rather than returning NaN', function () {
		// Every comparison against NaN is false, so a poisoned result would
		// stop the pointer moving again — the same bug wearing a new hat.
		assert.strictEqual(highestId([{ id: '12' }, { id: null }, { id: 'x' }, {}]), 12);
	});

	it('returns 0 for an empty or missing list', function () {
		assert.strictEqual(highestId([]), 0);
		assert.strictEqual(highestId(null), 0);
		assert.strictEqual(highestId(undefined), 0);
	});

	it('skips null rows', function () {
		assert.strictEqual(highestId([null, { id: '8' }, undefined]), 8);
	});
});
