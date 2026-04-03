// tests/activityMap.test.js — Unit tests for src/utils/activityMap.js
//
// Tests ACTIVITY_LABELS, ACTIVITY_FORMATTERS, formatActivity, getWebActivityLabel.
// Pure functions — no DB, no Redis.
// Run: npx mocha tests/activityMap.test.js

import assert from 'assert';
import {
	ACTIVITY_LABELS,
	ACTIVITY_FORMATTERS,
	formatActivity,
	getWebActivityLabel
} from '../src/utils/activityMap.js';

// ---------------------------------------------------------------------------
// ACTIVITY_LABELS — structure checks
// ---------------------------------------------------------------------------

describe('ACTIVITY_LABELS', function () {

	it('should be a plain object', function () {
		assert.ok(ACTIVITY_LABELS !== null && typeof ACTIVITY_LABELS === 'object' && !Array.isArray(ACTIVITY_LABELS));
	});

	it('should be non-empty', function () {
		assert.ok(Object.keys(ACTIVITY_LABELS).length > 0);
	});

	it('should have only string values', function () {
		for (var key of Object.keys(ACTIVITY_LABELS)) {
			assert.strictEqual(typeof ACTIVITY_LABELS[key], 'string',
				'Expected string value for key: ' + key);
			assert.ok(ACTIVITY_LABELS[key].length > 0,
				'Expected non-empty string for key: ' + key);
		}
	});

	it('should contain expected call-flow stage keys', function () {
		assert.ok('connecting'    in ACTIVITY_LABELS);
		assert.ok('negotiate'     in ACTIVITY_LABELS);
		assert.ok('logon'         in ACTIVITY_LABELS);
		assert.ok('login'         in ACTIVITY_LABELS);
		assert.ok('disconnecting' in ACTIVITY_LABELS);
		assert.ok('announcements' in ACTIVITY_LABELS);
	});

	it('should contain expected menu-command keys', function () {
		assert.ok('readMessages'  in ACTIVITY_LABELS);
		assert.ok('postMessage'   in ACTIVITY_LABELS);
		assert.ok('newScan'       in ACTIVITY_LABELS);
		assert.ok('fileBrowser'   in ACTIVITY_LABELS);
		assert.ok('doorBrowser'   in ACTIVITY_LABELS);
		assert.ok('email'         in ACTIVITY_LABELS);
	});

	it('should contain expected web activity keys', function () {
		assert.ok('web_browsing'  in ACTIVITY_LABELS);
		assert.ok('web_messages'  in ACTIVITY_LABELS);
		assert.ok('web_files'     in ACTIVITY_LABELS);
		assert.ok('web_doors'     in ACTIVITY_LABELS);
		assert.ok('web_pm'        in ACTIVITY_LABELS);
		assert.ok('web_profile'   in ACTIVITY_LABELS);
		assert.ok('web_admin'     in ACTIVITY_LABELS);
	});

	it('should map connecting to "Connecting"', function () {
		assert.strictEqual(ACTIVITY_LABELS.connecting, 'Connecting');
	});

	it('should map logon to "Logging In"', function () {
		assert.strictEqual(ACTIVITY_LABELS.logon, 'Logging In');
	});

	it('should map disconnecting to "Logging Off"', function () {
		assert.strictEqual(ACTIVITY_LABELS.disconnecting, 'Logging Off');
	});

	it('should map web_admin to "Admin Panel"', function () {
		assert.strictEqual(ACTIVITY_LABELS.web_admin, 'Admin Panel');
	});

	it('should have connecting and negotiate both map to "Connecting"', function () {
		assert.strictEqual(ACTIVITY_LABELS.connecting, ACTIVITY_LABELS.negotiate);
	});

	it('should have logon and login both map to "Logging In"', function () {
		assert.strictEqual(ACTIVITY_LABELS.logon, ACTIVITY_LABELS.login);
	});

	it('should have whosOnline and check_online both present', function () {
		assert.ok('whosOnline'   in ACTIVITY_LABELS);
		assert.ok('check_online' in ACTIVITY_LABELS);
	});
});

// ---------------------------------------------------------------------------
// ACTIVITY_FORMATTERS — structure checks
// ---------------------------------------------------------------------------

describe('ACTIVITY_FORMATTERS', function () {

	it('should be a plain object', function () {
		assert.ok(ACTIVITY_FORMATTERS !== null && typeof ACTIVITY_FORMATTERS === 'object' && !Array.isArray(ACTIVITY_FORMATTERS));
	});

	it('should have only function values', function () {
		for (var key of Object.keys(ACTIVITY_FORMATTERS)) {
			assert.strictEqual(typeof ACTIVITY_FORMATTERS[key], 'function',
				'Expected function for formatter key: ' + key);
		}
	});

	it('should contain expected formatter keys', function () {
		assert.ok('menu'     in ACTIVITY_FORMATTERS);
		assert.ok('door'     in ACTIVITY_FORMATTERS);
		assert.ok('runXtrn'  in ACTIVITY_FORMATTERS);
		assert.ok('loadMenu' in ACTIVITY_FORMATTERS);
	});

	it('menu formatter with detail should include detail in output', function () {
		var result = ACTIVITY_FORMATTERS.menu('Main');
		assert.ok(result.includes('Main'), 'Expected "Main" in: ' + result);
		assert.ok(result.includes('Menu'), 'Expected "Menu" in: ' + result);
	});

	it('menu formatter without detail should return generic label', function () {
		assert.strictEqual(ACTIVITY_FORMATTERS.menu(null), 'Browsing Menus');
		assert.strictEqual(ACTIVITY_FORMATTERS.menu(undefined), 'Browsing Menus');
		assert.strictEqual(ACTIVITY_FORMATTERS.menu(''), 'Browsing Menus');
	});

	it('door formatter with detailDisplay should prefer detailDisplay over detail', function () {
		var result = ACTIVITY_FORMATTERS.door('door-slug', 'Trade Wars 2002');
		assert.ok(result.includes('Trade Wars 2002'), 'Expected detailDisplay in: ' + result);
		assert.ok(!result.includes('door-slug'), 'Should not contain raw slug: ' + result);
	});

	it('door formatter with only detail and no detailDisplay should use detail', function () {
		var result = ACTIVITY_FORMATTERS.door('door-slug', null);
		assert.ok(result.includes('door-slug'), 'Expected detail in: ' + result);
	});

	it('door formatter with no args should return generic fallback', function () {
		assert.strictEqual(ACTIVITY_FORMATTERS.door(null, null), 'Playing a Door');
		assert.strictEqual(ACTIVITY_FORMATTERS.door(undefined, undefined), 'Playing a Door');
	});

	it('runXtrn formatter should behave identically to door formatter', function () {
		assert.strictEqual(
			ACTIVITY_FORMATTERS.runXtrn('slug', 'My Game'),
			ACTIVITY_FORMATTERS.door('slug', 'My Game')
		);
		assert.strictEqual(
			ACTIVITY_FORMATTERS.runXtrn(null, null),
			ACTIVITY_FORMATTERS.door(null, null)
		);
	});

	it('loadMenu formatter with detail should include detail', function () {
		var result = ACTIVITY_FORMATTERS.loadMenu('Files');
		assert.ok(result.includes('Files'), 'Expected "Files" in: ' + result);
		assert.ok(result.includes('Menu'), 'Expected "Menu" in: ' + result);
	});

	it('loadMenu formatter without detail should return generic label', function () {
		assert.strictEqual(ACTIVITY_FORMATTERS.loadMenu(null), 'Loading Menu');
		assert.strictEqual(ACTIVITY_FORMATTERS.loadMenu(undefined), 'Loading Menu');
		assert.strictEqual(ACTIVITY_FORMATTERS.loadMenu(''), 'Loading Menu');
	});
});

// ---------------------------------------------------------------------------
// formatActivity
// ---------------------------------------------------------------------------

describe('formatActivity', function () {

	describe('null / undefined / empty status', function () {
		it('should return "Unknown" for null', function () {
			assert.strictEqual(formatActivity(null), 'Unknown');
		});

		it('should return "Unknown" for undefined', function () {
			assert.strictEqual(formatActivity(undefined), 'Unknown');
		});

		it('should return "Unknown" for empty string', function () {
			assert.strictEqual(formatActivity(''), 'Unknown');
		});
	});

	describe('static ACTIVITY_LABELS lookup', function () {
		it('should return "Connecting" for "connecting"', function () {
			assert.strictEqual(formatActivity('connecting'), 'Connecting');
		});

		it('should return "Connecting" for "negotiate"', function () {
			assert.strictEqual(formatActivity('negotiate'), 'Connecting');
		});

		it('should return "Logging In" for "logon"', function () {
			assert.strictEqual(formatActivity('logon'), 'Logging In');
		});

		it('should return "Logging In" for "login"', function () {
			assert.strictEqual(formatActivity('login'), 'Logging In');
		});

		it('should return "Logging Off" for "disconnecting"', function () {
			assert.strictEqual(formatActivity('disconnecting'), 'Logging Off');
		});

		it('should return "Reading Announcements" for "announcements"', function () {
			assert.strictEqual(formatActivity('announcements'), 'Reading Announcements');
		});

		it('should return "Reading Messages" for "readMessages"', function () {
			assert.strictEqual(formatActivity('readMessages'), 'Reading Messages');
		});

		it('should return "Posting a Message" for "postMessage"', function () {
			assert.strictEqual(formatActivity('postMessage'), 'Posting a Message');
		});

		it('should return "New Message Scan" for "newScan"', function () {
			assert.strictEqual(formatActivity('newScan'), 'New Message Scan');
		});

		it('should return "Browsing Files" for "fileBrowser"', function () {
			assert.strictEqual(formatActivity('fileBrowser'), 'Browsing Files');
		});

		it('should return "Browsing Files" for "fileList"', function () {
			assert.strictEqual(formatActivity('fileList'), 'Browsing Files');
		});

		it('should return "Admin Panel" for "web_admin"', function () {
			assert.strictEqual(formatActivity('web_admin'), 'Admin Panel');
		});

		it('should return "Browsing Web" for "web_browsing"', function () {
			assert.strictEqual(formatActivity('web_browsing'), 'Browsing Web');
		});

		it('should return "Reading Mail" for "web_pm"', function () {
			assert.strictEqual(formatActivity('web_pm'), 'Reading Mail');
		});

		it('should ignore extra detail argument for static keys', function () {
			assert.strictEqual(formatActivity('logon', 'some detail'), 'Logging In');
		});
	});

	describe('dynamic formatter dispatch', function () {
		it('should call menu formatter and include detail', function () {
			var result = formatActivity('menu', 'Main');
			assert.ok(result.includes('Main'));
			assert.ok(result.includes('Menu'));
		});

		it('should call menu formatter with no detail and return generic', function () {
			assert.strictEqual(formatActivity('menu'), 'Browsing Menus');
		});

		it('should call door formatter with detailDisplay', function () {
			var result = formatActivity('door', 'slot-42', 'LORD');
			assert.ok(result.includes('LORD'), 'Expected detailDisplay "LORD" in: ' + result);
		});

		it('should call door formatter with only detail', function () {
			var result = formatActivity('door', 'lord');
			assert.ok(result.includes('lord'));
		});

		it('should call door formatter with no args and return fallback', function () {
			assert.strictEqual(formatActivity('door'), 'Playing a Door');
		});

		it('should call runXtrn formatter with detailDisplay', function () {
			var result = formatActivity('runXtrn', 'slug', 'BRE');
			assert.ok(result.includes('BRE'));
		});

		it('should call runXtrn formatter with no args and return fallback', function () {
			assert.strictEqual(formatActivity('runXtrn'), 'Playing a Door');
		});

		it('should call loadMenu formatter with detail', function () {
			var result = formatActivity('loadMenu', 'Files');
			assert.ok(result.includes('Files'));
			assert.ok(result.includes('Menu'));
		});

		it('should call loadMenu formatter with no detail and return generic', function () {
			assert.strictEqual(formatActivity('loadMenu'), 'Loading Menu');
		});
	});

	describe('unknown status fallback', function () {
		it('should capitalize the first letter of an unknown status', function () {
			assert.strictEqual(formatActivity('fooBar'), 'FooBar');
		});

		it('should capitalize single-character unknown status', function () {
			assert.strictEqual(formatActivity('x'), 'X');
		});

		it('should not crash on an all-caps unknown status', function () {
			var result = formatActivity('UNKNOWNSTATUS');
			assert.strictEqual(typeof result, 'string');
			assert.ok(result.length > 0);
		});

		it('should capitalize first letter but leave the rest intact for unknown status', function () {
			assert.strictEqual(formatActivity('idle'), 'Idle');
		});

		it('should not confuse an unknown status with a known one (case-sensitive)', function () {
			// 'Logon' (capital L) is not a key; should fall through to capitalize
			var result = formatActivity('Logon');
			assert.notStrictEqual(result, 'Logging In');
			assert.strictEqual(result, 'Logon');
		});
	});
});

// ---------------------------------------------------------------------------
// getWebActivityLabel
// ---------------------------------------------------------------------------

describe('getWebActivityLabel', function () {

	describe('direct key lookup', function () {
		it('should return label for web_browsing', function () {
			assert.strictEqual(getWebActivityLabel('web_browsing'), 'Browsing Web');
		});

		it('should return label for web_messages', function () {
			assert.strictEqual(getWebActivityLabel('web_messages'), 'Reading Messages');
		});

		it('should return label for web_files', function () {
			assert.strictEqual(getWebActivityLabel('web_files'), 'Browsing Files');
		});

		it('should return label for web_doors', function () {
			assert.strictEqual(getWebActivityLabel('web_doors'), 'Browsing Doors');
		});

		it('should return label for web_pm', function () {
			assert.strictEqual(getWebActivityLabel('web_pm'), 'Reading Mail');
		});

		it('should return label for web_profile', function () {
			assert.strictEqual(getWebActivityLabel('web_profile'), 'Editing Profile');
		});

		it('should return label for web_admin', function () {
			assert.strictEqual(getWebActivityLabel('web_admin'), 'Admin Panel');
		});
	});

	describe('prefixed key lookup (web_ prefix applied automatically)', function () {
		it('should return label when called with "browsing" (prefix applied)', function () {
			assert.strictEqual(getWebActivityLabel('browsing'), 'Browsing Web');
		});

		it('should return label when called with "messages" (prefix applied)', function () {
			assert.strictEqual(getWebActivityLabel('messages'), 'Reading Messages');
		});

		it('should return label when called with "files" (prefix applied)', function () {
			assert.strictEqual(getWebActivityLabel('files'), 'Browsing Files');
		});

		it('should return label when called with "doors" (prefix applied)', function () {
			assert.strictEqual(getWebActivityLabel('doors'), 'Browsing Doors');
		});

		it('should return label when called with "pm" (prefix applied)', function () {
			assert.strictEqual(getWebActivityLabel('pm'), 'Reading Mail');
		});

		it('should return label when called with "profile" (prefix applied)', function () {
			assert.strictEqual(getWebActivityLabel('profile'), 'Editing Profile');
		});

		it('should return label when called with "admin" (prefix applied)', function () {
			assert.strictEqual(getWebActivityLabel('admin'), 'Admin Panel');
		});
	});

	describe('non-web keys from ACTIVITY_LABELS', function () {
		it('should return label for a known non-web key as direct match', function () {
			// 'connecting' is in ACTIVITY_LABELS directly
			assert.strictEqual(getWebActivityLabel('connecting'), 'Connecting');
		});
	});

	describe('unknown keys', function () {
		it('should return null for an unknown key with no web_ variant', function () {
			assert.strictEqual(getWebActivityLabel('no_such_activity_xyz'), null);
		});

		it('should return null for null', function () {
			assert.strictEqual(getWebActivityLabel(null), null);
		});

		it('should return null for undefined', function () {
			assert.strictEqual(getWebActivityLabel(undefined), null);
		});

		it('should return null for empty string', function () {
			assert.strictEqual(getWebActivityLabel(''), null);
		});

		it('should return null for a key that only partially matches', function () {
			assert.strictEqual(getWebActivityLabel('web_'), null);
		});
	});
});
