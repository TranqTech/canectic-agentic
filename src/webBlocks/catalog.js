// catalog.js -- What each web block is, without what it does (#91).
//
// Names, labels, the settings a sysop can give a block in a flow, and the
// rules for checking a web flow before it is saved. Pure data and pure
// functions with no imports, so the call flow model and the admin page can
// validate a web flow without loading every model a block reads from. The
// implementations in this directory spread their entry from here, so a name
// or label is written once.

var SHOW_ALWAYS = { value: 'always', label: 'Always' };

function countOption(fallback) {
	return { key: 'count', label: 'How many', type: 'number', min: 1, max: 50, default: fallback };
}

var CATALOG = Object.freeze([
	{
		name: 'welcome', label: 'Welcome', requiresUser: false,
		hint: 'Greeting with a random piece of web art.',
		options: []
	},
	{
		name: 'announcements', label: 'Announcements', requiresUser: true,
		hint: 'Shown when there is an announcement new since their last visit, or a pinned one.',
		options: []
	},
	{
		name: 'lastcallers', label: 'Last Callers', requiresUser: false,
		hint: 'The most recent callers, terminal and web.',
		options: [
			{ key: 'show', label: 'Show', type: 'select', default: 'always', choices: [
				SHOW_ALWAYS,
				{ value: 'new', label: 'Only when someone else has called since their last visit' }
			] },
			countOption(15)
		]
	},
	{
		name: 'whosonline', label: "Who's Online", requiresUser: false,
		hint: 'Terminal nodes and web users online now.',
		options: [
			{ key: 'show', label: 'Show', type: 'select', default: 'always', choices: [
				SHOW_ALWAYS,
				{ value: 'others', label: 'Only when someone else is online' }
			] }
		]
	},
	{
		name: 'wall', label: 'The Wall', requiresUser: false,
		hint: 'Recent wall messages, with the post box for users allowed to post.',
		options: [
			{ key: 'show', label: 'Show', type: 'select', default: 'always', choices: [
				SHOW_ALWAYS,
				{ value: 'new', label: 'Only when someone else has posted since their last visit' }
			] },
			countOption(15)
		]
	},
	{
		name: 'newsfiles', label: 'News', requiresUser: false,
		hint: 'Active news and score files. Shown only when there are some.',
		options: []
	},
	{
		name: 'newmsgs', label: 'New Messages', requiresUser: true,
		hint: 'Unread messages in their subscribed areas. Shown only when there are some.',
		options: []
	},
	{
		name: 'newfiles', label: 'New Files', requiresUser: true,
		hint: 'Files new since their previous visit in subscribed file areas. Shown only when there are some.',
		options: []
	}
].map(function (e) {
	e.options = Object.freeze(e.options.map(function (o) {
		if (o.choices) o.choices = Object.freeze(o.choices);
		return Object.freeze(o);
	}));
	return Object.freeze(e);
}));

// The web call flow as it has always been: what the seeded Web flow holds,
// and what runs when there is no web flow in the database at all.
var DEFAULT_WEB_FLOW = Object.freeze([
	'welcome', 'announcements', 'lastcallers', 'whosonline',
	'wall', 'newsfiles', 'newmsgs', 'newfiles'
]);

function catalogEntry(name) {
	if (typeof name !== 'string') return null;
	for (var e of CATALOG) if (e.name === name) return e;
	return null;
}

/** A flow item's block name: items are 'name' or { stage: 'name', options }. */
function stageName(item) {
	if (typeof item === 'string') return item;
	return item && typeof item.stage === 'string' ? item.stage : null;
}

// One option value checked against its definition: the value to store, or
// undefined when it is not acceptable.
function checkOption(def, raw) {
	if (def.type === 'select') {
		for (var c of def.choices) if (c.value === raw) return raw;
		return undefined;
	}
	if (def.type === 'number') {
		var n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? parseInt(raw, 10) : NaN);
		if (!Number.isInteger(n) || n < def.min || n > def.max) return undefined;
		return n;
	}
	return undefined;
}

/**
 * Every option of a block with its value: the stored one when it is valid,
 * else the default. Lenient on purpose, since it runs for every visitor: a
 * value that went bad in the database costs a default, not the page.
 */
function resolveOptions(entry, stored) {
	var out = {};
	if (!entry) return out;
	stored = (stored && typeof stored === 'object') ? stored : {};
	for (var def of entry.options) {
		var v = Object.prototype.hasOwnProperty.call(stored, def.key) ? checkOption(def, stored[def.key]) : undefined;
		out[def.key] = v === undefined ? def.default : v;
	}
	return out;
}

/**
 * Check a web flow before it is saved. Strict, unlike resolveOptions: the
 * sysop is there to be told.
 *
 * Returns { stages, errors }. stages is the normalised form to store:
 * { stage } or { stage, options } with only known, valid option keys.
 * A block may appear once, because its name is its address
 * (/callflow/stage/:name) and where its settings are looked up.
 */
function normaliseWebStages(input) {
	var errors = [];
	var stages = [];
	if (!Array.isArray(input)) return { stages: [], errors: ['Stages must be a list'] };

	var seen = new Set();
	for (var item of input) {
		var name = stageName(item);
		var entry = catalogEntry(name);
		if (!entry) {
			errors.push('Not a web stage: ' + (name === null ? JSON.stringify(item) : name));
			continue;
		}
		if (seen.has(name)) {
			errors.push(entry.label + ' is in the flow twice; a web stage can appear once');
			continue;
		}
		seen.add(name);

		var out = { stage: name };
		var given = (item && typeof item === 'object' && item.options && typeof item.options === 'object') ? item.options : null;
		if (given) {
			var opts = {};
			for (var def of entry.options) {
				if (!Object.prototype.hasOwnProperty.call(given, def.key)) continue;
				var v = checkOption(def, given[def.key]);
				if (v === undefined) {
					errors.push(entry.label + ': ' + def.label + ' ' +
						(def.type === 'number' ? 'must be a whole number from ' + def.min + ' to ' + def.max : 'is not one of the choices'));
					continue;
				}
				opts[def.key] = v;
			}
			if (Object.keys(opts).length > 0) out.options = opts;
		}
		stages.push(out);
	}
	return { stages: stages, errors: errors };
}

/** One line describing a stage's settings, for the admin badge. Empty when all default. */
function describeOptions(entry, stored) {
	if (!entry) return '';
	var resolved = resolveOptions(entry, stored);
	var parts = [];
	for (var def of entry.options) {
		if (resolved[def.key] === def.default) continue;
		if (def.type === 'select') {
			var c = def.choices.find(function (x) { return x.value === resolved[def.key]; });
			parts.push(c ? c.label.toLowerCase() : String(resolved[def.key]));
		} else {
			parts.push(def.label.toLowerCase() + ' ' + resolved[def.key]);
		}
	}
	return parts.join('; ');
}

export {
	CATALOG,
	DEFAULT_WEB_FLOW,
	catalogEntry,
	stageName,
	resolveOptions,
	normaliseWebStages,
	describeOptions
};
