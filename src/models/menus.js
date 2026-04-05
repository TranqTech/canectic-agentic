// src/models/menus.js
// PostgreSQL-backed menu and menu entry management.
// Replaces the hardcoded defaultmenuarray with database queries.

import * as postgres from '../middleware/db/postgres.js';

// Valid display file types — maps to subdirectory in the art file hierarchy.
// drawscreen() in terminalcommands.js resolves:
//   "Screen" → textdir/<format>/screens/<filename>.<ext>  (full-screen art)
//   "Header" → textdir/<format>/headers/<filename>.<ext>  (header art)
//   ""       → textdir/<format>/misc/<filename>.<ext>     (default/misc)
// The filename has no path or extension — the art system resolves those
// by walking the terminal's format priority chain (rip→sixel→utf8→ansi→ascii).
const VALID_DISPLAY_FILE_TYPES = ['', 'Screen', 'Header', 'Welcome'];

// Valid menu types — determines input behavior.
// "Hotkey" = single-keypress dispatch (current handler behavior)
// "Lightbar" = arrow-key navigable highlight bar (future)
const VALID_MENU_TYPES = ['Hotkey', 'Lightbar'];

// Default entries added to every new menu.
// Sysops can modify or delete these after creation.
const DEFAULT_MENU_ENTRIES = [
	{ hotkey: '?', command_name: 'redrawMenu', display: '', sort_order: 9990 },
];

// ANSI color map — value, label, hex color, and fg-* CSS class from styles.css.
// Used by admin views for color select dropdowns with live preview.
// Hex values match the fg-* classes in public/css/styles.css.
const ANSI_COLORS = [
	{ value: 0,  label: 'Black',          hex: '#000000', css: 'fg-black' },
	{ value: 1,  label: 'Red',            hex: '#800000', css: 'fg-red' },
	{ value: 2,  label: 'Green',          hex: '#00af00', css: 'fg-green' },
	{ value: 3,  label: 'Yellow',         hex: '#ffaf00', css: 'fg-yellow' },
	{ value: 4,  label: 'Blue',           hex: '#005fd7', css: 'fg-blue' },
	{ value: 5,  label: 'Magenta',        hex: '#800080', css: 'fg-magenta' },
	{ value: 6,  label: 'Cyan',           hex: '#00d7ff', css: 'fg-cyan' },
	{ value: 7,  label: 'White',          hex: '#808080', css: 'fg-grey' },
	{ value: 8,  label: 'Bright Black',   hex: '#808080', css: 'fg-brightblack' },
	{ value: 9,  label: 'Bright Red',     hex: '#ff0000', css: 'fg-brightred' },
	{ value: 10, label: 'Bright Green',   hex: '#00ff00', css: 'fg-brightgreen' },
	{ value: 11, label: 'Bright Yellow',  hex: '#ffff00', css: 'fg-brightyellow' },
	{ value: 12, label: 'Bright Blue',    hex: '#0087ff', css: 'fg-brightblue' },
	{ value: 13, label: 'Bright Magenta', hex: '#ff00ff', css: 'fg-brightmagenta' },
	{ value: 14, label: 'Bright Cyan',    hex: '#00ffff', css: 'fg-brightcyan' },
	{ value: 15, label: 'Bright White',   hex: '#ffffff', css: 'fg-brightwhite' },
];

// --- Menu CRUD ---

async function getMenu(name) {
	var menu = await postgres.queryOne(
		'SELECT * FROM menus WHERE LOWER(name) = LOWER($1)',
		[name]
	);
	if (!menu) return null;

	var entries = await postgres.query(
		'SELECT * FROM menu_entries WHERE menu_id = $1 ORDER BY sort_order ASC, id ASC',
		[menu.id]
	);

	// Parse JSONB flag columns on each entry
	for (var i = 0; i < entries.length; i++) {
		if (typeof entries[i].required_flags === 'string') {
			try { entries[i].required_flags = JSON.parse(entries[i].required_flags); } catch (_) { entries[i].required_flags = []; }
		}
		if (typeof entries[i].prohibited_flags === 'string') {
			try { entries[i].prohibited_flags = JSON.parse(entries[i].prohibited_flags); } catch (_) { entries[i].prohibited_flags = []; }
		}
		entries[i].required_flags = entries[i].required_flags || [];
		entries[i].prohibited_flags = entries[i].prohibited_flags || [];
	}

	menu.menu_entries = entries;

	// Strip null color values so they arrive as undefined in _applyConfig().
	// The handler checks `config.title_clr !== undefined` — if it sees null
	// it overwrites the theme default, and setfgcolor(null) renders as black.
	var colorKeys = ['title_clr', 'input_clr', 'prompt_clr', 'error_clr', 'hotkey_clr', 'menu_prompt_clr', 'featured_clr'];
	for (var k = 0; k < colorKeys.length; k++) {
		if (menu[colorKeys[k]] === null) {
			delete menu[colorKeys[k]];
		}
	}

	// Same for entry-level colors: null means "use theme"
	for (var e = 0; e < entries.length; e++) {
		if (entries[e].fg_clr === null) delete entries[e].fg_clr;
		if (entries[e].bg_clr === null) delete entries[e].bg_clr;
	}

	return menu;
}

async function menuExists(name) {
	var row = await postgres.queryOne(
		'SELECT id FROM menus WHERE LOWER(name) = LOWER($1)',
		[name]
	);
	return !!row;
}

async function getAllMenus() {
	var menus = await postgres.query(
		`SELECT m.*, COUNT(e.id)::int AS entry_count
		 FROM menus m
		 LEFT JOIN menu_entries e ON e.menu_id = m.id
		 GROUP BY m.id
		 ORDER BY m.name ASC`
	);
	return menus || [];
}

async function getMenuById(id) {
	return await postgres.queryOne('SELECT * FROM menus WHERE id = $1', [id]);
}

async function createMenu(data) {
	var result = { status: false, errormessages: [], menuId: null };

	var name = (data.name || '').trim().toLowerCase();
	if (!name) {
		result.errormessages.push('Menu identifier is required');
		return result;
	}
	if (!/^[a-z0-9_-]+$/.test(name)) {
		result.errormessages.push('Menu identifier must contain only lowercase letters, numbers, hyphens, and underscores');
		return result;
	}

	// Check uniqueness
	var existing = await postgres.queryOne('SELECT id FROM menus WHERE name = $1', [name]);
	if (existing) {
		result.errormessages.push('A menu with that name already exists');
		return result;
	}

	var obj = {
		name: name,
		title: (data.title || name).trim(),
		menu_type: VALID_MENU_TYPES.includes(data.menu_type) ? data.menu_type : 'Hotkey',
		display_title: data.display_title !== 'false' && data.display_title !== false,
		display_entries: ['auto', 'off', 'art'].includes(data.display_entries) ? data.display_entries : 'auto',
		display_file: (data.display_file || '').trim(),
		display_file_type: (data.display_file_type || '').trim(),
		margin_top: parseInt(data.margin_top) >= 0 ? parseInt(data.margin_top) : 3,
		margin_bottom: parseInt(data.margin_bottom) >= 0 ? parseInt(data.margin_bottom) : 3,
		margin_left: parseInt(data.margin_left) >= 0 ? parseInt(data.margin_left) : 2,
		margin_right: parseInt(data.margin_right) >= 0 ? parseInt(data.margin_right) : 2,
		fill_order: data.fill_order === 'rows' ? 'rows' : 'columns',
		center_vertical: data.center_vertical === 'true' || data.center_vertical === true,
		max_columns: parseInt(data.max_columns) || 3,
		col_gap: parseInt(data.col_gap) || 2,
		title_clr: data.title_clr != null && data.title_clr !== '' ? parseInt(data.title_clr) : null,
		input_clr: data.input_clr != null && data.input_clr !== '' ? parseInt(data.input_clr) : null,
		prompt_clr: data.prompt_clr != null && data.prompt_clr !== '' ? parseInt(data.prompt_clr) : null,
		error_clr: data.error_clr != null && data.error_clr !== '' ? parseInt(data.error_clr) : null,
		hotkey_clr: data.hotkey_clr != null && data.hotkey_clr !== '' ? parseInt(data.hotkey_clr) : null,
		menu_prompt_clr: data.menu_prompt_clr != null && data.menu_prompt_clr !== '' ? parseInt(data.menu_prompt_clr) : null,
		featured_clr: data.featured_clr != null && data.featured_clr !== '' ? parseInt(data.featured_clr) : null,
		created_at: new Date(),
		updated_at: new Date()
	};

	var insertResult = await postgres.insertObject(obj, 'menus');
	if (insertResult.status) {
		result.status = true;
		result.menuId = insertResult.insertId;

		// Add default entries to the new menu
		for (var di = 0; di < DEFAULT_MENU_ENTRIES.length; di++) {
			await createEntry(insertResult.insertId, DEFAULT_MENU_ENTRIES[di]);
		}
	} else {
		result.errormessages.push('Database insert failed');
	}
	return result;
}

async function updateMenu(id, data) {
	var result = { status: false, errormessages: [] };

	var obj = {
		title: (data.title || '').trim(),
		menu_type: VALID_MENU_TYPES.includes(data.menu_type) ? data.menu_type : 'Hotkey',
		display_title: data.display_title !== 'false' && data.display_title !== false,
		display_entries: ['auto', 'off', 'art'].includes(data.display_entries) ? data.display_entries : 'auto',
		display_file: (data.display_file || '').trim(),
		display_file_type: (data.display_file_type || '').trim(),
		margin_top: parseInt(data.margin_top) >= 0 ? parseInt(data.margin_top) : 3,
		margin_bottom: parseInt(data.margin_bottom) >= 0 ? parseInt(data.margin_bottom) : 3,
		margin_left: parseInt(data.margin_left) >= 0 ? parseInt(data.margin_left) : 2,
		margin_right: parseInt(data.margin_right) >= 0 ? parseInt(data.margin_right) : 2,
		fill_order: data.fill_order === 'rows' ? 'rows' : 'columns',
		center_vertical: data.center_vertical === 'true' || data.center_vertical === true,
		max_columns: parseInt(data.max_columns) || 3,
		col_gap: parseInt(data.col_gap) || 2,
		title_clr: data.title_clr != null && data.title_clr !== '' ? parseInt(data.title_clr) : null,
		input_clr: data.input_clr != null && data.input_clr !== '' ? parseInt(data.input_clr) : null,
		prompt_clr: data.prompt_clr != null && data.prompt_clr !== '' ? parseInt(data.prompt_clr) : null,
		error_clr: data.error_clr != null && data.error_clr !== '' ? parseInt(data.error_clr) : null,
		hotkey_clr: data.hotkey_clr != null && data.hotkey_clr !== '' ? parseInt(data.hotkey_clr) : null,
		menu_prompt_clr: data.menu_prompt_clr != null && data.menu_prompt_clr !== '' ? parseInt(data.menu_prompt_clr) : null,
		featured_clr: data.featured_clr != null && data.featured_clr !== '' ? parseInt(data.featured_clr) : null,
		updated_at: new Date()
	};

	// Allow name change only if new name is unique and slug-safe
	if (data.name) {
		var trimmed = data.name.trim().toLowerCase();
		if (!/^[a-z0-9_-]+$/.test(trimmed)) {
			result.errormessages.push('Menu identifier must contain only lowercase letters, numbers, hyphens, and underscores');
			return result;
		}
		var existing = await postgres.queryOne('SELECT id FROM menus WHERE name = $1 AND id != $2', [trimmed, id]);
		if (existing) {
			result.errormessages.push('A menu with that identifier already exists');
			return result;
		}
		obj.name = trimmed;
	}

	await postgres.updateById(id, obj, 'menus');
	result.status = true;
	return result;
}

async function deleteMenu(id) {
	var result = { status: false, errormessages: [] };
	// Delete entries first (cascade)
	await postgres.write('DELETE FROM menu_entries WHERE menu_id = $1', [id]);
	await postgres.write('DELETE FROM menus WHERE id = $1', [id]);
	result.status = true;
	return result;
}

// --- Menu Entry CRUD ---

async function getEntriesForMenu(menuId) {
	var entries = await postgres.query(
		'SELECT * FROM menu_entries WHERE menu_id = $1 ORDER BY sort_order ASC, id ASC',
		[menuId]
	);
	for (var i = 0; i < entries.length; i++) {
		if (typeof entries[i].required_flags === 'string') {
			try { entries[i].required_flags = JSON.parse(entries[i].required_flags); } catch (_) { entries[i].required_flags = []; }
		}
		if (typeof entries[i].prohibited_flags === 'string') {
			try { entries[i].prohibited_flags = JSON.parse(entries[i].prohibited_flags); } catch (_) { entries[i].prohibited_flags = []; }
		}
		entries[i].required_flags = entries[i].required_flags || [];
		entries[i].prohibited_flags = entries[i].prohibited_flags || [];
	}
	return entries || [];
}

async function getEntryById(id) {
	return await postgres.queryOne('SELECT * FROM menu_entries WHERE id = $1', [id]);
}

async function createEntry(menuId, data) {
	var result = { status: false, errormessages: [], entryId: null };

	if (!menuId) {
		result.errormessages.push('Menu ID is required');
		return result;
	}

	// Get next sort order
	var maxRow = await postgres.queryOne(
		'SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM menu_entries WHERE menu_id = $1',
		[menuId]
	);
	var nextSort = (maxRow ? maxRow.max_sort : 0) + 10;

	// Handle multi-value form fields (Express sends array for multiple select)
	var requiredFlags = data.required_flags || [];
	if (typeof requiredFlags === 'string') {
		try { requiredFlags = JSON.parse(requiredFlags); } catch (_) { requiredFlags = [requiredFlags]; }
	}
	if (!Array.isArray(requiredFlags)) requiredFlags = [requiredFlags];
	requiredFlags = requiredFlags.filter(Boolean);

	var prohibitedFlags = data.prohibited_flags || [];
	if (typeof prohibitedFlags === 'string') {
		try { prohibitedFlags = JSON.parse(prohibitedFlags); } catch (_) { prohibitedFlags = [prohibitedFlags]; }
	}
	if (!Array.isArray(prohibitedFlags)) prohibitedFlags = [prohibitedFlags];
	prohibitedFlags = prohibitedFlags.filter(Boolean);

	var obj = {
		menu_id: menuId,
		sort_order: parseInt(data.sort_order) || nextSort,
		hotkey: (data.hotkey || '').trim().substring(0, 4),
		display: (data.display || '').trim(),
		command_name: (data.command_name || '').trim(),
		command_arg: (data.command_arg || '').trim(),
		fg_clr: data.fg_clr !== undefined && data.fg_clr !== '' ? parseInt(data.fg_clr) : null,
		bg_clr: data.bg_clr !== undefined && data.bg_clr !== '' ? parseInt(data.bg_clr) : null,
		featured: data.featured === 'true' || data.featured === true,
		min_security: data.min_security !== undefined && data.min_security !== '' ? parseInt(data.min_security) : null,
		required_flags: JSON.stringify(requiredFlags),
		prohibited_flags: JSON.stringify(prohibitedFlags),
		created_at: new Date(),
		updated_at: new Date()
	};

	var insertResult = await postgres.insertObject(obj, 'menu_entries');
	if (insertResult.status) {
		result.status = true;
		result.entryId = insertResult.insertId;
	} else {
		result.errormessages.push('Database insert failed');
	}
	return result;
}

async function updateEntry(entryId, data) {
	var result = { status: false, errormessages: [] };

	var requiredFlags = data.required_flags || [];
	if (typeof requiredFlags === 'string') {
		try { requiredFlags = JSON.parse(requiredFlags); } catch (_) { requiredFlags = [requiredFlags]; }
	}
	if (!Array.isArray(requiredFlags)) requiredFlags = [requiredFlags];
	requiredFlags = requiredFlags.filter(Boolean);

	var prohibitedFlags = data.prohibited_flags || [];
	if (typeof prohibitedFlags === 'string') {
		try { prohibitedFlags = JSON.parse(prohibitedFlags); } catch (_) { prohibitedFlags = [prohibitedFlags]; }
	}
	if (!Array.isArray(prohibitedFlags)) prohibitedFlags = [prohibitedFlags];
	prohibitedFlags = prohibitedFlags.filter(Boolean);

	var obj = {
		sort_order: parseInt(data.sort_order) || 0,
		hotkey: (data.hotkey || '').trim().substring(0, 4),
		display: (data.display || '').trim(),
		command_name: (data.command_name || '').trim(),
		command_arg: (data.command_arg || '').trim(),
		fg_clr: data.fg_clr !== undefined && data.fg_clr !== '' ? parseInt(data.fg_clr) : null,
		bg_clr: data.bg_clr !== undefined && data.bg_clr !== '' ? parseInt(data.bg_clr) : null,
		featured: data.featured === 'true' || data.featured === true,
		min_security: data.min_security !== undefined && data.min_security !== '' ? parseInt(data.min_security) : null,
		required_flags: JSON.stringify(requiredFlags),
		prohibited_flags: JSON.stringify(prohibitedFlags),
		updated_at: new Date()
	};

	await postgres.updateById(entryId, obj, 'menu_entries');
	result.status = true;
	return result;
}

async function deleteEntry(entryId) {
	await postgres.write('DELETE FROM menu_entries WHERE id = $1', [entryId]);
	return { status: true };
}

async function reorderEntries(menuId, orderedIds) {
	for (var i = 0; i < orderedIds.length; i++) {
		await postgres.write(
			'UPDATE menu_entries SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND menu_id = $3',
			[(i + 1) * 10, orderedIds[i], menuId]
		);
	}
	return { status: true };
}

// --- Available commands for dropdowns ---
// Keep in sync with menuhandler.js _doMenuCommand switch

function getAvailableCommands() {
	return [
		{ name: 'loadMenu',        label: 'Load Menu',         needsArg: true,  argLabel: 'Menu Name' },
		{ name: 'previousMenu',    label: 'Previous Menu',     needsArg: false },
		{ name: 'logOff',          label: 'Log Off (Fast)',     needsArg: false },
		{ name: 'goodbye',         label: 'Log Off (Confirm)',  needsArg: false },
		{ name: 'nodeSpy',         label: 'Node Spy',          needsArg: false },
		{ name: 'wall',            label: 'The Wall',          needsArg: false },
		{ name: 'sysInfo',         label: 'System Info',       needsArg: false },
		{ name: 'bulletins',       label: 'Bulletins',         needsArg: false },
		{ name: 'fileNewscan',     label: 'New File Scan',     needsArg: false },
		{ name: 'exitStage',       label: 'Exit Stage',        needsArg: false },
		{ name: 'redrawMenu',      label: 'Redraw Menu',       needsArg: false },
		{ name: 'runXtrn',         label: 'Run Door Game',     needsArg: true,  argLabel: 'Door Slug' },
		{ name: 'msgAreaChange',   label: 'Change Msg Area',   needsArg: false },
		{ name: 'msgGroupChange',  label: 'Change Msg Group',  needsArg: false },
		{ name: 'listMessages',    label: 'List Messages',     needsArg: false },
		{ name: 'readMessages',    label: 'Read Messages',     needsArg: false },
		{ name: 'postMessage',     label: 'Post Message',      needsArg: false },
		{ name: 'newScan',         label: 'New Scan (All)',     needsArg: false },
		{ name: 'newScanGroup',    label: 'New Scan (Group)',   needsArg: false },
		{ name: 'userList',        label: 'User List',         needsArg: false },
		{ name: 'lastCallers',     label: 'Last Callers',      needsArg: false },
		{ name: 'announcements',   label: 'Announcements',     needsArg: false },
		{ name: 'whosOnline',      label: "Who's Online",      needsArg: false },
		{ name: 'email',           label: 'Private Messages',  needsArg: false },
		{ name: 'checkEmail',      label: 'Check Email',       needsArg: false },
		{ name: 'verifyMail',      label: 'Verify Address',    needsArg: false },
		{ name: 'passwordReset',   label: 'Change Password',  needsArg: false },
		{ name: 'doorBrowser',     label: 'Door Browser',     needsArg: false },
		{ name: 'testDownload',    label: 'Test Download',     needsArg: false },
		{ name: 'fileAreaChange',  label: 'Change File Area',  needsArg: false },
		{ name: 'fileGroupChange', label: 'Change File Group', needsArg: false },
		{ name: 'fileBrowser',     label: 'File Browser',      needsArg: false },
		{ name: 'downloadBatch',   label: 'Download Batch',    needsArg: false },
		{ name: 'fileUpload',      label: 'Upload File',       needsArg: false },
		{ name: 'fileSearch',      label: 'File Search',       needsArg: false },
	].sort(function(a, b) { return a.label.localeCompare(b.label); });
}

function getValidDisplayFileTypes() {
	return VALID_DISPLAY_FILE_TYPES;
}

function getValidMenuTypes() {
	return VALID_MENU_TYPES;
}

function getAnsiColors() {
	return ANSI_COLORS;
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

async function duplicateMenu(sourceId, newName) {
	var result = { status: false, errormessages: [], menuId: null };

	var source = await getMenuById(sourceId);
	if (!source) {
		result.errormessages.push('Source menu not found');
		return result;
	}

	var name = (newName || '').trim().toLowerCase();
	if (!name) {
		result.errormessages.push('New menu name is required');
		return result;
	}
	if (!/^[a-z0-9_-]+$/.test(name)) {
		result.errormessages.push('Menu identifier must contain only lowercase letters, numbers, hyphens, and underscores');
		return result;
	}

	var existing = await postgres.queryOne('SELECT id FROM menus WHERE name = $1', [name]);
	if (existing) {
		result.errormessages.push('A menu with that name already exists');
		return result;
	}

	// Copy menu record (excluding id, name)
	var skip = new Set(['id', 'name', 'created_at', 'updated_at']);
	var obj = { name: name, created_at: new Date(), updated_at: new Date() };
	for (var key of Object.keys(source)) {
		if (!skip.has(key) && source[key] !== undefined) {
			obj[key] = source[key];
		}
	}
	obj.title = obj.title + ' (copy)';

	var insertResult = await postgres.insertObject(obj, 'menus');
	if (!insertResult.status) {
		result.errormessages.push('Failed to create menu copy');
		return result;
	}

	var newMenuId = insertResult.insertId;

	// Copy all entries
	var entries = await getEntriesForMenu(sourceId);
	for (var entry of entries) {
		var entryObj = {
			menu_id: newMenuId,
			sort_order: entry.sort_order,
			hotkey: entry.hotkey,
			display: entry.display,
			command_name: entry.command_name,
			command_arg: entry.command_arg,
			fg_clr: entry.fg_clr,
			bg_clr: entry.bg_clr,
			featured: entry.featured,
			min_security: entry.min_security,
			required_flags: JSON.stringify(entry.required_flags || []),
			prohibited_flags: JSON.stringify(entry.prohibited_flags || []),
			created_at: new Date(),
			updated_at: new Date()
		};
		await postgres.insertObject(entryObj, 'menu_entries');
	}

	result.status = true;
	result.menuId = newMenuId;
	alogger.writeAlog(5, 'Menu duplicated: ' + source.name + ' -> ' + name + ' (' + entries.length + ' entries)', 'greenbright');
	return result;
}

// ---------------------------------------------------------------------------
// Export / Import (JSON)
// ---------------------------------------------------------------------------

async function exportMenuToJson(menuId) {
	var menu = await getMenuById(menuId);
	if (!menu) return null;

	var entries = await getEntriesForMenu(menuId);

	// Strip DB-specific fields
	var skip = new Set(['id', 'created_at', 'updated_at', 'created_by_uuid', 'created_by_name']);
	var menuData = {};
	for (var key of Object.keys(menu)) {
		if (!skip.has(key)) menuData[key] = menu[key];
	}

	var entryData = [];
	var entrySkip = new Set(['id', 'menu_id', 'created_at', 'updated_at']);
	for (var entry of entries) {
		var ed = {};
		for (var ek of Object.keys(entry)) {
			if (!entrySkip.has(ek)) ed[ek] = entry[ek];
		}
		entryData.push(ed);
	}

	return {
		_format: 'canectic-menu-v1',
		menu: menuData,
		entries: entryData
	};
}

async function importMenuFromJson(data, overrideName) {
	var result = { status: false, errormessages: [], menuId: null };

	if (!data || !data.menu) {
		result.errormessages.push('Invalid menu JSON: missing menu object');
		return result;
	}

	var menuData = Object.assign({}, data.menu);
	if (overrideName) {
		menuData.name = overrideName.trim().toLowerCase();
	}

	// Create the menu via the standard path (validates name, checks uniqueness)
	var createResult = await createMenu(menuData);
	if (!createResult.status) {
		result.errormessages = createResult.errormessages;
		return result;
	}

	var newMenuId = createResult.menuId;

	// Delete the default entries that createMenu added (we'll import our own)
	var defaultEntries = await getEntriesForMenu(newMenuId);
	for (var de of defaultEntries) {
		await deleteEntry(de.id);
	}

	// Import entries
	var entries = data.entries || [];
	for (var i = 0; i < entries.length; i++) {
		var entry = entries[i];
		entry.sort_order = entry.sort_order || ((i + 1) * 10);
		await createEntry(newMenuId, entry);
	}

	result.status = true;
	result.menuId = newMenuId;
	alogger.writeAlog(5, 'Menu imported: ' + menuData.name + ' (' + entries.length + ' entries)', 'greenbright');
	return result;
}

export {
	getMenu,
	menuExists,
	getAllMenus,
	getMenuById,
	createMenu,
	updateMenu,
	deleteMenu,
	duplicateMenu,
	exportMenuToJson,
	importMenuFromJson,
	getEntriesForMenu,
	getEntryById,
	createEntry,
	updateEntry,
	deleteEntry,
	reorderEntries,
	getAvailableCommands,
	getValidDisplayFileTypes,
	getValidMenuTypes,
	getAnsiColors
};
