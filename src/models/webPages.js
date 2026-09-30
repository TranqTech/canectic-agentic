// webPages.js -- Pages the sysop writes for the website (#91 phase 4).
//
// A page is HTML written in the admin's editor, served at /page/<slug>,
// with the same who-sees-it rules as a navigation link. The navigation bar
// can link to one and the web call flow can show one as a stage (the web
// counterpart of the terminal's displayScreen); both refer to a page by its
// id, so changing a page's address never breaks them.
//
// Body HTML is the sysop's, rendered as written, as bulletins and
// announcements are: only admins can write it.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { checkEntryAccess, parseFlags } from '../utils/areaAccess.js';

var AUDIENCES = Object.freeze([
	{ value: 'all',    label: 'Everyone' },
	{ value: 'public', label: 'Visitors who are not logged in' },
	{ value: 'users',  label: 'Logged-in users' }
]);

var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** An address made from a title: "House Rules!" -> "house-rules". */
function slugify(title) {
	return String(title || '').toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
		.replace(/-+$/g, '');
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

/** Check a page from the admin form. Pure. Returns { page, errors }. */
function validatePage(form) {
	form = form || {};
	var errors = [];
	var title = typeof form.title === 'string' ? form.title.trim() : '';
	if (!title) errors.push('A title is required');
	else if (title.length > 128) errors.push('The title can be at most 128 characters');

	var slug = typeof form.slug === 'string' ? form.slug.trim().toLowerCase() : '';
	if (!slug) slug = slugify(title);
	if (!SLUG_RE.test(slug)) errors.push('The address may use lower-case letters, digits and hyphens, up to 64, not starting or ending with a hyphen');

	var audience = form.audience || 'all';
	if (!AUDIENCES.some(function (a) { return a.value === audience; })) errors.push('Choose who can read the page');

	var minSecurity = null;
	if (form.min_security !== undefined && form.min_security !== null && String(form.min_security).trim() !== '') {
		minSecurity = parseInt(form.min_security, 10);
		if (!/^\s*\d+\s*$/.test(String(form.min_security)) || minSecurity > 255) {
			errors.push('Security must be a whole number from 0 to 255, or blank');
			minSecurity = null;
		}
	}

	var body = typeof form.body_html === 'string' ? form.body_html.trim() : '';
	return {
		errors: errors,
		page: {
			slug: slug,
			title: title,
			show_title: form.show_title === undefined ? true : toBool(form.show_title),
			body_html: body || null,
			audience: audience,
			min_security: minSecurity,
			required_flags: toFlagList(form.required_flags),
			prohibited_flags: toFlagList(form.prohibited_flags),
			active: form.active === undefined ? true : toBool(form.active)
		}
	};
}

/** Whether this visitor (a session user, or null) may read the page. */
function pageVisibleTo(page, user) {
	if (!page || !page.active) return false;
	if (page.audience === 'public' && user) return false;
	if (page.audience === 'users' && !user) return false;
	return checkEntryAccess(user || null, page);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function normaliseRow(r) {
	return Object.assign({}, r, {
		required_flags: parseFlags(r.required_flags),
		prohibited_flags: parseFlags(r.prohibited_flags)
	});
}

// The navigation bar asks on every page view: cached, cleared by writes
// here, expiring on its own so another process's edit shows within a minute.
var CACHE_MS = 60000;
var _cache = null;
var _cacheAt = 0;

function invalidateCache() {
	_cache = null;
	_cacheAt = 0;
}

async function getAllPages() {
	var rows = await postgres.query('SELECT * FROM web_pages ORDER BY title ASC, id ASC', []);
	return (rows || []).map(normaliseRow);
}

/**
 * Every page by id, without bodies, for deciding who sees a link to one.
 * An empty map when the table cannot be read, which hides page links rather
 * than showing links to pages nobody can check.
 */
async function getPagesForRender() {
	if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
	var map = new Map();
	try {
		var rows = await postgres.query(
			'SELECT id, slug, title, audience, min_security, required_flags, prohibited_flags, active FROM web_pages', []);
		for (var r of rows || []) map.set(r.id, normaliseRow(r));
	} catch (err) {
		alogger.writeAlog(1, 'Web pages: could not read web_pages: ' + err.message, 'redbright');
	}
	_cache = map;
	_cacheAt = Date.now();
	return map;
}

async function getPageById(id) {
	var n = parseInt(id, 10);
	if (!(n > 0)) return null;
	var row = await postgres.queryOne('SELECT * FROM web_pages WHERE id = $1', [n]);
	return row ? normaliseRow(row) : null;
}

async function getPageBySlug(slug) {
	if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
	var row = await postgres.queryOne('SELECT * FROM web_pages WHERE slug = $1', [slug]);
	return row ? normaliseRow(row) : null;
}

function dbObject(page) {
	return Object.assign({}, page, {
		required_flags: JSON.stringify(page.required_flags),
		prohibited_flags: JSON.stringify(page.prohibited_flags)
	});
}

async function slugTaken(slug, exceptId) {
	var row = await postgres.queryOne('SELECT id FROM web_pages WHERE slug = $1', [slug]);
	return !!row && row.id !== exceptId;
}

async function createPage(form) {
	var result = { status: false, errormessages: [], insertId: 0 };
	var checked = validatePage(form);
	if (checked.errors.length) { result.errormessages = checked.errors; return result; }
	if (await slugTaken(checked.page.slug, null)) { result.errormessages.push('Another page already uses the address /page/' + checked.page.slug); return result; }
	var obj = dbObject(checked.page);
	obj.created_at = new Date();
	var dbres = await postgres.insertObject(obj, 'web_pages');
	if (!dbres.status) { result.errormessages = dbres.errormessages || ['Could not save the page']; return result; }
	invalidateCache();
	result.status = true;
	result.insertId = dbres.insertId;
	alogger.writeAlog(5, 'Web pages: created /page/' + checked.page.slug, 'greenbright');
	return result;
}

async function updatePage(id, form) {
	var result = { status: false, errormessages: [] };
	var existing = await getPageById(id);
	if (!existing) { result.errormessages.push('That page no longer exists'); return result; }
	var checked = validatePage(form);
	if (checked.errors.length) { result.errormessages = checked.errors; return result; }
	if (await slugTaken(checked.page.slug, existing.id)) { result.errormessages.push('Another page already uses the address /page/' + checked.page.slug); return result; }
	var obj = dbObject(checked.page);
	obj.updated_at = new Date();
	var count = await postgres.updateById(existing.id, obj, 'web_pages');
	if (!count) { result.errormessages.push('Could not save the page'); return result; }
	invalidateCache();
	result.status = true;
	alogger.writeAlog(5, 'Web pages: saved /page/' + checked.page.slug, 'greenbright');
	return result;
}

/**
 * Where a page is used: navigation links and web call flow stages. A page
 * that is used cannot be removed, since a link or stage pointing at nothing
 * is a silent hole; the sysop is told where to take it out.
 */
async function usesOf(id) {
	var uses = [];
	var links = await postgres.query("SELECT label FROM web_nav_items WHERE target_type = 'page' AND target = $1", [String(id)]) || [];
	for (var l of links) uses.push('the navigation link ' + l.label);
	var flow = await postgres.queryOne("SELECT stages FROM call_flows WHERE kind = 'web' ORDER BY is_system DESC, id ASC LIMIT 1", []);
	var stages = flow ? (typeof flow.stages === 'string' ? JSON.parse(flow.stages) : flow.stages) : [];
	if ((stages || []).some(function (s) { return s && s.stage === 'page' && s.options && Number(s.options.page) === Number(id); })) {
		uses.push('the web call flow');
	}
	// The home page layouts. The table is newer than web_pages, so a board
	// whose database update has not created it has no home page uses
	try {
		var homes = await postgres.query('SELECT audience, blocks FROM web_home_layouts', []) || [];
		for (var h of homes) {
			var blocks = typeof h.blocks === 'string' ? JSON.parse(h.blocks) : h.blocks;
			if ((blocks || []).some(function (s) { return s && s.stage === 'page' && s.options && Number(s.options.page) === Number(id); })) {
				uses.push(h.audience === 'users' ? 'the home page for logged-in users' : 'the home page for visitors');
			}
		}
	} catch (_) { /* no layouts table yet */ }
	return uses;
}

/**
 * For a list of web blocks about to be saved (a call flow or a home page
 * layout): an error for each Page block naming a page that does not exist.
 * The catalog cannot check this, since it reads no database. A draft is
 * fine: the block is simply skipped while it is one.
 */
async function missingPages(stages) {
	var errors = [];
	for (var st of stages || []) {
		if (!st || st.stage !== 'page' || !st.options) continue;
		var row = await postgres.queryOne('SELECT id FROM web_pages WHERE id = $1', [st.options.page]);
		if (!row) errors.push('Page: there is no page ' + st.options.page + ' (it may have been removed)');
	}
	return errors;
}

async function deletePage(id) {
	var result = { status: false, errormessages: [] };
	var existing = await getPageById(id);
	if (!existing) { result.errormessages.push('That page no longer exists'); return result; }
	var uses = await usesOf(existing.id);
	if (uses.length) { result.errormessages.push(existing.title + ' is used by ' + uses.join(' and ') + '; take it out there first, or untick Published to hide it'); return result; }
	var err = await postgres.write('DELETE FROM web_pages WHERE id = $1', [existing.id]);
	if (err) { result.errormessages.push('Could not remove the page: ' + err.message); return result; }
	invalidateCache();
	result.status = true;
	alogger.writeAlog(5, 'Web pages: removed /page/' + existing.slug, 'greenbright');
	return result;
}

export {
	AUDIENCES,
	SLUG_RE,
	slugify,
	validatePage,
	pageVisibleTo,
	invalidateCache,
	getAllPages,
	getPagesForRender,
	getPageById,
	getPageBySlug,
	createPage,
	updatePage,
	usesOf,
	missingPages,
	deletePage
};
