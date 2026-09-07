// tests/configOptions.test.js: config keys with a fixed set of values.
//
// A key like netmail_relay_mode has three legal values and no way to express
// that. It was declared type 'string', so the admin UI drew a free text box and
// the save route stored whatever was typed. Every consumer of these reads them
// as text and falls back to something safe on an unrecognised value, so a typo
// does not fail loudly: it silently changes behaviour while the settings page
// goes on displaying the typo as though it were in effect.
//
// Declaring `options` fixes both halves. The UI offers the values, and the save
// route refuses anything outside them.
//
// Pure: no database.
// Run: npx mocha

import assert from 'assert';

var defaults = null, pug = null;
try {
	defaults = await import('../src/config/configDefaults.js');
	pug = (await import('pug')).default;
} catch (_) { /* leave null, suites skip */ }

function definitions() {
	return defaults.CONFIG_DEFINITIONS || defaults.default;
}

function byKey(key) {
	return definitions().filter(function (d) { return d.key === key; })[0];
}

describe('config option declarations', function () {
	before(function () { if (!defaults) this.skip(); });

	it('declares the relay modes', function () {
		var def = byKey('netmail_relay_mode');
		assert.ok(def, 'netmail_relay_mode should exist');
		assert.ok(def.options && def.options.length === 3);
		assert.deepStrictEqual(def.options.map(function (o) { return o.value; }),
			['nodelist', 'off', 'on']);
	});

	it('defaults the relay mode to a value that is actually on offer', function () {
		// A default outside its own option list would render as no selection
		// and save as something the sysop never picked.
		var def = byKey('netmail_relay_mode');
		assert.ok(def.options.some(function (o) { return o.value === def.defaultValue; }),
			'default ' + def.defaultValue + ' is not one of the options');
	});

	it('gives every option a label and every declared key a description', function () {
		for (var def of definitions()) {
			if (!def.options) continue;
			for (var opt of def.options) {
				assert.ok(opt.value, def.key + ' has an option with no value');
				assert.ok(opt.label, def.key + ' option ' + opt.value + ' has no label');
			}
			assert.ok(def.description, def.key + ' has options but no description');
		}
	});

	it('has no duplicate values within one key', function () {
		for (var def of definitions()) {
			if (!def.options) continue;
			var vals = def.options.map(function (o) { return o.value; });
			assert.strictEqual(new Set(vals).size, vals.length, def.key + ' has duplicate options');
		}
	});

	it('keeps every option default consistent across all declared keys', function () {
		// zmodem_default_crc had the same shape as the relay mode and the same
		// gap, so the check is written against every key rather than one.
		for (var def of definitions()) {
			if (!def.options) continue;
			assert.ok(def.options.some(function (o) { return o.value === def.defaultValue; }),
				def.key + ' default ' + def.defaultValue + ' is not one of its options');
		}
	});
});

describe('config UI rendering of option keys', function () {
	before(function () { if (!defaults || !pug) this.skip(); });

	function render(setting) {
		var fn = pug.compileFile('src/views/admin/config/index.pug');
		return fn({
			sufficientAccess: true, title: 'Config', activelink: 'config',
			currentuser: { username: 'sysop' }, categories: ['network'],
			settings: [setting], envFilePath: '/x/.env', envDivergence: [],
			boardname: 'C', faviconlink: '/f.ico', currentPath: '/admin/config', flash: null
		});
	}

	function relaySetting(over) {
		return Object.assign({
			key: 'netmail_relay_mode', type: 'string', category: 'network',
			description: 'Whether this system carries netmail for other nodes.',
			value: 'nodelist', source: 'db', restart: false, defaultValue: 'nodelist',
			options: byKey('netmail_relay_mode').options
		}, over || {});
	}

	it('offers the values instead of a free text box', function () {
		var html = render(relaySetting());
		assert.ok(/<select[^>]*id="cfg_netmail_relay_mode"/.test(html), 'should be a select');
		assert.ok(!/<input[^>]*id="cfg_netmail_relay_mode"/.test(html),
			'a text input lets a sysop store a value nothing will honour');
	});

	it('renders every declared value as a choice', function () {
		var html = render(relaySetting());
		['nodelist', 'off', 'on'].forEach(function (v) {
			assert.ok(html.indexOf('value="' + v + '"') !== -1, 'missing option ' + v);
		});
	});

	it('marks the configured value as selected', function () {
		var html = render(relaySetting({ value: 'on' }));
		assert.ok(/value="on"[^>]*selected|selected[^>]*value="on"/.test(html),
			'the current value must come back selected or saving the form would change it');
	});

	it('shows the hint for the value in effect', function () {
		// The description says what the setting is. The hint says what this
		// particular choice does, which is the part a sysop is deciding on.
		assert.ok(render(relaySetting({ value: 'on' })).indexOf('Relay anything') !== -1);
	});

	it('disables the select when the value comes from the environment', function () {
		assert.ok(/<select[^>]*disabled/.test(render(relaySetting({ source: 'env' }))));
	});

	it('leaves an ordinary string key as a text input', function () {
		var html = render({
			key: 'boardname', type: 'string', category: 'network', description: 'Board name',
			value: 'Canectic', source: 'db', restart: false, defaultValue: '', options: null
		});
		assert.ok(/<input[^>]*id="cfg_boardname"/.test(html));
		assert.ok(!/<select[^>]*id="cfg_boardname"/.test(html));
	});
});

describe('configDefaults.isAllowedValue', function () {
	before(function () {
		if (!defaults || typeof defaults.isAllowedValue !== 'function') this.skip();
	});

	// This is what the admin save route calls. It lives in configDefaults
	// rather than in the route because the point is that nothing should be
	// able to store a value the consumers will not honour, and the admin form
	// is only the most likely way in.

	it('accepts every declared value', function () {
		['nodelist', 'off', 'on'].forEach(function (v) {
			assert.strictEqual(defaults.isAllowedValue('netmail_relay_mode', v), true, v);
		});
	});

	it('refuses a plausible near miss', function () {
		// The failure this exists for. "nodelists" or "Nodelist" would save
		// happily, then resolve to off, and the settings page would go on
		// showing the typo as though it were in effect.
		assert.strictEqual(defaults.isAllowedValue('netmail_relay_mode', 'nodelists'), false);
		assert.strictEqual(defaults.isAllowedValue('netmail_relay_mode', 'Nodelist'), false);
		assert.strictEqual(defaults.isAllowedValue('netmail_relay_mode', 'true'), false);
		assert.strictEqual(defaults.isAllowedValue('netmail_relay_mode', ''), false);
	});

	it('is exact, not fuzzy, so nothing is accepted by accident', function () {
		assert.strictEqual(defaults.isAllowedValue('netmail_relay_mode', ' on'), false);
		assert.strictEqual(defaults.isAllowedValue('netmail_relay_mode', 'on '), false);
		assert.strictEqual(defaults.isAllowedValue('netmail_relay_mode', 'ON'), false);
	});

	it('guards the other option key too', function () {
		assert.strictEqual(defaults.isAllowedValue('zmodem_default_crc', 'auto'), true);
		assert.strictEqual(defaults.isAllowedValue('zmodem_default_crc', 'crc32'), false);
	});

	it('permits anything for a key with no declared options', function () {
		// Most keys are free text and must stay that way.
		assert.strictEqual(defaults.isAllowedValue('boardname', 'Anything At All'), true);
		assert.strictEqual(defaults.isAllowedValue('boardname', ''), true);
	});

	it('permits anything for a key it does not know', function () {
		assert.strictEqual(defaults.isAllowedValue('no_such_key_at_all', 'x'), true);
	});
});
