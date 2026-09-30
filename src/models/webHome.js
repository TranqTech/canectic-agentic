// webHome.js -- The website's home page, one layout for visitors and one
// for logged-in users (#87, #91 phase 5).
//
// A layout is an ordered list of web blocks, the same blocks and settings
// the web call flow uses (src/webBlocks), shown as tabs or one above the
// other. What a visitor needs (what the board is, how to connect, how to
// log in) is not what a caller coming back wants, hence two.
//
// Until a sysop saves one, each layout is the home page as it always was:
// announcements as a tab, and for logged-in users the wall as a second.

import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import { normaliseWebStages } from '../webBlocks/catalog.js';
import { missingPages } from './webPages.js';

var AUDIENCES = Object.freeze([
	{ value: 'public', label: 'Visitors (not logged in)' },
	{ value: 'users',  label: 'Logged-in users' }
]);

var DISPLAYS = Object.freeze([
	{ value: 'tabs',    label: 'Tabs, one block each' },
	{ value: 'stacked', label: 'One above the other' }
]);

var DEFAULT_LAYOUTS = Object.freeze({
	public: Object.freeze({ display: 'tabs', blocks: Object.freeze([
		{ stage: 'announcements', options: { show: 'all' } }
	]) }),
	users: Object.freeze({ display: 'tabs', blocks: Object.freeze([
		{ stage: 'announcements', options: { show: 'all' } },
		{ stage: 'wall' }
	]) })
});

function isAudience(a) { return AUDIENCES.some(function (x) { return x.value === a; }); }
function isDisplay(d) { return DISPLAYS.some(function (x) { return x.value === d; }); }

function copyDefault(audience) {
	var d = DEFAULT_LAYOUTS[audience];
	return { display: d.display, blocks: JSON.parse(JSON.stringify(d.blocks)), isDefault: true };
}

/**
 * The layout for 'public' or 'users': the saved one, else the default. Read
 * every time rather than cached (it is one row), so an edit shows at once in
 * every process. A read error draws the default rather than an empty page.
 */
async function getLayout(audience) {
	if (!isAudience(audience)) audience = 'public';
	try {
		var row = await postgres.queryOne('SELECT display, blocks FROM web_home_layouts WHERE audience = $1', [audience]);
		if (!row) return copyDefault(audience);
		var blocks = typeof row.blocks === 'string' ? JSON.parse(row.blocks) : row.blocks;
		return {
			display: isDisplay(row.display) ? row.display : 'tabs',
			blocks: Array.isArray(blocks) ? blocks : [],
			isDefault: false
		};
	} catch (err) {
		alogger.writeAlog(1, 'Web home: could not read the ' + audience + ' layout, drawing the default: ' + err.message, 'redbright');
		return copyDefault(audience);
	}
}

/** Save a layout, checked as a web flow is. Returns { status, errormessages }. */
async function saveLayout(audience, input) {
	var result = { status: false, errormessages: [] };
	if (!isAudience(audience)) { result.errormessages.push('No such home page'); return result; }
	input = input || {};
	var display = input.display === undefined ? null : input.display;
	if (display !== null && !isDisplay(display)) { result.errormessages.push('Choose tabs or one above the other'); return result; }
	if (display === null) display = (await getLayout(audience)).display;

	var blocks;
	if (input.blocks === undefined) {
		blocks = (await getLayout(audience)).blocks;
	} else {
		var checked = normaliseWebStages(input.blocks);
		if (checked.errors.length === 0) checked.errors = await missingPages(checked.stages);
		if (checked.errors.length) { result.errormessages = checked.errors; return result; }
		blocks = checked.stages;
	}

	var err = await postgres.write(
		'INSERT INTO web_home_layouts (audience, display, blocks, updated_at) VALUES ($1, $2, $3, NOW()) ' +
		'ON CONFLICT (audience) DO UPDATE SET display = EXCLUDED.display, blocks = EXCLUDED.blocks, updated_at = NOW()',
		[audience, display, JSON.stringify(blocks)]);
	if (err) { result.errormessages.push('Could not save the home page: ' + err.message); return result; }
	result.status = true;
	alogger.writeAlog(5, 'Web home: saved the ' + audience + ' layout', 'greenbright');
	return result;
}

/** Put a layout back to the home page as it always was. */
async function resetLayout(audience) {
	var result = { status: false, errormessages: [] };
	if (!isAudience(audience)) { result.errormessages.push('No such home page'); return result; }
	var err = await postgres.write('DELETE FROM web_home_layouts WHERE audience = $1', [audience]);
	if (err) { result.errormessages.push('Could not reset the home page: ' + err.message); return result; }
	result.status = true;
	return result;
}

export {
	AUDIENCES,
	DISPLAYS,
	DEFAULT_LAYOUTS,
	getLayout,
	saveLayout,
	resetLayout
};
