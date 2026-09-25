// tests/channelSwitch.test.js — switching update channel from the Update page.
//
// The channel was a setting on the config page and nothing else: a board on
// development saw stable on the Update page but got no button for it, and one
// on stable never saw development. The Update page now switches, and says what
// a switch means, because the one move that surprises people is development ->
// stable: a build sorts ABOVE the stable it was cut from, so the board stays
// where it is until the next stable, and silence there reads as "did nothing".
//
// Run: npx mocha --no-config --exit tests/channelSwitch.test.js

import assert from 'assert';
import pug from 'pug';
import { describeSwitch, waitingForStable } from '../src/release/channelSwitch.js';
import { formatTimestamp, timestampMs } from '../src/utils/dateFormat.js';

describe('describeSwitch', function () {

	it('says nothing when the channel is not changing', function () {
		assert.strictEqual(describeSwitch('0.9.11a', 'stable', 'stable'), null);
	});

	it('refuses a channel that does not exist', function () {
		assert.strictEqual(describeSwitch('0.9.11a', 'stable', 'nightly'), null);
	});

	it('to development: builds are offered from now on', function () {
		assert.match(describeSwitch('0.9.11a', 'stable', 'development'), /Development builds are now offered/);
	});

	it('development to stable on a stable release: stable only', function () {
		assert.match(describeSwitch('0.9.11a', 'development', 'stable'), /Only stable releases/);
	});

	it('development to stable on a build: stays put until the next stable', function () {
		var t = describeSwitch('0.9.11a.20261001', 'development', 'stable');
		assert.match(t, /0\.9\.11a\.20261001/);
		assert.match(t, /newer than stable 0\.9\.11a/);
		assert.match(t, /first stable release after 0\.9\.11a/);
	});
});

describe('waitingForStable', function () {
	it('only speaks for a development build', function () {
		assert.strictEqual(waitingForStable('0.9.11a'), null);
		assert.ok(waitingForStable('0.9.11a.20261001.2'));
	});
});

describe('the Update page channel control', function () {
	var OPTIONS = [{ value: 'stable', label: 'Stable' }, { value: 'development', label: 'Development' }];

	function render(extra) {
		return pug.renderFile('src/views/admin/update/index.pug', Object.assign({
			currentuser: { username: 'tester', security: 255, permissionflags: ['Sysop'] },
			sufficientAccess: true, title: 'Software Update', activelink: 'update', ismobile: false,
			formatTimestamp: formatTimestamp, timestampMs: timestampMs,
			running: '0.9.11a', nodeVersion: 'v26.9.0', enabled: true, channel: 'stable',
			checkUrl: 'https://example.invalid/', last: null, result: null,
			preflight: { ok: true, blockers: [], warnings: [], checks: [] },
			disk: { total: 0, base: { bytes: 0 }, backup: { bytes: 0 }, staging: { bytes: 0 } },
			lastRun: null, runLive: false, graceSeconds: 300, canApply: false, notices: null,
			noticeRefused: false, lastRunNotices: [], bootProblems: [], history: [],
			channelOptions: OPTIONS, channelFromEnv: false, waitingForStable: null, flash: []
		}, extra || {}));
	}

	it('offers both channels, with the current one selected', function () {
		var html = render({ channel: 'development' });
		assert.match(html, /action="\/admin\/update\/channel"/);
		assert.match(html, /<option value="development" selected/);
		assert.match(html, /<option value="stable">/);
	});

	it('shows the channel read-only when .env sets it', function () {
		var html = render({ channelFromEnv: true });
		assert.doesNotMatch(html, /action="\/admin\/update\/channel"/);
		assert.match(html, /set in \.env/);
	});

	it('explains a development build on the stable channel', function () {
		var html = render({ running: '0.9.11a.20261001', waitingForStable: waitingForStable('0.9.11a.20261001') });
		assert.match(html, /first stable release after 0\.9\.11a/);
	});
});
