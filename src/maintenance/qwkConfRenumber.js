// qwkConfRenumber.js -- assign QWK conference numbers under the per-group block
// model.
//
// Conference 0 is E-mail by QWK convention, 1..RESERVED_CONF_COUNT are reserved
// for system conferences, and each message group owns a contiguous block of
// `qwk_group_stride` numbers starting at message_groups.qwk_conf_start. Areas
// take consecutive offsets inside their group's block so they cluster together
// in a mail reader's conference list.
//
// Extracted from src/tools/qwkConfRenumber.js, which was a CLI that planned,
// printed and wrote in one pass and called process.exit at every turn. Nothing
// else could use it, which is why the upgrade step it performs has been prose in
// the changelog rather than something the system does.
//
// planRenumber() is pure. It is where every rule that can be got wrong lives:
// which groups keep their existing start, which areas keep their offset, and
// which group cannot fit. Making it a function of its inputs is what lets those
// rules be tested against a fixture rather than a live message base.

import * as postgres from '../middleware/db/postgres.js';
import { RESERVED_CONF_COUNT } from '../models/msgAreas.js';

// The first stride-aligned slot above the reserved range.
function firstSlot(stride) {
	var s = stride;
	while (s <= RESERVED_CONF_COUNT) s += stride;
	return s;
}

/**
 * Work out what every group and area should be numbered, without writing.
 *
 * Pure: hand it rows and it returns a plan.
 *
 * @param {Array}  groups        message_groups rows, in (sort_order, id) order
 * @param {Map}    areasByGroup  group id -> message_areas rows in the same order
 * @param {number} stride        conference numbers per group
 * @param {object} opts          { force }
 * @returns {object} { groups: [...], areas: [...], full: [...] }
 *
 * `full` names any group with more areas than the stride allows. A caller must
 * treat a non-empty `full` as fatal: those areas cannot be numbered at all, and
 * writing a partial plan would leave the base half renumbered.
 */
function planRenumber(groups, areasByGroup, stride, opts) {
	var o = opts || {};
	var force = o.force === true;
	var groupPlan = [];
	var usedStarts = new Set();

	if (force) {
		// Discard everything and pack groups consecutively.
		var cursor = firstSlot(stride);
		for (var g of groups) {
			groupPlan.push({
				group: g,
				oldStart: g.qwk_conf_start != null ? parseInt(g.qwk_conf_start, 10) : null,
				newStart: cursor
			});
			usedStarts.add(cursor);
			cursor += stride;
		}
	} else {
		// Preserve every start already set, and fill only the gaps. This is
		// what makes the default mode safe to run unattended: a group that has
		// been numbered keeps its numbers, so readers holding a conference list
		// for it stay correct.
		var maxExisting = null;
		for (var g2 of groups) {
			if (g2.qwk_conf_start != null) {
				var existing = parseInt(g2.qwk_conf_start, 10);
				usedStarts.add(existing);
				if (maxExisting === null || existing > maxExisting) maxExisting = existing;
			}
		}
		var fillCursor = maxExisting != null ? maxExisting + stride : firstSlot(stride);
		for (var g3 of groups) {
			if (g3.qwk_conf_start != null) {
				var kept = parseInt(g3.qwk_conf_start, 10);
				groupPlan.push({ group: g3, oldStart: kept, newStart: kept });
			} else {
				while (usedStarts.has(fillCursor)) fillCursor += stride;
				groupPlan.push({ group: g3, oldStart: null, newStart: fillCursor });
				usedStarts.add(fillCursor);
				fillCursor += stride;
			}
		}
	}

	var areaPlan = [];
	var full = [];

	for (var ag of groupPlan) {
		var areas = areasByGroup.get(ag.group.id) || areasByGroup.get(String(ag.group.id)) || [];
		if (areas.length === 0) continue;

		if (areas.length > stride) {
			full.push({ shortcode: ag.group.shortcode, areas: areas.length, stride: stride });
			continue;
		}

		// First pass: keep an area where it is when its current number is a
		// valid offset inside the block it is already in. Repacking an area
		// that is already correct would renumber it for nothing, and every
		// renumber invalidates a conference list somebody is holding.
		var taken = new Set();
		var entries = [];
		for (var area of areas) {
			var oldNum = area.qwk_conf_number != null ? parseInt(area.qwk_conf_number, 10) : null;
			var entry = { area: area, offset: null, oldNum: oldNum };
			if (!force && ag.oldStart != null && oldNum != null) {
				var off = oldNum - ag.oldStart;
				if (off >= 0 && off < stride && !taken.has(off)) {
					entry.offset = off;
					taken.add(off);
				}
			}
			entries.push(entry);
		}

		// Second pass: everything still unplaced takes the next free slot.
		var nextSeq = 0;
		var overflowed = false;
		for (var ent of entries) {
			if (ent.offset !== null) continue;
			while (taken.has(nextSeq) && nextSeq < stride) nextSeq++;
			if (nextSeq >= stride) { overflowed = true; break; }
			ent.offset = nextSeq;
			taken.add(nextSeq);
			nextSeq++;
		}
		if (overflowed) {
			full.push({ shortcode: ag.group.shortcode, areas: areas.length, stride: stride });
			continue;
		}

		for (var e2 of entries) {
			if (e2.offset === null) continue;
			areaPlan.push({
				id: e2.area.id,
				shortcode: e2.area.shortcode,
				group_id: ag.group.id,
				group_shortcode: ag.group.shortcode,
				oldNum: e2.oldNum,
				newNum: ag.newStart + e2.offset
			});
		}
	}

	return { groups: groupPlan, areas: areaPlan, full: full };
}

/** Areas whose number actually changes. */
function changedAreas(plan) {
	return (plan.areas || []).filter(function (a) { return a.oldNum !== a.newNum; });
}

// ---------------------------------------------------------------------------
// Loading and writing
// ---------------------------------------------------------------------------

async function loadPlanInputs() {
	var groups = await postgres.query(
		'SELECT id, shortcode, name, sort_order, qwk_conf_start FROM message_groups ' +
		'ORDER BY sort_order ASC, id ASC', []);

	var areasByGroup = new Map();
	for (var g of (groups || [])) {
		var areas = await postgres.query(
			'SELECT id, shortcode, qwk_conf_number FROM message_areas ' +
			'WHERE group_id = $1 ORDER BY sort_order ASC, id ASC', [g.id]);
		areasByGroup.set(g.id, areas || []);
	}
	return { groups: groups || [], areasByGroup: areasByGroup };
}

/**
 * Make sure the column the plan writes to exists.
 *
 * The tool has always been runnable before the gateway has applied the
 * declarative schema, so it bootstraps its own column. Kept because the
 * migration path can reach this before that column exists on an old install.
 */
async function ensureSchema() {
	var err = await postgres.write(
		'ALTER TABLE message_groups ADD COLUMN IF NOT EXISTS qwk_conf_start INTEGER');
	if (err) throw new Error('could not add message_groups.qwk_conf_start: ' + err.message);

	var err2 = await postgres.write(
		"DO $$ BEGIN " +
		"IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_groups_qwk_conf_start_key') " +
		"THEN ALTER TABLE message_groups ADD CONSTRAINT message_groups_qwk_conf_start_key UNIQUE (qwk_conf_start); " +
		"END IF; END $$");
	if (err2) throw new Error('could not add the qwk_conf_start unique constraint: ' + err2.message);
}

/**
 * Apply a plan.
 *
 * Two-phase on purpose. Every area is first parked at -id, which cannot collide
 * with any real conference number, and only then given its final value. Writing
 * straight to the final numbers violates the UNIQUE constraint whenever the new
 * range overlaps the old, which it usually does.
 */
async function applyPlan(plan) {
	var failures = [];

	for (var park of plan.areas) {
		var e = await postgres.write(
			'UPDATE message_areas SET qwk_conf_number = $1 WHERE id = $2',
			[-1 * parseInt(park.id, 10), park.id]);
		if (e) {
			// Stop here rather than continuing. The base is partially parked,
			// and a re-run repairs it, but pressing on would mix parked and
			// final values.
			throw new Error('parking ' + park.shortcode + ' failed: ' + e.message +
				'. Some areas hold scratch conference numbers; re-run to finish.');
		}
	}

	for (var area of plan.areas) {
		var e2 = await postgres.write(
			'UPDATE message_areas SET qwk_conf_number = $1 WHERE id = $2',
			[area.newNum, area.id]);
		if (e2) failures.push(area.shortcode + ' -> ' + area.newNum + ': ' + e2.message);
	}

	for (var ag of plan.groups) {
		var e3 = await postgres.write(
			'UPDATE message_groups SET qwk_conf_start = $1 WHERE id = $2',
			[ag.newStart, ag.group.id]);
		if (e3) failures.push('group ' + ag.group.shortcode + ' -> ' + ag.newStart + ': ' + e3.message);
	}

	return failures;
}

/**
 * Plan and, unless this is a dry run, apply.
 *
 * Throws on anything a caller cannot sensibly continue past: a full group, or a
 * write failure. The CLI turns that into an exit code, the migration lets it
 * fail the update.
 *
 * @param {object} opts { force, dryRun, stride }
 */
async function renumberConferences(opts) {
	var o = opts || {};
	var stride = o.stride;
	if (!stride || stride <= 0) {
		var appConfig = (await import('../config/appConfig.js')).default;
		stride = appConfig.getNumber('qwk_group_stride', 1000);
		if (stride <= 0) stride = 1000;
	}

	await ensureSchema();

	var inputs = await loadPlanInputs();
	if (inputs.groups.length === 0) {
		return { stride: stride, plan: { groups: [], areas: [], full: [] }, changed: [], applied: false };
	}

	var plan = planRenumber(inputs.groups, inputs.areasByGroup, stride, { force: o.force });

	if (plan.full.length > 0) {
		var names = plan.full.map(function (f) {
			return f.shortcode + ' (' + f.areas + ' areas, stride ' + f.stride + ')';
		});
		throw new Error('these groups hold more areas than the stride allows: ' + names.join(', ') +
			'. Increase qwk_group_stride or split the group, then run again.');
	}

	var changed = changedAreas(plan);
	if (o.dryRun) {
		return { stride: stride, plan: plan, changed: changed, applied: false };
	}

	var failures = await applyPlan(plan);
	if (failures.length > 0) {
		throw new Error('renumber finished with ' + failures.length + ' failure(s): ' +
			failures.join('; '));
	}

	return { stride: stride, plan: plan, changed: changed, applied: true };
}

/** Does any group still lack a conference block? */
async function needsRenumber() {
	var row = await postgres.queryOne(
		'SELECT COUNT(*)::int AS n FROM message_groups WHERE qwk_conf_start IS NULL', []);
	return !!(row && row.n > 0);
}

export {
	firstSlot,
	planRenumber,
	changedAreas,
	loadPlanInputs,
	ensureSchema,
	applyPlan,
	renumberConferences,
	needsRenumber
};
