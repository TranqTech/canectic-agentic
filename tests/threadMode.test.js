// tests/threadMode.test.js — the thread mode vocabulary.
//
// `thread_mode` decides whether an area reads as threads or as a flat list.
// It now lives on the message GROUP as a default as well as on each area, so
// the same three values are validated by two models, on top of the two places
// msgAreas already checked them. That is how a list ends up in four copies
// that disagree.
//
// A disagreement does not throw. An unrecognised value is replaced with
// 'standard', so an area a sysop set to flat comes back threaded on whichever
// path has the stale copy, and only on that path. This is the same failure
// configDefaults carries an `options` list to prevent.
//
// The other half is the difference between "not submitted" and "submitted as
// nonsense": an update handler must leave a stored value alone in the first
// case and must not write rubbish in the second, which is why isThreadMode
// exists separately from normaliseThreadMode.
//
// Run: npx mocha --no-config --no-package tests/threadMode.test.js

import assert from 'assert';
import {
	THREAD_MODES, normaliseThreadMode, isThreadMode, threadModeLabel
} from '../src/utils/threadMode.js';

describe('thread mode vocabulary', function () {

	it('is exactly the three modes the column allows', function () {
		// message_areas.thread_mode and message_groups.thread_mode are both
		// VARCHAR(16) with no CHECK, so this list is the only thing keeping a
		// value the reader cannot interpret out of the database.
		assert.deepStrictEqual(THREAD_MODES.slice().sort(), ['no_threads', 'standard', 'subscribe_only']);
	});

	it('gives every mode a label, so none renders blank', function () {
		for (var mode of THREAD_MODES) {
			var label = threadModeLabel(mode);
			assert.ok(label && label.length > 0, mode + ' has no label');
		}
	});
});

describe('normaliseThreadMode', function () {

	it('accepts each valid mode unchanged', function () {
		for (var mode of THREAD_MODES) {
			assert.strictEqual(normaliseThreadMode(mode), mode);
		}
	});

	it('is case and whitespace insensitive, as form input arrives', function () {
		assert.strictEqual(normaliseThreadMode('  No_Threads  '), 'no_threads');
		assert.strictEqual(normaliseThreadMode('STANDARD'), 'standard');
	});

	it('falls back to standard for anything it does not know', function () {
		assert.strictEqual(normaliseThreadMode('flat'), 'standard');
		assert.strictEqual(normaliseThreadMode(''), 'standard');
		assert.strictEqual(normaliseThreadMode(null), 'standard');
		assert.strictEqual(normaliseThreadMode(undefined), 'standard');
		assert.strictEqual(normaliseThreadMode(42), 'standard');
	});

	it('takes the fallback it is given, which is how a group default reaches an area', function () {
		// A new area with no explicit choice inherits the group's mode. Without
		// this the group setting would exist and do nothing, which is worse
		// than not having it.
		assert.strictEqual(normaliseThreadMode('', 'no_threads'), 'no_threads');
		assert.strictEqual(normaliseThreadMode(undefined, 'subscribe_only'), 'subscribe_only');
	});

	it('lets an explicit choice beat the fallback', function () {
		assert.strictEqual(normaliseThreadMode('standard', 'no_threads'), 'standard');
	});

	it('does not let a bad fallback smuggle in an invalid mode', function () {
		// The group's stored value is itself normalised before being used as a
		// fallback, but this is the backstop if a caller forgets.
		assert.strictEqual(normaliseThreadMode('', normaliseThreadMode('nonsense')), 'standard');
	});
});

describe('isThreadMode', function () {

	it('is true only for values we recognise', function () {
		for (var mode of THREAD_MODES) assert.strictEqual(isThreadMode(mode), true);
		assert.strictEqual(isThreadMode('NO_THREADS'), true);
	});

	it('is false for absent input, so an update leaves the stored value alone', function () {
		assert.strictEqual(isThreadMode(undefined), false);
		assert.strictEqual(isThreadMode(null), false);
		assert.strictEqual(isThreadMode(''), false);
	});

	it('is false for nonsense, so an update does not write it', function () {
		// normaliseThreadMode would turn 'flat' into 'standard'. On an update
		// that would silently rewrite a sysop's existing choice, which is why
		// the update path asks this question first.
		assert.strictEqual(isThreadMode('flat'), false);
		assert.strictEqual(isThreadMode('threaded'), false);
	});
});

describe('threadModeLabel', function () {

	it('names the modes the way the admin forms do', function () {
		assert.strictEqual(threadModeLabel('standard'), 'Standard (threaded)');
		assert.strictEqual(threadModeLabel('no_threads'), 'No Threads (flat)');
		assert.strictEqual(threadModeLabel('subscribe_only'), 'Subscribe Only');
	});

	it('labels an unknown stored value rather than rendering blank', function () {
		assert.strictEqual(threadModeLabel('rubbish'), 'Standard (threaded)');
		assert.strictEqual(threadModeLabel(null), 'Standard (threaded)');
	});
});
