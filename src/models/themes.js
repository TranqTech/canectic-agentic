// src/models/themes.js
// PostgreSQL-backed terminal color theme management.

import * as postgres from '../middleware/db/postgres.js';
import { readFileSync } from 'fs';
import * as path from 'path';

// Theme color property definitions — used by admin UI for building the editor.
// Each entry: { key, label, category } where category groups related colors.
var THEME_PROPERTIES = [
	// General UI
	{ key: 'title_clr',          label: 'Title',                category: 'General' },
	{ key: 'title_bg',           label: 'Title Background',     category: 'General' },
	{ key: 'header_clr',         label: 'Header',               category: 'General' },
	{ key: 'header_border_clr',  label: 'Header Border',        category: 'General' },
	{ key: 'box_border_clr',     label: 'Box Border',           category: 'General' },
	{ key: 'list_border_clr',    label: 'List Border',          category: 'General' },
	{ key: 'df_clr',             label: 'Default Text',         category: 'General' },
	{ key: 'label_clr',          label: 'Label',                category: 'General' },
	{ key: 'error_clr',          label: 'Error',                category: 'General' },
	{ key: 'warn_clr',           label: 'Warning',              category: 'General' },
	{ key: 'progress_clr',       label: 'Progress',             category: 'General' },
	{ key: 'time_clr',           label: 'Time Display',         category: 'General' },
	{ key: 'ver_clr',            label: 'Version',              category: 'General' },

	// Board / System
	{ key: 'board_name_clr',     label: 'Board Name',           category: 'System' },
	{ key: 'board_loc_clr',      label: 'Board Location',       category: 'System' },

	// Menu
	{ key: 'prompt_clr',         label: 'Prompt',               category: 'Menu' },
	{ key: 'menu_prompt_clr',    label: 'Menu Prompt',          category: 'Menu' },
	{ key: 'hotkey_clr',         label: 'Hotkey',               category: 'Menu' },
	{ key: 'cmd_clr',            label: 'Command',              category: 'Menu' },
	{ key: 'opt_clr',            label: 'Option',               category: 'Menu' },
	{ key: 'featured_clr',       label: 'Featured',             category: 'Menu' },

	// Lightbar
	{ key: 'lb_clr',             label: 'Lightbar',             category: 'Lightbar' },
	{ key: 'lb_cmd_clr',         label: 'Lightbar Command',     category: 'Lightbar' },
	{ key: 'lb_opt_clr',         label: 'Lightbar Option',      category: 'Lightbar' },

	// Input / Auth
	{ key: 'input_clr',          label: 'Input',                category: 'Input' },
	{ key: 'field_clr',          label: 'Field',                category: 'Input' },
	{ key: 'uname_clr',          label: 'Username',             category: 'Input' },
	{ key: 'uname_label_clr',    label: 'Username Label',       category: 'Input' },
	{ key: 'passwd_clr',         label: 'Password',             category: 'Input' },
	{ key: 'passwd_label_clr',   label: 'Password Label',       category: 'Input' },

	// Editor
	{ key: 'editor_prompt_clr',  label: 'Editor Prompt',        category: 'Editor' },

	// Messages
	{ key: 'msg_clr',            label: 'Message',              category: 'Messages' },
	{ key: 'msg_body_clr',       label: 'Message Body',         category: 'Messages' },
	{ key: 'msg_quote_clr',      label: 'Quoted Text',          category: 'Messages' },
	{ key: 'msg_tear_clr',       label: 'Tearline',             category: 'Messages' },
	{ key: 'msg_origin_clr',     label: 'Origin Line',          category: 'Messages' },
	{ key: 'msg_tagline_clr',    label: 'Tagline',              category: 'Messages' },

	// Layout
	{ key: 'msg_x_margin',       label: 'Message X Margin',     category: 'Layout' },
	{ key: 'msg_y_margin',       label: 'Message Y Margin',     category: 'Layout' },
];

// All color column keys (excludes non-color fields like margins, slug, name, etc.)
var COLOR_KEYS = THEME_PROPERTIES.filter(function(p) {
	return p.key.endsWith('_clr') || p.key === 'title_bg';
}).map(function(p) { return p.key; });

// All property keys (includes margins)
var ALL_PROPERTY_KEYS = THEME_PROPERTIES.map(function(p) { return p.key; });

// --- Theme CRUD ---

async function getAllThemes() {
	var themes = await postgres.query(
		'SELECT * FROM themes ORDER BY is_default DESC, name ASC'
	);
	return themes || [];
}

async function getThemeById(id) {
	return await postgres.queryOne('SELECT * FROM themes WHERE id = $1', [id]);
}

async function getThemeBySlug(slug) {
	return await postgres.queryOne('SELECT * FROM themes WHERE slug = $1', [slug]);
}

async function getDefaultTheme() {
	var theme = await postgres.queryOne('SELECT * FROM themes WHERE is_default = true');
	if (!theme) {
		// Fall back to first theme
		theme = await postgres.queryOne('SELECT * FROM themes ORDER BY id ASC LIMIT 1');
	}
	return theme;
}

async function createTheme(data) {
	var result = { status: false, errormessages: [], themeId: null };

	var slug = (data.slug || '').trim().toLowerCase();
	if (!slug) {
		result.errormessages.push('Slug is required');
		return result;
	}
	if (!/^[a-z0-9_-]+$/.test(slug)) {
		result.errormessages.push('Slug must contain only lowercase letters, numbers, hyphens, and underscores');
		return result;
	}

	var name = (data.name || '').trim();
	if (!name) {
		result.errormessages.push('Name is required');
		return result;
	}

	var existing = await postgres.queryOne('SELECT id FROM themes WHERE slug = $1', [slug]);
	if (existing) {
		result.errormessages.push('A theme with that slug already exists');
		return result;
	}

	var obj = {
		slug: slug,
		name: name,
		description: (data.description || '').trim() || null,
		is_default: false,
		created_at: new Date(),
		updated_at: new Date()
	};

	// Copy color properties
	for (var i = 0; i < ALL_PROPERTY_KEYS.length; i++) {
		var key = ALL_PROPERTY_KEYS[i];
		if (data[key] !== undefined && data[key] !== '') {
			obj[key] = parseInt(data[key]);
			if (isNaN(obj[key])) obj[key] = 0;
		}
	}

	var insertResult = await postgres.insertObject(obj, 'themes');
	if (insertResult.status) {
		result.status = true;
		result.themeId = insertResult.insertId;
	} else {
		result.errormessages.push('Database insert failed');
	}
	return result;
}

async function updateTheme(id, data) {
	var result = { status: false, errormessages: [] };

	// If slug is changing, check uniqueness
	if (data.slug) {
		var slug = data.slug.trim().toLowerCase();
		if (!/^[a-z0-9_-]+$/.test(slug)) {
			result.errormessages.push('Slug must contain only lowercase letters, numbers, hyphens, and underscores');
			return result;
		}
		var existing = await postgres.queryOne('SELECT id FROM themes WHERE slug = $1 AND id != $2', [slug, id]);
		if (existing) {
			result.errormessages.push('A theme with that slug already exists');
			return result;
		}
	}

	var obj = {
		name: (data.name || '').trim(),
		description: (data.description || '').trim() || null,
		updated_at: new Date()
	};

	if (data.slug) {
		obj.slug = data.slug.trim().toLowerCase();
	}

	// Copy color properties
	for (var i = 0; i < ALL_PROPERTY_KEYS.length; i++) {
		var key = ALL_PROPERTY_KEYS[i];
		if (data[key] !== undefined && data[key] !== '') {
			obj[key] = parseInt(data[key]);
			if (isNaN(obj[key])) obj[key] = 0;
		}
	}

	await postgres.updateById(id, obj, 'themes');
	result.status = true;
	return result;
}

async function deleteTheme(id) {
	// Do not delete the default theme
	var theme = await postgres.queryOne('SELECT is_default FROM themes WHERE id = $1', [id]);
	if (theme && theme.is_default) {
		return { status: false, errormessages: ['Cannot delete the default theme'] };
	}
	await postgres.write('DELETE FROM themes WHERE id = $1', [id]);
	return { status: true };
}

async function setDefaultTheme(id) {
	// Clear existing default
	await postgres.write('UPDATE themes SET is_default = false WHERE is_default = true', []);
	// Set new default
	await postgres.write('UPDATE themes SET is_default = true WHERE id = $1', [id]);
	return { status: true };
}

async function duplicateTheme(id, newSlug, newName) {
	var source = await getThemeById(id);
	if (!source) return { status: false, errormessages: ['Source theme not found'] };

	var data = Object.assign({}, source);
	delete data.id;
	delete data.created_at;
	delete data.updated_at;
	data.slug = newSlug;
	data.name = newName;
	data.is_default = false;

	return await createTheme(data);
}

// Convert a theme row to the plain object shape that handlers expect (same as old JSON files)
function themeToConfig(row) {
	if (!row) return {};
	var config = {};
	for (var i = 0; i < ALL_PROPERTY_KEYS.length; i++) {
		var key = ALL_PROPERTY_KEYS[i];
		if (row[key] !== undefined && row[key] !== null) {
			config[key] = row[key];
		}
	}
	return config;
}

function getThemeProperties() {
	return THEME_PROPERTIES;
}

function getColorKeys() {
	return COLOR_KEYS;
}

function getPropertyCategories() {
	var cats = [];
	var seen = {};
	for (var i = 0; i < THEME_PROPERTIES.length; i++) {
		if (!seen[THEME_PROPERTIES[i].category]) {
			cats.push(THEME_PROPERTIES[i].category);
			seen[THEME_PROPERTIES[i].category] = true;
		}
	}
	return cats;
}

// Seed the default theme from the legacy JSON file if no themes exist in DB
async function seedDefaultTheme() {
	var existing = await postgres.query('SELECT id FROM themes LIMIT 1');
	if (existing && existing.length > 0) return; // Already seeded

	var jsonPath = path.join(path.dirname('./'), 'config', 'themes', 'canectic.json');
	try {
		var jsonData = JSON.parse(readFileSync(jsonPath, 'utf8'));
		var data = Object.assign({}, jsonData, {
			slug: 'canectic',
			name: 'Canectic',
			description: 'Default system theme',
			is_default: true
		});
		// Use direct insert to bypass createTheme's is_default=false override
		var obj = {
			slug: data.slug,
			name: data.name,
			description: data.description,
			is_default: true,
			created_at: new Date(),
			updated_at: new Date()
		};
		for (var i = 0; i < ALL_PROPERTY_KEYS.length; i++) {
			var key = ALL_PROPERTY_KEYS[i];
			if (data[key] !== undefined) {
				obj[key] = parseInt(data[key]);
				if (isNaN(obj[key])) obj[key] = 0;
			}
		}
		await postgres.insertObject(obj, 'themes');
	} catch (_) {
		// JSON file missing or parse error — table will just be empty until admin creates a theme
	}
}

export {
	getAllThemes,
	getThemeById,
	getThemeBySlug,
	getDefaultTheme,
	createTheme,
	updateTheme,
	deleteTheme,
	setDefaultTheme,
	duplicateTheme,
	themeToConfig,
	getThemeProperties,
	seedDefaultTheme,
	getColorKeys,
	getPropertyCategories
};
