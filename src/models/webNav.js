// webNav.js -- The sysop-editable web navigation bar (#91 phase 3).
//
// The left side of the user navbar used to be written into
// src/views/includes/user-nav.pug, which is code: a sysop could not rename,
// hide, reorder or add a link, and editing the template was undone by the
// next update. It is now rows of web_nav_items, edited at /admin/webnav.
//
// The right side (Dashboard, Mail, notifications, the user menu, Login)
// stays in the template on purpose: it is how a sysop reaches the admin and
// how anyone logs in or out, so it must not be removable from a web page.
//
// Hiding a link is not disabling a feature. The page stays reachable by its
// address; this decides only what the bar shows.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';
import { checkEntryAccess, parseFlags } from '../utils/areaAccess.js';

// Pages a link can point at by name. activelink is what the page's route
// passes its view, so the bar can highlight it; pages that pass nothing are
// matched on their path instead. enabledKey hides the link while the
// feature it leads to is switched off.
var BUILTINS = Object.freeze([
	{ key: 'messages',      label: 'Messages',      href: '/messages',      activelink: 'messages' },
	{ key: 'files',         label: 'Files',         href: '/files',         activelink: 'files' },
	{ key: 'doors',         label: 'Doors',         href: '/doors',         activelink: 'doors' },
	{ key: 'chat',          label: 'Chat',          href: '/whosonline',    activelink: 'chat' },
	{ key: 'wall',          label: 'Wall',          href: '/wall',          activelink: 'wall' },
	{ key: 'bulletins',     label: 'Bulletins',     href: '/bulletins' },
	{ key: 'stats',         label: 'System Info',   href: '/stats' },
	{ key: 'notifications', label: 'Notifications', href: '/notifications' },
	{ key: 'qwk',           label: 'QWK',           href: '/qwk',           enabledKey: 'qwk_enabled' },
	{ key: 'doorserver',    label: 'Door Server',   href: '/doorserver',    enabledKey: 'doorserver_enabled' }
].map(Object.freeze));

var TARGET_TYPES = Object.freeze([
	{ value: 'builtin',  label: 'A page on this board' },
	{ value: 'url',      label: 'An address (another site, or a path here)' },
	{ value: 'dropdown', label: 'A menu holding other links' }
]);

var AUDIENCES = Object.freeze([
	{ value: 'all',    label: 'Everyone' },
	{ value: 'public', label: 'Visitors who are not logged in' },
	{ value: 'users',  label: 'Logged-in users' }
]);

// The bar as it has always been: what an empty table is seeded with, and
// what is drawn if the table cannot be read.
var DEFAULT_ITEMS = Object.freeze(['messages', 'files', 'doors', 'chat', 'wall'].map(function (key, i) {
	var b = builtin(key);
	return Object.freeze({
		id: -(i + 1), parent_id: null, sort_order: (i + 1) * 10,
		label: b.label, icon: null, target_type: 'builtin', target: key,
		new_tab: false, audience: 'all', min_security: null,
		required_flags: [], prohibited_flags: [], active: true
	});
}));

function builtin(key) {
	for (var b of BUILTINS) if (b.key === key) return b;
	return null;
}

function hasValue(list, v) {
	return list.some(function (x) { return x.value === v; });
}

function toFlagList(v) {
	if (v === undefined || v === null || v === '') return [];
	if (Array.isArray(v)) return v.map(String).map(function (s) { return s.trim(); }).filter(Boolean);
	var parsed = parseFlags(v);
	if (parsed.length) return parsed.map(String);
	return String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function toBool(v) {
	return v === true || v === 'true' || v === 'on' || v === '1' || v === 1;
}

// An address a link may carry: http(s) anywhere, or a path on this board.
// Anything else (javascript:, data:, a protocol-relative //host) is refused,
// since the bar is on every page.
function isAllowedUrl(u) {
	if (typeof u !== 'string' || !u || u.length > 512 || /\s/.test(u)) return false;
	if (/^https?:\/\/[^/\\]/i.test(u)) return true;
	return u.charAt(0) === '/' && u.charAt(1) !== '/' && u.charAt(1) !== '\\';
}

/**
 * Check a link from the admin form. Pure: whether a parent exists and is a
 * menu is the caller's to check against the database.
 * Returns { item, errors }.
 */
function validateItem(form) {
	form = form || {};
	var errors = [];
	var label = typeof form.label === 'string' ? form.label.trim() : '';
	if (!label) errors.push('A label is required');
	else if (label.length > 64) errors.push('The label can be at most 64 characters');

	var icon = typeof form.icon === 'string' ? form.icon.trim().replace(/^bi-/, '') : '';
	if (icon && !/^[a-z0-9-]{1,64}$/.test(icon)) errors.push('The icon is a Bootstrap icon name, such as chat-dots');

	var type = form.target_type || 'builtin';
	if (!hasValue(TARGET_TYPES, type)) errors.push('Choose what the link points at');

	var target = typeof form.target === 'string' ? form.target.trim() : '';
	if (type === 'builtin' && !builtin(target)) errors.push('Choose a page on this board');
	if (type === 'url' && !isAllowedUrl(target)) errors.push('The address must start with http://, https:// or / (a path on this board)');
	if (type === 'dropdown') target = null;

	var parentId = (form.parent_id === undefined || form.parent_id === null || form.parent_id === '') ? null : parseInt(form.parent_id, 10);
	if (parentId !== null && !(parentId > 0)) errors.push('Choose a menu to put the link in, or none');
	if (type === 'dropdown' && parentId !== null) errors.push('A menu cannot go inside another menu');

	var audience = form.audience || 'all';
	if (!hasValue(AUDIENCES, audience)) errors.push('Choose who sees the link');

	var minSecurity = null;
	if (form.min_security !== undefined && form.min_security !== null && String(form.min_security).trim() !== '') {
		minSecurity = parseInt(form.min_security, 10);
		if (!Number.isInteger(minSecurity) || minSecurity < 0 || minSecurity > 255 || !/^\s*\d+\s*$/.test(String(form.min_security))) {
			errors.push('Security must be a whole number from 0 to 255, or blank');
			minSecurity = null;
		}
	}

	return {
		errors: errors,
		item: {
			parent_id: parentId,
			label: label,
			icon: icon || null,
			target_type: type,
			target: target || null,
			new_tab: type === 'dropdown' ? false : toBool(form.new_tab),
			audience: audience,
			min_security: minSecurity,
			required_flags: toFlagList(form.required_flags),
			prohibited_flags: toFlagList(form.prohibited_flags),
			active: form.active === undefined ? true : toBool(form.active)
		}
	};
}

// ---------------------------------------------------------------------------
// What one visitor sees
// ---------------------------------------------------------------------------

function isActivePath(href, path) {
	if (!href || !path || href.charAt(0) !== '/' || href === '/') return false;
	return path === href || path.indexOf(href + '/') === 0;
}

function visibleTo(item, user, isEnabled) {
	if (!item.active) return false;
	if (item.audience === 'public' && user) return false;
	if (item.audience === 'users' && !user) return false;
	if (!checkEntryAccess(user, item)) return false;
	if (item.target_type === 'builtin') {
		var b = builtin(item.target);
		if (!b) return false;
		if (b.enabledKey && !isEnabled(b.enabledKey)) return false;
	}
	return true;
}

function linkFor(item, ctx) {
	var href = null, active = false;
	if (item.target_type === 'builtin') {
		var b = builtin(item.target);
		href = b.href;
		active = (b.activelink && ctx.activelink === b.activelink) || isActivePath(b.href, ctx.path);
	} else if (item.target_type === 'url') {
		href = item.target;
		active = isActivePath(item.target, ctx.path);
	}
	return {
		label: item.label,
		icon: item.icon || null,
		href: href,
		newTab: !!item.new_tab,
		external: /^https?:/i.test(href || ''),
		active: !!active,
		children: []
	};
}

/**
 * The bar for one request, as a tree: [{ label, icon, href, newTab,
 * external, active, children }]. A menu with nothing visible in it is left
 * out, and a link whose parent is gone or not a menu is shown at the top
 * level rather than lost.
 *
 * ctx: { user (session or null), activelink, path, isEnabled(key) }
 */
function buildNav(items, ctx) {
	ctx = ctx || {};
	var isEnabled = ctx.isEnabled || function (key) { return appConfig.getBoolean(key, false); };
	var user = ctx.user || null;
	var rows = (items || []).slice().sort(function (a, b) {
		return (a.sort_order || 0) - (b.sort_order || 0) || (a.id || 0) - (b.id || 0);
	});
	var menus = new Map();
	for (var r of rows) if (r.target_type === 'dropdown' && !r.parent_id) menus.set(r.id, r);

	var top = [];
	var byMenu = new Map();
	for (var row of rows) {
		var inMenu = row.parent_id && menus.has(row.parent_id) && row.target_type !== 'dropdown';
		if (!visibleTo(row, user, isEnabled)) continue;
		if (inMenu) {
			if (!visibleTo(menus.get(row.parent_id), user, isEnabled)) continue;
			if (!byMenu.has(row.parent_id)) byMenu.set(row.parent_id, []);
			byMenu.get(row.parent_id).push(linkFor(row, ctx));
		} else if (row.target_type === 'dropdown') {
			if (row.parent_id) continue;
			var menu = linkFor(row, ctx);
			menu.id = row.id;
			top.push(menu);
		} else {
			top.push(linkFor(row, ctx));
		}
	}
	return top.filter(function (link) {
		if (link.id === undefined) return true;
		link.children = byMenu.get(link.id) || [];
		link.active = link.children.some(function (c) { return c.active; });
		delete link.id;
		return link.children.length > 0;
	});
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Every page asks, so the rows are cached; writes here clear it, and it
// expires on its own so an edit made by another process shows within a
// minute rather than at the next restart.
var CACHE_MS = 60000;
var _cache = null;
var _cacheAt = 0;

function invalidateCache() {
	_cache = null;
	_cacheAt = 0;
}

function normaliseRow(r) {
	return Object.assign({}, r, {
		required_flags: parseFlags(r.required_flags),
		prohibited_flags: parseFlags(r.prohibited_flags)
	});
}

async function getAllItems() {
	var rows = await postgres.query('SELECT * FROM web_nav_items ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC', []);
	return (rows || []).map(normaliseRow);
}

/**
 * The rows the bar is drawn from. The defaults when the table is empty or
 * cannot be read, so a board is never left without its links.
 */
async function getItemsForRender() {
	if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
	try {
		var rows = await getAllItems();
		_cache = rows.length > 0 ? rows : DEFAULT_ITEMS.slice();
	} catch (err) {
		alogger.writeAlog(1, 'Web nav: could not read web_nav_items, drawing the default bar: ' + err.message, 'redbright');
		_cache = DEFAULT_ITEMS.slice();
	}
	_cacheAt = Date.now();
	return _cache;
}

async function getItemById(id) {
	var row = await postgres.queryOne('SELECT * FROM web_nav_items WHERE id = $1', [parseInt(id, 10)]);
	return row ? normaliseRow(row) : null;
}

// The database half of the checks: the parent must exist and be a menu,
// and a menu that holds links must stay a menu.
async function parentProblem(item, selfId) {
	if (item.parent_id === null) return null;
	if (selfId && item.parent_id === selfId) return 'A link cannot go inside itself';
	var parent = await getItemById(item.parent_id);
	if (!parent) return 'That menu no longer exists';
	if (parent.target_type !== 'dropdown') return (parent.label || 'That link') + ' is not a menu';
	if (parent.parent_id) return 'A menu cannot go inside another menu';
	return null;
}

function dbObject(item) {
	return Object.assign({}, item, {
		required_flags: JSON.stringify(item.required_flags),
		prohibited_flags: JSON.stringify(item.prohibited_flags)
	});
}

async function createItem(form) {
	var result = { status: false, errormessages: [], insertId: 0 };
	var checked = validateItem(form);
	if (checked.errors.length) { result.errormessages = checked.errors; return result; }
	var problem = await parentProblem(checked.item, null);
	if (problem) { result.errormessages.push(problem); return result; }

	var last = await postgres.queryOne(
		'SELECT COALESCE(MAX(sort_order), 0) AS m FROM web_nav_items WHERE parent_id IS NOT DISTINCT FROM $1', [checked.item.parent_id]);
	var obj = dbObject(checked.item);
	obj.sort_order = (parseInt(last && last.m, 10) || 0) + 10;
	obj.created_at = new Date();
	var dbres = await postgres.insertObject(obj, 'web_nav_items');
	if (!dbres.status) { result.errormessages = dbres.errormessages || ['Could not save the link']; return result; }
	invalidateCache();
	result.status = true;
	result.insertId = dbres.insertId;
	alogger.writeAlog(5, 'Web nav: added ' + checked.item.label, 'greenbright');
	return result;
}

async function updateItem(id, form) {
	var result = { status: false, errormessages: [] };
	var existing = await getItemById(id);
	if (!existing) { result.errormessages.push('That link no longer exists'); return result; }
	var checked = validateItem(form);
	if (checked.errors.length) { result.errormessages = checked.errors; return result; }
	var problem = await parentProblem(checked.item, existing.id);
	if (problem) { result.errormessages.push(problem); return result; }
	if (existing.target_type === 'dropdown' && checked.item.target_type !== 'dropdown') {
		var kids = await postgres.queryOne('SELECT COUNT(*)::int AS n FROM web_nav_items WHERE parent_id = $1', [existing.id]);
		if (kids && kids.n > 0) { result.errormessages.push(existing.label + ' holds links; move or remove them before it stops being a menu'); return result; }
	}
	var obj = dbObject(checked.item);
	obj.updated_at = new Date();
	if (obj.parent_id !== existing.parent_id) {
		var last = await postgres.queryOne(
			'SELECT COALESCE(MAX(sort_order), 0) AS m FROM web_nav_items WHERE parent_id IS NOT DISTINCT FROM $1', [obj.parent_id]);
		obj.sort_order = (parseInt(last && last.m, 10) || 0) + 10;
	}
	var count = await postgres.updateById(existing.id, obj, 'web_nav_items');
	if (!count) { result.errormessages.push('Could not save the link'); return result; }
	invalidateCache();
	result.status = true;
	alogger.writeAlog(5, 'Web nav: saved ' + checked.item.label, 'greenbright');
	return result;
}

async function deleteItem(id) {
	var result = { status: false, errormessages: [] };
	var existing = await getItemById(id);
	if (!existing) { result.errormessages.push('That link no longer exists'); return result; }
	var kids = await postgres.queryOne('SELECT COUNT(*)::int AS n FROM web_nav_items WHERE parent_id = $1', [existing.id]);
	if (kids && kids.n > 0) { result.errormessages.push(existing.label + ' holds links; move or remove them first'); return result; }
	var err = await postgres.write('DELETE FROM web_nav_items WHERE id = $1', [existing.id]);
	if (err) { result.errormessages.push('Could not remove the link: ' + err.message); return result; }
	invalidateCache();
	result.status = true;
	alogger.writeAlog(5, 'Web nav: removed ' + existing.label, 'greenbright');
	return result;
}

/**
 * Put links in the order given. ids must all share one parent, since the
 * page reorders within the top level or within one menu.
 */
async function reorderItems(ids) {
	var result = { status: false, errormessages: [] };
	if (!Array.isArray(ids) || ids.length === 0) { result.errormessages.push('Nothing to reorder'); return result; }
	var clean = ids.map(function (x) { return parseInt(x, 10); });
	if (clean.some(function (x) { return !(x > 0); })) { result.errormessages.push('Bad link id'); return result; }
	var rows = await postgres.query('SELECT id, parent_id FROM web_nav_items WHERE id = ANY($1::int[])', [clean]) || [];
	if (rows.length !== clean.length) { result.errormessages.push('Some of those links no longer exist'); return result; }
	var parents = new Set(rows.map(function (r) { return r.parent_id === null ? 'top' : r.parent_id; }));
	if (parents.size !== 1) { result.errormessages.push('Links can only be reordered among their neighbours'); return result; }
	for (var i = 0; i < clean.length; i++) {
		await postgres.write('UPDATE web_nav_items SET sort_order = $1, updated_at = NOW() WHERE id = $2', [(i + 1) * 10, clean[i]]);
	}
	invalidateCache();
	result.status = true;
	return result;
}

/**
 * Seed the bar as it has always been, into an empty table only. Deleting
 * every link therefore brings the defaults back at the next start; to hide
 * them all, switch them off instead.
 */
async function seedDefaults() {
	var row = await postgres.queryOne('SELECT COUNT(*)::int AS n FROM web_nav_items', []);
	if (!row || row.n > 0) return 0;
	var seeded = 0;
	for (var d of DEFAULT_ITEMS) {
		var obj = dbObject(d);
		delete obj.id;
		obj.created_at = new Date();
		var res = await postgres.insertObject(obj, 'web_nav_items');
		if (res && res.status) seeded++;
	}
	invalidateCache();
	if (seeded) alogger.writeAlog(3, '[webNav] Seeded ' + seeded + ' default navigation link(s)', 'cyan');
	return seeded;
}

export {
	BUILTINS,
	TARGET_TYPES,
	AUDIENCES,
	DEFAULT_ITEMS,
	builtin,
	isAllowedUrl,
	validateItem,
	buildNav,
	invalidateCache,
	getAllItems,
	getItemsForRender,
	getItemById,
	createItem,
	updateItem,
	deleteItem,
	reorderItems,
	seedDefaults
};
