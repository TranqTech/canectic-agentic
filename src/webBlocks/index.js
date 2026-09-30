// index.js -- The registry of web blocks (#91).
//
// A block is one piece of web content the sysop can place: announcements,
// last callers, the wall, new messages and so on. The web call flow shows
// blocks one at a time; the landing page (#87) will show several at once.
// Both read the same definitions, so a block behaves the same wherever it is
// placed and a new one is written once.
//
// A block is its catalog entry (catalog.js: name, label, requiresUser, the
// settings a sysop may give it) plus:
//
//   view          Pug partial rendered with load()'s result
//   available(ctx, opts)  optional. Null means "nothing to show, skip me";
//                 an object is extra detail for the stage list (count, areas).
//                 Omitted means always shown.
//   load(ctx, opts)  the locals for the view
//
// opts is always complete: every setting the block declares, with the flow's
// value or the default (catalog.resolveOptions).
//
// available() is separate from load() because the stage list is built for
// every stage up front and must stay cheap: counting news files is a query,
// rendering them reads every file from disk.

import * as alogger from '../utils/alogger.js';
import { createContext, getLastCallflowAt } from './context.js';
import { CATALOG, DEFAULT_WEB_FLOW, catalogEntry, stageName, resolveOptions } from './catalog.js';

import welcome from './welcome.js';
import announcements from './announcements.js';
import lastCallers from './lastCallers.js';
import whosOnline from './whosOnline.js';
import wall from './wall.js';
import newsFiles from './newsFiles.js';
import newMessages from './newMessages.js';
import newFiles from './newFiles.js';
import bulletins from './bulletins.js';
import sysInfo from './sysInfo.js';
import newMail from './newMail.js';
import verifyMail from './verifyMail.js';
import page from './page.js';

// Every catalog entry implemented, nothing implemented that is not in the
// catalog: a flow is validated against the catalog and run against this.
var BLOCKS = new Map();
for (var block of [welcome, announcements, lastCallers, whosOnline, wall, newsFiles, newMessages, newFiles,
	bulletins, sysInfo, newMail, verifyMail, page]) {
	if (!catalogEntry(block.name)) throw new Error('webBlocks: ' + block.name + ' is not in the catalog');
	if (BLOCKS.has(block.name)) throw new Error('webBlocks: duplicate block name ' + block.name);
	BLOCKS.set(block.name, Object.freeze(block));
}
for (var entry of CATALOG) {
	if (!BLOCKS.has(entry.name)) throw new Error('webBlocks: catalog entry ' + entry.name + ' has no implementation');
}

/** The block called name, or null. A Map, so '__proto__' is just a miss. */
function getBlock(name, registry) {
	registry = registry || BLOCKS;
	return (typeof name === 'string' && registry.get(name)) || null;
}

function listBlocks() {
	return Array.from(BLOCKS.values());
}

/**
 * The item for block name in a flow, or null when the flow does not have it.
 * A repeatable block (a Page) is matched on its telling-apart setting too,
 * given as which (the value from the stage's address).
 */
function findStage(flow, name, which) {
	var entry = catalogEntry(name);
	for (var item of flow || []) {
		if (stageName(item) !== name) continue;
		if (!entry || !entry.repeatable) return item;
		var v = item && item.options ? item.options[entry.repeatable] : undefined;
		if (v !== undefined && String(v) === String(which)) return item;
	}
	return null;
}

// Where the call flow page fetches a stage from. A repeatable stage carries
// its setting in the address, since its name alone is not unique.
function stagePath(block, item) {
	var path = '/callflow/stage/' + block.name;
	var entry = catalogEntry(block.name);
	if (entry && entry.repeatable) {
		var v = item && item.options ? item.options[entry.repeatable] : '';
		path += '?' + entry.repeatable + '=' + encodeURIComponent(String(v === undefined ? '' : v));
	}
	return path;
}

/** A block's complete settings as a flow item gives them. */
function optionsFor(block, item) {
	return resolveOptions(catalogEntry(block.name), item && typeof item === 'object' ? item.options : null);
}

/**
 * The stages this user will see, in order, each as {name, label, ...detail}.
 * flow items are block names or { stage, options }.
 *
 * A block that throws is left out and logged rather than failing the list:
 * one broken query should cost the user one stage, not the whole call flow
 * (or, once blocks are on the landing page, the home page).
 */
async function buildStageList(ctx, flow, registry) {
	flow = flow || DEFAULT_WEB_FLOW;
	registry = registry || BLOCKS;
	var stages = [];
	if (!ctx.user) return stages;

	for (var item of flow) {
		var name = stageName(item);
		var block = getBlock(name, registry);
		if (!block) {
			alogger.writeAlog(2, 'Web blocks: flow names unknown block "' + name + '", skipped', 'yellow');
			continue;
		}
		var detail;
		try {
			detail = block.available ? await block.available(ctx, optionsFor(block, item)) : {};
		} catch (err) {
			alogger.writeAlog(1, 'Web blocks: ' + block.name + ' failed, left out: ' + (err && err.stack || err), 'redbright');
			continue;
		}
		if (!detail) continue;

		// detail may relabel a stage (a Page is labelled with the page's
		// title) but never rename it, since the name is how it is fetched
		var stage = { name: block.name, label: block.label };
		for (var key of Object.keys(detail)) {
			if (key === 'name' || key === 'path') continue;
			if (key === 'label' && (typeof detail.label !== 'string' || !detail.label)) continue;
			stage[key] = detail[key];
		}
		stage.path = stagePath(block, item);
		stages.push(stage);
	}
	return stages;
}

export {
	BLOCKS,
	DEFAULT_WEB_FLOW,
	getBlock,
	listBlocks,
	findStage,
	stagePath,
	optionsFor,
	buildStageList,
	createContext,
	getLastCallflowAt
};
