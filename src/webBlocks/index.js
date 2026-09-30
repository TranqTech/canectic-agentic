// index.js -- The registry of web blocks (#91).
//
// A block is one piece of web content the sysop can place: announcements,
// last callers, the wall, new messages and so on. The web call flow shows
// blocks one at a time; the landing page (#87) will show several at once.
// Both read the same definitions, so a block behaves the same wherever it is
// placed and a new one is written once.
//
// A block is:
//
//   name          stable identifier, stored in flows; never rename one
//   label         what the sysop and the user see
//   view          Pug partial rendered with load()'s result
//   requiresUser  true when it means nothing to a visitor (new messages)
//   available(ctx)  optional. Null means "nothing to show, skip me";
//                 an object is extra detail for the stage list (count, areas).
//                 Omitted means always shown.
//   load(ctx)     the locals for the view
//
// available() is separate from load() because the stage list is built for
// every stage up front and must stay cheap: counting news files is a query,
// rendering them reads every file from disk.

import * as alogger from '../utils/alogger.js';
import { createContext, getLastCallflowAt } from './context.js';

import welcome from './welcome.js';
import announcements from './announcements.js';
import lastCallers from './lastCallers.js';
import whosOnline from './whosOnline.js';
import wall from './wall.js';
import newsFiles from './newsFiles.js';
import newMessages from './newMessages.js';
import newFiles from './newFiles.js';

var BLOCKS = new Map();
for (var block of [welcome, announcements, lastCallers, whosOnline, wall, newsFiles, newMessages, newFiles]) {
	if (BLOCKS.has(block.name)) throw new Error('webBlocks: duplicate block name ' + block.name);
	BLOCKS.set(block.name, Object.freeze(block));
}

// The web call flow as it has always been. Phase 2 of #91 makes this a
// seeded, editable flow; until then it is the flow.
var DEFAULT_WEB_FLOW = Object.freeze([
	'welcome', 'announcements', 'lastcallers', 'whosonline',
	'wall', 'newsfiles', 'newmsgs', 'newfiles'
]);

/** The block called name, or null. A Map, so '__proto__' is just a miss. */
function getBlock(name, registry) {
	registry = registry || BLOCKS;
	return (typeof name === 'string' && registry.get(name)) || null;
}

function listBlocks() {
	return Array.from(BLOCKS.values());
}

/**
 * The stages this user will see, in order, each as {name, label, ...detail}.
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

	for (var name of flow) {
		var block = getBlock(name, registry);
		if (!block) {
			alogger.writeAlog(2, 'Web blocks: flow names unknown block "' + name + '", skipped', 'yellow');
			continue;
		}
		var detail;
		try {
			detail = block.available ? await block.available(ctx) : {};
		} catch (err) {
			alogger.writeAlog(1, 'Web blocks: ' + block.name + ' failed, left out: ' + (err && err.stack || err), 'redbright');
			continue;
		}
		if (!detail) continue;

		var stage = { name: block.name, label: block.label };
		for (var key of Object.keys(detail)) {
			if (key !== 'name' && key !== 'label') stage[key] = detail[key];
		}
		stages.push(stage);
	}
	return stages;
}

export {
	BLOCKS,
	DEFAULT_WEB_FLOW,
	getBlock,
	listBlocks,
	buildStageList,
	createContext,
	getLastCallflowAt
};
